import { memoryAudioJobStore } from '@sibei/api';
import { audioJobStoreConformance } from '../store/conformance.js';
import type { OpenHarness } from '../store/conformance.js';

/**
 * The in-memory audio-job store against the same contract the SQLite and Postgres adapters answer to
 * (SIB2-137). It is what `createApi` falls back to and what the service tests build on, so it has to be
 * the port and not a lookalike; the contract needs no native binding, so it lives in the fast layer.
 */
const open: OpenHarness = async (options = {}) => {
  const audio = memoryAudioJobStore(options.now === undefined ? {} : { now: options.now });
  return { audio, store: undefined as never, jobs: undefined as never, auth: undefined as never, close: () => audio.close() };
};

audioJobStoreConformance('memory', open);
