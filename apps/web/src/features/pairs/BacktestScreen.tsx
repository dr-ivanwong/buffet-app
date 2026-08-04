/**
 * The backtest surface (integration plan §4, slice 4): every candidate
 * pair's train and holdout results with the windows visibly separate,
 * the assumptions and the stated criteria beside the outcomes, and the
 * trade lists that reconcile to the curves. Education framing: the
 * screen describes what the engine measured and never advises; a pair's
 * go or no-go reads the way the pairs plan states it, as met and unmet
 * gates, not buttons.
 */
import type { BacktestPair, PairsBacktestCollection } from '@plainsight/api-contract';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';

import { Placeholder } from '../../components/Placeholder';
import * as placeholderStyles from '../../components/placeholder.css';
import { EquityChart } from './EquityChart';
import { formatFetchTime, formatPValue, formatRatio } from './format';
import type { LegIndex } from './legs';
import * as pairsStyles from './pairs.css';
import * as styles from './backtest.css';

const REASON_WORDS: Record<string, string> = {
  exitBand: 'exit band',
  zStop: 'z-stop',
  timeStop: 'time stop',
  windowEnd: 'window end'
};

const pct = (value: number): string => `${value.toFixed(1)}%`;

export interface BacktestScreenProps {
  status: 'loading' | 'signed_out' | 'error' | 'ready';
  errorMessage: string | undefined;
  onRetry: () => void;
  collection: PairsBacktestCollection | undefined;
  fetchedAt: number | undefined;
  online: boolean;
  legs: LegIndex;
  focusPair: string | undefined;
  onFocusPair: (ticker1: string, ticker2: string) => void;
}

function Gate({ label, met }: { label: string; met: boolean }): ReactElement {
  return (
    <li className={styles.gate}>
      <span className={met ? styles.gateMet : styles.gateUnmet}>{met ? 'met' : 'not met'}</span>
      <span>{label}</span>
    </li>
  );
}

function StatRow({
  label,
  train,
  holdout
}: {
  label: string;
  train: string;
  holdout: string;
}): ReactElement {
  return (
    <tr>
      <th scope="row" className={styles.statLabel}>
        {label}
      </th>
      <td className={styles.statValue}>{train}</td>
      <td className={styles.statValue}>{holdout}</td>
    </tr>
  );
}

export function BacktestScreen({
  status,
  errorMessage,
  onRetry,
  collection,
  fetchedAt,
  online,
  legs,
  focusPair,
  onFocusPair
}: BacktestScreenProps): ReactElement {
  if (status === 'signed_out') {
    return (
      <Placeholder
        title="Sign in to read the sleeve"
        note="The backtest surface reads the engine's published artefacts through your account."
      >
        <Link className={placeholderStyles.link} to="/settings">
          Go to Settings
        </Link>
      </Placeholder>
    );
  }
  if (status === 'error') {
    return (
      <Placeholder title="The sleeve could not be read" note={errorMessage ?? 'The last fetch failed.'}>
        <button type="button" className={pairsStyles.retry} onClick={onRetry}>
          Retry
        </button>
      </Placeholder>
    );
  }
  if (status === 'loading' || collection === undefined) {
    return <p className={pairsStyles.quiet}>Loading the latest backtest…</p>;
  }
  const report = collection.latest;
  if (report === null) {
    return (
      <Placeholder
        title="No backtest published yet"
        note="Run the engine's backtest over a published scan and publish its artefact; the surface renders the latest run."
      />
    );
  }
  if (report.pairs.length === 0) {
    return (
      <Placeholder
        title="No candidates to backtest"
        note="The scan this run read carried no candidate pairs; the surface has nothing to validate."
      />
    );
  }

  const focused: BacktestPair =
    report.pairs.find((row) => `${row.ticker1}-${row.ticker2}` === focusPair) ?? report.pairs[0]!;
  const { assumptions, criteria } = report;
  const leg1 = legs.get(focused.ticker1);
  const leg2 = legs.get(focused.ticker2);

  return (
    <div className={pairsStyles.screen}>
      <header>
        <h1 className={pairsStyles.title}>Backtest</h1>
        <p className={pairsStyles.provenance}>
          Run <span className={pairsStyles.figure}>{report.runDate}</span> over scan{' '}
          <span className={pairsStyles.figure}>{report.scanRunDate}</span> · engine{' '}
          <span className={pairsStyles.figure}>{report.engineVersion}</span>
          {report.closesSource == null ? null : (
            <> · closes from <span className={pairsStyles.figure}>{report.closesSource}</span></>
          )}
          {fetchedAt === undefined ? null : (
            <>
              {' '}
              · fetched <span className={pairsStyles.figure}>{formatFetchTime(fetchedAt)}</span>
            </>
          )}
          {online ? null : ' · offline, showing the last fetch'}
        </p>
        <p className={pairsStyles.caption}>
          Net of costs by construction: {formatRatio(assumptions.costBpsPerSide)} basis points a
          side on the gross notional of every entry and exit, and{' '}
          {formatRatio(assumptions.borrowBpsPerAnnum)} basis points a year of borrow on the short
          leg. Entry beyond ±{formatRatio(assumptions.entryZ)}σ, exit inside{' '}
          {formatRatio(assumptions.exitZ)}σ, abandon past {formatRatio(assumptions.stopZ)}σ or
          after {assumptions.maxHoldDays} days, statistics on a {assumptions.lookbackDays}-day
          rolling window. The training window fitted everything; the holdout after{' '}
          <span className={pairsStyles.figure}>{report.window.splitDate}</span> is spent once and
          was touched by nothing.
        </p>
      </header>

      <section>
        <h2 className={pairsStyles.sectionTitle}>Pairs</h2>
        <p className={pairsStyles.caption}>
          The stated criteria, not buttons: significance under{' '}
          {formatRatio(criteria.maxPreselectionPValue)}; training Sharpe above{' '}
          {formatRatio(criteria.trainMinSharpe)}, drawdown no worse than{' '}
          {pct(criteria.trainMaxDrawdownPct)}, win rate above {pct(criteria.trainMinWinRatePct)};
          holdout Sharpe above {formatRatio(criteria.holdoutMinSharpe)}.
        </p>
        <div className={styles.scroller}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.textHead}>
                  Pair
                </th>
                <th scope="col" className={styles.numericHead}>
                  Train Sharpe
                </th>
                <th scope="col" className={styles.numericHead}>
                  Train max DD
                </th>
                <th scope="col" className={styles.numericHead}>
                  Win rate
                </th>
                <th scope="col" className={styles.numericHead}>
                  Holdout Sharpe
                </th>
                <th scope="col" className={styles.textHead}>
                  Verdict
                </th>
              </tr>
            </thead>
            <tbody>
              {report.pairs.map((row) => {
                const key = `${row.ticker1}-${row.ticker2}`;
                const isFocused = row === focused;
                return (
                  <tr key={key} className={isFocused ? styles.focusedRow : undefined}>
                    <td className={styles.pairCell}>
                      <button
                        type="button"
                        className={styles.pairButton}
                        aria-pressed={isFocused}
                        onClick={() => onFocusPair(row.ticker1, row.ticker2)}
                      >
                        {row.ticker1}–{row.ticker2}
                      </button>
                    </td>
                    <td className={styles.numericCell}>{formatRatio(row.train.annualSharpe)}</td>
                    <td className={styles.numericCell}>{pct(row.train.maxDrawdownPct)}</td>
                    <td className={styles.numericCell}>{pct(row.train.winRatePct)}</td>
                    <td className={styles.numericCell}>{formatRatio(row.holdout.annualSharpe)}</td>
                    <td className={styles.verdictCell}>
                      {row.selected ? 'Selected' : 'Not selected'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className={pairsStyles.sectionTitle}>
          {focused.ticker1}–{focused.ticker2}
        </h2>
        <p className={pairsStyles.caption}>
          Equity per dollar of one-unit capital, each window from its own start; the shaded stretch
          is the holdout, which selection never touched. Hedge ratio{' '}
          <span className={pairsStyles.figure}>{formatRatio(focused.beta)}</span>, scan p-value{' '}
          <span className={pairsStyles.figure}>{formatPValue(focused.scanPValue)}</span>.
        </p>
        <EquityChart pair={focused} />
        <table className={styles.statsTable}>
          <thead>
            <tr>
              <th scope="col" className={styles.statLabel} />
              <th scope="col" className={styles.statHead}>
                Training
              </th>
              <th scope="col" className={styles.statHead}>
                Holdout
              </th>
            </tr>
          </thead>
          <tbody>
            <StatRow
              label="Window"
              train={`${focused.train.start} to ${focused.train.end}`}
              holdout={`${focused.holdout.start} to ${focused.holdout.end}`}
            />
            <StatRow
              label="Annualised Sharpe"
              train={formatRatio(focused.train.annualSharpe)}
              holdout={formatRatio(focused.holdout.annualSharpe)}
            />
            <StatRow
              label="Total return"
              train={pct(focused.train.totalReturnPct)}
              holdout={pct(focused.holdout.totalReturnPct)}
            />
            <StatRow
              label="Max drawdown"
              train={pct(focused.train.maxDrawdownPct)}
              holdout={pct(focused.holdout.maxDrawdownPct)}
            />
            <StatRow
              label="Win rate"
              train={pct(focused.train.winRatePct)}
              holdout={pct(focused.holdout.winRatePct)}
            />
            <StatRow
              label="Round trips"
              train={String(focused.train.tradeCount)}
              holdout={String(focused.holdout.tradeCount)}
            />
            <StatRow
              label="Profit factor"
              train={formatRatio(focused.train.profitFactor)}
              holdout={formatRatio(focused.holdout.profitFactor)}
            />
          </tbody>
        </table>

        <h3 className={styles.verdictHeading}>
          {focused.selected ? 'Selected' : 'Not selected'}
        </h3>
        <ul className={styles.gates}>
          <Gate
            label={`Scan significance under ${formatRatio(criteria.maxPreselectionPValue)}`}
            met={focused.gates.significance}
          />
          <Gate
            label={`Training Sharpe above ${formatRatio(criteria.trainMinSharpe)}`}
            met={focused.gates.trainSharpe}
          />
          <Gate
            label={`Training drawdown no worse than ${pct(criteria.trainMaxDrawdownPct)}`}
            met={focused.gates.trainDrawdown}
          />
          <Gate
            label={`Training win rate above ${pct(criteria.trainMinWinRatePct)}`}
            met={focused.gates.trainWinRate}
          />
          <Gate
            label={`Holdout Sharpe above ${formatRatio(criteria.holdoutMinSharpe)}`}
            met={focused.gates.holdoutSharpe}
          />
        </ul>

        <p className={pairsStyles.caption}>
          {leg1 !== undefined && leg2 !== undefined ? (
            <>
              Both legs live in the library:{' '}
              <Link to="/company/$id" params={{ id: leg1.companyId }} className={styles.legLink}>
                {focused.ticker1}
              </Link>{' '}
              and{' '}
              <Link to="/company/$id" params={{ id: leg2.companyId }} className={styles.legLink}>
                {focused.ticker2}
              </Link>
              ,{' '}
              <Link
                to="/compare"
                search={{ ids: `${leg1.companyId},${leg2.companyId}` }}
                className={styles.legLink}
              >
                side by side
              </Link>
              .
            </>
          ) : (
            'A leg outside the library has no statements to qualify it; the research surface carries the join.'
          )}
        </p>

        <h3 className={styles.tradesHeading}>Round trips</h3>
        <div className={styles.tradeScroller}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.textHead}>
                  Window
                </th>
                <th scope="col" className={styles.textHead}>
                  Entry
                </th>
                <th scope="col" className={styles.textHead}>
                  Exit
                </th>
                <th scope="col" className={styles.textHead}>
                  Side
                </th>
                <th scope="col" className={styles.numericHead}>
                  Days
                </th>
                <th scope="col" className={styles.numericHead}>
                  Net P&L
                </th>
                <th scope="col" className={styles.textHead}>
                  Close
                </th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['training', focused.train.trades],
                  ['holdout', focused.holdout.trades]
                ] as const
              ).flatMap(([window, trades]) =>
                trades.map((trade) => (
                  <tr key={`${window}-${trade.entryDate}`}>
                    <td className={styles.tradeCell}>{window}</td>
                    <td className={styles.tradeCell}>{trade.entryDate}</td>
                    <td className={styles.tradeCell}>{trade.exitDate ?? 'open at end'}</td>
                    <td className={styles.tradeCell}>
                      {trade.direction === 1 ? 'long spread' : 'short spread'}
                    </td>
                    <td className={styles.numericCell}>{trade.daysHeld}</td>
                    <td className={styles.numericCell}>{trade.pnl.toFixed(2)}</td>
                    <td className={styles.tradeCell}>
                      {REASON_WORDS[trade.exitReason] ?? trade.exitReason}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
