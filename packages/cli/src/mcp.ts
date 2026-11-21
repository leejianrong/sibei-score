import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { PARSE_FAILURE, McpToolError, handleMcpMessage } from '@sibei/api';
import type { McpBackend, Operation } from '@sibei/api';
import { CliError } from './client.js';
import type { Client } from './client.js';
import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';

/**
 * `sbscore mcp` — the MCP stdio transport (V22b, ADR-0034 decision 5): the same tools `/mcp` serves, for an MCP
 * client that launches a local process (Claude Desktop, an editor) instead of connecting to a URL.
 *
 * **A thin wrapper, and not a second implementation.** The tools, their schemas and the protocol handling are
 * `@sibei/api`'s own (`mcp/tools.ts`, `mcp/protocol.ts`) — the identical functions `/mcp` runs — so "the same
 * tool results as `/mcp`" is a property of the code. All that differs is the backend: here it is this CLI's
 * HTTP {@link Client}, which is **an HTTP client of the API (ADR-0002) and never a second write path**; every
 * write is a `POST /v1/scores/:id/ops` that the applier alone applies. It runs on the credentials `sbscore
 * auth login` stored (or `SBSCORE_TOKEN`), against `--url`, exactly like every other verb, so a hosted server
 * judges the token's `read`/`write` scopes and a local server needs none.
 *
 * The transport is newline-delimited JSON-RPC: one message per line on stdin, one per line on stdout. **stdout
 * is the protocol and nothing else** — a stray line there breaks the client — so every diagnostic goes to
 * stderr. A message that is not JSON gets the JSON-RPC parse error back on stdout and the loop carries on.
 */

export interface McpStdio {
  input: Readable;
  /** One protocol line. The caller appends the newline (`io.out` does). */
  write(line: string): void;
  /** Diagnostics, on stderr. Never the protocol. */
  log(text: string): void;
}

/** The CLI client as an {@link McpBackend}: the API's own errors, carried across as the tools' errors. */
export function clientBackend(client: Client): McpBackend {
  async function carried<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof CliError) {
        throw new McpToolError(error.kind, error.message, {
          ...(error.detail === undefined ? {} : { detail: error.detail }),
          ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
          ...(error.operation === undefined ? {} : { operation: error.operation }),
        });
      }
      throw error;
    }
  }
  return {
    list: () => carried(() => client.list()),
    read: (id) => carried(() => client.read(id)),
    create: (operations) => carried(() => client.create(operations as Operation[])),
    apply: (id, operations, expectedVersion) => carried(() => client.apply(id, operations as Operation[], expectedVersion)),
    undo: (id, expectedVersion) => carried(() => client.undo(id, expectedVersion)),
    redo: (id, expectedVersion) => carried(() => client.redo(id, expectedVersion)),
    exportScore: (id, choices) =>
      carried(async () => {
        const { bytes, filename, contentType } = await client.exportScore(id, choices);
        return { bytes, filename, contentType };
      }),
  };
}

export async function mcp(client: Client, stdio: McpStdio): Promise<ExitCode> {
  const backend = clientBackend(client);
  const session = {
    backend,
    // The server decides what this credential may do and says so in the tool's own error; nothing is
    // pre-judged here, so a hosted refusal and a local success both arrive as the API gave them.
    can: () => true,
    onUnexpected: (error: unknown) => stdio.log(`sbscore mcp: a tool failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`),
  };

  // Sequential, so replies leave in the order requests arrived. A tool call is a round trip to the API.
  for await (const line of createInterface({ input: stdio.input, crlfDelay: Infinity })) {
    if (line.trim() === '') continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      stdio.write(JSON.stringify(PARSE_FAILURE));
      continue;
    }
    const answer = await handleMcpMessage(message, session);
    if (answer !== null) stdio.write(JSON.stringify(answer));
  }
  return EXIT.ok;
}
