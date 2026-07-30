/**
 * The live surface's two charts: the trailing z-score with the rule's
 * bands, and cumulative live P&L against the engine's replay. Both state
 * a history without performing one (animation off), and both hide from
 * the accessibility tree; the captions and stat rows beside them carry
 * the same numbers as text.
 */
import type { DailyPair, DailyPairsReport } from '@plainsight/api-contract';
import type { ReactElement } from 'react';
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis
} from 'recharts';

import { colour } from '../../styles/tokens.css';
import * as styles from './live.css';

export function ZChart({
  pair,
  assumptions
}: {
  pair: DailyPair;
  assumptions: DailyPairsReport['assumptions'];
}): ReactElement {
  const points = pair.zSeries.dates.map((date, index) => ({
    date,
    z: pair.zSeries.values[index] ?? null
  }));
  const bands = [
    { value: assumptions.entryZ, stroke: colour.textSecondary, dash: '4 3' },
    { value: -assumptions.entryZ, stroke: colour.textSecondary, dash: '4 3' },
    { value: assumptions.exitZ, stroke: colour.border, dash: '2 3' },
    { value: -assumptions.exitZ, stroke: colour.border, dash: '2 3' },
    { value: assumptions.stopZ, stroke: colour.investigate, dash: '6 3' },
    { value: -assumptions.stopZ, stroke: colour.investigate, dash: '6 3' }
  ];
  return (
    <div className={styles.chartFrame} aria-hidden="true">
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="date"
            interval="preserveStartEnd"
            minTickGap={80}
            tick={{ fontSize: 11, fill: colour.textSecondary }}
            tickLine={false}
            axisLine={{ stroke: colour.border }}
          />
          <YAxis
            width={36}
            domain={['auto', 'auto']}
            tick={{ fontSize: 11, fill: colour.textSecondary }}
            tickFormatter={(value: number) => value.toFixed(1)}
            tickLine={false}
            axisLine={false}
          />
          {bands.map((band) => (
            <ReferenceLine
              key={band.value}
              y={band.value}
              stroke={band.stroke}
              strokeDasharray={band.dash}
            />
          ))}
          <Line
            dataKey="z"
            stroke={colour.accent}
            dot={false}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PnlChart({ pnl }: { pnl: DailyPairsReport['pnl'] }): ReactElement {
  const points = pnl.dates.map((date, index) => ({
    date,
    live: pnl.cumulative[index] ?? null,
    engine: pnl.engineCumulative[index] ?? null
  }));
  return (
    <div className={styles.chartFrame} aria-hidden="true">
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="date"
            interval="preserveStartEnd"
            minTickGap={80}
            tick={{ fontSize: 11, fill: colour.textSecondary }}
            tickLine={false}
            axisLine={{ stroke: colour.border }}
          />
          <YAxis
            width={56}
            domain={['auto', 'auto']}
            tick={{ fontSize: 11, fill: colour.textSecondary }}
            tickFormatter={(value: number) => value.toFixed(0)}
            tickLine={false}
            axisLine={false}
          />
          <ReferenceLine y={0} stroke={colour.border} />
          <Line
            dataKey="engine"
            stroke={colour.chartSeries3}
            dot={false}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            isAnimationActive={false}
          />
          <Line
            dataKey="live"
            stroke={colour.accent}
            dot={false}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
