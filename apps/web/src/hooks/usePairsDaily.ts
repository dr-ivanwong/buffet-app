/**
 * The daily kind's read (integration plan §4, slice 5): the live
 * surface's data, the shared token-and-envelope path from pairsRead.
 */
import {
  pairsDailyCollectionSchema,
  type PairsDailyCollection
} from '@plainsight/api-contract';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchPairsRead, type PairsRead } from './pairsRead';

export type PairsDailyFetch = PairsRead<PairsDailyCollection>;

export const PAIRS_DAILY_QUERY_KEY = ['pairsArtefacts', 'daily'] as const;

export async function fetchPairsDaily(
  fetchImpl: typeof fetch = fetch
): Promise<PairsDailyFetch> {
  return fetchPairsRead('daily', (raw) => pairsDailyCollectionSchema.parse(raw), fetchImpl);
}

export function usePairsDaily(): UseQueryResult<PairsDailyFetch> {
  return useQuery({
    queryKey: PAIRS_DAILY_QUERY_KEY,
    queryFn: () => fetchPairsDaily(),
    staleTime: 5 * 60_000
  });
}
