import { createFileRoute, useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';

import { LiveScreen } from '../features/pairs/LiveScreen';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { usePairsDaily } from '../hooks/usePairsDaily';
import { usePairsWeekly } from '../hooks/usePairsWeekly';
import { liveSearchSchema } from './-search';

// The live surface (integration plan §4, slice 5; frontend spec §1.1 as
// amended 2026-07-23): the nightly report's three panels: spread and
// z-score per deployed pair, the leg execution and imbalance tracker,
// and the risk and P&L summary, with the weekly monitor's strip beneath.
// The app renders the engine's book and never trades.
export const Route = createFileRoute('/pairs/live')({
  validateSearch: liveSearchSchema,
  component: LiveRoute
});

function LiveRoute(): ReactElement {
  const { pair } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const daily = usePairsDaily();
  const weekly = usePairsWeekly();
  const online = useOnlineStatus();

  const collection = daily.data?.kind === 'ok' ? daily.data.collection : undefined;
  const weeklyReport =
    weekly.data?.kind === 'ok' ? (weekly.data.collection.latest ?? undefined) : undefined;

  const status = ((): 'loading' | 'signed_out' | 'error' | 'ready' => {
    if (daily.data?.kind === 'ok') return 'ready';
    if (daily.data?.kind === 'signed_out') return 'signed_out';
    if (daily.isError) return 'error';
    return 'loading';
  })();

  const runDate = collection?.latest?.runDate;
  const staleDays =
    runDate === undefined
      ? 0
      : Math.floor((Date.now() - new Date(`${runDate}T00:00:00Z`).getTime()) / 86_400_000);

  return (
    <LiveScreen
      status={status}
      errorMessage={daily.error instanceof Error ? daily.error.message : undefined}
      onRetry={() => void daily.refetch()}
      collection={collection}
      weekly={weeklyReport}
      fetchedAt={daily.dataUpdatedAt === 0 ? undefined : daily.dataUpdatedAt}
      online={online}
      staleDays={staleDays}
      focusPair={pair}
      onFocusPair={(ticker1, ticker2) =>
        void navigate({ search: { pair: `${ticker1}-${ticker2}` }, replace: true })
      }
    />
  );
}
