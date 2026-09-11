import { parseOmrDocument } from '@sibei/model';
import type { OmrDocument } from '@sibei/model';
import type { ImageFormat } from './upload.js';

/**
 * The port to the OMR worker (ADR-0005): hand it one image, get back the raw recognised objects.
 *
 * The worker is a separate Python process/container that owns oemer and nothing else — it never
 * touches the store and never becomes a second write path (ADR-0005, ADR-0003). This is the seam the
 * API calls it across. A port, so the API package names no URL and no transport (ADR-0001): the CLI
 * composition root builds the HTTP adapter and injects it, and a test injects a stub that returns a
 * committed fixture without a real oemer run (which needs weights and minutes, V9).
 *
 * **The schema-conformance guard lives here** (ADR-0005: "the worker must conform to the model's
 * JSON schema … needs a schema-conformance test"). Whatever the worker returns is run through
 * `parseOmrDocument` before it is handed back, so malformed worker output fails at the language
 * boundary rather than downstream wearing a type it does not deserve.
 */
export interface WorkerClient {
  /**
   * Recognise one image and return its {@link OmrDocument}. `imagePath` is provenance the worker
   * echoes into `source.imagePath` — a basename, never a host path (ADR-0029). Rejects (throws
   * {@link WorkerError}) when the worker is unreachable, errors, or returns something off-schema;
   * the runner turns that into a failed, retryable job with the message as its diagnostic (Q80).
   */
  recognize(image: Buffer, meta: { imagePath: string; format: ImageFormat }): Promise<OmrDocument>;
}

/** A failed call to the worker. Its `message` becomes a job's diagnostic, so it is written for a human. */
export class WorkerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkerError';
  }
}

export interface HttpWorkerClientOptions {
  /** The worker's base URL, e.g. `http://worker:8000` in compose, `http://127.0.0.1:8000` locally. */
  url: string;
  /**
   * A `fetch`. Defaults to the global one (Node 22). Injected so a test can drive the adapter
   * without a live socket, and so the offline container can be sure nothing here reaches the network
   * except this call to the worker on the private compose network.
   */
  fetch?: typeof fetch;
}

/**
 * The HTTP adapter. It POSTs the raw image bytes to `POST {url}/recognize?name=<basename>` with the
 * content type detected at the upload boundary, and reads back the {@link OmrDocument} JSON.
 *
 * **No timeout.** A CPU-only recognition is ~5.4 minutes (V9, ADR-0025) and content-independent, so
 * a timeout short enough to catch a hung worker would abort every healthy run. The job is
 * asynchronous precisely so a slow call is a progress bar and not a hang (ADR-0001), and a genuinely
 * dead worker fails the fetch (connection refused/reset) rather than hanging — which is the Q80 path
 * this returns as a `WorkerError`.
 */
export function createHttpWorkerClient(options: HttpWorkerClientOptions): WorkerClient {
  const base = options.url.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;

  return {
    async recognize(image, meta) {
      const target = `${base}/recognize?name=${encodeURIComponent(meta.imagePath)}`;
      const contentType = meta.format === 'png' ? 'image/png' : 'image/jpeg';

      let response: Response;
      try {
        response = await doFetch(target, {
          method: 'POST',
          headers: { 'content-type': contentType },
          // A fresh Uint8Array view: undici (Node's fetch) wants a BodyInit, and a Buffer is one, but
          // slicing to an ArrayBuffer view avoids any shared-pool surprises with a reused Buffer.
          body: new Uint8Array(image),
        });
      } catch (error) {
        // Connection refused, reset, DNS failure: the worker is stopped or unreachable (Q80).
        throw new WorkerError(
          `could not reach the OMR worker at ${base}: ${describe(error)}`,
          { cause: error },
        );
      }

      if (!response.ok) {
        const detail = await bodyText(response);
        throw new WorkerError(
          `the OMR worker returned ${response.status} ${response.statusText}${detail}`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new WorkerError('the OMR worker returned a body that is not JSON', { cause: error });
      }

      try {
        // The language-boundary guard (ADR-0005). Throws OmrSchemaError listing every problem.
        return parseOmrDocument(payload);
      } catch (error) {
        throw new WorkerError(`the OMR worker returned an off-schema document: ${describe(error)}`, {
          cause: error,
        });
      }
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A short, safe slice of an error response body for the diagnostic — never the image, never a path. */
async function bodyText(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text === '' ? '' : `: ${text.slice(0, 200)}`;
  } catch {
    return '';
  }
}
