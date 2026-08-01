<script lang="ts">
  /**
   * The shell: two views and a hash.
   *
   * Read-only, all of it. V4b's honest end is a score you can look at and not touch — no
   * selection, no editing, no inspector (V4c), and no live updates (V4d). There is no "New chart"
   * button anywhere in here on purpose, so **Q79's parity between the two surfaces is knowingly
   * unmet at the end of this card**: `score.create`, `meta.set`, `note.*` and `rest.*` all have a
   * CLI verb and no UI control. V4c closes it. Splitting the UI's first write across two cards
   * would be worse than one slice of booked debt.
   */
  import LibraryView from './components/LibraryView.svelte';
  import ScoreView from './components/ScoreView.svelte';
  import TopBar from './components/TopBar.svelte';
  import { hashOf, LIBRARY, routeOf } from './lib/routing.js';

  let route = $state(routeOf(window.location.hash));
  let title = $state<string | null>(null);
  let reachable = $state(true);

  function sync(): void {
    route = routeOf(window.location.hash);
    if (route.view === 'library') title = null;
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', sync);
</script>

<TopBar {route} {title} {reachable} onLibrary={() => (window.location.hash = hashOf(LIBRARY))} />

<main>
  {#if route.view === 'library'}
    <LibraryView onReachable={(ok) => (reachable = ok)} />
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
