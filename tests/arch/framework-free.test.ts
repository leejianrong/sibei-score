import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `model`, `music`, `layout` and `codec` import nothing framework-specific and nothing
 * Node-specific, because `layout` and `model` run in the browser as well as on the
 * server (ADR-0005, ADR-0022). PLAN.md asks for this to be asserted rather than left
 * to discipline.
 *
 * Two mechanisms, deliberately. The compiler is the real guard: those packages declare
 * `"types": []` and no DOM lib, so a Node or DOM global will not typecheck. This test
 * covers what the compiler cannot see — the import graph and the declared
 * dependencies — and fails loudly if the tsconfig guard is ever loosened.
 */

const REPO = resolve(import.meta.dirname, '../..');

/**
 * The four packages PLAN.md names, plus `engrave`. Those not yet built are skipped, not
 * assumed.
 *
 * `engrave` is here because it turned out it could be: our own engraver emits SVG markup
 * rather than DOM nodes, so it needs no `document`, no jsdom and no renderer. That is
 * what let the server-side render path drop a headless DOM entirely (ADR-0030), so the
 * same guards that keep `layout` portable now apply to it.
 */
const FRAMEWORK_FREE = ['model', 'music', 'layout', 'codec', 'engrave'];

/** Present in the repo but framework- or platform-bound by design. */
const ALLOWED_TO_BE_IMPURE = ['pdf', 'api', 'cli', 'ui'];

const FRAMEWORK_PACKAGES = [
  'svelte',
  'react',
  'react-dom',
  'vue',
  '@angular/core',
  'vite',
  'vexflow',
  'jsdom',
  'pdfkit',
  'svg-to-pdfkit',
  'better-sqlite3',
  'express',
];

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function sourceFiles(directory: string): string[] {
  if (!exists(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
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

const IMPORT_PATTERN = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? '');
}

/**
 * Code with the comments taken out. The rule is that layout may not *depend* on
 * VexFlow; explaining in a comment why a unit or a field exists is not a dependency,
 * and stripping comments is what keeps the two apart.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function packagesPresent(names: string[]): string[] {
  return names.filter((name) => exists(join(REPO, 'packages', name)));
}

describe('the framework-free core', () => {
  it('covers at least the packages V1 builds', () => {
    expect(packagesPresent(FRAMEWORK_FREE)).toEqual(expect.arrayContaining(['model', 'layout']));
  });

  for (const name of packagesPresent(FRAMEWORK_FREE)) {
    describe(`@sibei/${name}`, () => {
      const files = sourceFiles(join(REPO, 'packages', name, 'src'));

      it('has source to check', () => {
        expect(files.length).toBeGreaterThan(0);
      });

      it('imports no Node builtin', () => {
        const offenders = files.flatMap((file) =>
          importsOf(file)
            .filter((specifier) => NODE_BUILTINS.has(specifier))
            .map((specifier) => `${file}: ${specifier}`),
        );
        expect(offenders).toEqual([]);
      });

      it('imports no framework or platform package', () => {
        const offenders = files.flatMap((file) =>
          importsOf(file)
            .filter((specifier) =>
              FRAMEWORK_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`)),
            )
            .map((specifier) => `${file}: ${specifier}`),
        );
        expect(offenders).toEqual([]);
      });

      it('imports only relative paths and other framework-free packages', () => {
        const permitted = new Set(packagesPresent(FRAMEWORK_FREE).map((n) => `@sibei/${n}`));
        const offenders = files.flatMap((file) =>
          importsOf(file)
            .filter((specifier) => !specifier.startsWith('.') && !permitted.has(specifier))
            .map((specifier) => `${file}: ${specifier}`),
        );
        expect(offenders).toEqual([]);
      });

      it('declares no dependency outside the framework-free set', () => {
        const manifest = JSON.parse(
          readFileSync(join(REPO, 'packages', name, 'package.json'), 'utf8'),
        ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
        const permitted = new Set(packagesPresent(FRAMEWORK_FREE).map((n) => `@sibei/${n}`));
        expect(declared.filter((dep) => !permitted.has(dep))).toEqual([]);
      });

      it('keeps the compiler guard: no ambient types, no DOM lib', () => {
        const tsconfig = JSON.parse(
          readFileSync(join(REPO, 'packages', name, 'tsconfig.json'), 'utf8'),
        ) as { compilerOptions?: { types?: string[]; lib?: string[] } };
        expect(tsconfig.compilerOptions?.types).toEqual([]);
        expect(tsconfig.compilerOptions?.lib).toBeDefined();
        expect(tsconfig.compilerOptions?.lib?.map((l) => l.toLowerCase())).not.toContain('dom');
      });
    });
  }
});

describe('the draw seam', () => {
  const layoutFiles = sourceFiles(join(REPO, 'packages/layout/src'));
  const engraveFiles = sourceFiles(join(REPO, 'packages/engrave/src'));

  it('has an adapter to check', () => {
    expect(engraveFiles.length).toBeGreaterThan(0);
  });

  it('keeps a renderer out of layout entirely (ADR-0014)', () => {
    const offenders = layoutFiles.filter((file) => /vexflow|\bVex\b|\bVF\./i.test(codeOf(file)));
    expect(offenders).toEqual([]);
  });

  it('keeps layout decisions out of the adapter: no grid, no pagination, no page spec', () => {
    // The adapter is handed positions. If it started resolving them it would be
    // deciding layout, which is the one thing ADR-0014 forbids it.
    const offenders = engraveFiles.filter((file) =>
      /\b(planSystems|allocateWidths|resolvePageSpec|systemVertical|resolveBarAccidentals)\b/.test(
        codeOf(file),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps VexFlow out of the tree entirely (ADR-0030)', () => {
    // It was pinned to a dead branch behind the seam and is now gone. The seam is what
    // made both true, and this is what keeps it from creeping back.
    const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared.filter((dep) => dep.includes('vexflow'))).toEqual([]);
    expect(exists(join(REPO, 'packages/draw'))).toBe(false);

    const offenders = engraveFiles.filter((file) => /vexflow|\bVex\b|\bVF\./i.test(codeOf(file)));
    expect(offenders).toEqual([]);
  });

  it('keeps text measurement out of the adapter (ADR-0015)', () => {
    // `measureText` and `getBBox` only exist in a real browser, so using either would
    // put text in one place on screen and another in print.
    const offenders = engraveFiles.filter((file) => /\b(measureText|getBBox)\b/.test(codeOf(file)));
    expect(offenders).toEqual([]);
  });

  it('keeps a DOM off the server render path, which the engraver is what allows', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'packages/pdf/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared.filter((dep) => dep.includes('jsdom'))).toEqual([]);
  });

  it('has a home for every impure package it declares', () => {
    for (const name of ALLOWED_TO_BE_IMPURE) {
      const path = join(REPO, 'packages', name);
      if (!exists(path)) continue;
      expect(exists(join(path, 'package.json'))).toBe(true);
    }
  });
});
