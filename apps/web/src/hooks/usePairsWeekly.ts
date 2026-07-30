/**
 * The weekly monitor's read (integration plan §4, slice 5): the strip on
 * the live surface, the shared token-and-envelope path from pairsRead.
 */
import {
  pairsWeeklyCollectionSchema,
  type PairsWeeklyCollection
} from '@plainsight/api-contract';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchPairsRead, type PairsRead } from './pairsRead';

export type PairsWeeklyFetch = PairsRead<PairsWeeklyCollection>;

export const PAIRS_WEEKLY_QUERY_KEY = ['pairsArtefacts', 'weekly'] as const;

export async function fetchPairsWeekly(
  fetchImpl: typeof fetch = fetch
): Promise<PairsWeeklyFetch> {
  return fetchPairsRead('weekly', (raw) => pairsWeeklyCollectionSchema.parse(raw), fetchImpl);
}

export function usePairsWeekly(): UseQueryResult<PairsWeeklyFetch> {
  return useQuery({
    queryKey: PAIRS_WEEKLY_QUERY_KEY,
    queryFn: () => fetchPairsWeekly(),
    staleTime: 5 * 60_000
  });
}
