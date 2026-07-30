/**
 * The live surface (integration plan §4, slice 5): the nightly report's
 * three panels: the spread and z-score panel per deployed pair, the leg
 * execution and imbalance tracker, and the risk and P&L summary, with
 * the weekly monitor's strip beneath. The engine acts, this screen
 * observes: a halted reconciliation renders loudly, a stale report says
 * so, and nothing here can move money. The copy describes the engine's
 * own targets, positions and limits, advising no one.
 */
import type {
  DailyPair,
  PairsDailyCollection,
  WeeklyMonitoringReport
} from '@plainsight/api-contract';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';

import { Placeholder } from '../../components/Placeholder';
import * as placeholderStyles from '../../components/placeholder.css';
import { formatFetchTime, formatPValue, formatRatio } from './format';
import * as backtestStyles from './backtest.css';
import * as pairsStyles from './pairs.css';
import * as styles from './live.css';
import { PnlChart, ZChart } from './LiveCharts';

const STALE_AFTER_DAYS = 4;

const money = (value: number): string =>
  value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface LiveScreenProps {
  status: 'loading' | 'signed_out' | 'error' | 'ready';
  errorMessage: string | undefined;
  onRetry: () => void;
  collection: PairsDailyCollection | undefined;
  weekly: WeeklyMonitoringReport | undefined;
  fetchedAt: number | undefined;
  online: boolean;
  staleDays: number;
  focusPair: string | undefined;
  onFocusPair: (ticker1: string, ticker2: string) => void;
}

function StatRow({ label, value, tone }: { label: string; value: string; tone?: 'investigate' | 'flag' }): ReactElement {
  const valueClass =
    tone === 'flag'
      ? styles.statValueFlag
      : tone === 'investigate'
        ? styles.statValueInvestigate
        : styles.statValue;
  return (
    <div className={styles.stat}>
      <dt className={styles.statLabel}>{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}

export function LiveScreen({
  status,
  errorMessage,
  onRetry,
  collection,
  weekly,
  fetchedAt,
  online,
  staleDays,
  focusPair,
  onFocusPair
}: LiveScreenProps): ReactElement {
  if (status === 'signed_out') {
    return (
      <Placeholder
        title="Sign in to read the sleeve"
        note="The live surface reads the engine's published artefacts through your account."
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
    return <p className={pairsStyles.quiet}>Loading the latest nightly report…</p>;
  }
  const report = collection.latest;
  if (report === null) {
    return (
      <Placeholder
        title="No nightly report published yet"
        note="Run the engine's compute against the paper login and publish the daily artefact; the live surface renders the latest run."
      />
    );
  }

  const focused: DailyPair =
    report.pairs.find((row) => `${row.ticker1}-${row.ticker2}` === focusPair) ?? report.pairs[0]!;
  const { pnl, reconciliation, assumptions } = report;
  const drawdownBeyondLimit = Math.abs(pnl.drawdownPct) > pnl.declaredMaxDrawdownPct;
  const lastDaily = pnl.daily.at(-1) ?? 0;

  return (
    <div className={pairsStyles.screen}>
      <header>
        <h1 className={pairsStyles.title}>Live book</h1>
        <p className={pairsStyles.provenance}>
          Nightly report <span className={pairsStyles.figure}>{report.runDate}</span>
          {report.paper ? ' · paper login' : ' · live login'} · engine{' '}
          <span className={pairsStyles.figure}>{report.engineVersion}</span>
          {fetchedAt === undefined ? null : (
            <>
              {' '}
              · fetched <span className={pairsStyles.figure}>{formatFetchTime(fetchedAt)}</span>
            </>
          )}
          {online ? null : ' · offline, showing the last fetch'}
        </p>
        {staleDays > STALE_AFTER_DAYS ? (
          <p className={styles.staleBanner} role="status">
            The last nightly report is {staleDays} days old; the compute job may not have run.
            Check the engine before reading anything below as current.
          </p>
        ) : null}
        {reconciliation.status === 'halted' ? (
          <div className={styles.haltBanner} role="alert">
            <strong>Halted with no orders.</strong> The book and the broker disagree
            {reconciliation.mismatches.length > 0
              ? `: ${reconciliation.mismatches
                  .map((entry) => `${entry.ticker} (book ${entry.book}, broker ${entry.broker})`)
                  .join('; ')}`
              : ''}
            . The engine refuses to trade until a human resolves the book and clears the halt.
          </div>
        ) : reconciliation.status === 'unchecked' ? (
          <p className={pairsStyles.caption}>
            No execute run has reconciled this book yet; targets exist, orders have not.
          </p>
        ) : null}
      </header>

      <section>
        <h2 className={pairsStyles.sectionTitle}>Spread and z-score</h2>
        {report.pairs.length > 1 ? (
          <div className={styles.pairPicker}>
            {report.pairs.map((row) => {
              const key = `${row.ticker1}-${row.ticker2}`;
              const isFocused = row === focused;
              return (
                <button
                  key={key}
                  type="button"
                  className={isFocused ? styles.pairChipActive : styles.pairChip}
                  aria-pressed={isFocused}
                  onClick={() => onFocusPair(row.ticker1, row.ticker2)}
                >
                  {key}
                </button>
              );
            })}
          </div>
        ) : null}
        <p className={pairsStyles.caption}>
          <span className={styles.zFigure}>{formatRatio(focused.z)}σ</span>
          {focused.stoodDown
            ? ' · stood down until the spread re-enters the exit band'
            : focused.heldUnits !== 0
              ? ` · holding ${String(focused.heldUnits)} unit(s), day ${String(focused.daysHeld)}`
              : ' · flat'}
          {' · '}spread {formatRatio(focused.spread)} against a {assumptions.lookbackDays}-day mean
          of {formatRatio(focused.spreadMean)} (deviation {formatRatio(focused.spreadStd)}). Entry
          beyond ±{formatRatio(assumptions.entryZ)}σ, exit inside {formatRatio(assumptions.exitZ)}
          σ, abandon past {formatRatio(assumptions.stopZ)}σ or after {assumptions.maxHoldDays}{' '}
          days.
        </p>
        <ZChart pair={focused} assumptions={assumptions} />
      </section>

      <section>
        <h2 className={pairsStyles.sectionTitle}>Leg execution and imbalance</h2>
        <p className={pairsStyles.caption}>
          Targets are tomorrow's instruction to the execute job; held is the book after its last
          run. A nonzero imbalance is work the morning job has not done yet, or could not do.
        </p>
        <table className={styles.legsTable}>
          <thead>
            <tr>
              <th scope="col" className={backtestStyles.textHead}>
                Leg
              </th>
              <th scope="col" className={backtestStyles.numericHead}>
                Target shares
              </th>
              <th scope="col" className={backtestStyles.numericHead}>
                Held shares
              </th>
              <th scope="col" className={backtestStyles.numericHead}>
                Imbalance
              </th>
            </tr>
          </thead>
          <tbody>
            {focused.legs.map((leg) => {
              const imbalance = leg.targetShares - leg.heldShares;
              return (
                <tr key={leg.ticker}>
                  <td className={backtestStyles.tradeCell}>{leg.ticker}</td>
                  <td className={backtestStyles.numericCell}>{leg.targetShares}</td>
                  <td className={backtestStyles.numericCell}>{leg.heldShares}</td>
                  <td
                    className={
                      imbalance === 0 ? backtestStyles.numericCell : styles.imbalanceCell
                    }
                  >
                    {imbalance === 0 ? '0' : `${imbalance > 0 ? '+' : ''}${String(imbalance)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <h3 className={backtestStyles.tradesHeading}>Fills</h3>
        {report.fills.length === 0 ? (
          <p className={pairsStyles.quiet}>No fills recorded yet.</p>
        ) : (
          <div className={backtestStyles.tradeScroller}>
            <table className={backtestStyles.table}>
              <thead>
                <tr>
                  <th scope="col" className={backtestStyles.textHead}>
                    Filled
                  </th>
                  <th scope="col" className={backtestStyles.textHead}>
                    Leg
                  </th>
                  <th scope="col" className={backtestStyles.numericHead}>
                    Shares
                  </th>
                  <th scope="col" className={backtestStyles.numericHead}>
                    Price
                  </th>
                  <th scope="col" className={backtestStyles.numericHead}>
                    Reference close
                  </th>
                  <th scope="col" className={backtestStyles.numericHead}>
                    Slippage
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...report.fills].reverse().map((fill, index) => (
                  <tr key={`${fill.filledOn}-${fill.ticker}-${String(index)}`}>
                    <td className={backtestStyles.tradeCell}>{fill.filledOn}</td>
                    <td className={backtestStyles.tradeCell}>{fill.ticker}</td>
                    <td className={backtestStyles.numericCell}>
                      {fill.shares > 0 ? '+' : ''}
                      {fill.shares}
                    </td>
                    <td className={backtestStyles.numericCell}>{money(fill.price)}</td>
                    <td className={backtestStyles.numericCell}>{money(fill.referenceClose)}</td>
                    <td className={backtestStyles.numericCell}>
                      {formatRatio(fill.slippageBps)} bps
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={pairsStyles.caption}>
          Realised cost per side:{' '}
          {pnl.realisedCostBpsPerSide === null
            ? 'no fills yet'
            : `${formatRatio(pnl.realisedCostBpsPerSide)} bps against the modelled ${formatRatio(pnl.modelledCostBpsPerSide)} bps`}
          ; limit orders cap {formatRatio(report.limitCapBps)} bps through the touch.
        </p>
      </section>

      <section>
        <h2 className={pairsStyles.sectionTitle}>Risk and P&L</h2>
        <PnlChart pnl={pnl} />
        <dl className={styles.stats}>
          <StatRow label="Cumulative P&L" value={money(pnl.cumulative.at(-1) ?? 0)} />
          <StatRow label="Latest day" value={money(lastDaily)} />
          <StatRow
            label={`Drawdown against the declared ${formatRatio(pnl.declaredMaxDrawdownPct)}%`}
            value={`${formatRatio(pnl.drawdownPct)}%`}
            {...(drawdownBeyondLimit ? { tone: 'flag' as const } : {})}
          />
          <StatRow label="Worst drawdown" value={`${formatRatio(pnl.maxDrawdownPct)}%`} />
          <StatRow label="Gross exposure" value={money(pnl.grossExposure)} />
          <StatRow
            label="Stops fired"
            value={String(pnl.stopsFired)}
            {...(pnl.stopsFired > 0 ? { tone: 'investigate' as const } : {})}
          />
          <StatRow label="Round trips" value={String(pnl.roundTrips)} />
        </dl>
        <p className={pairsStyles.caption}>
          The engine line replays the rule on the same closes with modelled costs; the live line is
          the book as it was actually held. A gap between them is the finding, not a performance.
        </p>

        <h3 className={backtestStyles.tradesHeading}>Weekly monitor</h3>
        {weekly === undefined ? (
          <p className={pairsStyles.quiet}>No weekly monitor published yet.</p>
        ) : (
          <>
            <table className={styles.legsTable}>
              <thead>
                <tr>
                  <th scope="col" className={backtestStyles.textHead}>
                    Pair
                  </th>
                  <th scope="col" className={backtestStyles.numericHead}>
                    Cointegration p now
                  </th>
                  <th scope="col" className={backtestStyles.numericHead}>
                    Beta drift
                  </th>
                  <th scope="col" className={backtestStyles.numericHead}>
                    Tracking error
                  </th>
                </tr>
              </thead>
              <tbody>
                {weekly.pairs.map((row) => (
                  <tr key={`${row.ticker1}-${row.ticker2}`}>
                    <td className={backtestStyles.tradeCell}>
                      {row.ticker1}–{row.ticker2}
                    </td>
                    <td
                      className={
                        row.pValueNow >= 0.05
                          ? styles.imbalanceCell
                          : backtestStyles.numericCell
                      }
                    >
                      {formatPValue(row.pValueNow)}
                    </td>
                    <td className={backtestStyles.numericCell}>
                      {formatRatio(row.betaDriftPct)}%
                    </td>
                    <td className={backtestStyles.numericCell}>
                      {row.trackingErrorBps === null
                        ? 'n/a'
                        : `${formatRatio(row.trackingErrorBps)} bps`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {weekly.correlations.length > 0 ? (
              <p className={pairsStyles.caption}>
                Pair-to-pair correlation:{' '}
                {weekly.correlations
                  .map((entry) => `${entry.pairA} with ${entry.pairB} ${formatRatio(entry.correlation)}`)
                  .join('; ')}
                . The plan watches for anything above 0.3.
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
