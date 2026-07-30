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

/** The four packages PLAN.md names. Those not yet built are skipped, not assumed. */
const FRAMEWORK_FREE = ['model', 'music', 'layout', 'codec'];

/** Present in the repo but framework- or platform-bound by design. */
const ALLOWED_TO_BE_IMPURE = ['draw', 'pdf', 'api', 'cli', 'ui'];

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
  const drawFiles = sourceFiles(join(REPO, 'packages/draw/src'));

  it('keeps VexFlow out of layout entirely (ADR-0014)', () => {
    const offenders = layoutFiles.filter((file) => /vexflow|\bVex\b|\bVF\./i.test(codeOf(file)));
    expect(offenders).toEqual([]);
  });

  it('keeps layout decisions out of draw: no grid, no pagination, no page spec building', () => {
    // The adapter is handed positions. If it started resolving them it would be
    // deciding layout, which is the one thing ADR-0014 forbids it.
    const offenders = drawFiles.filter((file) =>
      /\b(planSystems|allocateWidths|resolvePageSpec|systemVertical|resolveBarAccidentals)\b/.test(
        codeOf(file),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps Node out of draw, which runs in the browser too', () => {
    const offenders = drawFiles.flatMap((file) =>
      importsOf(file)
        .filter((specifier) => NODE_BUILTINS.has(specifier))
        .map((specifier) => `${file}: ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('has a home for every impure package it declares', () => {
    for (const name of ALLOWED_TO_BE_IMPURE) {
      const path = join(REPO, 'packages', name);
      if (!exists(path)) continue;
      expect(exists(join(path, 'package.json'))).toBe(true);
    }
  });
});
