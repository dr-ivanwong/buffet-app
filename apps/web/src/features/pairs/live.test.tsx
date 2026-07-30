// @vitest-environment jsdom
/**
 * The live surface against a stubbed API: the three panels, the halt
 * rendered loudly, the staleness warning, and the states. The exit
 * criteria of the slice live here: paper artefacts render cleanly, a
 * halt is unmissable, and a stale report says so.
 */
import 'fake-indexeddb/auto';

import type {
  DailyPairsReport,
  PairsDailyCollection,
  PairsWeeklyCollection
} from '@plainsight/api-contract';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '../../db';
import { setMeta } from '../../db/meta';
import { queryClient, Route as rootRoute } from '../../routes/__root';
import { routeTree } from '../../routeTree.gen';

void rootRoute;

const TODAY = new Date().toISOString().slice(0, 10);

function dailyPair(ticker1: string, ticker2: string, heldUnits: number): DailyPairsReport['pairs'][number] {
  return {
    ticker1,
    ticker2,
    beta: 2.5,
    capital: 30_000,
    z: -1.24,
    spread: 12.4,
    spreadMean: 13.1,
    spreadStd: 0.6,
    stoodDown: false,
    daysHeld: heldUnits === 0 ? 0 : 3,
    heldUnits,
    targetUnits: heldUnits + 2,
    unitGross: 350,
    legs: [
      { ticker: ticker1, targetShares: heldUnits + 2, heldShares: heldUnits },
      { ticker: ticker2, targetShares: -Math.round((heldUnits + 2) * 2.5), heldShares: -Math.round(heldUnits * 2.5) }
    ],
    zSeries: {
      dates: ['2024-01-22', '2024-01-23', '2024-01-24', '2024-01-25', TODAY],
      values: [0.4, 1.1, 2.2, 1.4, -1.24]
    }
  };
}

function report(overrides: Partial<DailyPairsReport> = {}): DailyPairsReport {
  return {
    artefact: 'dailyPairsReport',
    schemaVersion: 1,
    engineVersion: '0.1.0',
    runDate: TODAY,
    generatedAt: '2026-07-23T08:30:00Z',
    paper: true,
    reconciliation: { status: 'clean', checkedAt: '2026-07-23T00:20:00Z', mismatches: [] },
    assumptions: {
      lookbackDays: 60,
      entryZ: 2.0,
      exitZ: 0.5,
      stopZ: 3.5,
      maxHoldDays: 60,
      costBpsPerSide: 15.0,
      borrowBpsPerAnnum: 50.0
    },
    limitCapBps: 10.0,
    pairs: [dailyPair('AAA', 'BBB', 4), dailyPair('CCC', 'DDD', 0)],
    fills: [
      {
        filledOn: '2024-01-25',
        ticker: 'AAA',
        shares: 4,
        price: 100.12,
        referenceClose: 100.1,
        slippageBps: 2.0
      }
    ],
    pnl: {
      dates: ['2024-01-24', '2024-01-25', TODAY],
      daily: [12.5, -4.2, 8.8],
      cumulative: [12.5, 8.3, 17.1],
      engineCumulative: [13.0, 9.1, 18.4],
      drawdownPct: -0.4,
      maxDrawdownPct: -1.9,
      declaredMaxDrawdownPct: 12.0,
      grossExposure: 2801.4,
      stopsFired: 1,
      roundTrips: 3,
      realisedCostBpsPerSide: 16.4,
      modelledCostBpsPerSide: 15.0
    },
    ...overrides
  };
}

const WEEKLY: PairsWeeklyCollection = {
  latest: {
    artefact: 'weeklyMonitoringReport',
    schemaVersion: 1,
    engineVersion: '0.1.0',
    runDate: TODAY,
    generatedAt: '2026-07-23T08:35:00Z',
    pairs: [
      {
        ticker1: 'AAA',
        ticker2: 'BBB',
        deployedBeta: 2.5,
        pValueNow: 0.0021,
        halfLifeDaysNow: 4.1,
        refitBeta: 2.52,
        betaDriftPct: 0.8,
        trackingErrorBps: 6.6
      }
    ],
    correlations: []
  },
  history: []
};

function collections(daily: PairsDailyCollection): (url: string) => Response {
  return (url) => {
    if (url.includes('/daily')) {
      return new Response(JSON.stringify(daily), { status: 200 });
    }
    return new Response(JSON.stringify(WEEKLY), { status: 200 });
  };
}

async function seedSignedIn(): Promise<void> {
  await setMeta(db, 'authSession', {
    idToken: 'id-token',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000,
    email: 'owner@example.com'
  });
}

function stubFetch(responder: (url: string) => Response): ReturnType<typeof vi.fn> {
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return responder(url);
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

function renderAt(path: string): void {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] })
  });
  render(<RouterProvider router={router} />);
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  queryClient.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the live surface', () => {
  it('renders the three panels and the weekly strip from fresh artefacts', async () => {
    await seedSignedIn();
    stubFetch(collections({ latest: report(), history: [] }));
    renderAt('/pairs/live');

    expect(await screen.findByRole('heading', { name: 'Live book' })).toBeInTheDocument();
    // Spread and z-score panel, focused on the first pair.
    expect(screen.getByText('-1.24σ')).toBeInTheDocument();
    // Leg execution and imbalance: the unworked delta is highlighted.
    expect(screen.getByRole('heading', { name: 'Leg execution and imbalance' })).toBeInTheDocument();
    expect(screen.getAllByText('+2').length).toBeGreaterThan(0);
    // Risk and P&L summary with the declared limit and the weekly strip.
    expect(screen.getByText('Drawdown against the declared 12.00%')).toBeInTheDocument();
    expect(screen.getByText('16.40 bps against the modelled 15.00 bps', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Weekly monitor')).toBeInTheDocument();
    expect(screen.getByText('0.002')).toBeInTheDocument();
    // Fresh report: no staleness warning.
    expect(screen.queryByText(/days old/)).not.toBeInTheDocument();
  });

  it('renders a halted reconciliation loudly, as an alert', async () => {
    await seedSignedIn();
    stubFetch(
      collections({
        latest: report({
          reconciliation: {
            status: 'halted',
            checkedAt: '2026-07-23T00:20:00Z',
            mismatches: [{ ticker: 'BBB', book: -10, broker: -7 }]
          }
        }),
        history: []
      })
    );
    renderAt('/pairs/live');

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Halted with no orders.');
    expect(banner).toHaveTextContent('BBB (book -10, broker -7)');
    expect(banner).toHaveTextContent('refuses to trade');
  });

  it('says so when the nightly report has gone stale', async () => {
    await seedSignedIn();
    stubFetch(collections({ latest: report({ runDate: '2024-01-26' }), history: [] }));
    renderAt('/pairs/live');

    expect(await screen.findByRole('status')).toHaveTextContent(/days old/);
  });

  it('switches the focused pair through the picker', async () => {
    await seedSignedIn();
    stubFetch(collections({ latest: report(), history: [] }));
    renderAt('/pairs/live');

    fireEvent.click(await screen.findByRole('button', { name: 'CCC-DDD' }));
    expect(await screen.findByText(/flat/)).toBeInTheDocument();
  });

  it('renders the empty sleeve honestly and offers the rail sections', async () => {
    await seedSignedIn();
    await setMeta(db, 'pairsSeen', true);
    stubFetch(() => new Response(JSON.stringify({ latest: null, history: [] }), { status: 200 }));
    renderAt('/pairs/live');

    expect(await screen.findByText('No nightly report published yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Live' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Backtest' })).toHaveAttribute('href', '/pairs/backtest');
  });

  it('asks for sign-in without calling the API', async () => {
    const fetchImpl = stubFetch(() => new Response('{}', { status: 200 }));
    renderAt('/pairs/live');
    expect(await screen.findByText('Sign in to read the sleeve')).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a failed read with a retry', async () => {
    await seedSignedIn();
    stubFetch(() => new Response('{}', { status: 500 }));
    renderAt('/pairs/live');
    expect(await screen.findByText('The sleeve could not be read')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
