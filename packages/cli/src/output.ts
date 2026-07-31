import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { EXIT } from './exit-codes.js';
import { CliError } from './client.js';

/**
 * Where a downloaded artefact lands.
 *
 * This is small and it is all about one thing: **a filename that came off a socket is not a
 * path.** The server sanitises the download name at the source, because it goes into a
 * `Content-Disposition` header and the stem is the chart's title — but "the server already
 * checked" is exactly the assumption that makes a client the weak half of a pair, and the CLI is
 * the half that turns the name into a write. A name is therefore taken as a *suggestion* and
 * re-derived here, and the directory the user chose is the boundary.
 *
 * Two checks rather than one, deliberately. The allowlist cannot reject anything the real server
 * would send, so it costs nothing; the containment assertion states the actual property, so a
 * future change to the allowlist cannot quietly stop enforcing it.
 */

/**
 * The characters a name may hold. Deliberately narrower than any filesystem's rule: it is exactly
 * what `downloadName` in the export path emits, so a legitimate name always survives it, and
 * everything a path is built out of — a separator, a colon, a NUL, a leading dot — does not.
 */
const SAFE_NAME = /^[A-Za-z0-9 _-]+(?:\.[A-Za-z0-9]+)?$/;

/**
 * The server's suggestion, or the fallback when it is not a plain filename.
 *
 * `basename` first, so a name carrying a directory part is stripped rather than rejected outright;
 * the allowlist then catches everything else, `..` included.
 */
export function safeDownloadName(suggested: string, fallback: string): string {
  const stripped = basename(suggested.replace(/\\/g, '/').trim());
  return SAFE_NAME.test(stripped) ? stripped : fallback;
}

/** A name from a score id, for when the server suggested nothing usable. The id is user text too. */
export function fallbackName(id: string, extension: string): string {
  const stem = id.replace(/[^A-Za-z0-9 _-]+/g, '-').slice(0, 60);
  return `${stem === '' || stem.replace(/-/g, '') === '' ? 'score' : stem}.${extension}`;
}

/**
 * `name` inside `directory`, or a failure. The assertion the allowlist above is a first line of
 * defence for: whatever the name turned out to be, the file it resolves to is under the directory
 * the user chose, or nothing is written.
 */
export function resolveWithin(directory: string, name: string): string {
  const base = resolve(directory);
  const target = resolve(base, name);
  const inside = relative(base, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new CliError(
      EXIT.usage,
      'unsafe-path',
      `refusing to write ${JSON.stringify(name)}: it is not a file inside ${base}`,
    );
  }
  return target;
}

/**
 * The output path for a download.
 *
 * - `--out` naming a file writes exactly there. The user typed a path; it is theirs.
 * - `--out` naming a directory (an existing one, or one written with a trailing separator) puts the
 *   server's suggested name inside it.
 * - no `--out` at all is the same case with the working directory, which is what `sibei export`
 *   with nothing else on the line does — and the help text says so, because a program that writes
 *   a file somewhere the caller has to guess is a program nobody trusts.
 */
export function outputPathFor(options: {
  out: string | undefined;
  suggested: string;
  fallback: string;
  cwd: string;
  isDirectory: (path: string) => boolean;
}): string {
  const { out, cwd } = options;
  const name = safeDownloadName(options.suggested, options.fallback);

  if (out === undefined) return resolveWithin(cwd, name);

  const absolute = resolve(cwd, out);
  const namesADirectory = out.endsWith('/') || out.endsWith(sep) || options.isDirectory(absolute);
  return namesADirectory ? resolveWithin(absolute, name) : absolute;
}
