"""The cross-language contract fixtures.

Deterministic reports, seeded and fixed-clock, committed to the
api-contract package as the golden fixtures both sides test against:
the engine's suite asserts its own serialisation still matches the
committed bytes (write-side drift fails there), and the api-contract
suite parses the same bytes with the Zod schemas (read-side drift fails
there). Schema drift therefore fails a test, never a render.

Regenerate after an intended schema change, from quant/pairs-engine:

    uv run python -m pairs_engine.golden > ../../packages/api-contract/fixtures/pair-scan.golden.json
    uv run python -m pairs_engine.golden backtest > ../../packages/api-contract/fixtures/backtest.golden.json

and land the fixtures, the pydantic change, and the Zod change in the
same commit.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .artefacts import (
    BacktestReport,
    PairScanReport,
    build_backtest_report,
    build_report,
)
from .backtest import backtest_pair
from .research import scan
from .synthetic import cointegrated_pair, make_series, random_walk
from .windows import TRAIN_FRACTION, freeze_split, union_calendar

GOLDEN_SEED = 17
GOLDEN_GENERATED_AT = datetime(2026, 7, 22, 9, 30, 0, tzinfo=timezone.utc)


def golden_closes() -> dict[str, pd.Series]:
    """Five tickers: one planted cointegrated pair, two independent
    walks, one short-history ticker whose pairs are all skipped, so the
    fixtures exercise every row shape the schemas carry."""
    rng = np.random.default_rng(GOLDEN_SEED)
    price1, price2 = cointegrated_pair(rng, 800, beta=2.5)
    return {
        "AAA": make_series(price1, name="AAA"),
        "BBB": make_series(price2, name="BBB"),
        "CCC": make_series(random_walk(rng, 800), name="CCC"),
        "DDD": make_series(random_walk(rng, 800), name="DDD"),
        "EEE": make_series(random_walk(rng, 300), name="EEE"),
    }


def golden_report() -> PairScanReport:
    closes = golden_closes()
    calendar = union_calendar(closes)
    split = freeze_split(calendar)
    result = scan(closes, split)
    return build_report(
        result,
        calendar=calendar,
        split=split,
        train_fraction=TRAIN_FRACTION,
        min_shared_train_days=500,
        generated_at=GOLDEN_GENERATED_AT,
    )


def golden_backtest_report() -> BacktestReport:
    """The scan's candidates backtested over the same closes, train and
    holdout separate, exactly the shape slice 4's surface reads."""
    closes = golden_closes()
    scan_report = golden_report()
    split = pd.Timestamp(scan_report.window.split_date)
    stats_by_pair = {(row.ticker1, row.ticker2): row for row in scan_report.pairs}
    results = [
        backtest_pair(
            closes[candidate.ticker1],
            closes[candidate.ticker2],
            beta=candidate.beta,
            split=split,
            scan_p_value=stats_by_pair[(candidate.ticker1, candidate.ticker2)].p_value,
            scan_half_life_days=stats_by_pair[
                (candidate.ticker1, candidate.ticker2)
            ].half_life_days,
        )
        for candidate in scan_report.candidates
    ]
    return build_backtest_report(results, scan_report, GOLDEN_GENERATED_AT)


GOLDEN_LIVE_DAYS = 40
GOLDEN_LIVE_CAPITAL = 30_000.0


class _ScriptedBroker:
    """Deterministic paper fills for the fixture run: every order fills
    at the quote nudged two basis points against the trade, and the
    share ledger mirrors what was worked, so reconciliation stays clean."""

    def __init__(self) -> None:
        self.shares: dict[str, int] = {}
        self.quotes: dict[str, float] = {}

    def positions(self) -> dict[str, int]:
        return dict(self.shares)

    def place_capped_limit(self, ticker: str, shares: int, cap_bps: float):
        from .execute import BrokerFill

        del cap_bps
        price = self.quotes[ticker] * (1 + 0.0002 * (1 if shares > 0 else -1))
        self.shares[ticker] = self.shares.get(ticker, 0) + shares
        return BrokerFill(ticker=ticker, shares=shares, price=price)


def golden_live_state(root):
    """A scripted paper run over the planted pair's last stretch: compute
    then execute per close, fills from the scripted broker, so the daily
    and weekly fixtures carry every shape the live surface renders."""
    from pathlib import Path

    from .data import CloseStore
    from .execute import run_execute
    from .live import LiveConfig, LivePairConfig, LiveState, run_compute

    root = Path(root)
    closes = golden_closes()
    series1, series2 = closes["AAA"], closes["BBB"]
    store = CloseStore(root / "data")
    state = LiveState(root / "live")
    state.write_config(
        LiveConfig(
            paper=True,
            pairs=[
                LivePairConfig(ticker1="AAA", ticker2="BBB", beta=2.5, capital=GOLDEN_LIVE_CAPITAL)
            ],
        )
    )
    broker = _ScriptedBroker()
    total = len(series1)
    for offset in range(total - GOLDEN_LIVE_DAYS, total):
        store.save("AAA", series1.iloc[: offset + 1])
        store.save("BBB", series2.iloc[: offset + 1])
        run_compute(state, store)
        broker.quotes = {
            "AAA": float(series1.iloc[offset]),
            "BBB": float(series2.iloc[offset]),
        }
        run_execute(state, broker, now=GOLDEN_GENERATED_AT)
    return state, store


def golden_daily_report():
    import tempfile

    from .live import build_daily_report

    with tempfile.TemporaryDirectory() as workspace:
        state, store = golden_live_state(workspace)
        return build_daily_report(state, store, GOLDEN_GENERATED_AT)


def golden_weekly_report():
    import tempfile

    from .live import build_weekly_report

    with tempfile.TemporaryDirectory() as workspace:
        state, store = golden_live_state(workspace)
        return build_weekly_report(state, store, GOLDEN_GENERATED_AT)


def golden_json() -> str:
    return golden_report().model_dump_json(by_alias=True, indent=2) + "\n"


def golden_backtest_json() -> str:
    return golden_backtest_report().model_dump_json(by_alias=True, indent=2) + "\n"


def golden_daily_json() -> str:
    return golden_daily_report().model_dump_json(by_alias=True, indent=2) + "\n"


def golden_weekly_json() -> str:
    return golden_weekly_report().model_dump_json(by_alias=True, indent=2) + "\n"


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "pair-scan"
    output = {
        "pair-scan": golden_json,
        "backtest": golden_backtest_json,
        "daily": golden_daily_json,
        "weekly": golden_weekly_json,
    }[which]()
    print(output, end="")
