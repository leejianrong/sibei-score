import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAssets, resolveUiDirectory } from '@sibei/cli';
import { parseFlags } from '@sibei/cli';

/**
 * The filesystem behind the API's `AssetSource` port (V8g).
 *
 * Real temp directories throughout: the thing under test is reading a built bundle off disk, and a
 * stubbed filesystem would only assert against the stub. The *routing* over these bytes lives in
 * `tests/api/static-assets.ts`; this file is the reader and the `--ui` resolution.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sbscore-ui-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a file under the bundle, creating parent directories the way a build's nesting needs. */
function put(relative: string, contents: string): void {
  const path = join(dir, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

describe('loadAssets', () => {
  const textOf = (bytes: Uint8Array | undefined): string =>
    bytes === undefined ? '' : new TextDecoder().decode(bytes);

  it('serves a file by its request path, with a leading slash and forward slashes', () => {
    put('index.html', '<!doctype html>');
    put('assets/app.js', 'console.log(1)');
    const assets = loadAssets(dir);

    expect(textOf(assets.asset('/index.html')?.bytes)).toBe('<!doctype html>');
    expect(textOf(assets.asset('/assets/app.js')?.bytes)).toBe('console.log(1)');
  });

  it('serves index.html at /', () => {
    put('index.html', '<!doctype html>');
    const assets = loadAssets(dir);
    expect(assets.asset('/')).toEqual(assets.asset('/index.html'));
  });

  it('returns null for a path with no file, so routing 404s it', () => {
    put('index.html', '<!doctype html>');
    const assets = loadAssets(dir);
    expect(assets.asset('/missing.js')).toBeNull();
    // No SPA fallback: a real path miss is a miss, not the index.
    expect(assets.asset('/library')).toBeNull();
  });

  it('gives each extension its content type, and an unknown one a safe default', () => {
    put('index.html', 'h');
    put('assets/app.js', 'j');
    put('assets/app.css', 'c');
    put('fonts/bravura.woff2', 'f');
    put('logo.svg', 's');
    put('weird.bin', 'b');
    const assets = loadAssets(dir);

    expect(assets.asset('/index.html')?.contentType).toBe('text/html; charset=utf-8');
    expect(assets.asset('/assets/app.js')?.contentType).toBe('text/javascript; charset=utf-8');
    expect(assets.asset('/assets/app.css')?.contentType).toBe('text/css; charset=utf-8');
    expect(assets.asset('/fonts/bravura.woff2')?.contentType).toBe('font/woff2');
    expect(assets.asset('/logo.svg')?.contentType).toBe('image/svg+xml');
    // Not a guessed executable — a download (the responses also carry nosniff).
    expect(assets.asset('/weird.bin')?.contentType).toBe('application/octet-stream');
  });

  it('reads a directory with no index without inventing a / route', () => {
    put('assets/app.js', 'j');
    const assets = loadAssets(dir);
    expect(assets.asset('/')).toBeNull();
    expect(assets.asset('/assets/app.js')).not.toBeNull();
  });
});

describe('resolveUiDirectory', () => {
  const flagsFor = (...argv: string[]) => parseFlags(argv);
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.SBSCORE_UI;
    delete process.env.SBSCORE_UI;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SBSCORE_UI;
    else process.env.SBSCORE_UI = savedEnv;
  });

  it('is undefined when neither --ui nor SBSCORE_UI is set (the development default)', () => {
    expect(resolveUiDirectory(flagsFor())).toBeUndefined();
  });

  it('accepts a built bundle directory named by --ui', () => {
    put('index.html', '<!doctype html>');
    expect(resolveUiDirectory(flagsFor('--ui', dir))).toBe(dir);
  });

  it('reads the directory from SBSCORE_UI too', () => {
    put('index.html', '<!doctype html>');
    process.env.SBSCORE_UI = dir;
    expect(resolveUiDirectory(flagsFor())).toBe(dir);
  });

  it('refuses a path that is not a directory, rather than starting a UI-less server', () => {
    expect(() => resolveUiDirectory(flagsFor('--ui', join(dir, 'nowhere')))).toThrow(/not a directory/);
  });

  it('refuses a directory with no index.html — an unbuilt or half-copied bundle', () => {
    put('assets/app.js', 'j');
    expect(() => resolveUiDirectory(flagsFor('--ui', dir))).toThrow(/no index\.html/);
  });
});
