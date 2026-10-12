<script lang="ts">
  /**
   * The shell: two views and a hash, and since V20b, who is using them.
   *
   * On a local install nothing account-shaped is ever drawn (`GET /v1/me` says `mode: local`). On a
   * hosted deployment a person with no session sees the sign-in gate instead of the library, a signed-in
   * person sees a chip in the top bar, and a 401 while the app is open leaves what is on screen readable
   * under a banner. The transitions live in `lib/session.ts`; this file holds the value and draws it.
   *
   * The editing surface is documented where it landed (V4c); the account chrome adds no write path.
   */
  import { onMount } from 'svelte';
  import AccountMenu from './components/AccountMenu.svelte';
  import DeviceApproval from './components/DeviceApproval.svelte';
  import LibraryView from './components/LibraryView.svelte';
  import ScoreView from './components/ScoreView.svelte';
  import SessionBanner from './components/SessionBanner.svelte';
  import SignInGate from './components/SignInGate.svelte';
  import TokenList from './components/TokenList.svelte';
  import TopBar from './components/TopBar.svelte';
  import { onSessionEnded, signOut } from './lib/api.js';
  import { hashOf, LIBRARY, routeOf, TOKENS } from './lib/routing.js';
  import type { Route } from './lib/routing.js';
  import { afterUnauthenticated, CHECKING, loadSession, takeReturn } from './lib/session.js';
  import type { Session } from './lib/session.js';

  /** The crumb for the pages that are not a chart. A chart reports its own title once it has loaded. */
  const titleOf = (r: Route): string | null =>
    r.view === 'device' ? 'Approve a device' : r.view === 'tokens' ? 'API tokens' : null;

  let route = $state(routeOf(window.location.hash));
  let title = $state<string | null>(titleOf(routeOf(window.location.hash)));
  let reachable = $state(true);
  let session = $state<Session>(CHECKING);

  function sync(): void {
    route = routeOf(window.location.hash);
    if (route.view !== 'score') title = titleOf(route);
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', sync);

  onMount(() => {
    const stop = onSessionEnded(() => (session = afterUnauthenticated(session)));

    loadSession().then(
      (loaded) => {
        session = loaded;
        // Back from the sign-in round trip: put the person where they were.
        if (loaded.phase === 'signed-in') {
          let place: string | null = null;
          try {
            place = takeReturn(window.sessionStorage);
          } catch {
            // blocked storage: stay on the library
          }
          if (place !== null && place !== window.location.hash) window.location.hash = place;
        }
      },
      () => {
        // The API could not be reached. Draw the app as a local one would be: the views already have an
        // honest screen for an unreachable server, and a sign-in gate over a dead API cannot work.
        session = { phase: 'local' };
        reachable = false;
      },
    );

    return stop;
  });

  async function leave(): Promise<void> {
    try {
      await signOut();
    } catch {
      // Still signed out as far as this tab is concerned if the request fails; the cookie, if it
      // survived, is the server's to refuse the next time.
    }
    session = { phase: 'signed-out' };
  }
</script>

<TopBar {route} {title} {reachable} onLibrary={() => (window.location.hash = hashOf(LIBRARY))}>
  {#snippet account()}
    {#if session.phase === 'signed-in'}
      <AccountMenu account={session.account} onTokens={() => (window.location.hash = hashOf(TOKENS))} onSignOut={leave} />
    {/if}
  {/snippet}
</TopBar>

{#if session.phase === 'ended'}
  <SessionBanner />
{/if}

{#if session.phase === 'signed-out'}
  <SignInGate />
{:else if session.phase !== 'checking'}
  <main>
    {#if route.view === 'library'}
      <LibraryView onReachable={(ok) => (reachable = ok)} />
    {:else if route.view === 'device' || route.view === 'tokens'}
      {#if session.phase === 'signed-in' || session.phase === 'ended'}
        {#if route.view === 'device'}<DeviceApproval />{:else}<TokenList />{/if}
      {:else}
        <!-- A local install has no accounts, so it has nothing to approve and no tokens to list. -->
        <section class="local">
          <p>This is a local install. It has no accounts, so there are no API tokens to approve or list.</p>
          <a href={hashOf(LIBRARY)}>Back to the library</a>
        </section>
      {/if}
    {:else}
      <!-- Keyed on the id so opening a second chart remounts rather than reusing the first one's
           loaded state. -->
      {#key route.id}
        <ScoreView
          id={route.id}
          onTitle={(loaded) => (title = loaded)}
          onReachable={(ok) => (reachable = ok)}
        />
      {/key}
    {/if}
  </main>
{/if}

<style>
  .local {
    display: grid;
    justify-items: start;
    gap: 12px;
    max-width: 560px;
    margin: 48px auto;
    padding: 0 16px;
    font: var(--md-sys-typescale-body-medium);
    color: var(--md-sys-color-on-surface);
  }
  .local p {
    margin: 0;
  }
  .local a {
    color: var(--md-sys-color-primary);
    font: var(--md-sys-typescale-label-large);
  }
</style>
