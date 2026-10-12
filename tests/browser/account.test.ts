import type { Page, Route } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * The account chrome (V20b) in a real browser. The stack under test is a local one, so `GET /v1/me` and
 * the sign-in routes are answered by route stubs: the API side of hosted mode is pinned against a real
 * socket in `tests/api/hosted-auth.test.ts`, and what is under test here is only what the page does with
 * each answer — which screen it draws, and that it never draws an account on a local install.
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

async function open(me: (route: Route) => Promise<void> | void, extra?: (page: Page) => Promise<void>): Promise<Page> {
  const page = await stack.browser.newPage();
  await page.route('**/v1/me', me);
  if (extra) await extra(page);
  await page.goto(`${stack.uiUrl}/`, { waitUntil: 'domcontentloaded' });
  return page;
}

describe('signed out, on a hosted deployment', () => {
  it('shows the sign-in gate instead of the library, and signs in by navigating to the server', async () => {
    const page = await open((route) => json(route, 401, unauthenticated));
    try {
      await page.waitForSelector('.gate');
      expect(await page.locator('.row').count()).toBe(0);
      expect(await page.getByRole('link', { name: 'Sign in with GitHub' }).getAttribute('href')).toBe('/v1/auth/github/login');
      expect(await page.locator('.chip').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('remembers the chart that was open across the sign-in round trip', async () => {
    stack.cli(['new', '--id', 'soul', '--title', 'Body and Soul', '--key', 'Db', '--bars', '4']);
    const page = await stack.browser.newPage();
    try {
      await page.route('**/v1/me', (route) => json(route, 401, unauthenticated));
      await page.goto(`${stack.uiUrl}/#/score/soul`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.gate');
      // Stop the navigation to GitHub; what matters is what was stored before it.
      await page.route('**/v1/auth/github/login', (route) => route.fulfill({ status: 200, body: 'github' }));
      await page.getByRole('link', { name: 'Sign in with GitHub' }).click();
      await page.waitForLoadState('domcontentloaded');
      expect(await page.evaluate(() => window.sessionStorage.getItem('sbscore.return'))).toBe('#/score/soul');
    } finally {
      await page.close();
    }
  });
});

describe('signed in', () => {
  it('names the account in a chip, and the menu signs out back to the gate', async () => {
    let loggedOut = false;
    const page = await open(
      (route) => (loggedOut ? json(route, 401, unauthenticated) : json(route, 200, { mode: 'hosted', user: ALICE })),
      async (p) => {
        await p.route('**/v1/auth/logout', (route) => {
          loggedOut = true;
          return route.fulfill({ status: 204 });
        });
      },
    );
    try {
      await page.waitForSelector('.chip');
      expect(await page.locator('.chip').innerText()).toContain('alice');
      await page.locator('.chip').click();
      expect(await page.locator('.menu .name').innerText()).toBe('Alice A');
      await page.getByRole('menuitem', { name: 'Sign out' }).click();
      await page.waitForSelector('.gate');
      expect(loggedOut).toBe(true);
      expect(await page.locator('.chip').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('closes the menu on Escape and returns focus to the chip', async () => {
    const page = await open((route) => json(route, 200, { mode: 'hosted', user: ALICE }));
    try {
      await page.waitForSelector('.chip');
      await page.locator('.chip').click();
      await page.waitForSelector('.menu');
      await page.keyboard.press('Escape');
      expect(await page.locator('.menu').count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.className)).toContain('chip');
    } finally {
      await page.close();
    }
  });

  it('keeps the chart on screen under a banner when a request comes back 401', async () => {
    stack.cli(['new', '--id', 'ended', '--title', 'Still Here', '--key', 'C', '--bars', '4']);
    const page = await open((route) => json(route, 200, { mode: 'hosted', user: ALICE }), async (p) => {
      await p.route('**/v1/scores/ended', (route) => json(route, 401, unauthenticated));
    });
    try {
      await page.waitForSelector('.chip');
      await page.evaluate(() => {
        window.location.hash = '#/score/ended';
      });
      await page.waitForSelector('[role="alert"]');
      expect(await page.locator('[role="alert"]').innerText()).toContain('You have been signed out');
      expect(await page.getByRole('link', { name: 'Sign in again' }).getAttribute('href')).toBe('/v1/auth/github/login');
    } finally {
      await page.close();
    }
  });
});

describe('a local install', () => {
  it('draws no gate and no account chrome, exactly as before', async () => {
    const page = await open((route) => json(route, 200, { mode: 'local' }));
    try {
      await page.waitForSelector('.rows, .empty, .row, main');
      expect(await page.locator('.gate').count()).toBe(0);
      expect(await page.locator('.chip').count()).toBe(0);
      expect(await page.locator('[role="alert"]').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
