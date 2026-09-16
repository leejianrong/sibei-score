/**
 * `@sibei/synth/imaging` — the native half: render a score to a raster page and degrade it into a
 * photographed-looking image. Kept separate from the pure `@sibei/synth` barrel because it loads
 * native bindings (`@resvg/resvg-js`, `sharp`), which the fast test layer forbids (the dlopen trap,
 * KAN-514). Import this only from the infra layer, scripts, or the eval harness.
 */

export * from './rasterize.js';
export * from './fonts.js';
export * from './degrade.js';
export * from './harness.js';
export * from './crops.js';
export * from './band-crops.js';
export * from './detect.js';
export type { RawImage } from './perspective.js';
export { perspectiveWarp } from './perspective.js';
