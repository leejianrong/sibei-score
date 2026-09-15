/**
 * `@sibei/synth` — the pure core: seeded score generation, ground-truth labels, and OMR-accuracy
 * metrics. Everything reachable from here is framework- and Node-free, so it is safe for the fast
 * test layer (no native binding is loaded by importing this barrel).
 *
 * The imaging half — rendering a score to a raster image and degrading it — needs native bindings
 * (`@resvg/resvg-js`, `sharp`) and lives behind the separate `@sibei/synth/imaging` entry so this
 * one stays pure. See ADR-0031 for why the package as a whole is the deliberate exception to the
 * "no Node APIs" rule, and `tests/arch` for the guard that keeps it out of every product bundle.
 */

export * from './rng.js';
export * from './generate.js';
export * from './labels.js';
export * from './metrics.js';
export * from './vocab.js';
export * from './systems.js';
