// @vitest-environment jsdom
/**
 * The pairs research surface against a stubbed API: states, the
 * fundamentals join, the sheet's derivations, and the rail's progressive
 * gate riding the device's pairs-seen memory.
 */
import 'fake-indexeddb/auto';

import type { PairsArtefactCollection } from '@plainsight/api-contract';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '../../db';
import { setMeta } from '../../db/meta';
import { queryClient, Route as rootRoute } from '../../routes/__root';
import { routeTree } from '../../routeTree.gen';

void rootRoute;

const T1 = '2026-07-22T10:00:00.000Z';

const REPORT = {
  artefact: 'pairScanReport',
  schemaVersion: 1,
  engineVersion: '0.1.0',
  runDate: '2024-01-26',
  generatedAt: '2026-07-22T09:30:00Z',
  closesSource: 'yahoo',
  universe: ['AAA', 'BBB', 'CCC'],
  window: {
    start: '2021-01-04',
    end: '2024-01-26',
    splitDate: '2023-06-19',
    trainFraction: 0.8,
    minSharedTrainDays: 500
  },
  criteria: {
    maxPValue: 0.05,
    maxCandidateHalfLifeDays: 30,
    halfLifeCeilingDays: 120,
    minAbsRegressionR: 0.1,
    requirePositiveBeta: true
  },
  pairsTested: 2,
  pairs: [
    {
      ticker1: 'AAA',
      ticker2: 'BBB',
      sharedTrainDays: 640,
      pValue: 0.0005,
      beta: 2.5,
      intercept: 10.1,
      correlation: 0.99,
      halfLifeDays: 3.5,
      halfLifeValid: true,
      candidate: true
    },
    {
      ticker1: 'AAA',
      ticker2: 'CCC',
      sharedTrainDays: 640,
      pValue: 0.41,
      beta: -1.2,
      intercept: 220.4,
      correlation: -0.31,
      halfLifeDays: null,
      halfLifeValid: false,
      candidate: false
    }
  ],
  skipped: [
    { ticker1: 'BBB', ticker2: 'CCC', sharedTrainDays: 120, reason: 'insufficientSharedHistory' }
  ],
  candidates: [
    {
      ticker1: 'AAA',
      ticker2: 'BBB',
      beta: 2.5,
      pValue: 0.0005,
      halfLifeDays: 3.5,
      correlation: 0.99
    }
  ]
} satisfies NonNullable<PairsArtefactCollection['latest']>;

const COLLECTION: PairsArtefactCollection = {
  latest: REPORT,
  history: [
    {
      runDate: '2024-01-26',
      engineVersion: '0.1.0',
      schemaVersion: 1,
      generatedAt: '2026-07-22T09:30:00Z',
      receivedAt: '2026-07-22T09:31:00Z',
      sizeBytes: 2048
    }
  ]
};

async function seedSignedIn(): Promise<void> {
  await setMeta(db, 'authSession', {
    idToken: 'id-token',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000,
    email: 'owner@example.com'
  });
}

async function seedCompany(id: string, name: string, ticker: string): Promise<void> {
  await db.companies.put({
    id,
    name,
    ticker,
    exchange: 'ASX',
    sector: 'banks',
    currency: 'AUD',
    sample: false,
    createdAt: T1,
    updatedAt: T1,
    dataVersion: 0
  });
}

function stubFetch(response: () => Response): ReturnType<typeof vi.fn> {
  const impl = vi.fn(async () => response());
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

describe('the pairs research surface', () => {
  it('renders the candidate with its statistics and the fundamentals join', async () => {
    await seedSignedIn();
    await seedCompany('c-aaa', 'Alpha Holdings', 'AAA');
    await seedCompany('c-bbb', 'Beta Group', 'BBB');
    const fetchImpl = stubFetch(
      () => new Response(JSON.stringify(COLLECTION), { status: 200 })
    );
    renderAt('/pairs');

    expect(await screen.findByRole('button', { name: 'AAA–BBB' })).toBeInTheDocument();
    expect(screen.getByText('2024-01-26')).toBeInTheDocument();
    // The provenance stamp: a research-phase scan says where its closes
    // came from, right on the provenance line.
    expect(screen.getByText(/closes from/)).toBeInTheDocument();
    expect(screen.getByText('yahoo')).toBeInTheDocument();
    expect(screen.getByText('2.50')).toBeInTheDocument();
    expect(screen.getByText('3.5 days')).toBeInTheDocument();
    // The join: both legs in the library carry sector and flag state, and
    // the pair links to Compare. The library's live pass lands a tick
    // after the fetch, so the first join assertion waits.
    expect(await screen.findAllByText('Banks')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'AAA' })).toHaveAttribute('href', '/company/c-aaa');
    // Two Compare links exist here: the rail's destination (two companies
    // seeded) and the candidate row's side-by-side link; the row's one
    // carries both leg ids.
    const compareLinks = screen.getAllByRole('link', { name: 'Compare' });
    expect(
      compareLinks.some((link) => (link.getAttribute('href') ?? '').includes('c-aaa'))
    ).toBe(true);
    const request = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(request[0]).toContain('/v1/pairs/artefacts/pair-scan');
    expect((request[1].headers as Record<string, string>).authorization).toBe(
      'Bearer access-token'
    );
  });

  it('remembers artefacts were seen, which raises the rail item', async () => {
    await seedSignedIn();
    stubFetch(() => new Response(JSON.stringify(COLLECTION), { status: 200 }));
    renderAt('/pairs');

    await screen.findByRole('button', { name: 'AAA–BBB' });
    await waitFor(async () => {
      expect((await db.meta.get('pairsSeen'))?.value).toBe(true);
    });
    expect(await screen.findByRole('link', { name: 'Pairs' })).toBeInTheDocument();
  });

  it('opens the pair sheet with the gate-by-gate verdict and derivations', async () => {
    await seedSignedIn();
    stubFetch(() => new Response(JSON.stringify(COLLECTION), { status: 200 }));
    renderAt('/pairs');

    fireEvent.click(await screen.findByRole('button', { name: 'AAA–BBB' }));
    expect(await screen.findByRole('heading', { name: 'Candidate' })).toBeInTheDocument();
    expect(screen.getAllByText('met')).toHaveLength(3);
    expect(screen.getByText(/training window 2021-01-04 to 2023-06-19/)).toBeInTheDocument();
    expect(screen.getByText(/the spread is AAA minus 2.50 times BBB/)).toBeInTheDocument();
  });

  it('switches the matrix measure through the segmented control', async () => {
    await seedSignedIn();
    stubFetch(() => new Response(JSON.stringify(COLLECTION), { status: 200 }));
    renderAt('/pairs');

    await screen.findByRole('button', { name: 'AAA–BBB' });
    expect(screen.getByText(/strength of correlation/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Cointegration' }));
    expect(await screen.findByText(/Shading by the cointegration test/)).toBeInTheDocument();
  });

  it('renders the empty sleeve honestly and clears the rail memory', async () => {
    await seedSignedIn();
    await setMeta(db, 'pairsSeen', true);
    stubFetch(
      () => new Response(JSON.stringify({ latest: null, history: [] }), { status: 200 })
    );
    renderAt('/pairs');

    expect(await screen.findByText('No scan published yet')).toBeInTheDocument();
    await waitFor(async () => {
      expect((await db.meta.get('pairsSeen'))?.value).toBe(false);
    });
  });

  it('asks for sign-in when the device has no session, without calling the API', async () => {
    const fetchImpl = stubFetch(() => new Response('{}', { status: 200 }));
    renderAt('/pairs');

    expect(await screen.findByText('Sign in to read the sleeve')).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a failed read with the envelope message and a retry', async () => {
    await seedSignedIn();
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'internal',
              message: 'The sleeve could not be read.',
              details: [],
              requestId: 'req_1'
            }
          }),
          { status: 500 }
        )
    );
    renderAt('/pairs');

    expect(await screen.findByText('The sleeve could not be read')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
