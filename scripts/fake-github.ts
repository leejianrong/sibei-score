import { startFakeGitHub } from '../tests/fixtures/fake-github.js';

/**
 * A fake GitHub for the hosted-compose smoke test (V24, `scripts/smoke-hosted.sh`). Run inside the API image,
 * on the compose network, so the API's server-side code exchange reaches it by name while the smoke driver
 * reaches the same server through a loopback publish. Whoever is at the keyboard is `FAKE_GITHUB_LOGIN`.
 *
 * Dev and CI only: nothing under `packages/` imports this, and it is not part of any shipped command.
 */
const clientId = process.env.SBSCORE_GITHUB_CLIENT_ID ?? 'smoke-client';
const clientSecret = process.env.SBSCORE_GITHUB_CLIENT_SECRET ?? 'smoke-secret';
const fake = await startFakeGitHub({
  clientId,
  clientSecret,
  port: Number(process.env.FAKE_GITHUB_PORT ?? 9000),
  // The compose smoke override sets this to the container's wide address; the default is loopback, as everywhere.
  host: process.env.FAKE_GITHUB_HOST ?? '127.0.0.1',
});
fake.nextUser = { id: 4242, login: process.env.FAKE_GITHUB_LOGIN ?? 'smoketest', name: 'Smoke Test' };
console.log(`fake github listening on ${fake.url} (signs in as ${fake.nextUser.login})`);
