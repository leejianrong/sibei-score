import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The HTTP boundary, asserted structurally (ADR-0029, ADR-0001).
 *
 * `tests/store/api.test.ts` drives the guards over a real socket, which is where the behaviour
 * lives. These are the claims a request cannot demonstrate: that there is no *other* way to bind,
 * that a route handler cannot reach a write path, and that nothing in the tree is quietly holding a
 * wildcard CORS header waiting to be switched on.
 */

const REPO = resolve(import.meta.dirname, '../..');

const ROUTES = 'packages/api/src/http/routes.ts';
const SERVER = 'packages/api/src/http/server.ts';

function sourceFiles(directory: string): string[] {
  if (!exists(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function productFiles(): string[] {
  return [...sourceFiles(join(REPO, 'packages')), ...sourceFiles(join(REPO, 'scripts'))].map((file) =>
    relative(REPO, file),
  );
}

describe('the bind address (ADR-0029)', () => {
  it('is loopback wherever it appears, and 0.0.0.0 appears nowhere', () => {
    // A compose file's default would expose the port on the host's network, so this is the check
    // that has to survive the arrival of a compose file in V8.
    const offenders = productFiles().filter((file) => /0\.0\.0\.0/.test(codeOf(join(REPO, file))));
    expect(offenders).toEqual([]);
  });

  it('is not a parameter of listen, so nobody can pass the wrong one', () => {
    const server = codeOf(join(REPO, SERVER));
    expect(server).toMatch(/server\.listen\(port, LOOPBACK/);
    // `listen(port: number)` and nothing else. A host argument is the whole risk.
    expect(server).toMatch(/listen\(port: number\): Promise/);
    expect(server).not.toMatch(/listen\([^)]*host/);
  });
});

describe('no wildcard CORS (ADR-0029)', () => {
  it('sets no access-control header anywhere in the tree', () => {
    const offenders = productFiles().filter((file) =>
      /access-control-allow/i.test(codeOf(join(REPO, file))),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the routes cannot write (ADR-0003)', () => {
  it('has the files it claims to have', () => {
    for (const file of [ROUTES, SERVER]) expect(exists(join(REPO, file))).toBe(true);
  });

  it('hands the route handlers a reader and a library, and no writer', () => {
    // The narrowing is the mechanism: `server.ts` is the only file holding the whole store, and the
    // routes are typed to see halves that cannot write. So the single write path survives the
    // arrival of an HTTP layer without anybody having to remember it.
    const routes = codeOf(join(REPO, ROUTES));
    expect(routes).toMatch(/reader: ScoreReader/);
    expect(routes).toMatch(/library: ScoreLibrary/);
    expect(routes).not.toMatch(/\bScoreWriter\b/);
    expect(routes).not.toMatch(/\bScoreStore\b/);
  });

  it('runs the guards before routing, so an unrouted path is not a way past them', () => {
    const server = codeOf(join(REPO, SERVER));
    const guardAt = server.indexOf('checkHost(request)');
    const routeAt = server.indexOf('await route(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(routeAt).toBeGreaterThan(guardAt);
  });
});

describe('the hosting-shaped constraint (ADR-0001)', () => {
  it('takes no filesystem path in a route and returns none', () => {
    // Scores are addressed by id. Nothing in the HTTP layer reads or writes a file, which is what
    // makes "hosting is a deployment change" true of the API surface as well as the store.
    const http = productFiles().filter((file) => file.startsWith('packages/api/src/http/'));
    expect(http.length).toBeGreaterThan(0);
    for (const file of http) {
      const code = codeOf(join(REPO, file));
      expect(code).not.toMatch(/from 'node:fs'|from 'node:path'|readFileSync|writeFileSync/);
    }
  });
});

describe('the logs (ADR-0029)', () => {
  it('have no field a file path or a body could go in', () => {
    // The rule for later is that no image bytes and no file paths reach a log. The cheapest way to
    // keep that true is for the line to have nowhere to put them.
    const log = codeOf(join(REPO, 'packages/api/src/http/log.ts'));
    const line = /interface RequestLine \{[^}]*\}/.exec(log)?.[0] ?? '';
    expect(line).toBeTruthy();
    expect(line).toMatch(/method|path|status|durationMs/);
    expect(line).not.toMatch(/\bbody\b|\bfilename\b|\bpath: string\[\]|\bheaders\b/);
  });

  it('log an error’s message and not its innards, since a store error carries the db path', () => {
    const log = codeOf(join(REPO, 'packages/api/src/http/log.ts'));
    expect(log).toMatch(/cause instanceof Error \? cause\.message : undefined/);
    expect(log).not.toMatch(/\.stack\b/);
  });
});
