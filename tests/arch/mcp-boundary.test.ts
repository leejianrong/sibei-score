import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The MCP endpoint is not a second write path (V22a, ADR-0003, ADR-0034 decision 5).
 *
 * `/mcp` runs its tools onto the same narrowed services the `/v1/` routes get — a `ScoreReader`, the
 * `Applier`, an `Exporter` — and nothing wider. So, like `routes.ts`, no file under `mcp/` may name the
 * whole store, the writer, the identity port or a database driver: a file that cannot name the type cannot
 * have been handed one, which is stronger than checking what it does with it.
 */

const REPO = resolve(import.meta.dirname, '../..');
const MCP = join(REPO, 'packages/api/src/mcp');

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const files = readdirSync(MCP).filter((name) => name.endsWith('.ts'));

describe('the MCP endpoint goes through the applier', () => {
  it('has the files it claims to have', () => {
    expect([...files].sort()).toEqual(['backend.ts', 'endpoint.ts', 'protocol.ts', 'tools.ts']);
  });

  it.each(files)('%s names no store, no writer, no identity port and no driver', (name) => {
    const code = codeOf(join(MCP, name));
    expect(code).not.toMatch(/\bScoreWriter\b|\bScoreStore\b|\bScoreLibrary\b|\bAuthStore\b|\bJobStore\b|better-sqlite3|\bpg\b/);
  });

  it("writes only by calling the applier, with the principal's owner", () => {
    const backend = codeOf(join(MCP, 'backend.ts'));
    expect(backend).toMatch(/applier\.apply\(owner, null,/);
    expect(backend).toMatch(/applier\.apply\(owner, id,/);
    expect(backend).toMatch(/applier\.undo\(owner, id,/);
    expect(backend).toMatch(/applier\.redo\(owner, id,/);
    // The reader is only ever asked as that owner, so a tool has no argument that names another.
    for (const call of backend.match(/reader\.\w+\([^)]*\)/g) ?? []) expect(call).toMatch(/\(owner\b/);
    for (const call of backend.match(/exporter\.\w+\([^)]*\)/g) ?? []) expect(call).toMatch(/\(owner,/);
  });

  it('keeps tools transport-free, so the stdio wrapper runs the very same ones', () => {
    for (const name of ['tools.ts', 'protocol.ts']) {
      expect(codeOf(join(MCP, name))).not.toMatch(/node:http|IncomingMessage|ServerResponse/);
    }
  });

  it('takes a bearer token only: the endpoint never reads a session cookie', () => {
    const endpoint = codeOf(join(MCP, 'endpoint.ts'));
    expect(endpoint).not.toMatch(/cookie/i);
    expect(endpoint).toMatch(/headers\.authorization/);
  });
});
