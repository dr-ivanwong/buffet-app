import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, type ReactElement } from 'react';

import { completeSignIn } from '../auth/session';
import { useSyncRunner } from '../sync/useSync';
import { AppRail } from '../components/AppRail';
import * as railStyles from '../components/appRail.css';
import { Placeholder } from '../components/Placeholder';
import * as placeholderStyles from '../components/placeholder.css';
import { db } from '../db';
import { LIBRARY_WIDE_MEDIA } from '../features/library/libraryMedia';
import { useCompanies } from '../hooks/useCompanies';
import { useCompany } from '../hooks/useCompany';
import { useMediaQuery } from '../hooks/useMediaQuery';
import * as styles from '../styles/shell.css';

export const Route = createRootRoute({
  component: RootShell,
  notFoundComponent: NotFound,
});

// Server state (main plan §5: TanStack Query from Phase 2), provided at the
// root route so every render of the tree carries it, tests included. It
// caches the market-data reads; the library itself rides the sync engine,
// with IndexedDB as the working copy (main plan §12.9).
// Exported for tests only: suites that exercise query-fed screens reset
// the cache between cases the way they reset Dexie.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 }
  }
});

/** Screens that render in the wider column (frontend spec §7): the dashboard, compare, and the pairs surfaces. */
const WIDE_ROUTE_IDS: readonly string[] = [
  '/company/$id/',
  '/compare',
  '/pairs/',
  '/pairs/backtest',
  '/pairs/live',
];

/**
 * Ask the browser to keep this origin's data, once per launch. Browsers
 * decide by their own heuristics and may silently decline; the data screen
 * shows the answer either way.
 */
function useRequestPersistence(): void {
  useEffect(() => {
    const storage = navigator.storage as StorageManager | undefined;
    if (storage !== undefined && typeof storage.persist === 'function') {
      void storage.persist();
    }
  }, []);
}

/**
 * Finish a hosted-UI sign-in when the URL carries one (the registered
 * redirect is the origin root). The query is stripped either way so a
 * bookmark or reload never replays a dead code; every other launch is
 * untouched, because the params simply are not there.
 */
function useCompleteSignIn(): void {
  useEffect(() => {
    const search = window.location.search;
    if (!search.includes('code=') || !search.includes('state=')) return;
    void completeSignIn(search).then((outcome) => {
      if (outcome !== 'not_a_callback') {
        window.history.replaceState(null, '', window.location.pathname);
      }
    });
  }, []);
}

/**
 * The stored theme choice, applied to the document (tokens.css.ts): light or
 * dark outranks the system preference in either direction, and auto (or an
 * unreadable row) removes the attribute to hand control back to the system.
 */
function useAppliedTheme(): void {
  const themeRow = useLiveQuery(() => db.meta.get('theme'), []);
  const value = themeRow?.value;
  useEffect(() => {
    if (value === 'light' || value === 'dark') {
      document.documentElement.dataset.theme = value;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }, [value]);
}

function RootShell(): ReactElement {
  useRequestPersistence();
  useCompleteSignIn();
  useSyncRunner();
  useAppliedTheme();
  const wide = useRouterState({
    select: (state) => state.matches.some((match) => WIDE_ROUTE_IDS.includes(match.routeId)),
  });
  // The library borrows the wide column while its screener is on (finance-look
  // gap plan §5): eight columns need the dashboard's width. The same signals
  // that gate the screener gate the width, so the rows always get the narrow
  // column back.
  const libraryRoute = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === '/'),
  });
  const screenerWidth = useMediaQuery(LIBRARY_WIDE_MEDIA);
  const libraryTableRow = useLiveQuery(() => db.meta.get('libraryTableView'), []);
  const libraryScreener = libraryRoute && screenerWidth && libraryTableRow?.value === true;
  // The rail's container facts: the open company (if any) for its section
  // group, and the library size for Compare's progressive appearance.
  const companyId = useRouterState({
    select: (state) => {
      const match = state.matches.find((entry) => entry.routeId.startsWith('/company/$id'));
      return match === undefined ? undefined : (match.params as { id?: string }).id;
    },
  });
  const company = useCompany(companyId ?? '');
  const companies = useCompanies();
  // The sleeve's progressive rule (integration plan §4): Pairs joins the
  // rail once this device has seen artefacts on the API; the pairs route
  // keeps the flag current on every read. On the sleeve's own routes the
  // rail lists its sections, the company-group pattern.
  const pairsSeenRow = useLiveQuery(() => db.meta.get('pairsSeen'), []);
  const pairsSection = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId.startsWith('/pairs')),
  });
  const columnClass = wide || libraryScreener ? styles.columnWideRail : styles.columnRail;
  return (
    <QueryClientProvider client={queryClient}>
      <main className={columnClass}>
        <div className={railStyles.frame}>
          <AppRail
            showCompare={(companies?.length ?? 0) >= 2}
            showPairs={pairsSeenRow?.value === true}
            pairsSection={pairsSection}
            companyId={companyId}
            companyName={companyId === undefined ? undefined : company?.name}
          />
          <div>
            <Outlet />
          </div>
        </div>
      </main>
    </QueryClientProvider>
  );
}

// Every URL is bookmarkable and relaunch-safe (frontend spec §1.1), so an
// address that matches nothing gets a way home rather than a dead end.
function NotFound(): ReactElement {
  return (
    <Placeholder title="Nothing at this address" note="That page does not exist.">
      <Link className={placeholderStyles.link} to="/">
        Back to the library
      </Link>
    </Placeholder>
  );
}
