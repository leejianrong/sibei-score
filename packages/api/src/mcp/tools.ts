import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';
import { EXPORT_FONTS, EXPORT_FORMATS, EXPORT_INSTRUMENTS, EXPORT_PAPERS } from '../export/export.js';
import { OPERATION_TYPES } from '../ops/operations.js';

/**
 * The MCP tools (V22a/V22b, ADR-0034 decision 5), defined **once** and run over two backends: the server's
 * own (`mcp/backend.ts`, straight onto the applier, reader and exporter, for `/mcp`) and the CLI's HTTP
 * client (`sbscore mcp`, over stdio). Because both reach this file, "the same tool results as `/mcp`" is a
 * property of the code and not a promise: the arguments, the shaping of a result and the shape of a failure
 * cannot drift between the two.
 *
 * **A tool result is the API's own structured response or error** (ADR-0008), not a rewrite of it. A
 * success carries the JSON the matching `/v1/` route answers; a failure carries `{ error: { kind, message,
 * detail?, currentVersion?, operation? } }` verbatim, so an agent branches on `kind` and re-reads at
 * `currentVersion` after a stale write exactly as a CLI caller would. The one thing a tool adds is a
 * readable form: `read_score` answers the text projection (ADR-0009), which prints the addresses a write
 * accepts, so reading teaches the agent how to write.
 *
 * Nothing here writes. A tool reaches a score only through the {@link McpBackend} it is given, and the
 * server's backend is a thin wrapper over the applier, the only writer (ADR-0003).
 */

/** A failure as the API reports it. The `/v1/` problem body's `error` object, field for field. */
export class McpToolError extends Error {
  readonly kind: string;
  readonly detail: unknown;
  readonly currentVersion: number | undefined;
  readonly operation: number | undefined;

  constructor(kind: string, message: string, extra: { detail?: unknown; currentVersion?: number; operation?: number } = {}) {
    super(message);
    this.name = 'McpToolError';
    this.kind = kind;
    this.detail = extra.detail;
    this.currentVersion = extra.currentVersion;
    this.operation = extra.operation;
  }
}

export interface ExportedArtefact {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

export interface ExportChoices {
  format?: string;
  instrument?: string;
  paper?: string;
  font?: string;
}

/**
 * What a tool needs from a library, whoever hosts it. Every method throws {@link McpToolError} for a failure
 * the API would report, and returns the API's own JSON for a success. `unknown` for the wire shapes, on
 * purpose: both hosts hand back what their transport already decoded, and a tool only forwards it.
 */
export interface McpBackend {
  list(): Promise<unknown>;
  read(id: string): Promise<{ score: Score; version: number; updatedAt: string }>;
  /** Apply a create batch (its first operation is `score.create`). */
  create(operations: readonly unknown[]): Promise<unknown>;
  apply(id: string, operations: readonly unknown[], expectedVersion: number): Promise<unknown>;
  undo(id: string, expectedVersion: number): Promise<unknown>;
  redo(id: string, expectedVersion: number): Promise<unknown>;
  exportScore(id: string, choices: ExportChoices): Promise<ExportedArtefact>;
}

export type ToolAccess = 'read' | 'write';

export interface McpContent {
  type: 'text' | 'resource';
  text?: string;
  resource?: { uri: string; mimeType: string; blob?: string; text?: string };
}

export interface ToolResult {
  content: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** What a caller needs to be allowed to do to run it. */
  access: ToolAccess;
  run(backend: McpBackend, args: Record<string, unknown>): Promise<ToolResult>;
}

/** An argument the tool cannot run without. The API's own `validation` kind, so it is branchable like the rest. */
function invalid(message: string): McpToolError {
  return new McpToolError('validation', message);
}

function text(args: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw invalid(`\`${key}\` is required`);
    return undefined;
  }
  if (typeof value !== 'string' || (required && value === '')) throw invalid(`\`${key}\` must be a${required ? ' non-empty' : ''} string`);
  return value;
}

function whole(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid(`\`${key}\` is required: the score version you last read (every write carries one, ADR-0003)`);
  }
  return value;
}

function operations(args: Record<string, unknown>): unknown[] {
  const value = args.operations;
  if (!Array.isArray(value) || value.length === 0) throw invalid('`operations` must be a non-empty list');
  return value;
}

function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

const OPERATIONS_SCHEMA = {
  type: 'array',
  minItems: 1,
  description:
    'The operations to apply, in order, as one all-or-nothing batch (one undo undoes the batch). ' +
    'Each is `{ type, target?, payload? }`. `target` is an address printed by read_score: `bar3.beat2` a beat ' +
    '(where note.add and chord.set land; a beat with nothing on it is refused, listing the real onsets), `bar3.n2` ' +
    'the second item of bar 3, `note-17` a stable id, and a bare `bar3` for the whole-bar operations (section, barline, ending).',
  items: {
    type: 'object',
    required: ['type'],
    properties: {
      type: { type: 'string', enum: [...OPERATION_TYPES] },
      target: { type: 'string', description: 'An address from read_score, e.g. bar3, bar3.n2, bar3.beat3.' },
      payload: {
        type: 'object',
        description:
          'The operation\'s fields, e.g. { "text": "Cmaj7" } for chord.set, ' +
          '{ "pitch": "Eb5", "duration": { "value": 4, "dots": 0 } } for note.add (value 1, 2, 4, 8, 16 or 32).',
      },
    },
  },
} as const;

const ID = { type: 'string', description: 'The score id, as list_scores prints it.' } as const;
const EXPECTED = {
  type: 'integer',
  minimum: 0,
  description:
    'The score version you last read. A write on a stale version is refused with kind "stale-version" and ' +
    '`currentVersion`: re-read, then retry at that version.',
} as const;

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'list_scores',
    description: 'List your charts: id, version, key, title and composer of each.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    access: 'read',
    async run(backend) {
      return json(await backend.list());
    },
  },
  {
    name: 'read_score',
    description:
      'Read a chart. The default `projection` is a compact text view (bars four to a row, chords above the notes, ' +
      'review flags) that prints the addresses write tools accept, and the version to pass back as expectedVersion. ' +
      'Use format "json" for the full structured document when the projection leaves something out.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: ID, format: { type: 'string', enum: ['projection', 'json'], default: 'projection' } },
      additionalProperties: false,
    },
    access: 'read',
    async run(backend, args) {
      const record = await backend.read(text(args, 'id', true)!);
      const format = text(args, 'format', false) ?? 'projection';
      if (format === 'json') return json(record);
      if (format !== 'projection') throw invalid('`format` must be "projection" or "json"');
      const projection = projectScore(record.score);
      return {
        content: [{ type: 'text', text: `${projection}\n\nversion: ${record.version}` }],
        structuredContent: { version: record.version, updatedAt: record.updatedAt, projection },
      };
    },
  },
  {
    name: 'create_score',
    description:
      'Create a chart. `operations` is a batch whose first operation is `score.create`, e.g. ' +
      '{ "type": "score.create", "payload": { "id": "autumn-leaves", "title": "Autumn Leaves", "barCount": 32 } }, ' +
      'optionally followed by more operations. Answers the new id and its version.',
    inputSchema: { type: 'object', required: ['operations'], properties: { operations: OPERATIONS_SCHEMA }, additionalProperties: false },
    access: 'write',
    async run(backend, args) {
      return json(await backend.create(operations(args)));
    },
  },
  {
    name: 'edit_score',
    description:
      'Edit a chart with a batch of operations, atomically, at the version you read. Answers the new version and ' +
      'what changed. A failure names the operation (`operation`, 1-based) and why, with the real data to correct it ' +
      '(an address miss lists the bar\'s actual onsets).',
    inputSchema: {
      type: 'object',
      required: ['id', 'expectedVersion', 'operations'],
      properties: { id: ID, expectedVersion: EXPECTED, operations: OPERATIONS_SCHEMA },
      additionalProperties: false,
    },
    access: 'write',
    async run(backend, args) {
      return json(await backend.apply(text(args, 'id', true)!, operations(args), whole(args, 'expectedVersion')));
    },
  },
  {
    name: 'undo',
    description: 'Undo the last batch on a chart. Idempotent at the start of history (`moved: false`).',
    inputSchema: { type: 'object', required: ['id', 'expectedVersion'], properties: { id: ID, expectedVersion: EXPECTED }, additionalProperties: false },
    access: 'write',
    async run(backend, args) {
      return json(await backend.undo(text(args, 'id', true)!, whole(args, 'expectedVersion')));
    },
  },
  {
    name: 'redo',
    description: 'Redo the last undone batch on a chart. Idempotent past the end of history (`moved: false`).',
    inputSchema: { type: 'object', required: ['id', 'expectedVersion'], properties: { id: ID, expectedVersion: EXPECTED }, additionalProperties: false },
    access: 'write',
    async run(backend, args) {
      return json(await backend.redo(text(args, 'id', true)!, whole(args, 'expectedVersion')));
    },
  },
  {
    name: 'export_score',
    description:
      'Export a chart as a printable PDF (the engraved lead sheet) or as MusicXML. `instrument` renders a transposing ' +
      'part instead of the concert score. A PDF comes back as an embedded resource.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: ID,
        format: { type: 'string', enum: EXPORT_FORMATS.filter((format) => format !== 'svg'), default: 'pdf' },
        instrument: { type: 'string', enum: [...EXPORT_INSTRUMENTS], default: 'concert' },
        paper: { type: 'string', enum: [...EXPORT_PAPERS] },
        font: { type: 'string', enum: [...EXPORT_FONTS] },
      },
      additionalProperties: false,
    },
    access: 'read',
    async run(backend, args) {
      const id = text(args, 'id', true)!;
      const choices: ExportChoices = {};
      for (const key of ['format', 'instrument', 'paper', 'font'] as const) {
        const value = text(args, key, false);
        if (value !== undefined) choices[key] = value;
      }
      const artefact = await backend.exportScore(id, choices);
      const summary = { filename: artefact.filename, contentType: artefact.contentType, bytes: artefact.bytes.length };
      const uri = `sibei://scores/${encodeURIComponent(id)}/${encodeURIComponent(artefact.filename)}`;
      const body = Buffer.from(artefact.bytes);
      const isText = artefact.contentType.includes('xml');
      return {
        content: [
          { type: 'text', text: JSON.stringify(summary) },
          {
            type: 'resource',
            resource: isText
              ? { uri, mimeType: artefact.contentType, text: body.toString('utf8') }
              : { uri, mimeType: artefact.contentType, blob: body.toString('base64') },
          },
        ],
        structuredContent: summary,
      };
    },
  },
];

/** A failure as a tool result: the API's error object, verbatim, flagged as an error. */
export function failureResult(error: McpToolError): ToolResult {
  const body = {
    error: {
      kind: error.kind,
      message: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
      ...(error.operation === undefined ? {} : { operation: error.operation }),
    },
  };
  return { ...json(body), isError: true };
}
