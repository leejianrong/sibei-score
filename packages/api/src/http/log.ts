/**
 * Structured logs. CLAUDE.md listed a health endpoint and these as due "when there is a server",
 * and now there is one.
 *
 * Deliberately narrow. ADR-0029's rule for later is that **no image bytes and no file paths** reach
 * a log, and the cheapest way to keep that true is for the log line to have no field they could go
 * in. There are no secrets in the MVP so none can leak; this is about not building the habit that
 * would leak them once there are.
 */

export interface RequestLine {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export interface Logger {
  request(line: RequestLine): void;
  error(message: string, cause?: unknown): void;
}

/** JSON per line, on stderr, so stdout stays clean for anything that wants to pipe it. */
export const consoleLogger: Logger = {
  request(line) {
    process.stderr.write(`${JSON.stringify({ level: 'info', ...line })}\n`);
  },
  error(message, cause) {
    // The message, not the stack, and never the cause's own fields: an error out of the store can
    // carry the database path in it.
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        message,
        cause: cause instanceof Error ? cause.message : undefined,
      })}\n`,
    );
  },
};

/** For tests and for a CLI that should say nothing. */
export const silentLogger: Logger = { request() {}, error() {} };
