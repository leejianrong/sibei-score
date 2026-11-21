import { MCP_TOOLS, McpToolError, failureResult } from './tools.js';
import type { McpBackend, ToolAccess, ToolResult } from './tools.js';

/**
 * The slice of the Model Context Protocol this server speaks (V22a, ADR-0034 decision 5): JSON-RPC 2.0 with
 * `initialize`, `ping`, `tools/list` and `tools/call`, and nothing else. It is written out rather than taken
 * from the official SDK on purpose: the SDK brings a web framework, a schema library and a validator into a
 * package that is otherwise `node:http` and `pg`/`better-sqlite3` (ADR-0034 keeps the API framework-free,
 * ADR-0027's register stays as short as it is), to carry what is one switch statement here. The transport
 * stays stateless — no session id, no server-initiated stream — which the Streamable HTTP spec allows and a
 * single-replica API wants.
 *
 * This module is transport-free: `/mcp` (`endpoint.ts`) feeds it HTTP bodies and `sbscore mcp` feeds it
 * lines of stdin, and both get the same answers because it is the same function over the same tools.
 */

/** Newest first. A client asking for one of these is answered with it; any other is answered with the first. */
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const SERVER_INFO = { name: 'sibei-score', version: '0.1.0' } as const;

const INSTRUCTIONS =
  'sibei-score is a jazz lead-sheet editor. Call list_scores, then read_score: its text projection prints the ' +
  'addresses (bar3, bar3.n2, bar3.beat3) that edit_score accepts, and the version to pass back as ' +
  'expectedVersion. Writes are batches and all-or-nothing; a stale write is refused with currentVersion, so ' +
  're-read and retry. export_score returns a PDF or MusicXML.';

export interface McpSession {
  backend: McpBackend;
  /** Whether the caller may do this. The HTTP transport answers from the token's scopes; stdio is always yes. */
  can(access: ToolAccess): boolean;
  /** Where an unexpected failure is reported — a tool failing in a way the API has no word for. */
  onUnexpected?(error: unknown): void;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function fail(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return typeof value === 'object' && value !== null && (value as { jsonrpc?: unknown }).jsonrpc === '2.0' && typeof (value as { method?: unknown }).method === 'string';
}

/** The JSON-RPC answer to a body that was not JSON at all. */
export const PARSE_FAILURE: JsonRpcResponse = fail(null, PARSE_ERROR, 'the body is not valid JSON');

/**
 * Handle one message, or a batch of them. `null` means there is nothing to send back — the message was a
 * notification (no `id`) or a response, which the transport acknowledges without a body.
 */
/**
 * The most messages one JSON-RPC batch may carry (SEC H2). The batch runs concurrently, so without a bound
 * one 1 MB body holds thousands of heavy tool calls. Refused whole, before any message runs.
 */
export const MAX_MCP_BATCH = 10;

export async function handleMcpMessage(message: unknown, session: McpSession): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(message)) {
    if (message.length === 0) return fail(null, INVALID_REQUEST, 'an empty batch');
    if (message.length > MAX_MCP_BATCH) return fail(null, INVALID_REQUEST, `a batch is capped at ${MAX_MCP_BATCH} messages, got ${message.length}`);
    const answers = (await Promise.all(message.map((one) => handleOne(one, session)))).filter((a): a is JsonRpcResponse => a !== null);
    return answers.length === 0 ? null : answers;
  }
  return handleOne(message, session);
}

async function handleOne(message: unknown, session: McpSession): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) {
    // A response to something we never asked, or garbage. Responses have no `method` and want no answer.
    const looksLikeResponse = typeof message === 'object' && message !== null && 'id' in message && ('result' in message || 'error' in message);
    return looksLikeResponse ? null : fail(null, INVALID_REQUEST, 'not a JSON-RPC 2.0 request');
  }
  const isNotification = message.id === undefined;
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;

  switch (message.method) {
    case 'initialize': {
      if (isNotification) return null;
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_PROTOCOLS as readonly string[]).includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
      return {
        jsonrpc: '2.0',
        id: message.id ?? null,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return isNotification ? null : { jsonrpc: '2.0', id: message.id ?? null, result: {} };
    case 'tools/list': {
      if (isNotification) return null;
      const tools = MCP_TOOLS.filter((tool) => session.can(tool.access)).map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
      return { jsonrpc: '2.0', id: message.id ?? null, result: { tools } };
    }
    case 'tools/call': {
      if (isNotification) return null;
      const name = params.name;
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (tool === undefined) return fail(message.id, INVALID_PARAMS, `no tool called ${JSON.stringify(name)}`);
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      return { jsonrpc: '2.0', id: message.id ?? null, result: await callTool(tool, args, session) };
    }
    default:
      // `notifications/initialized`, `notifications/cancelled` and the like want no answer.
      if (isNotification || message.method.startsWith('notifications/')) return null;
      return fail(message.id, METHOD_NOT_FOUND, `this server does not implement ${message.method}`);
  }
}

async function callTool(tool: (typeof MCP_TOOLS)[number], args: Record<string, unknown>, session: McpSession): Promise<ToolResult> {
  if (!session.can(tool.access)) {
    return failureResult(
      new McpToolError('insufficient-scope', `this credential is not allowed to ${tool.access}; ${tool.name} needs the ${tool.access} scope`),
    );
  }
  try {
    return await tool.run(session.backend, args);
  } catch (error) {
    if (error instanceof McpToolError) return failureResult(error);
    session.onUnexpected?.(error);
    return failureResult(new McpToolError('internal', 'something went wrong running that tool'));
  }
}
