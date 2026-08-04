/**
 * The pairs research screen (integration plan §4): the latest published
 * scan rendered as the candidate table and the correlation-and-
 * cointegration matrix, with the fundamentals join into the library.
 * Education framing throughout: the surface describes what the engine
 * measured and never advises.
 */
import type { PairsArtefactCollection } from '@plainsight/api-contract';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';

import { Placeholder } from '../../components/Placeholder';
import * as placeholderStyles from '../../components/placeholder.css';
import { SegmentedControl } from '../../components/SegmentedControl';
import { formatFetchTime } from './format';
import type { LegIndex } from './legs';
import { PairCandidates } from './PairCandidates';
import { PairSheet } from './PairSheet';
import { PairsMatrix } from './PairsMatrix';
import * as styles from './pairs.css';

export type PairsView = 'correlation' | 'cointegration';

const VIEW_OPTIONS = [
  { value: 'correlation', label: 'Correlation' },
  { value: 'cointegration', label: 'Cointegration' }
] as const;

export interface PairsScreenProps {
  status: 'loading' | 'signed_out' | 'error' | 'ready';
  errorMessage: string | undefined;
  onRetry: () => void;
  collection: PairsArtefactCollection | undefined;
  fetchedAt: number | undefined;
  online: boolean;
  legs: LegIndex;
  view: PairsView;
  onViewChange: (next: PairsView) => void;
  openPair: string | undefined;
  onOpenPair: (ticker1: string, ticker2: string) => void;
  onClosePair: () => void;
}

export function PairsScreen({
  status,
  errorMessage,
  onRetry,
  collection,
  fetchedAt,
  online,
  legs,
  view,
  onViewChange,
  openPair,
  onOpenPair,
  onClosePair
}: PairsScreenProps): ReactElement {
  if (status === 'signed_out') {
    return (
      <Placeholder
        title="Sign in to read the sleeve"
        note="The pairs research surface reads the engine's published artefacts through your account."
      >
        <Link className={placeholderStyles.link} to="/settings">
          Go to Settings
        </Link>
      </Placeholder>
    );
  }
  if (status === 'error') {
    return (
      <Placeholder
        title="The sleeve could not be read"
        note={errorMessage ?? 'The last fetch failed.'}
      >
        <button type="button" className={styles.retry} onClick={onRetry}>
          Retry
        </button>
      </Placeholder>
    );
  }
  if (status === 'loading' || collection === undefined) {
    return <p className={styles.quiet}>Loading the latest scan…</p>;
  }
  const report = collection.latest;
  if (report === null) {
    return (
      <Placeholder
        title="No scan published yet"
        note="Run the engine's scan and publish its artefact; the research surface renders the latest run."
      />
    );
  }
  return (
    <div className={styles.screen}>
      <header>
        <h1 className={styles.title}>Pairs</h1>
        <p className={styles.provenance}>
          Run <span className={styles.figure}>{report.runDate}</span> · engine{' '}
          <span className={styles.figure}>{report.engineVersion}</span>
          {report.closesSource == null ? null : (
            <> · closes from <span className={styles.figure}>{report.closesSource}</span></>
          )}
          {fetchedAt === undefined ? null : (
            <> · fetched <span className={styles.figure}>{formatFetchTime(fetchedAt)}</span></>
          )}
          {online ? null : ' · offline, showing the last fetch'}
        </p>
        <p className={styles.caption}>
          {report.pairsTested} pairs tested on the training window to {report.window.splitDate}; the
          holdout after it stays untouched. Statistics select pairs; the library qualifies them.
        </p>
      </header>

      <section>
        <h2 className={styles.sectionTitle}>Candidates</h2>
        <p className={styles.caption}>
          Pairs passing every gate: significance under {report.criteria.maxPValue}, a valid
          half-life inside {report.criteria.maxCandidateHalfLifeDays} days, and a positive hedge
          ratio. Each statistic opens its derivation.
        </p>
        <PairCandidates report={report} legs={legs} onOpenPair={onOpenPair} />
      </section>

      <section>
        <h2 className={styles.sectionTitle}>Matrix</h2>
        <SegmentedControl
          label="Matrix measure"
          options={VIEW_OPTIONS}
          value={view}
          onChange={onViewChange}
        />
        <p className={styles.visuallyHidden}>
          The matrix is a visual summary; the candidate table and each pair's sheet carry the same
          statistics accessibly.
        </p>
        <PairsMatrix report={report} view={view} onOpenPair={onOpenPair} />
        <p className={styles.caption}>
          {view === 'correlation'
            ? 'Shading by the strength of correlation over the training window: blue with, grey against.'
            : 'Shading by the cointegration test: solid under the 1% level, mid under 5%, faint otherwise.'}{' '}
          Empty cells lacked shared history. Select a cell for the pair's statistics.
        </p>
      </section>

      {openPair === undefined ? null : (
        <PairSheet report={report} pairKey={openPair} legs={legs} onClose={onClosePair} />
      )}
    </div>
  );
}
