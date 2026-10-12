import type { Page, Route } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * Approving a device and the token list (V21b) in a real browser. As in `account.test.ts` the stack under
 * test is local, so `GET /v1/me` and the token routes are answered by route stubs: the server's behaviour
 * is pinned over a real socket in `tests/api/hosted-auth.test.ts`, and what is under test here is only what
 * the page does with each answer.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

const ALICE = { id: 'usr_1', login: 'alice', name: 'Alice A' };
const unauthenticated = { error: { kind: 'unauthenticated', message: 'not a principal this server knows' } };
const json = (route: Route, status: number, body: unknown): Promise<void> =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const signedIn = (route: Route): Promise<void> => json(route, 200, { mode: 'hosted', user: ALICE });

async function openAt(
  hash: string,
  me: (route: Route) => Promise<void> | void,
  extra?: (page: Page) => Promise<void>,
): Promise<Page> {
  const page = await stack.browser.newPage();
  await page.route('**/v1/me', me);
  if (extra) await extra(page);
  await page.goto(`${stack.uiUrl}/${hash}`, { waitUntil: 'domcontentloaded' });
  return page;
}

const token = (id: string, name: string, scopes: string[]) => ({
  id,
  name,
  scopes,
  createdAt: '2026-10-12T00:00:00Z',
  expiresAt: '2027-01-10T00:00:00Z',
});

describe('approving a device', () => {
  it('shapes the code as it is typed, keeps Approve off until it is complete, then sends what was chosen', async () => {
    let posted: { userCode: string; name: string; scopes: string[] } | undefined;
    const page = await openAt('#/device', signedIn, async (p) => {
      await p.route('**/v1/auth/device/approve', (route) => {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      });
    });
    try {
      await page.waitForSelector('#device-code');
      const approve = page.getByRole('button', { name: 'Approve', exact: true });
      await page.locator('#device-code').pressSequentially('bcdfg');
      expect(await page.locator('#device-code').inputValue()).toBe('BCDF-G');
      expect(await approve.isDisabled()).toBe(true);
      await page.locator('#device-code').pressSequentially('hjk');
      expect(await page.locator('#device-code').inputValue()).toBe('BCDF-GHJK');
      expect(await approve.isDisabled()).toBe(false);

      await page.locator('#device-name').fill('my laptop');
      await page.getByRole('button', { name: 'Change your charts' }).click();
      await approve.click();
      await page.waitForSelector('[role="status"]');
      expect(await page.locator('[role="status"]').innerText()).toContain('Device approved');
      expect(posted).toEqual({ userCode: 'BCDF-GHJK', name: 'my laptop', scopes: ['read'] });
    } finally {
      await page.close();
    }
  });

  it('never lets the last scope be switched off', async () => {
    const page = await openAt('#/device', signedIn);
    try {
      await page.waitForSelector('#device-code');
      const read = page.getByRole('button', { name: 'Read your charts' });
      const write = page.getByRole('button', { name: 'Change your charts' });
      await write.click();
      expect(await read.getAttribute('aria-pressed')).toBe('true');
      await read.click();
      expect(await read.getAttribute('aria-pressed')).toBe('true');
      expect(await write.getAttribute('aria-pressed')).toBe('false');
    } finally {
      await page.close();
    }
  });

  it('says a code that is not waiting is not waiting, and says what to do', async () => {
    const page = await openAt('#/device', signedIn, async (p) => {
      await p.route('**/v1/auth/device/approve', (route) =>
        json(route, 404, { error: { kind: 'unknown-code', message: 'not waiting' } }),
      );
    });
    try {
      await page.waitForSelector('#device-code');
      await page.locator('#device-code').pressSequentially('bcdfghjk');
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await page.waitForSelector('[role="alert"]');
      const text = await page.locator('[role="alert"]').innerText();
      expect(text).toContain('That code is not waiting for approval');
      expect(text).toContain('sbscore auth login');
      expect(await page.locator('#device-code').getAttribute('aria-invalid')).toBe('true');
    } finally {
      await page.close();
    }
  });

  it('shows the sign-in gate to a signed-out visitor and remembers to come back here', async () => {
    const page = await openAt('#/device', (route) => json(route, 401, unauthenticated));
    try {
      await page.waitForSelector('.gate');
      await page.route('**/v1/auth/github/login', (route) => route.fulfill({ status: 200, body: 'signing in' }));
      await page.getByRole('link', { name: 'Sign in with GitHub' }).click();
      await page.waitForLoadState('domcontentloaded');
      expect(await page.evaluate(() => window.sessionStorage.getItem('sbscore.return'))).toBe('#/device');
    } finally {
      await page.close();
    }
  });
});

describe('the API token list', () => {
  it('is reached from the account menu, and lists tokens without any token in sight', async () => {
    const page = await openAt('', signedIn, async (p) => {
      await p.route('**/v1/auth/tokens', (route) =>
        json(route, 200, { tokens: [token('tok_1', 'my laptop', ['read', 'write']), token('tok_2', 'ci-runner', ['read'])] }),
      );
    });
    try {
      await page.waitForSelector('.chip');
      await page.locator('.chip').click();
      await page.getByRole('menuitem', { name: 'API tokens' }).click();
      await page.waitForSelector('.row');
      expect(await page.locator('.row .name').allInnerTexts()).toEqual(['my laptop', 'ci-runner']);
      expect(await page.locator('.row').first().innerText()).toContain('Expires 10 Jan 2027');
      expect(await page.locator('body').innerText()).not.toMatch(/sbs_/);
      expect(await page.locator('.crumbs').innerText()).toContain('API tokens');
    } finally {
      await page.close();
    }
  });

  it('asks before revoking, and Keep changes nothing', async () => {
    let deleted = 0;
    const page = await openAt('#/tokens', signedIn, async (p) => {
      await p.route('**/v1/auth/tokens', (route) => json(route, 200, { tokens: [token('tok_1', 'my laptop', ['read'])] }));
      await p.route('**/v1/auth/tokens/tok_1', (route) => {
        deleted++;
        return route.fulfill({ status: 204 });
      });
    });
    try {
      await page.waitForSelector('.row');
      await page.getByRole('button', { name: 'Revoke my laptop' }).click();
      expect(await page.locator('.row').innerText()).toContain('stops it working immediately');
      expect(deleted).toBe(0);
      await page.getByRole('button', { name: 'Keep' }).click();
      expect(await page.locator('.row').innerText()).not.toContain('stops it working');
      expect(deleted).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('revokes on confirmation and the row goes, leaving the empty state with how to make another', async () => {
    let deleted = 0;
    const page = await openAt('#/tokens', signedIn, async (p) => {
      await p.route('**/v1/auth/tokens', (route) => json(route, 200, { tokens: [token('tok_1', 'my laptop', ['read'])] }));
      await p.route('**/v1/auth/tokens/tok_1', (route) => {
        deleted++;
        return route.fulfill({ status: 204 });
      });
    });
    try {
      await page.waitForSelector('.row');
      await page.getByRole('button', { name: 'Revoke my laptop' }).click();
      await page.getByRole('button', { name: 'Revoke', exact: true }).click();
      await page.waitForSelector('.empty');
      expect(deleted).toBe(1);
      expect(await page.locator('.empty').innerText()).toContain('sbscore --url');
      expect(await page.locator('.empty').innerText()).toContain('auth login');
    } finally {
      await page.close();
    }
  });

  it('shows how to create the first token when there are none', async () => {
    const page = await openAt('#/tokens', signedIn, async (p) => {
      await p.route('**/v1/auth/tokens', (route) => json(route, 200, { tokens: [] }));
    });
    try {
      await page.waitForSelector('.empty');
      expect(await page.locator('.empty h2').innerText()).toBe('No API tokens yet');
    } finally {
      await page.close();
    }
  });
});

describe('a local install has nothing to approve or list', () => {
  it('says so on both pages instead of showing a form that cannot work', async () => {
    for (const hash of ['#/device', '#/tokens']) {
      const page = await openAt(hash, (route) => json(route, 200, { mode: 'local' }));
      try {
        await page.waitForSelector('.local');
        expect(await page.locator('.local').innerText()).toContain('no accounts');
        expect(await page.locator('#device-code').count()).toBe(0);
      } finally {
        await page.close();
      }
    }
  });
});

describe('one typeface across the account chrome', () => {
  it('uses the same font family on the gate, the approval form and the token list', async () => {
    const families = new Set<string>();
    const measure = async (page: Page, selectors: string[]): Promise<void> => {
      for (const selector of selectors) {
        families.add(await page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontFamily));
      }
    };
    const gate = await openAt('', (route) => json(route, 401, unauthenticated));
    try {
      await gate.waitForSelector('.gate');
      await measure(gate, ['.gate h1', '.gate .lede', '.gate .filled', '.gate .support']);
    } finally {
      await gate.close();
    }
    const device = await openAt('#/device', signedIn);
    try {
      await device.waitForSelector('#device-code');
      await measure(device, ['h1', 'label', '#device-code', '#device-name', '.filter', '.filled', '.help']);
    } finally {
      await device.close();
    }
    const tokens = await openAt('#/tokens', signedIn, async (p) => {
      await p.route('**/v1/auth/tokens', (route) => json(route, 200, { tokens: [token('t', 'laptop', ['read'])] }));
    });
    try {
      await tokens.waitForSelector('.row');
      await measure(tokens, ['h1', '.row .name', '.row .meta', '.scope', '.danger']);
    } finally {
      await tokens.close();
    }
    expect([...families]).toHaveLength(1);
  });
});
