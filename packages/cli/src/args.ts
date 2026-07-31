import type { Dots, NoteValue } from '@sibei/model';
import { EXIT } from './exit-codes.js';
import { CliError } from './client.js';

/**
 * Argument parsing. Small on purpose — the CLI's job is to turn a verb into an operation and post it,
 * and every decision about whether the operation is *valid* belongs to the server, so that the two
 * surfaces cannot disagree about it (ADR-0002). This file rejects things that are not arguments at
 * all; it does not second-guess a pitch.
 */

export interface Flags {
  positional: string[];
  options: Map<string, string>;
  switches: Set<string>;
}

const SWITCHES = new Set(['json', 'help', 'pickup', 'pdf']);

/**
 * The short forms. There is exactly one, because `-o` for "write it here" is what every program
 * that produces a file spells this way and a caller should not have to look it up. Everything else
 * stays long: a CLI an agent drives is read more often than it is typed.
 */
const SHORT = new Map([['o', 'out']]);

export function parseFlags(argv: readonly string[]): Flags {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const switches = new Set<string>();

  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at] ?? '';
    if (!token.startsWith('--')) {
      const short = token.startsWith('-') ? SHORT.get(token.slice(1)) : undefined;
      if (short === undefined) {
        positional.push(token);
        continue;
      }
      const value = argv[at + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new CliError(EXIT.usage, 'usage', `${token} needs a value`);
      }
      options.set(short, value);
      at += 1;
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      options.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    if (SWITCHES.has(body)) {
      switches.add(body);
      continue;
    }
    const value = argv[at + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliError(EXIT.usage, 'usage', `--${body} needs a value`);
    }
    options.set(body, value);
    at += 1;
  }
  return { positional, options, switches };
}

export function required(flags: Flags, name: string, verb: string): string {
  const value = flags.options.get(name);
  if (value === undefined) throw new CliError(EXIT.usage, 'usage', `${verb} needs --${name}`);
  return value;
}

export function requiredPositional(flags: Flags, at: number, what: string, verb: string): string {
  const value = flags.positional[at];
  if (value === undefined || value === '') {
    throw new CliError(EXIT.usage, 'usage', `${verb} needs ${what}`);
  }
  return value;
}

export function optionalNumber(flags: Flags, name: string): number | undefined {
  const raw = flags.options.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError(EXIT.usage, 'usage', `--${name} takes a whole number, not ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * `--dur 8`, `--dur 4.`, `--dur 2..` — a note value and a dot per dot, the same spelling the text
 * projection prints. Reading a projection is how an agent learns to write a command (ADR-0009), so
 * the two notations had better be the same one.
 */
export function parseDuration(spec: string): { value: NoteValue; dots: Dots } {
  const match = /^(\d+)(\.{0,2})$/.exec(spec.trim());
  if (match === null) {
    throw new CliError(
      EXIT.usage,
      'usage',
      `${JSON.stringify(spec)} is not a duration; write 4, or 4. for a dotted quarter`,
    );
  }
  const [, digits, dots] = match;
  return { value: Number(digits) as NoteValue, dots: (dots ?? '').length as Dots };
}

/**
 * `--port`, which unlike every other number here may be **0**: that asks the OS for a free port, and
 * it is how a test starts a server without picking one and hoping. `optionalNumber` rejected it, which
 * made `serve --port 0` impossible for no reason.
 */
export function optionalPort(flags: Flags, name: string): number | undefined {
  const raw = flags.options.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new CliError(EXIT.usage, 'usage', `--${name} takes a port from 0 to 65535, not ${JSON.stringify(raw)}`);
  }
  return value;
}
