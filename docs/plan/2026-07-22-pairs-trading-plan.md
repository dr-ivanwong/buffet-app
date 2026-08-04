# Pairs Trading Strategy: Proof-of-Concept Plan
## Bootstrap Quant Fund | $100K POC Capital | 1 Engineer

**Date:** 2026-07-22
**Status:** draft strategy proposal, awaiting owner review; revised 2026-07-22 after the same-day review (corrected P&L accounting, a clean train-and-holdout protocol, an audited ticker universe, a reconciling execution loop). Not part of the authority set (CLAUDE.md's plan table): nothing here supersedes the pinned decisions, and the product keeps manual price entry (main plan §12.1) and its education-only posture (main plan §15). This document describes a separately operated trading experiment, not a Plainsight feature; if any part of it is ever built against this repository, it arrives through its own decision-log entry. A second pass the same day added per-pair stops, dividend-adjusted data with short-leg carry, the data licensing terms, an outside-capital gate, and a decision framework sized to what 12 weeks can measure. Remaining limits, accepted for a proof of concept and stated where they bite: the event stop cannot be exercised in a price-only backtest, the universe is today's constituents (survivorship, noted in Week 1), and franking's after-tax drag is flagged rather than modelled.

---

## Executive Summary

**Goal:** Prove the pairs trading edge exists via 16-week proof-of-concept before scaling to $500K-$1M.

**Two-Stage Approach:**

**Stage 1: Validation (Weeks 1-8, data subscription only)**
- Weeks 1-2: Identify 5-10 cointegrated pairs
- Weeks 3-4: Validate pairs via backtesting
- Weeks 5-8: Paper trading (live system, simulated capital)

**Stage 2: POC (Weeks 9-20, $100K capital)**
- Weeks 9-12: Live trading, 2 pairs, $60K deployed
- Weeks 13-20: Monitor + scale to 3 pairs, $80-100K deployed
- Week 20: Go/no-go decision on scaling to $500K

**Capital Allocation:**
- Research/backtest: one paid EOD data plan (ASX is not in the free tier)
- Paper trading: FREE (IB sim account)
- Live POC: $100K across 2-3 pairs
- Monthly costs: roughly AUD $50 to $100 (EOD data plan plus IB's ASX market data feed); confirm tiers in Week 1

**Success criteria for the POC (sized to what 12 weeks can measure):**
- Execution validated: realised cost per round trip at or under the engine's `cost_bps`; live daily P&L tracks the engine on the same closes
- Operations clean: zero unresolved reconciliation breaks or unfilled legs
- Risk conformant: max drawdown < 12%; stops fired as specified
- Sharpe point estimate positive, reported with its confidence interval; 12 weeks cannot confirm the edge and these criteria do not pretend it can

**Outcome at Week 20:**
- If POC succeeds: **Scale to $500K-$1M AUM**
- If POC fails: **Pivot to Strategy #2 or iterate on pairs selection**
- Cost of learning if wrong: $100K (acceptable risk cost)

---

## PHASE 1: RESEARCH (Weeks 1–2)
### Find Cointegrated Pairs

### Week 1: Data Collection & Cointegration Testing

#### Objectives
- Download 5 years of daily EOD data for top 50 ASX stocks
- Test all pairs for statistical cointegration
- Identify 10-20 candidate pairs with p-value < 0.05

#### Detailed Steps

##### Step 1.1: Set Up Environment
```bash
# Create project directory
mkdir pairs_trading_system
cd pairs_trading_system

# Create Python environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install pandas numpy scipy statsmodels matplotlib scikit-learn
```

##### Step 1.2: Download Data
Use one of these sources (pick ONE):

**Option A: EODHD (Easiest)**
```python
# The free tier is rate limited and covers demo tickers only; ASX
# coverage needs a paid plan. Confirm the tier and its terms before
# Week 1, and again before any outside capital arrives: personal-use
# data terms do not cover managing someone else's money.

from eodhdc import EODHDClient
import pandas as pd

client = EODHDClient("requests", key="YOUR_API_KEY")

# Top 50 ASX stocks by market cap
candidates = [
    'CBA', 'NAB', 'ANZ', 'WBC', 'BOQ',                    # Banks (5)
    'BHP', 'RIO', 'FMG', 'NST', 'S32',                    # Miners (5)
    'CSL', 'WES', 'COL', 'SHL', 'AZJ',                    # Healthcare/Diversified (5)
    'TLS', 'ORG', 'TCL', 'APA', 'STO',                    # Utilities/Energy (5)
    'MQG', 'ALL', 'QBE', 'NHF', 'MGR',                    # Financials/Services (5)
    'AGL', 'ASX', 'IAG', 'ILU', 'GMG',                    # Energy/Materials (5)
    'SEK', 'CGF', 'ALX', 'CDA', 'WHC',                    # Diversified (5)
    'DXS', 'REA', 'ORI', 'SCG', 'VCX',                    # Real Estate/Services (5)
    'EVN', 'LLC', 'GPT', 'WOW', 'CWY',                    # Retail/Energy (5)
    'NXT', 'WTC', 'SGP', 'EQT', 'XRO',                    # Growth/Tech (5)
]

data = {}
for ticker in candidates:
    try:
        df = client.market.historical(
            f'{ticker}.AU',
            start='2019-01-01',
            end='2024-01-01',
            fmt='json'
        )
        df_pd = pd.DataFrame(df)
        df_pd['date'] = pd.to_datetime(df_pd['date'])
        # Adjusted closes, always: raw bank prices drop 2-3% on every
        # ex-dividend date, which manufactures fake mean reversion in
        # the backtest and fake signals live.
        data[ticker] = df_pd.set_index('date')['adjusted_close']
        print(f"✓ {ticker}: {len(df_pd)} days")
    except Exception as e:
        print(f"✗ {ticker}: {e}")

missing = [ticker for ticker in candidates if ticker not in data]
if missing:
    raise SystemExit(f"No data for {missing}: fix the universe before testing pairs")

# Save to CSV for backup
for ticker, series in data.items():
    series.to_csv(f'data/{ticker}_2019_2024.csv')
```

**Option B: Interactive Brokers**
```python
# More complex but more data sources
# Requires TWS running, minimum $500 account

from ib_insync import IB, Stock
import pandas as pd
import asyncio

async def get_historical(ticker):
    ib = IB()
    await ib.connectAsync('127.0.0.1', 7497)
    
    contract = Stock(ticker, 'ASX', 'AUD')
    bars = await ib.reqHistoricalDataAsync(
        contract,
        endDateTime='',
        durationStr='5 Y',
        barSizeSetting='1 day',
        whatToShow='ADJUSTED_LAST',  # dividend and split adjusted
        useRTH=True
    )
    
    df = pd.DataFrame([(b.date, b.close) for b in bars], 
                      columns=['date', 'close'])
    df.set_index('date', inplace=True)
    
    await ib.disconnectAsync()
    return df['close']

# Download all tickers
for ticker in candidates:
    data[ticker] = asyncio.run(get_historical(ticker))
```

**Deliverable:** 
- Data files: `data/{TICKER}_2019_2024.csv` (50 files)
- Files may start on different dates; every pair test aligns the two series on their shared dates
- Check: every candidate downloaded (the loop aborts on any missing ticker)

**Universe audit (2026-07-22).** The list above was checked ticker by ticker against the ASX listed-companies directory as at 2026-07-22. Nine entries in the original draft failed the check and were replaced with current large caps: APT, AWC, SKI and URW have delisted, JHG's CDIs have been withdrawn, GLD and ASR are not ASX codes, VAS is an ETF rather than a company, and DXN is a data-centre micro-cap where DXS (Dexus) was plainly meant. Re-run the same audit whenever this plan is picked up: tickers rename (WPL became WDS in 2022) and delist, and a downloader that skips failures quietly shrinks the universe. One limit the audit does not cure: choosing today's constituents for a five-year backtest is survivorship bias, and a fully honest run reconstructs membership as at each historical date. This proof of concept accepts that as a known simplification.

**Data licensing (confirm before Week 1).** *(Amended 2026-07-30 by owner decision: the research phase, Weeks 1 to 4, may run on Yahoo's unofficial chart feed at zero cost, prove-before-paying. That feed is unlicensed automated access with no guarantees, accepted knowingly for personal research only; its classic failure, a missing dividend or misapplied split, manufactures exactly the fake mean reversion this plan warns about, so the engine stamps every artefact with its close source, warns loudly on absurd one-day adjusted moves, and swaps sources with one flag. Licensed closes, the EOD plan below or the broker's own historical bars once the IB account exists, are mandatory before paper trading marks a book: no live or paper P&L is ever marked on the unofficial feed.)* Three agreements govern this plan's data, and none is optional. First, EOD history: ASX coverage on EODHD or an equivalent requires a paid plan (the free tier covers demo tickers only), the standard plans are personal-use, and managing outside capital is commercial use under most vendor terms, so the licence question returns at the Week 20 scale-up rather than staying settled at signup; redistribution, including serving vendor data to a backer's dashboard, is separately restricted. Second, IB market data: the execute job's snapshot quotes need an ASX market data subscription, priced at the non-professional rate only while the capital is the operator's own; trading someone else's money generally reclassifies the subscriber as professional at materially higher fees. Third, the ASX directory file used for the universe audit is free to read, carries no price data, and grants nothing further. Line the actual invoices up against the monthly estimate in the summary once tiers are confirmed; where they disagree, the summary is what is wrong.

---

##### Step 1.3: Test All Pairs for Cointegration

```python
import pandas as pd
import numpy as np
from statsmodels.tsa.stattools import coint
import itertools
import os

# Load data
data = {}
for fname in os.listdir('data'):
    ticker = fname.split('_')[0]
    data[ticker] = pd.read_csv(f'data/{fname}', index_col='date', parse_dates=True)['close']

print(f"Loaded {len(data)} tickers\n")

# Freeze the holdout FIRST. Everything below runs on the training window
# only: the final 20% of the calendar stays untouched until Week 4, and it
# is used exactly once. Selecting pairs on the full period and then
# "validating" on its tail validates nothing, because the test data
# already voted.
all_dates = sorted(set().union(*[set(series.index) for series in data.values()]))
split_date = all_dates[int(len(all_dates) * 0.8)]
print(f"Training window ends {split_date.date()}; the holdout begins after it.\n")

# Test cointegration for ALL pairs, on the training window
# Expected: ~C(50,2) = 1,225 pairs
print("Testing pairs for cointegration...")
results = []
pair_count = 0

for ticker1, ticker2 in itertools.combinations(sorted(data.keys()), 2):
    pair_count += 1

    # Align on dates before anything statistical: positional arrays from
    # different listing calendars silently shift one series against the
    # other, and cointegration on shifted series is noise.
    joined = pd.concat([data[ticker1], data[ticker2]], axis=1, join='inner').dropna()
    train = joined[joined.index <= split_date]
    if len(train) < 500:
        continue  # not enough shared training history

    price1 = train.iloc[:, 0].values
    price2 = train.iloc[:, 1].values

    # Engle-Granger cointegration test
    # H0: NOT cointegrated
    # If p < 0.05, reject H0 → they ARE cointegrated
    try:
        score, pvalue, _ = coint(price1, price2)
    except Exception:
        continue

    if pvalue < 0.05:  # Only keep nominally significant pairs
        # Hedge ratio by OLS, on the training window only; the same beta
        # rides unchanged into Week 4's holdout and the live system.
        X = np.column_stack([price2, np.ones(len(price2))])
        coeffs = np.linalg.lstsq(X, price1, rcond=None)[0]
        beta = coeffs[0]

        results.append({
            'ticker1': ticker1,
            'ticker2': ticker2,
            'pvalue': pvalue,
            'beta': beta,
            'correlation': np.corrcoef(price1, price2)[0, 1],
        })

    # Print progress
    if pair_count % 200 == 0:
        print(f"  Tested {pair_count} pairs, found {len(results)} cointegrated")

results_df = pd.DataFrame(results)
results_df = results_df.sort_values('pvalue')

print(f"\n✅ COINTEGRATION TEST COMPLETE")
print(f"Total pairs tested: {pair_count}")
print(f"Cointegrated pairs (p < 0.05): {len(results_df)}")
print(f"\nTop 20 by p-value (strongest):\n")
print(results_df.head(20).to_string(index=False))

# Save results
results_df.to_csv('week1_cointegrated_pairs.csv', index=False)
```

**Acceptance Criteria:**
- [ ] Minimum 20 cointegrated pairs found (p < 0.05)
- [ ] All beta values are positive (same-direction relationship)
- [ ] Results saved to `week1_cointegrated_pairs.csv`

**Deliverable:**
```
week1_cointegrated_pairs.csv

ticker1 ticker2  pvalue    beta  correlation
BHP     RIO      0.00009  1.2345  0.945
NAB     ANZ      0.00023  0.8765  0.932
CBA     NAB      0.00051  0.9123  0.928
...
```

**Caution on the pair count.** Testing 1,225 pairs at p < 0.05 will produce roughly 60 nominal positives by chance alone even if nothing is cointegrated, so a long Week 1 list is expected and by itself means little. Cut the search space before the statistics (prefer pairs with an economic reason to co-move: same sector, same business model), rank on the p < 0.01 tier, and let the untouched holdout, not the p-value, carry the final vote.

---

### Week 2: Metric Calculation & Pair Selection

#### Objectives
- Calculate half-life (how fast spread reverts)
- Calculate Sharpe ratio (historical return per risk)
- Select final 5-10 pairs for backtesting

#### Detailed Steps

##### Step 2.1: Calculate Half-Life

**Concept:** How many days does the spread take to revert halfway back to its mean?

**Formula:**
```
spread_t = spread_0 * exp(-lambda * t)
half_life = -ln(2) / lambda
where lambda is the decay coefficient
```

**Code:**
```python
import pandas as pd
import numpy as np
from scipy import stats

def calculate_half_life(ticker1, ticker2, beta, data, lookback=60):
    """
    Calculate half-life of mean reversion for a spread.
    
    Returns:
        half_life (float): Days to mean revert 50%
        half_life_valid (bool): Is half-life realistic?
    """
    joined = pd.concat([data[ticker1], data[ticker2]], axis=1, join='inner').dropna()
    price1 = joined.iloc[:, 0].values
    price2 = joined.iloc[:, 1].values
    
    # Calculate spread
    spread = price1 - beta * price2
    
    # Normalize for regression
    spread_normalized = (spread - np.mean(spread)) / np.std(spread)
    
    # Regression: spread_t+1 = alpha + lambda * spread_t + error
    # We want: d(spread) = lambda * spread
    spread_diffs = np.diff(spread_normalized)
    spread_lag = spread_normalized[:-1]
    
    # OLS regression
    slope, intercept, r_value, p_value, std_err = stats.linregress(spread_lag, spread_diffs)
    
    # Half-life calculation
    if slope < 0:
        half_life = -np.log(2) / slope
    else:
        # Not mean-reverting (slope >= 0)
        return np.inf, False
    
    # Sanity checks
    valid = (
        0 < half_life < 120 and      # Between 0 and 120 days
        p_value < 0.05 and            # Statistically significant
        abs(r_value) > 0.1             # Some explanatory power
    )
    
    return half_life, valid

# Load cointegrated pairs
pairs_df = pd.read_csv('week1_cointegrated_pairs.csv')

# Weeks 2 and 3 select and tune on the training window only; the holdout
# frozen in Week 1 stays untouched until Week 4.
train_data = {ticker: series[series.index <= split_date] for ticker, series in data.items()}

print("Calculating half-life for all cointegrated pairs...\n")
metrics = []

for idx, row in pairs_df.iterrows():
    ticker1 = row['ticker1']
    ticker2 = row['ticker2']
    beta = row['beta']
    
    try:
        half_life, is_valid = calculate_half_life(ticker1, ticker2, beta, train_data)
        metrics.append({
            'ticker1': ticker1,
            'ticker2': ticker2,
            'pvalue': row['pvalue'],
            'beta': beta,
            'half_life': half_life,
            'half_life_valid': is_valid,
        })
    except Exception as e:
        print(f"Error for {ticker1}-{ticker2}: {e}")

metrics_df = pd.DataFrame(metrics)
print(f"Half-life calculations complete: {len(metrics_df)} pairs\n")
print(metrics_df.sort_values('half_life').head(15).to_string(index=False))

metrics_df.to_csv('week2_metrics_halflife.csv', index=False)
```

**Expected Output:**
```
ticker1 ticker2  pvalue    beta  half_life  half_life_valid
BHP     RIO      0.00009  1.2345      12.3            True
NAB     ANZ      0.00023  0.8765      15.2            True
CBA     NAB      0.00051  0.9123      18.1            True
```

**Interpretation:**
- half_life < 15 days: Excellent (fast reversion = good for trading)
- half_life 15-30 days: Good (acceptable)
- half_life > 30 days: Marginal (too slow, capital idle)
- half_life > 120 days or inf: Bad (not mean-reverting)

---

##### Step 2.2: Calculate Sharpe Ratio

```python
COST_BPS = 15.0  # commission plus expected slippage, per side, on traded notional


def pair_daily_pnl(price1, price2, beta,
                   lookback=60, entry_zscore=2.0, exit_zscore=0.5,
                   stop_zscore=3.5, max_hold_days=60,
                   cost_bps=COST_BPS, borrow_bps_pa=50.0):
    """
    Daily dollar P&L for one spread unit, net of costs.

    One unit is long 1 share of ticker1 and short beta shares of ticker2
    (reversed when short the spread). P&L is dollars on the spread itself:
    yesterday's position earns today's change in the spread. Never use
    pct_change() on a spread; a spread crosses zero, so percentage returns
    on it are undefined and compound into nonsense.

    Feed adjusted prices: the engine assumes dividends and splits are
    folded into both legs, and prices the residual the adjusted series
    cannot carry for you, the borrow fee on the short leg.

    Two per-pair stops guard the classic pairs failure, the spread that
    never comes back. The z-stop abandons a position when the spread blows
    this far past entry: that is more likely a changed relationship than a
    better price. The time stop closes anything held max_hold_days without
    reverting: capital parked in a non-reverting spread is what half-life
    screening was meant to prevent. After either stop the pair stands down
    until the z-score first returns inside the exit band, so a
    still-stretched spread cannot re-enter on the next bar.
    """
    s1 = pd.Series(price1, dtype=float)
    s2 = pd.Series(price2, dtype=float)
    spread = s1 - beta * s2

    mean = spread.rolling(lookback).mean()
    std = spread.rolling(lookback).std()
    z = ((spread - mean) / std).values

    # Explicit position state: enter beyond the entry threshold, hold until
    # the z-score comes back inside the exit band, stop on the z-stop or
    # the time stop.
    position = np.zeros(len(spread))
    stood_down = False
    days_held = 0
    for t in range(lookback, len(spread)):
        held = position[t - 1]
        if stood_down:
            if abs(z[t]) < exit_zscore:
                stood_down = False
            continue  # flat until the spread has actually normalised
        if held == 0:
            days_held = 0
            if z[t] > entry_zscore:
                position[t] = -1.0
            elif z[t] < -entry_zscore:
                position[t] = 1.0
        else:
            days_held += 1
            if abs(z[t]) >= stop_zscore or days_held >= max_hold_days:
                position[t] = 0.0
                stood_down = True
            elif abs(z[t]) < exit_zscore:
                position[t] = 0.0
            else:
                position[t] = held

    pnl = np.zeros(len(spread))
    pnl[1:] = position[:-1] * np.diff(spread.values)

    # Every entry and exit trades both legs of one unit; costs charge on
    # that gross notional so every number downstream is net.
    gross_notional = (s1 + beta * s2).values
    traded_units = np.abs(np.diff(position, prepend=0.0))
    pnl -= traded_units * gross_notional * (cost_bps / 10_000)

    # The short leg pays to borrow. Adjusted prices already net
    # dividends through the spread on both legs; the borrow fee is the
    # residual carry a total-return series does not include.
    short_leg = np.where(position > 0, beta * s2.values,
                         np.where(position < 0, s1.values, 0.0))
    pnl[1:] -= short_leg[:-1] * (borrow_bps_pa / 10_000 / 252)

    return pnl, position, gross_notional


def calculate_sharpe(ticker1, ticker2, beta, data, lookback=60, entry_zscore=2.0):
    """Annualised net Sharpe of one pair, for ranking candidates."""
    # Align the two series on dates first: positional arrays from different
    # listing calendars silently shift one series against the other.
    joined = pd.concat([data[ticker1], data[ticker2]], axis=1, join='inner').dropna()
    pnl, position, gross_notional = pair_daily_pnl(
        joined.iloc[:, 0].values, joined.iloc[:, 1].values, beta,
        lookback=lookback, entry_zscore=entry_zscore
    )
    # Daily returns against the capital carrying one unit. The constant
    # cancels inside the Sharpe ratio; the costs above do not.
    capital = float(np.nanmean(gross_notional))
    daily = pnl[lookback:] / capital
    if daily.std() == 0:
        return 0.0
    return float(daily.mean() / daily.std() * np.sqrt(252))

# Calculate Sharpe for all pairs
print("Calculating Sharpe ratio for all pairs...\n")

sharpe_results = []
for idx, row in metrics_df.iterrows():
    ticker1 = row['ticker1']
    ticker2 = row['ticker2']
    beta = row['beta']
    
    try:
        sharpe = calculate_sharpe(ticker1, ticker2, beta, train_data)
        sharpe_results.append({
            'ticker1': ticker1,
            'ticker2': ticker2,
            'sharpe': sharpe,
            'half_life': row['half_life'],
            'pvalue': row['pvalue'],
            'beta': beta,
        })
    except:
        pass

sharpe_df = pd.DataFrame(sharpe_results)
sharpe_df = sharpe_df.sort_values('sharpe', ascending=False)

print(f"Sharpe calculations complete: {len(sharpe_df)} pairs\n")
print("Top 15 by Sharpe ratio:\n")
print(sharpe_df.head(15).to_string(index=False))

sharpe_df.to_csv('week2_metrics_sharpe.csv', index=False)
```

**Output shape (illustrative figures, not targets):**
```
ticker1 ticker2  sharpe  half_life  pvalue    beta
BHP     RIO       2.145       12.3  0.00009  1.2345
NAB     ANZ       1.873       15.2  0.00023  0.8765
CBA     NAB       1.652       18.1  0.00051  0.9123
```

---

##### Step 2.3: Final Pair Selection

```python
# Load all metrics
sharpe_df = pd.read_csv('week2_metrics_sharpe.csv')

# Filter for "good" pairs
# Criteria: Sharpe > 1.5, half-life < 30 days, p-value < 0.05
final_pairs = sharpe_df[
    (sharpe_df['sharpe'] > 1.5) &
    (sharpe_df['half_life'] < 30) &
    (sharpe_df['pvalue'] < 0.01)
].copy()

final_pairs = final_pairs.sort_values('sharpe', ascending=False)

print(f"\n{'='*70}")
print(f"FINAL PAIRS SELECTED FOR BACKTESTING")
print(f"{'='*70}\n")
print(final_pairs.head(10).to_string(index=False))
print(f"\n{len(final_pairs)} pairs passed all filters\n")

# Detailed summary
print("\nSelection Criteria:")
print("  ✓ Sharpe > 1.5 (profitable)")
print("  ✓ Half-life < 30 days (fast reversion)")
print("  ✓ p-value < 0.01 (highly significant)\n")

final_pairs.to_csv('week2_final_pairs_for_backtest.csv', index=False)

print(f"✅ Saved to: week2_final_pairs_for_backtest.csv")
```

**Acceptance Criteria:**
- [ ] Minimum 5 pairs selected
- [ ] All pairs have Sharpe > 1.5
- [ ] All pairs have half-life < 30 days
- [ ] File saved: `week2_final_pairs_for_backtest.csv`

**Deliverable (illustrative shape; figures are placeholders):**
```
week2_final_pairs_for_backtest.csv

ticker1 ticker2  sharpe  half_life  pvalue    beta
BHP     RIO       2.145       12.3  0.00009  1.2345
NAB     ANZ       1.873       15.2  0.00023  0.8765
CBA     NAB       1.652       18.1  0.00051  0.9123
WDS     STO       1.423       22.1  0.00078  1.1234
CSL     WES       1.312       25.3  0.00145  0.7654
```

---

## PHASE 2: BACKTEST (Weeks 3–4)
### Validate Pairs via Simulated Trading

### Week 3: Training-Window Backtest

#### Objectives
- Simulate trading each pair over the training window, net of costs
- Measure: Sharpe, drawdown, win rate, # of trades
- Select top 5 pairs for deployment

#### Detailed Steps

##### Step 3.1: Build Backtest Engine

```python
import pandas as pd
import numpy as np

def backtest_pair(ticker1, ticker2, beta, data,
                  entry_zscore=2.0, exit_zscore=0.5,
                  lookback=60, cost_bps=COST_BPS):
    """
    Backtest a single pair on the Step 2.2 engine: dollar P&L per spread
    unit, explicit hold-until-exit state, costs on every entry and exit.
    Metrics come off the dollar equity curve against a fixed capital base;
    nothing compounds percentage returns of a zero-crossing series.
    """
    joined = pd.concat([data[ticker1], data[ticker2]], axis=1, join='inner').dropna()

    pnl, position, gross_notional = pair_daily_pnl(
        joined.iloc[:, 0].values, joined.iloc[:, 1].values, beta,
        lookback=lookback, entry_zscore=entry_zscore,
        exit_zscore=exit_zscore, cost_bps=cost_bps
    )
    pnl = pnl[lookback:]
    position = position[lookback:]

    capital = float(np.nanmean(gross_notional))  # dollars carrying one unit
    equity = capital + np.cumsum(pnl)
    daily_returns = pnl / capital

    total_return = (equity[-1] / capital - 1) * 100
    annual_return = daily_returns.mean() * 252 * 100

    annual_sharpe = 0.0
    if daily_returns.std() > 0:
        annual_sharpe = daily_returns.mean() / daily_returns.std() * np.sqrt(252)

    running_max = np.maximum.accumulate(equity)
    max_drawdown = ((equity - running_max) / running_max).min() * 100

    # Trade statistics per round trip, not per day: a trade opens when the
    # position leaves zero and closes when it returns there.
    trade_pnls = []
    open_idx = None
    for t in range(len(position)):
        if open_idx is None and position[t] != 0:
            open_idx = t
        elif open_idx is not None and position[t] == 0:
            trade_pnls.append(pnl[open_idx:t + 1].sum())
            open_idx = None
    if open_idx is not None:
        trade_pnls.append(pnl[open_idx:].sum())

    num_trades = len(trade_pnls)
    wins = sum(1 for p in trade_pnls if p > 0)
    win_rate = wins / num_trades * 100 if num_trades else 0.0
    gross_profit = sum(p for p in trade_pnls if p > 0)
    gross_loss = abs(sum(p for p in trade_pnls if p < 0))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else 0.0

    return {
        'ticker1': ticker1,
        'ticker2': ticker2,
        'pair': f'{ticker1}-{ticker2}',
        'beta': beta,
        'total_return': total_return,
        'annual_return': annual_return,
        'annual_sharpe': annual_sharpe,
        'max_drawdown': max_drawdown,
        'num_trades': num_trades,
        'win_rate': win_rate,
        'profit_factor': profit_factor,
        'daily_pnl': pnl,
        'equity_curve': equity,
    }

# Load pairs to backtest
pairs_to_test = pd.read_csv('week2_final_pairs_for_backtest.csv')

print("=" * 70)
print("BACKTESTING PAIRS")
print("=" * 70 + "\n")

backtest_results = []

for idx, row in pairs_to_test.iterrows():
    ticker1 = row['ticker1']
    ticker2 = row['ticker2']
    beta = row['beta']
    
    print(f"Testing {ticker1}-{ticker2}...", end=' ')
    
    try:
        result = backtest_pair(ticker1, ticker2, beta, train_data)
        backtest_results.append(result)
        
        print(f"Sharpe: {result['annual_sharpe']:>6.2f}  DD: {result['max_drawdown']:>7.1f}%  Trades: {result['num_trades']:>4.0f}")
    except Exception as e:
        print(f"FAILED: {e}")

# Summary DataFrame
results_df = pd.DataFrame([
    {k: v for k, v in r.items() if k not in ['daily_pnl', 'equity_curve']}
    for r in backtest_results
])

results_df = results_df.sort_values('annual_sharpe', ascending=False)

print(f"\n{'='*70}")
print(f"BACKTEST RESULTS")
print(f"{'='*70}\n")
print(results_df.to_string(index=False))

# Save results
results_df.to_csv('week3_backtest_results.csv', index=False)

print(f"\n✅ Saved to: week3_backtest_results.csv")
```

**Acceptance Criteria:**
- [ ] All 5+ pairs backtested successfully
- [ ] Results saved to `week3_backtest_results.csv`
- [ ] At least 3 pairs have net Sharpe > 1.5 and max drawdown no worse than -15%

**Deliverable (illustrative shape; figures are placeholders):**
```
week3_backtest_results.csv

pair      beta  total_return  annual_sharpe  max_drawdown  num_trades  win_rate  profit_factor
BHP-RIO   1.23        185.4           2.15          -8.3         284      47.2         2.34
NAB-ANZ   0.88        142.3           1.87         -10.1         301      46.8         2.01
CBA-NAB   0.91        128.5           1.65         -11.9         318      45.3         1.78
WDS-STO   1.12         98.7           1.42         -13.2         356      44.1         1.54
CSL-WES   0.77         76.4           1.31         -14.8         389      43.2         1.35
```

---

##### Step 3.2: Analyze Results & Select Live Candidates

```python
# Load backtest results
results_df = pd.read_csv('week3_backtest_results.csv')

# Filter for "live-able" pairs
# Criteria: Sharpe > 1.5, max DD > -15%, win rate > 45%
live_candidates = results_df[
    (results_df['annual_sharpe'] > 1.5) &
    (results_df['max_drawdown'] > -15) &  # percent units, as the engine reports
    (results_df['win_rate'] > 45)       # percent units; per round trip, not per day
].copy()

live_candidates = live_candidates.sort_values('annual_sharpe', ascending=False)

print("\n" + "="*70)
print("PAIRS PASSING BACKTEST FILTERS")
print("="*70 + "\n")

print(f"Filter 1: Sharpe > 1.5 (profitable)")
print(f"Filter 2: Max DD > -15% (manageable risk)")
print(f"Filter 3: Win rate > 45% (adequate frequency)\n")

print(live_candidates.to_string(index=False))
print(f"\n{len(live_candidates)} pairs qualified for deployment\n")

live_candidates.to_csv('week3_live_candidates.csv', index=False)
```

---

### Week 4: Out-of-Sample Validation

#### Objectives
- Test each pair on completely separate ("unseen") data
- Ensure strategy isn't overfit to historical period
- Final go/no-go decision

#### Detailed Steps

##### Step 4.1: Holdout Validation

```python
def validate_out_of_sample(ticker1, ticker2, beta, data, split_date,
                           entry_zscore=2.0, exit_zscore=0.5,
                           lookback=60, cost_bps=COST_BPS):
    """
    One-shot holdout validation, with the exact rule that trades live.

    Everything tunable (the pair, beta, the thresholds) was fixed on the
    training window in Weeks 1 and 2; this function's only job is to run
    the identical rolling-statistics engine from Step 2.2 across data that
    influenced none of those choices. It warm-starts with the last lookback
    days of training so the first holdout day has statistics. The static
    train-mean variant this replaces validated a strategy nobody deploys:
    rolling in the backtest means rolling here.
    """
    joined = pd.concat([data[ticker1], data[ticker2]], axis=1, join='inner').dropna()
    holdout_from = joined.index.searchsorted(split_date, side='right')
    window = joined.iloc[max(holdout_from - lookback, 0):]

    pnl, position, gross_notional = pair_daily_pnl(
        window.iloc[:, 0].values, window.iloc[:, 1].values, beta,
        lookback=lookback, entry_zscore=entry_zscore,
        exit_zscore=exit_zscore, cost_bps=cost_bps
    )
    pnl = pnl[lookback:]          # score only true holdout days
    position = position[lookback:]

    capital = float(np.nanmean(gross_notional))
    daily = pnl / capital
    equity = capital + np.cumsum(pnl)

    oos_sharpe = 0.0
    if daily.std() > 0:
        oos_sharpe = float(daily.mean() / daily.std() * np.sqrt(252))
    running_max = np.maximum.accumulate(equity)
    oos_max_dd = ((equity - running_max) / running_max).min() * 100

    trade_pnls = []
    open_idx = None
    for t in range(len(position)):
        if open_idx is None and position[t] != 0:
            open_idx = t
        elif open_idx is not None and position[t] == 0:
            trade_pnls.append(pnl[open_idx:t + 1].sum())
            open_idx = None
    if open_idx is not None:
        trade_pnls.append(pnl[open_idx:].sum())
    oos_win_rate = (
        sum(1 for tp in trade_pnls if tp > 0) / len(trade_pnls) * 100
        if trade_pnls else 0.0
    )

    return {
        'pair': f'{ticker1}-{ticker2}',
        'holdout_start': str(window.index[lookback].date()),
        'holdout_end': str(window.index[-1].date()),
        'oos_return': (equity[-1] / capital - 1) * 100,
        'oos_sharpe': oos_sharpe,
        'oos_max_dd': oos_max_dd,
        'oos_win_rate': oos_win_rate,
    }

# Load candidates
candidates = pd.read_csv('week3_live_candidates.csv')

print("\n" + "="*70)
print("OUT-OF-SAMPLE VALIDATION (Train/Test Split)")
print("="*70 + "\n")

oos_results = []

for idx, row in candidates.iterrows():
    ticker1 = row['ticker1']
    ticker2 = row['ticker2']
    beta = row['beta']
    
    print(f"\n{ticker1}-{ticker2}:")
    
    try:
        result = validate_out_of_sample(ticker1, ticker2, beta, data, split_date)
        oos_results.append(result)
        
        print(f"  OOS Sharpe: {result['oos_sharpe']:>6.2f}")
        print(f"  OOS DD: {result['oos_max_dd']:>7.1f}%")
    except Exception as e:
        print(f"  FAILED: {e}")

oos_df = pd.DataFrame(oos_results)
oos_df = oos_df.sort_values('oos_sharpe', ascending=False)

print(f"\n{'='*70}")
print(f"OUT-OF-SAMPLE RESULTS")
print(f"{'='*70}\n")
print(oos_df.to_string(index=False))

oos_df.to_csv('week4_oos_validation.csv', index=False)
```

**Acceptance Criteria:**
- [ ] OOS Sharpe within 80% of in-sample Sharpe (not overfit)
- [ ] Minimum 3 pairs pass OOS validation
- [ ] Results saved to `week4_oos_validation.csv`

**The holdout is spent once.** If these numbers send you back to change thresholds or swap pairs, the changed strategy has now seen the holdout, and re-splitting the same history cannot re-arm it. Iterate inside the training window only, and treat paper trading (Weeks 5 to 8) as the next genuinely unseen data.

**Example:**
```
In-sample Sharpe: 2.15
OOS Sharpe: 1.87  (87% of in-sample ✓)
→ Good validation, not overfit
```

vs.

```
In-sample Sharpe: 2.15
OOS Sharpe: 0.81  (38% of in-sample ✗)
→ Significant degradation, likely overfit
```

---

##### Step 4.2: Final Deployment Decision

```python
# Load OOS results
oos_df = pd.read_csv('week4_oos_validation.csv')

# Final filter: OOS Sharpe > 1.2
final_live_pairs = oos_df[
    oos_df['oos_sharpe'] > 1.2
].sort_values('oos_sharpe', ascending=False)

print("\n" + "="*70)
print("FINAL PAIRS APPROVED FOR LIVE DEPLOYMENT")
print("="*70 + "\n")

for idx, row in final_live_pairs.iterrows():
    print(f"✅ {row['pair']:<10} OOS Sharpe: {row['oos_sharpe']:>6.2f}")

print(f"\nTotal pairs ready: {len(final_live_pairs)}")
print(f"\n✨ READY FOR WEEK 5 DEPLOYMENT\n")

final_live_pairs.to_csv('week4_final_live_pairs.csv', index=False)
```

**Deliverable (illustrative shape; figures are placeholders):**
```
week4_final_live_pairs.csv

pair      holdout_start  holdout_end  oos_return  oos_sharpe  oos_max_dd  oos_win_rate
BHP-RIO   2023-01-03     2023-12-29        11.2        1.61        -6.8          52.0
NAB-ANZ   2023-01-03     2023-12-29         8.9        1.38        -7.9          50.0
CBA-NAB   2023-01-03     2023-12-29         7.4        1.29        -9.1          47.0
```

---

## PHASE 3: PAPER TRADING (Weeks 5–8)
### Risk-Free Live System Validation

### Objectives
- Run complete live system against IB paper trading account
- Verify signals execute without errors
- Test data feeds, monitoring dashboard, risk controls
- Confirm system latency/infrastructure ready for real capital
- **Zero real capital at risk**

### Week 5-8: Paper Trading Setup & Execution

#### Step 5.1: Interactive Brokers Paper Account

**Setup (30 min):**
1. Log into IB account (already created for real trading)
2. Enable TWS Paper Trading mode
3. Set paper account starting balance: $100K
4. Deploy same 2 pairs as planned for live

**Run system identically to live:**
```python
# Same code as weeks 9+, pointed at the paper login. Paper and live are
# different TWS logins listening on different ports (paper 7497, live 7496
# by default); the clientId only names this API connection and selects
# nothing.

async def main():
    pairs_config = [
        {'ticker1': 'BHP', 'ticker2': 'RIO', 'beta': 1.2345, 'capital': 50_000},
        {'ticker1': 'NAB', 'ticker2': 'ANZ', 'beta': 0.8765, 'capital': 50_000},
    ]

    trader = PairsTrader(pairs_config, state_path='paper_positions.json')
    await trader.connect(port=7497, client_id=2)  # the paper login's port
    try:
        await trader.daily_rebalance()
    finally:
        await trader.disconnect()
```

**Run for 4 weeks (20 trading days).**

#### Step 5.2: Paper Trading Acceptance Criteria

- [ ] System runs daily without manual intervention (cron job)
- [ ] All signals execute correctly (no stuck orders)
- [ ] Dashboard updates with real-time data
- [ ] Logs record every trade, slippage, cost
- [ ] Risk controls trigger appropriately (no false alarms)
- [ ] 60-80 trades executed across both pairs
- [ ] Paper daily P&L tracks the engine run on the same closes (correlation > 0.9); four weeks cannot measure Sharpe and is not asked to

#### Step 5.3: Paper Trading Metrics

Compare paper trading against the engine run on the same closes:

```
BHP-RIO Pair:
  Engine P&L vs. paper P&L, same closes: correlation 0.96 ✓
  Realised cost per round trip: 12 bps vs. 15 bps modelled ✓

NAB-ANZ Pair:
  Engine P&L vs. paper P&L, same closes: correlation 0.94 ✓
  Realised cost per round trip: 14 bps vs. 15 bps modelled ✓

✅ READY FOR LIVE DEPLOYMENT (plumbing and costs validated; four weeks
cannot measure edge and did not try)
```

**If tracking is loose or costs overshoot the model:**
- Investigate: Data feed delays? Execution slippage worse than modelled?
- Adjust thresholds (e.g., entry z-score 2.0 → 2.2)
- Run another 2 weeks of paper trading
- Do NOT deploy live until paper tracks the engine

---

## PHASE 4: LIVE POC (Weeks 9–20)
### Proof-of-Concept with Real Capital

### Objectives
- Deploy $100K across 2-3 pairs
- Accumulate 80-120 real trades over 12 weeks
- Measure realised costs and live-versus-engine tracking; report Sharpe with its interval
- Test for disqualifying evidence; edge confirmation needs quarters, not weeks
- Collect track record for backer reporting

### Week 9: Setup & Initial Deployment

#### Step 9.1: Capital Deployment Setup

**Interactive Brokers Account Status:**
- Account opened in Week 1 for backtesting
- Paper trading validated in Weeks 5-8
- **Now fund with $100K real capital**

**Capital Allocation ($100K total):**
```
Account Balance: $100,000
├─ Pair 1 (BHP-RIO):     $30,000  (30% AUM)
├─ Pair 2 (NAB-ANZ):     $30,000  (30% AUM)
├─ Pair 3 (CBA-NAB):     $20,000  (20% AUM, optional)
├─ Margin buffer:        $15,000  (15% AUM, for drawdown tolerance)
└─ Emergency reserve:     $5,000   (5% AUM, for unexpected issues)
```

**Position Sizing per Pair:**
```
BHP-RIO ($30K gross allocation, beta 1.23):
├─ One unit: long 1 BHP (~$40) against short 1.23 RIO (~$148), or the
│  reverse; roughly $188 gross notional per unit
├─ Units for $30K gross: ~160, so ~160 BHP shares against ~197 RIO shares
└─ Beta-neutral by construction (one unit's P&L is exactly the spread move
   the backtest measured); the dollar legs are deliberately unequal, so
   watch the single-name exposure on the larger leg

Total portfolio margin: $100K supporting ~$140K gross exposure
Leverage ratio: 1.4x (conservative, well within IB limits)
```

**Critical: Start with $60K deployed across 2 pairs (Week 9), not $100K.**
- Pair 1 (BHP-RIO): $30K
- Pair 2 (NAB-ANZ): $30K
- Reserve $40K for weeks 13+ scaling

This gives you buffer for margin calls/slippage in first month.

**Python API Setup (Already Done, But Verify):**
```bash
# Install IB client library (if not done)
pip install ib-insync

# Test connection to the LIVE login. Live TWS listens on 7496 by default
# (paper on 7497); the port and the login select live, the clientId does not.
python
>>> from ib_insync import IB
>>> ib = IB()
>>> ib.connect('127.0.0.1', 7496, clientId=1)
>>> print(ib.accountSummary())  # Should show real capital
```

---

#### Short Legs: Borrow, Dividends, Franking

Every position here is half short, and the plan must price that half:

- **Borrow.** ASX20 names are usually general collateral (tens of basis
  points per annum) through IB's stock loan desk, but availability is per
  name, per day. Check borrow and its fee before deploying a pair, and
  treat a special (an elevated fee or restricted availability) as
  disqualifying: the engine's `borrow_bps_pa` assumes general collateral.
- **Dividends.** The short leg pays the full cash dividend to the lender on
  every ex-date it is held across. On adjusted prices the backtest already
  nets this through the spread, so the performance numbers are fair, but
  the live cash flow is real and lumpy: bank pairs go ex twice a year at
  2-3% a time, so expect the cash account to breathe.
- **Franking.** Two asymmetries the backtest does not model. The payment in
  lieu on a short leg is cash only, while the natural holder it displaced
  would have received franking credits; and on the long leg the 45-day
  holding period rule means positions flipped inside 45 days forfeit their
  franking credits entirely. For an Australian own-money book this is a
  real after-tax drag on a strategy whose average hold is shorter than the
  rule. It does not change the gross numbers; it belongs in any honest
  after-tax appraisal at scale-up.
- **Short-sale reporting.** ASIC short position reports bind when a short
  position reaches both AUD 100,000 and 0.01% of issued capital. POC leg
  sizes sit far under both thresholds; re-check at every scale-up.


#### Step 9.2: Build Live Trading System (Updated)

```python
"""
PAIRS TRADING LIVE SYSTEM

Two jobs, not one:
  1. compute (after close, 18:30 AEST): append today's closes, update the
     rolling statistics, decide target units per pair, write targets.json
  2. execute (10:15 AEST next day, after the ASX staggered open finishes):
     reconcile broker positions against the local book, then work the
     deltas with capped limit orders

The local book (positions.json) records what the system believes it holds;
the broker records what it actually holds. Every run starts by comparing
the two and halts on any mismatch, because a system that cannot say what
it owns must not be allowed to trade. Signals come from stored daily
closes under the same rolling rule the backtest measured, never from live
quotes against close-based statistics, which would trade a different
strategy from the tested one.
"""

import asyncio
import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd
from ib_insync import IB, LimitOrder, Stock

logging.basicConfig(
    filename='live_trading.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

STATE = Path('positions.json')     # the local book: {pair: units held}
TARGETS = Path('targets.json')     # written nightly by the compute job
# Adjusted closes. The nightly job refreshes the whole trailing window
# from the vendor rather than appending, because adjustment factors move
# on every ex-date and an appended raw close silently mixes two series.
CLOSES = Path('data/closes.csv')

ENTRY_Z = 2.0
EXIT_Z = 0.5
LOOKBACK = 60
STOP_Z = 3.5        # abandon: this far past entry is a broken pair, not a bargain
MAX_HOLD_DAYS = 60  # time stop: reversion that never comes is not reversion
LIMIT_CAP_BPS = 10  # how far through the touch a limit order may pay


def compute_targets(pairs_config):
    """Nightly job: today's close decides tomorrow's target position.

    The book keeps a little state per pair (units, days held, stood_down)
    so the same stops the backtest measured apply live: the z-stop, the
    time stop, and the stand-down that blocks re-entry until the spread
    first trades back inside the exit band.
    """
    closes = pd.read_csv(CLOSES, index_col='date', parse_dates=True)
    book = json.loads(STATE.read_text()) if STATE.exists() else {}
    targets = {}
    for pair in pairs_config:
        t1, t2, beta = pair['ticker1'], pair['ticker2'], pair['beta']
        spread = closes[t1] - beta * closes[t2]
        window = spread.tail(LOOKBACK)
        z = float((spread.iloc[-1] - window.mean()) / window.std())

        name = f'{t1}-{t2}'
        entry = book.get(name, {})
        held = entry.get('units', 0)
        days_held = entry.get('days_held', 0)
        stood_down = entry.get('stood_down', False)

        if stood_down:
            direction = 0
            if abs(z) < EXIT_Z:
                stood_down = False  # normalised; eligible again from tomorrow
        elif held == 0:
            direction = -1 if z > ENTRY_Z else (1 if z < -ENTRY_Z else 0)
        elif abs(z) >= STOP_Z or days_held + 1 >= MAX_HOLD_DAYS:
            direction = 0
            stood_down = True
            logging.warning('stop on %s: z=%.2f after %d days held', name, z, days_held + 1)
        else:
            # hold until the z-score is back inside the exit band
            direction = 0 if abs(z) < EXIT_Z else int(np.sign(held))

        unit_gross = float(closes[t1].iloc[-1] + beta * closes[t2].iloc[-1])
        units = int(pair['capital'] / unit_gross)
        targets[name] = {
            'ticker1': t1, 'ticker2': t2, 'beta': beta,
            'z': round(z, 2),
            'target_units': direction * units,
            'stood_down': stood_down,
        }
        logging.info('compute %s: z=%.2f target=%d units', name, z, direction * units)
    TARGETS.write_text(json.dumps(targets, indent=2))


class PairsTrader:
    def __init__(self, pairs_config, state_path=STATE):
        self.pairs = pairs_config
        self.state_path = Path(state_path)
        self.ib = IB()

    async def connect(self, host='127.0.0.1', port=7496, client_id=1):
        # Live TWS listens on 7496 and paper on 7497 by default. The port
        # and the login select live versus paper; the clientId only names
        # this API session.
        await self.ib.connectAsync(host, port, clientId=client_id)
        logging.info('Connected to IB on port %d', port)

    async def reconcile(self):
        """Compare the local book with the broker before any order."""
        book = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        broker = {p.contract.symbol: p.position for p in await self.ib.reqPositionsAsync()}
        expected = {}
        for pair in self.pairs:
            units = book.get(f"{pair['ticker1']}-{pair['ticker2']}", {}).get('units', 0)
            expected[pair['ticker1']] = expected.get(pair['ticker1'], 0) + units
            expected[pair['ticker2']] = expected.get(pair['ticker2'], 0) - round(units * pair['beta'])
        for symbol, want in expected.items():
            have = int(broker.get(symbol, 0))
            if have != want:
                raise RuntimeError(
                    f'book/broker mismatch on {symbol}: book {want}, broker {have}; '
                    'halting with no orders until a human resolves it'
                )
        return book

    async def _work_leg(self, ticker, delta):
        """One leg as a capped limit order, awaited to completion."""
        if delta == 0:
            return
        contract = Stock(ticker, 'ASX', 'AUD')
        await self.ib.qualifyContractsAsync(contract)
        # Snapshot quotes still need an ASX market data subscription on the
        # account; without one this returns NaN and the run halts here.
        quote = self.ib.reqMktData(contract, snapshot=True)
        for _ in range(50):
            if not np.isnan(quote.bid) and not np.isnan(quote.ask):
                break
            await asyncio.sleep(0.2)
        else:
            raise RuntimeError(f'no quote for {ticker}; check the market data subscription')
        side = 'BUY' if delta > 0 else 'SELL'
        touch = quote.ask if delta > 0 else quote.bid
        cap = touch * (1 + LIMIT_CAP_BPS / 10_000) if delta > 0 else touch * (1 - LIMIT_CAP_BPS / 10_000)
        trade = self.ib.placeOrder(contract, LimitOrder(side, abs(delta), round(cap, 2)))
        while not trade.isDone():
            await asyncio.sleep(1)
        logging.info('%s %d %s capped at %.2f: %s', side, abs(delta), ticker, cap, trade.orderStatus.status)
        if trade.orderStatus.status != 'Filled':
            # A filled first leg with an unfilled second is naked
            # single-name exposure; stop and surface it rather than retry.
            raise RuntimeError(f'unfilled leg {ticker}; resolve before the next run')

    async def daily_rebalance(self):
        book = await self.reconcile()
        targets = json.loads(TARGETS.read_text())
        for name, target in targets.items():
            entry = book.get(name, {'units': 0, 'days_held': 0, 'stood_down': False})
            delta_units = target['target_units'] - entry['units']
            if delta_units != 0:
                # risk gate first (see the risk controls section): loss limits,
                # position and leverage caps, the drawdown circuit breaker
                await self._work_leg(target['ticker1'], delta_units)
                await self._work_leg(target['ticker2'], -round(delta_units * target['beta']))
            held_now = target['target_units']
            if held_now == 0:
                days_held = 0
            elif entry['units'] == 0:
                days_held = 1  # opened today
            else:
                days_held = entry['days_held'] + 1
            book[name] = {
                'units': held_now,
                'days_held': days_held,
                'stood_down': target['stood_down'],
            }
            # write after every pair, not at the end: a crash mid-run must
            # not leave filled orders outside the book
            self.state_path.write_text(json.dumps(book, indent=2))
        logging.info('Daily rebalance complete')

    async def disconnect(self):
        await self.ib.disconnectAsync()
        logging.info('Disconnected from IB')


# pairs_execute.py entry point (10:15 AEST): reconcile, then work targets.
async def main():
    pairs_config = [
        {'ticker1': 'BHP', 'ticker2': 'RIO', 'beta': 1.2345, 'capital': 30_000},
        {'ticker1': 'NAB', 'ticker2': 'ANZ', 'beta': 0.8765, 'capital': 30_000},
    ]
    trader = PairsTrader(pairs_config)
    await trader.connect(port=7496, client_id=1)  # the live login's port
    try:
        await trader.daily_rebalance()
    finally:
        await trader.disconnect()

if __name__ == '__main__':
    asyncio.run(main())
```

**Deploy as cron jobs:**
```bash
# Edit crontab
crontab -e

# Two jobs. flock stops a slow run from overlapping the next one, which is
# how one signal becomes a double order.
30 18 * * 1-5 flock -n /tmp/pairs.compute.lock /usr/bin/python3 /home/user/pairs_compute.py
15 10 * * 1-5 flock -n /tmp/pairs.execute.lock /usr/bin/python3 /home/user/pairs_execute.py

# 10:15, not the open: ASX opens in staggered alphabetical groups from
# 10:00:00 to about 10:09:15, so an at-the-open job fires while half the
# board is still in auction.
```

---

#### Step 5.3: Create Monitoring Dashboard

**Simple HTML Dashboard:**
```html
<!DOCTYPE html>
<html>
<head>
    <title>Pairs Trading Dashboard</title>
    <style>
        body { font-family: Arial; margin: 20px; }
        .metric { font-size: 24px; font-weight: bold; margin: 10px; }
        .good { color: green; }
        .bad { color: red; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #4CAF50; color: white; }
    </style>
</head>
<body>
    <h1>🎯 Pairs Trading Live Dashboard</h1>
    
    <h2>Portfolio Summary</h2>
    <div class="metric" id="daily_pnl">Daily P&L: --</div>
    <div class="metric" id="ytd_return">YTD Return: --</div>
    <div class="metric" id="sharpe">Sharpe: --</div>
    <div class="metric" id="max_dd">Max Drawdown: --</div>
    
    <h2>Live Positions</h2>
    <table id="positions_table">
        <tr>
            <th>Pair</th>
            <th>Signal</th>
            <th>Z-Score</th>
            <th>Position</th>
            <th>P&L</th>
            <th>Last Update</th>
        </tr>
    </table>
    
    <script>
        // The compute job writes status.json beside this page; the page
        // only renders it. (Parsing free-form log lines as JSON does not
        // work, and the log stays a log.)
        setInterval(() => {
            fetch('/status.json')
                .then(r => r.json())
                .then(data => {
                    document.getElementById('daily_pnl').textContent = `Daily P&L: $${data.daily_pnl}`;
                    document.getElementById('ytd_return').textContent = `YTD Return: ${data.ytd_return}%`;
                    document.getElementById('sharpe').textContent = `Sharpe: ${data.sharpe}`;
                    document.getElementById('max_dd').textContent = `Max Drawdown: ${data.max_dd}%`;

                    const table = document.getElementById('positions_table');
                    for (const [pair, m] of Object.entries(data.pairs)) {
                        let row = document.getElementById(pair);
                        if (!row) {
                            row = document.createElement('tr');
                            row.id = pair;
                            table.appendChild(row);
                        }
                        row.innerHTML = `
                            <td>${pair}</td>
                            <td>${m.signal}</td>
                            <td>${m.z.toFixed(2)}</td>
                            <td>${m.units}</td>
                            <td>${m.pnl}</td>
                            <td>${m.updated}</td>
                        `;
                    }
                });
        }, 30000);
    </script>
</body>
</html>
```

**Serve via Python, localhost only (the page carries account P&L):**
```bash
python3 -m http.server 8000 --bind 127.0.0.1
# Open: http://localhost:8000/dashboard.html
```

---

#### Step 5.4: Risk Controls

```python
"""
RISK MANAGEMENT RULES
Applied before every order
"""

def apply_risk_controls(order, account_info, pair_config):
    """Check if order passes risk filters"""
    
    # 1. Daily loss limit
    if account_info['daily_pnl'] < -account_info['initial_capital'] * 0.01:
        logging.warning("⚠️  Daily loss limit (-1%) breached. TRADING HALTED.")
        return False
    
    # 2. Position size limit (no single pair > 30% of AUM)
    position_value = order['size'] * order['price']
    if position_value > account_info['initial_capital'] * 0.30:
        logging.warning(f"⚠️  Position size too large ({position_value}). REJECTED.")
        return False
    
    # 3. Leverage limit (net exposure < 1.5x)
    if account_info['gross_exposure'] > account_info['initial_capital'] * 1.50:
        logging.warning("⚠️  Leverage too high. REJECTED.")
        return False
    
    # 4. Drawdown circuit breaker (> 15% drawdown = stop trading)
    drawdown_pct = account_info['max_drawdown'] / account_info['initial_capital']
    if drawdown_pct > 0.15:
        logging.warning("⚠️  Drawdown > 15%. TRADING PAUSED.")
        return False
    
    return True  # Order approved
```

**Per-pair stops (in the engine and the book).** Three stops sit inside the strategy itself, not around it. The z-stop abandons at |z| >= 3.5: a spread that far past entry is more likely a changed relationship (a takeover, a guidance shock, an index event) than a better price. The time stop closes anything held 60 trading days without reverting, roughly three times the longest half-life the screen accepts. After either stop the pair stands down until its z-score first returns inside the exit band, so a still-stretched spread cannot re-enter the next morning. Both run identically in the backtest engine and the nightly compute job. **The event stop is operational, not statistical:** on any market-sensitive announcement touching either leg (a takeover or scheme, a capital raising, a trading halt, guidance withdrawn), close the pair the same day and retire it pending re-validation. A price-only backtest cannot exercise this rule, which is one honest reason live results will not perfectly match it.

---

### Acceptance Criteria for Week 5
- [ ] IB account funded and connected
- [ ] Live trading system deployed and tested in paper mode
- [ ] First live trade executed successfully
- [ ] Dashboard accessible and updating
- [ ] Logs recording all trades and decisions
- [ ] First week: $30-50K deployed (test phase)

---

## PHASE 5: MONITOR & SCALE (Weeks 13–20)
### Scale to 3 Pairs, Prove Edge, Prepare for Larger Deployment

### Week 13-14: Monitor & Verify Signals (First Month Live)

**Daily Tasks (5-10 min):**
- Check dashboard for errors
- Verify P&L matches expected from signal
- Monitor data feed quality (no stale prices)
- Review IB order logs for execution issues

**Weekly Tasks (30 min):**
- Recalculate rolling statistics (mean/std of spreads)
- Review all trades: entry/exit logic correct?
- Check cointegration hasn't broken (re-run Engle-Granger test)
- Update monitoring spreadsheet

```python
"""
WEEKLY MONITORING CHECKLIST
"""

def weekly_monitoring():
    # 1. Recalculate rolling statistics
    for pair in live_pairs:
        ticker1, ticker2, beta = pair['ticker1'], pair['ticker2'], pair['beta']
        
        # Get last 60 closes
        hist1 = get_last_n_closes(ticker1, 60)
        hist2 = get_last_n_closes(ticker2, 60)
        
        spread = hist1 - beta * hist2
        spread_mean = np.mean(spread)
        spread_std = np.std(spread)
        
        print(f"{ticker1}-{ticker2}")
        print(f"  Mean: {spread_mean:.2f}, Std: {spread_std:.2f}")
    
    # 2. Verify cointegration hasn't degraded
    # (re-run Engle-Granger test on last 2 years)
    score, pvalue, _ = coint(hist1, hist2)
    if pvalue > 0.05:
        logging.warning(f"⚠️  {ticker1}-{ticker2} cointegration broken (p={pvalue})")
        # Consider dropping this pair
    
    # 3. Check P&L vs expectations
    expected_pnl = calculate_expected_pnl_this_week()
    actual_pnl = get_actual_pnl_this_week()
    
    if actual_pnl < expected_pnl * 0.5:
        logging.warning(f"⚠️  Actual P&L {actual_pnl} much lower than expected {expected_pnl}")
        # Investigate: wrong beta? Market changed? Data error?
```

---

### Week 15-16: Add Optional 3rd Pair

**Only if:**
- Pairs 1-2 are tracking backtest (Sharpe > 1.3)
- No cointegration breakdowns
- No data feed issues

**Deployment:**
- Capital: Add third pair with remaining $20-40K
- Same process: the nightly compute job takes the pair on, the 10:15 execute job works it, same daily cycle
- Monitor correlation matrix (all pairs < 0.3 correlated)

**If 3rd pair breaks cointegration:** Don't deploy, save capital for next iteration.

---

### What 12 Weeks Can and Cannot Measure

The standard error of an annualised Sharpe ratio estimated over T years is
roughly sqrt((1 + SR^2/2) / T). Twelve weeks is T = 0.23, so a measured
Sharpe of 1.4 arrives with a standard error near 3: statistically
indistinguishable from zero, and from 3. No honest 12-week window can
"confirm the edge", and a criterion that pretends otherwise selects for
luck. Quarters of live trading, not weeks, narrow Sharpe to anything
useful.

What 12 weeks measures well:

1. **Costs.** Realised slippage and commission per round trip against the
   engine's `cost_bps`; with 100+ trades this converges fast, and it is
   the assumption most likely to sink the strategy.
2. **Tracking.** Live daily P&L against the engine run on the same closes:
   correlation and tracking error prove the system trades the strategy
   that was tested, which is what the paper and POC phases exist to show.
3. **Operations.** Reconciliation mismatches, unfilled legs, halts, stop
   behaviour: countable, and any nonzero count is a finding.
4. **Risk conformance.** Drawdown and exposure inside their modelled
   ranges; stops firing as specified.

The Week 20 decision therefore reads: scale if execution is validated
(costs at or under model, tracking tight, operations clean), risk behaved,
and the Sharpe point estimate is positive with its interval acknowledged;
abort on disqualifying evidence (costs far over model, tracking loose,
stops misfiring, cointegration gone); otherwise extend at current size.
Even a full scale verdict is a bet sized by judgement, not a proof, and the
honest posture is that edge confirmation continues at $500K, with the same
monthly measurements, for at least the first year.

---


### Week 17-20: Prepare for Scaling Decision

**Week 17:**
- Calculate the final empirical Sharpe with its confidence interval (12 weeks of live data across 2-3 pairs)
- Score the real gates: realised costs vs. `cost_bps`, live-versus-engine tracking, operational and risk conformance
- Document max drawdown, win rate, profitability
- Identify any regime changes or cointegration degradation

**Week 18-19:**
- Prepare POC report for backer (see "Week 20 Backer Report" section below)
- Write up: What worked, what didn't, why edge is real or why it failed
- If successful: Detailed plan for scaling to $500K-$1M
- Commission the outside-capital legal advice if not already running (the gate in the structure section)

**Week 20: Go/No-Go Decision**

**If the gates pass (execution validated, operations clean, risk conformant, positive point estimate):**
```
Next step: Scale to $500K-$1M AUM
Timeline: 4-8 weeks to full deployment
Expected returns: $75-100K+ annually (18-20% on $500K)

Action items:
├─ Secure $500K from backer (gated on the settled legal structure; see the outside-capital section)
├─ Deploy 5 pairs across $500K capital
├─ Maintain same daily rebalancing infrastructure
└─ Report monthly to backer
```

**If there is disqualifying evidence (costs far over model, loose tracking, stops misfiring, cointegration gone):**
```
Outcome: disqualified as implemented; the money stops before the theory does
Cost of learning: $100K (acceptable)

Options:
├─ Pivot to Strategy #2 (daily momentum)
├─ Iterate: Different pair selection, different entry/exit thresholds
├─ Investigate: Was cointegration sample-dependent? Did regime break?
└─ Wind down: Maintain $100K, return to PE/portfolio manager work
```

**If the picture is mixed:**
```
Outcome: no disqualifier, but the evidence is thin

Options:
├─ Run another 4 weeks to gather more data
├─ Optimize thresholds (increase entry z-score from 2.0 to 2.2)
├─ Add more pairs to diversify
└─ Scale to $200-300K (modest, not full $1M)
```

---

## End-of-Phase Metrics & Reporting

### POC Progress Tracking (Weeks 9-20)

**Track these metrics weekly:**

| Week | Capital Deployed | Pairs Live | Trades YTD | Sharpe (12w roll) | DD | Status |
|------|------------------|-----------|-----------|-------------------|-----|--------|
| 9 | $60K | 2 | 0 | -- | 0% | 🟡 Starting |
| 12 | $60K | 2 | 45 | 1.89 | -6% | 🟢 On track |
| 15 | $80-100K | 2-3 | 80 | 1.76 | -8% | 🟢 Validating |
| 20 | $100K | 3 | 120 | 1.62 | -9% | 🟢 Proven |

**Acceptance Criteria at Week 20:**
- [ ] Realised cost per round trip at or under the engine's `cost_bps`
- [ ] Live daily P&L tracks the engine on the same closes (correlation > 0.9)
- [ ] Zero unresolved reconciliation breaks or unfilled legs
- [ ] Max drawdown ≤ 12%; stops fired as specified
- [ ] ≥100 real trades executed
- [ ] Sharpe point estimate positive, its interval reported beside it

---

### Week 20 Backer Report (POC Success Scenario)

```markdown
# Pairs Trading POC: Final Report

## Executive Summary
**Status: ✅ EDGE CONFIRMED**

### Key Metrics (12-Week Live Period)
| Metric | Backtest | POC Live | Variance |
|--------|----------|----------|----------|
| Sharpe Ratio | 1.80 | 1.68 | -6.7% ✅ |
| Max Drawdown | -9.2% | -8.5% | +0.7% ✅ |
| Win Rate | 47.3% | 46.1% | -1.2% ✅ |
| Total Trades | -- | 142 | -- |
| Total Return | -- | +$18,450 | +18.5% |
| Annualized Return | 18% | 18.5% | +0.5% ✅ |

### Capital Deployment
- POC Capital: $100,000
- Deployed Pairs: 3 (BHP-RIO, NAB-ANZ, CBA-NAB)
- Average Utilization: 85% (margin buffer maintained)
- Monthly Avg Cost: AUD $55 (commissions + slippage)

### Risk Management Compliance
- Daily loss limit (-1% AUM): ✅ Never breached
- Position size limit (30% AUM): ✅ All < 30%
- Leverage limit (1.5x): ✅ Maintained at 1.3-1.4x
- Drawdown circuit breaker (15%): ✅ Only hit -8.5%

### Consistency Validation
```
Backtest Sharpe vs. POC Live Sharpe:

BHP-RIO:
  Backtest: 2.15 | Paper: 1.98 | Live: 2.01 → ✅ Consistent

NAB-ANZ:
  Backtest: 1.87 | Paper: 1.76 | Live: 1.72 → ✅ Consistent

CBA-NAB:
  Backtest: 1.65 | Paper: 1.54 | Live: 1.49 → ✅ Consistent

Portfolio (3 pairs):
  Backtest: 1.80 | Live: 1.68 → 93% of expected ✅
```

### Cointegration Status (Re-tested Week 20)
All pairs maintain statistically significant cointegration:
```
BHP-RIO: p-value = 0.0001 (cointegrated ✅)
NAB-ANZ: p-value = 0.0003 (cointegrated ✅)
CBA-NAB: p-value = 0.0012 (cointegrated ✅)
```

Half-lives still < 30 days (mean reversion stable).

### Operational Performance
- System uptime: 99.8% (1 day TWS restart)
- Data feed quality: Excellent (no gaps > 1 hour)
- Execution slippage: 4.2 bps avg (modeled 5 bps ✅)
- Commission cost: AUD $42/month avg (expected ✅)

### Why This Edge Is Real

1. **Tracking**: live P&L follows the engine day by day on the same closes, and realised costs came in at model. The Sharpe interval is wide at 12 weeks and is reported beside the point estimate, not hidden.

2. **Cointegration Stability**: All 3 pairs maintain statistical cointegration over 12 months (not sample-dependent).

3. **Mechanical Logic**: Mean reversion to spread is provable mathematically (no black-box ML).

4. **Scalability**: Position sizing scales linearly; no execution degradation observed at $100K scale.

5. **Market Neutral**: Correlation to ASX-200 = 0.04 (uncorrelated, proves not buying market).

### Recommendation: Scale to $500K-$1M

#### Deployment Plan
```
Timeline: 8-12 weeks
Capital: $500K initial, can scale to $1M

Pair Allocation:
├─ BHP-RIO (best performer): $150K
├─ NAB-ANZ (stable): $150K
├─ CBA-NAB (lowest vol): $100K
├─ 2 New pairs (validated): $100K
└─ Margin buffer: $50K

Expected Year 1 Returns: $90-120K (18-24% on $500K)
```

#### Infrastructure Changes Needed
```
Minimal. Current system scales linearly:
├─ 2 cron jobs (compute 18:30 AEST, execute 10:15 AEST daily)
├─ 1 IB account (can handle $1M+ positions)
├─ Same monitoring dashboard
└─ Same risk controls
```

### Financial Forecast (18-Month Outlook)

**Conservative Case (1.5x Sharpe = 13% annual):**
```
Year 1: $500K → $565K (+13%)
Year 2: $565K → $639K (+13%)
3-Year AUM: $639K
```

**Base Case (1.65x Sharpe = 18% annual):**
```
Year 1: $500K → $590K (+18%)
Year 2: $590K → $696K (+18%)
3-Year AUM: $696K
```

**Optimistic Case (1.8x Sharpe = 22% annual):**
```
Year 1: $500K → $610K (+22%)
Year 2: $610K → $745K (+22%)
3-Year AUM: $745K
```

### Known Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| ASX pair availability | Pairs run out of opportunities | Monitor for new cointegrated pairs; geographic expansion |
| Cointegration breakdown | Edge disappears | Weekly test; drop pairs with p > 0.05 |
| Market regime change | Correlations change | Leverage cap at 1.5x; daily DD limit |
| Execution issues | Slippage increases | 2x position size; wider entry z-scores |
| Competitive entry | Edge degrades | Already invisible to competitors; small ASX market |

### Backer Next Steps

1. **Approve $500K deployment**, conditional on the settled legal structure (the outside-capital section; nothing moves before it); can start with $200K
2. **Monthly reporting**: Sharpe, DD, Sharpe consistency vs. backtest
3. **Annual review**: ROI, strategy evolution, competitive landscape
4. **Optional**: Add 2nd strategy (daily momentum) in parallel for diversification

---

## Conclusion

We've successfully proven that pairs trading works on the ASX with:
- ✅ Mathematically cointegrated pairs
- ✅ Consistent Sharpe ratio across backtest / paper / live
- ✅ Capital-efficient deployment (1.3-1.4x leverage)
- ✅ Market-neutral risk profile
- ✅ Fully automated, low-touch operation

**Recommendation: Proceed to $500K deployment. Edge is real.**

---

**Prepared by:** [Engineer Name]
**Date:** [Week 20 Date]
**Approved by:** [Backer Name]
```

---

### Monthly Report Template (During Weeks 9-20)

```markdown
# Monthly POC Report: [MONTH] (Week [X])

## Portfolio Summary
- **Deployed Capital:** $[X]K
- **Pairs Active:** [X]
- **Monthly Return:** [+X]% (actual)
- **YTD Return (live):** [+X]%
- **Sharpe (12-week rolling):** [X.XX]

## Pair Status
| Pair | Status | Monthly P&L | Sharpe | Cointegration | Notes |
|------|--------|-------------|--------|---------------|-------|
| BHP-RIO | LIVE | +$[X] | [X.XX] | ✅ p=0.0001 | On track |
| NAB-ANZ | LIVE | +$[X] | [X.XX] | ✅ p=0.0003 | On track |
| CBA-NAB | [LIVE/PENDING] | +$[X] | [X.XX] | ✅ p=0.0012 | [Status] |

## Risk Metrics
- Max drawdown (month): [X]%
- Max drawdown (YTD): [X]%
- Largest single trade loss: -$[X]
- VaR 95%: -$[X]
- Leverage ratio: [X.X]x

## Operational
- System uptime: [X]%
- Execution slippage: [X] bps avg
- Commission cost: AUD $[X]
- Data issues: [None / [details]]

## Variance to Expectations
- Expected monthly Sharpe: [X.XX]
- Actual monthly Sharpe: [X.XX]
- Variance: [+/-X]% ✅/⚠️

## Next Month
- [ ] Continue monitoring for cointegration breakdown
- [ ] [Optional: Add 3rd pair / Scale capital / etc.]
- [ ] Prepare for Week 20 go/no-go decision

## Backer Update (1 sentence)
"POC tracking as expected. 12-week live Sharpe [X.XX] vs. backtest [X.XX]. Edge remains consistent."
```

---

## Outside Capital: Structure Before Scale

The POC trades the operator's own account, and nothing more is needed for
that. The moment the Week 20 decision would bring a backer's money under
management, this stops being an engineering question:

- **Licensing.** Managing another person's capital for a fee or a profit
  share is a financial service under the Corporations Act 2001. Doing it
  without an Australian financial services licence, an authorised
  representative arrangement under someone else's licence, or a genuine
  exemption is an offence, and "it's only one backer" is not an exemption.
- **The plausible structures**, in rough order of weight: the backer trades
  their own account and employs or contracts the operator; the operator
  becomes a corporate authorised representative under an incumbent AFSL
  holder; a wholesale-only mandate through a licensed trustee or platform,
  if the backer meets the wholesale client tests; or a fresh AFSL, which is
  a business decision in its own right, not a form to fill in.
- **Adjacent questions for the same advice session:** the trading entity
  (individual, company, trust) and its tax treatment; whether the backer
  relationship is a loan, an investment or a mandate, because the three are
  regulated differently; insurance; and what happens to open positions if
  either party wants out mid-quarter.

**The gate:** no outside dollar is accepted before written advice from an
Australian financial services lawyer settles the structure. The Week 20
"secure $500K" step is conditional on this gate, and the advice should be
commissioned around Week 12, because licensing arrangements take longer
than eight weeks.

---


## Slippage & Commission Analysis ($100K POC)

### Why This Matters

At $100K capital, transaction costs are **highest as a % of returns**. This is the main risk to POC success. These figures set the engine's cost assumption (`cost_bps` in Step 2.2), so the backtest, the holdout validation and the go/no-go thresholds are all net of costs; this section calibrates that number, and live fills recalibrate it.

### Cost Breakdown

**Per Round-Trip Trade ($30K pair position):**
```
Commissions (ASX):
  ├─ Buy 1,000 BHP: AUD $10-15
  ├─ Sell 600 RIO: AUD $8-12
  └─ Total per round-trip: AUD $36-54 (let's say $45)

Slippage (bid-ask spread):
  ├─ BHP mid: $40, spread: $0.03 (0.075%)
  ├─ 1,000 shares × $0.015 avg slippage: $15
  ├─ RIO mid: $120, spread: $0.05 (0.042%)
  ├─ 600 shares × $0.025 avg slippage: $15
  └─ Total slippage per round-trip: $30

Total cost per round-trip: $45 + $30 = $75
Cost as % of $30K position: 0.25%
Cost per 12-week period (120 trades): $75 × 120 = $9,000
Impact on $100K AUM: 9% drag
```

### Impact on Sharpe

```
Without slippage: Sharpe 1.8 → Expected annual return: 18%
With $9K slippage: Effective return: 18% - 9% = 9%
Effective Sharpe: 1.8 × (9/18) = 0.9

⚠️ This is CRITICAL. You might fail POC due to slippage alone.
```

### Mitigation Strategies

**1. Optimize Position Sizing (Execute Larger Blocks)**
```
Instead of:  1,000 BHP @ 1 share/sec = 1,000 sec = high market impact
Try:         1,000 BHP @ 10 shares/sec = 100 sec = lower impact

Use IB's VWAP algorithm to split order over 5-10 minutes
Estimated slippage reduction: 30-50%
```

**2. Trade Less Frequently (Widen Entry/Exit Thresholds)**
```
Current:  Entry z > 2.0 → ~200 trades/year
Optimize: Entry z > 2.2 → ~140 trades/year

Reduces trades by 30% → reduces slippage cost by 30%
Sharpe might drop 5-10%, but more achievable
```

**3. Increase Position Size (Justify larger capital)**
```
With $100K: position is $30K → 0.25% slippage cost/round-trip
With $200K: position is $60K → same $75 cost, 0.125% slippage
Slippage drag cut in half.

→ Ask backer for $150K instead of $100K if possible
```

### Conservative POC Assumption

**For planning purposes, assume:**
```
Backtest Sharpe: 1.80
Less slippage (0.6%): -0.18 Sharpe
Empirical POC Sharpe: 1.62

Plan on the net number and hold margin for error;
the Week 20 gates score realised costs directly
```

### Early Warning Sign

**If by Week 12 (1 month live) realised costs overshoot the model or tracking is loose:**
- Don't continue to Week 20
- Investigate: Is slippage worse than expected? Are commissions higher? Did edge disappear?
- Decision point: Abort POC or optimise thresholds and restart

---

## Contingency Plans

### If Pair Cointegration Breaks

**Scenario:** Engle-Granger test p-value > 0.05

(The per-pair stops are the fast path out of a breaking pair; this weekly test is the slow confirmation that it should not come back.)

**Action:**
1. Remove pair from live trading immediately
2. Pull capital from broken pair
3. Identify replacement pair from research backup list
4. Backtest replacement pair (2-3 days)
5. Deploy replacement

**Impact:** ~1 week delay, -$150K capital temporarily, portfolio Sharpe drops 10-15%

---

### If Backer Gets Nervous (Market Crash)

**Scenario:** ASX down 10%, portfolio DD hits -12%, backer calls asking if system is broken

**Response:**
- "Pairs trading is market-neutral. We're short the broad market on BHP-RIO correlation. Our -12% DD is normal for this strategy."
- Show: Correlation to ASX-200 = 0.02 (uncorrelated)
- Show: Same pairs profited during COVID crash in 2020
- Show: Rebalancing daily prevents large losses

---

### If One Engineer Gets Sick

**Scenario:** Engineer unavailable for 1-2 weeks

**Preparation:**
1. Cron job runs automatically (no manual intervention needed)
2. Document every signal, every order, every metric
3. Dashboard updates daily automatically
4. Backup: Hire contract developer as on-call (cost: $500-1000/week if needed)

---

## Success Criteria by Week (POC Timeline)

| Week | Milestone | Acceptance | Status |
|------|-----------|-----------|--------|
| 2 | 5+ cointegrated pairs identified | p < 0.05 for all | 🟢 Must have |
| 4 | 5 pairs backtested, 3+ pass OOS validation | Sharpe > 1.5 in-sample, > 1.3 OOS | 🟢 Must have |
| 8 | Paper trading complete, system validated | P&L tracks the engine; costs at or under model | 🟢 Must have |
| 12 | 2 pairs live (1 month), 45+ trades | No critical errors; costs and tracking on model | 🟢 Must have |
| 16 | 2-3 pairs live (2 months), 80+ trades | Tracking tight, no cointegration breaks | 🟡 Should have |
| 20 | POC complete, 120+ trades, gates scored | Execution, operations and risk gates all pass | 🟢 **GO/NO-GO DECISION** |

---

## Financial Projections

### POC Phase (Weeks 9-20, $100K deployed)

#### Conservative Case (Sharpe 1.4)
- Expected monthly return: 1.0% (12% annual)
- Week 20 P&L: +$12,000 (12% return on $100K)
- Slippage/commission impact: -$600 (6% drag)
- Net: +$11,400 → **11.4% POC return**

#### Base Case (Sharpe 1.65)
- Expected monthly return: 1.3% (15.6% annual)
- Week 20 P&L: +$15,600 (15.6% return on $100K)
- Slippage/commission impact: -$600
- Net: +$15,000 → **15% POC return**

#### Optimistic Case (Sharpe 1.8)
- Expected monthly return: 1.5% (18% annual)
- Week 20 P&L: +$18,000 (18% return on $100K)
- Slippage/commission impact: -$600
- Net: +$17,400 → **17.4% POC return**

### Post-POC Phase (After Week 20, Scaling to $500K)

**If the Week 20 gates pass, scale to $500K:**

| Scenario | Sharpe | Annual % | Year 1 Return | Year 2 Return | 3-Year AUM |
|----------|--------|----------|---------------|---------------|-----------|
| Conservative (1.4) | 1.4 | 13% | $65K | $73K | $639K |
| Base (1.65) | 1.65 | 18% | $90K | $106K | $696K |
| Optimistic (1.8) | 1.8 | 22% | $110K | $134K | $745K |

**Note on Slippage at $500K Scale:**
```
At $100K: Slippage impact = 0.6% (significant)
At $500K: Slippage impact = 0.12% (minimal)

This means your effective Sharpe IMPROVES as you scale
(less drag relative to returns)
```

---

## Key Files & Deliverables

### Phase 1: Research (Weeks 1-2)
- `week1_cointegrated_pairs.csv`: All cointegrated pairs
- `week2_final_pairs_for_backtest.csv`: Top candidates

### Phase 2: Backtest (Weeks 3-4)
- `week3_backtest_results.csv`: Full period backtest metrics
- `week4_oos_validation.csv`: Out-of-sample validation
- `week4_final_live_pairs.csv`: Approved for deployment

### Phase 3: Paper Trading (Weeks 5-8)
- `paper_trading.log`: Simulated trades, daily P&L
- `paper_trading_results.csv`: Paper Sharpe, drawdown, consistency check
- `paper_vs_backtest_comparison.csv`: Validation metrics

### Phase 4: Live POC (Weeks 9-20)
- `live_trading.py`: Live trading system code
- `live_trading.log`: Real trades, daily P&L, risk metrics
- `dashboard.html`: Monitoring dashboard (updated daily)
- `daily_report.csv`: Daily position sizes, signals, P&L
- `weekly_monitoring.csv`: Cointegration tests, rolling Sharpe
- `week20_poc_report.md`: Final go/no-go decision document

### Backer Materials
- `poc_pitch_deck.pdf`: Initial $100K POC pitch
- `month1_report.md`: Weeks 9-12 results
- `month2_report.md`: Weeks 13-16 results
- `final_scaling_proposal.md`: $500K deployment plan (if POC succeeds)

---

## References & Resources

**Cointegration & Pairs Trading:**
- Engle & Granger (1987): "Co-integration and Error Correction" (foundational paper)
- Vidyamurthy, G. (2004): "Pairs Trading" (practical guide)

**Open Source Libraries:**
- statsmodels: Engle-Granger test
- ib_insync: Interactive Brokers API
- eodhdc: End-of-day historical data

**Alternative Data Providers:**
- EODHD (AUD $50-100/month; ASX needs a paid tier, personal use unless a commercial agreement says otherwise)
- Interactive Brokers (AUD $40+/month for data subscriptions, at non-professional rates while the money is your own)
- Polygon.io (limited free tier)

---

## Overall Timeline Comparison

### Original Plan (Full Deployment, Week 5 Go-Live)
```
Week 1-2: Research (data plan only)
Week 3-4: Backtest (no new costs)
Week 5-12: Live trading ($1M deployed)
Result: Prove strategy works or lose $1M

Risk: High (all capital deployed immediately)
Timeline: 12 weeks total
```

### Revised POC Plan (De-Risked, Week 9 Go-Live)
```
Week 1-2: Research (data plan only)
Week 3-4: Backtest (no new costs)
Week 5-8: Paper trading (no new costs)
Week 9-20: Live POC ($100K deployed)
Result: Prove strategy works on $100K, then scale

Risk: Low (only $100K at risk, $15-40K expected ROI)
Timeline: 20 weeks total, and weeks 1-8 risk no capital
Full deployment: After Week 20 go/no-go decision
```

### Why This is Better

| Factor | Original | Revised |
|--------|----------|---------|
| Capital at risk | $1M | $100K |
| Capital-free validation | 4 weeks | 8 weeks |
| Time to prove edge | 12 weeks | 12 weeks (but paper-validated) |
| Backer confidence | "Trust me" | "12 weeks paper + 12 weeks live data" |
| Total timeline to scale | 12 weeks | 20 weeks (but $15K+ learned, not lost) |
| Expected profit if right | +$50-80K | +$12-18K (then $500K scale) |
| Expected loss if wrong | -$1M | -$100K |

**The revised plan is ~10x better risk/reward.**

---

## Sign-Off

**Engineer:** [Your Name]
**Backer:** [Backer Name]
**Start Date:** [Week 1 Date]
**POC Completion:** [Week 20 Date]
**Scaling Decision:** [Week 20 Date]

### Commitment

This POC plan is executable within the 20-week window by 1 engineer with $100K capital and consistent daily 5-10 minute monitoring. 

**Weeks 1-8 deploy no capital** (the only spend is the data plan). If at Week 8 you want to abort, you've invested your time and a small subscription, and learned whether the system tracks its engine via paper trading.

**Week 20 go/no-go decision** is binary:
- **GO:** Scale to $500K-$1M (full deployment happens then, not before)
- **NO-GO:** Close strategy, learn for $100K, pivot to Strategy #2

This structure protects both engineer and backer from catastrophic loss while proving the strategy works.
