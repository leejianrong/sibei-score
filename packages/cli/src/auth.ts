import { CliError, createClient } from './client.js';
import type { Client } from './client.js';
import { loadCredential, removeCredential, saveCredential } from './credentials.js';
import type { TokenSource } from './credentials.js';
import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';
import type { Flags } from './args.js';
import type { Io } from './commands.js';

/**
 * `sbscore auth login|logout|status|token` (V21b, ADR-0034 decision 4): the CLI's half of the device flow
 * the server gained in V21a.
 *
 * **The CLI never sees a password, a session cookie or one of GitHub's tokens.** `login` asks our server to
 * start an authorisation, prints a short code and where to type it, and polls. The person approves in a
 * browser they are already signed in to, and the CLI receives a token *we* minted. Like every other verb
 * this is an HTTP client of the API and holds no store (ADR-0002).
 *
 * **A token is printed by exactly one verb, `auth token`,** which exists so `$(sbscore auth token)` is a
 * token and nothing else. `login`, `status` and every error leave it out, in both output modes, so a
 * credential does not end up in a terminal recording or a CI log by being displayed on the way past.
 *
 * What the browser decides, not the CLI: the token's name and scopes are chosen where the code is
 * approved, because that is the step where a human says yes to something specific.
 */

export interface AuthContext {
  baseUrl: string;
  credentialsPath: string;
  io: Io;
  json: boolean;
  /** The client for this server, carrying whatever token resolved (none if signed out). */
  client: Client;
  /** What the environment or the file supplied for this server, if anything. */
  resolved: { token: string; source: TokenSource } | undefined;
  sleep: (ms: number) => Promise<void>;
  readStdin: () => Promise<string>;
  now: () => Date;
}

/** The poll's backoff step when the server says slow down (RFC 8628 §3.5). */
const SLOW_DOWN_MS = 5_000;

export async function auth(flags: Flags, context: AuthContext): Promise<ExitCode> {
  const action = flags.positional[1] ?? '';
  switch (action) {
    case 'login':
      return login(flags, context);
    case 'logout':
      return logout(context);
    case 'status':
      return status(context);
    case 'token':
      return token(context);
    default:
      throw new CliError(
        EXIT.usage,
        'usage',
        `auth needs one of: login, logout, status, token (got ${JSON.stringify(action)}). Try --help.`,
      );
  }
}

const emit = (context: AuthContext, human: string, data: unknown): void =>
  context.io.out(context.json ? JSON.stringify(data) : human);

function notHosted(baseUrl: string): CliError {
  return new CliError(
    EXIT.usage,
    'not-hosted',
    `${baseUrl} is a local server: it has no accounts, so there is nothing to sign in to. Sign in to a hosted ` +
      `deployment with --url or SBSCORE_URL.`,
  );
}

async function login(flags: Flags, context: AuthContext): Promise<ExitCode> {
  const { baseUrl } = context;

  if (flags.switches.has('token-stdin') || flags.options.has('token')) {
    const given = flags.options.get('token');
    if (given !== undefined) {
      // Not refused: the ADR names `login --token` as the headless fallback. But an argument lands in shell
      // history and in `ps`, which a pipe does not, and a person should know before they paste one.
      context.io.err(
        'sbscore: --token leaves the token in your shell history and process list; prefer --token-stdin or SBSCORE_TOKEN.',
      );
    }
    const token = (given ?? (await context.readStdin())).trim();
    if (token === '') throw new CliError(EXIT.usage, 'usage', 'auth login --token needs a token; none was given');
    return keepToken(context, token);
  }

  const anonymous = createClient(baseUrl);
  await requireHosted(anonymous, baseUrl);

  const device = await anonymous.startDevice();
  const minutes = Math.round(device.expiresIn / 60);
  if (context.json) {
    context.io.out(
      JSON.stringify({
        event: 'device',
        url: baseUrl,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        expiresIn: device.expiresIn,
        interval: device.interval,
      }),
    );
  } else {
    context.io.out(
      [
        `To sign in to ${baseUrl}, open:`,
        `  ${device.verificationUri}`,
        `and enter this code:  ${device.userCode}`,
        `Waiting for approval (the code expires in ${minutes} minutes)...`,
      ].join('\n'),
    );
  }

  let interval = device.interval * 1000;
  for (;;) {
    await context.sleep(interval);
    let polled;
    try {
      polled = await anonymous.pollDevice(device.deviceCode);
    } catch (error) {
      if (error instanceof CliError && error.kind === 'expired-code') {
        throw new CliError(
          error.code,
          error.kind,
          'the code expired before it was approved. Run `sbscore auth login` again.',
        );
      }
      throw error;
    }
    if (polled.status === 'pending') continue;
    if (polled.status === 'slow-down') {
      interval += SLOW_DOWN_MS;
      continue;
    }
    return keepToken(context, polled.accessToken, {
      tokenId: polled.tokenId,
      scopes: polled.scopes,
      expiresAt: polled.expiresAt,
    });
  }
}

/** Learn the server is hosted without a credential: a hosted server answers `/v1/me` with 401, a local one with 200. */
async function requireHosted(client: Client, baseUrl: string): Promise<void> {
  try {
    if ((await client.me()).mode === 'local') throw notHosted(baseUrl);
  } catch (error) {
    if (error instanceof CliError && error.kind === 'unauthenticated') return;
    throw error;
  }
}

/** Verify a token against the server, then keep it. Nothing is stored for a token the server will not accept. */
async function keepToken(
  context: AuthContext,
  token: string,
  extra: { tokenId?: string; scopes?: readonly string[]; expiresAt?: string } = {},
): Promise<ExitCode> {
  const { baseUrl } = context;
  const me = await createClient(baseUrl, { token }).me();
  if (me.mode === 'local' || me.user === undefined) throw notHosted(baseUrl);

  saveCredential(context.credentialsPath, baseUrl, {
    token,
    ...(extra.tokenId === undefined ? {} : { tokenId: extra.tokenId }),
    ...(extra.scopes === undefined ? {} : { scopes: extra.scopes }),
    ...(extra.expiresAt === undefined ? {} : { expiresAt: extra.expiresAt }),
    savedAt: context.now().toISOString(),
  });

  const who = me.user.name === null || me.user.name === '' ? me.user.login : `${me.user.login} (${me.user.name})`;
  const detail = [
    extra.scopes === undefined ? undefined : `scopes ${extra.scopes.join(', ')}`,
    extra.expiresAt === undefined ? undefined : `expires ${extra.expiresAt.slice(0, 10)}`,
  ].filter((part): part is string => part !== undefined);
  emit(
    context,
    `Signed in to ${baseUrl} as ${who}${detail.length === 0 ? '' : ` (${detail.join('; ')})`}.\n` +
      `Credential saved to ${context.credentialsPath}.`,
    {
      event: 'signed-in',
      url: baseUrl,
      user: me.user,
      ...(extra.scopes === undefined ? {} : { scopes: extra.scopes }),
      ...(extra.expiresAt === undefined ? {} : { expiresAt: extra.expiresAt }),
      credentials: context.credentialsPath,
    },
  );
  return EXIT.ok;
}

function logout(context: AuthContext): ExitCode {
  const { baseUrl } = context;
  const removed = removeCredential(context.credentialsPath, baseUrl);
  if (!removed) {
    const note =
      context.resolved?.source === 'SBSCORE_TOKEN'
        ? ' SBSCORE_TOKEN is set in this environment; unset it to stop using that credential.'
        : '';
    emit(context, `Not signed in to ${baseUrl}; nothing to do.${note}`, { event: 'signed-out', url: baseUrl, removed: false });
    return EXIT.ok;
  }
  emit(
    context,
    `Signed out of ${baseUrl}. The credential is forgotten here, but the token itself stays valid until you ` +
      `revoke it in the browser (Account, API tokens).`,
    { event: 'signed-out', url: baseUrl, removed: true },
  );
  return EXIT.ok;
}

async function status(context: AuthContext): Promise<ExitCode> {
  const { baseUrl, resolved } = context;
  let me;
  try {
    me = await context.client.me();
  } catch (error) {
    if (!(error instanceof CliError) || error.kind !== 'unauthenticated') throw error;
    // Hosted, and either no credential or one the server will not take. Both are "not signed in"; they
    // differ in what to say, because only one of them is something a person did.
    const rejected = resolved !== undefined;
    emit(
      context,
      rejected
        ? `The credential for ${baseUrl} was refused (revoked or expired). Run \`sbscore auth login\`.`
        : `Not signed in to ${baseUrl}. Run \`sbscore auth login\`.`,
      { url: baseUrl, mode: 'hosted', signedIn: false, ...(rejected ? { rejected: true } : {}) },
    );
    return EXIT.refused;
  }

  if (me.mode === 'local' || me.user === undefined) {
    emit(context, `${baseUrl} is a local server: there is no sign-in.`, { url: baseUrl, mode: 'local', signedIn: false });
    return EXIT.ok;
  }

  const credential = resolved?.source === 'file' ? loadCredential(context.credentialsPath, baseUrl) : undefined;
  const who = me.user.name === null || me.user.name === '' ? me.user.login : `${me.user.login} (${me.user.name})`;
  const expires = credential?.expiresAt;
  emit(
    context,
    `Signed in to ${baseUrl} as ${who}.\n` +
      `Credential from ${resolved?.source === 'SBSCORE_TOKEN' ? 'SBSCORE_TOKEN' : context.credentialsPath}` +
      `${expires === undefined ? '' : `; expires ${expires.slice(0, 10)}`}.`,
    {
      url: baseUrl,
      mode: 'hosted',
      signedIn: true,
      source: resolved?.source,
      user: me.user,
      ...(credential?.scopes === undefined ? {} : { scopes: credential.scopes }),
      ...(expires === undefined ? {} : { expiresAt: expires }),
    },
  );
  return EXIT.ok;
}

function token(context: AuthContext): ExitCode {
  if (context.resolved === undefined) {
    throw new CliError(
      EXIT.refused,
      'not-signed-in',
      `not signed in to ${context.baseUrl}. Run \`sbscore auth login\`, or set SBSCORE_TOKEN.`,
    );
  }
  // The one place a token is printed, and bare: no label, no JSON wrapper, nothing to strip.
  context.io.out(context.resolved.token);
  return EXIT.ok;
}
