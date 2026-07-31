#!/usr/bin/env -S node --experimental-strip-types
import { run } from './commands.js';

/**
 * The entry point. Thin on purpose: `run` returns an exit code rather than calling `process.exit`, so
 * the whole command surface is testable in-process without a subprocess per assertion (ADR-0008's
 * distinct exit codes are still checked through a real subprocess, because that is the contract a
 * caller actually sees).
 */
const code = await run(process.argv.slice(2), {
  io: {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  },
});
process.exit(code);
