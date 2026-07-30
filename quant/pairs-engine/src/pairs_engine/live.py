"""The live sleeve's state and the nightly compute job.

Two jobs, not one (pairs trading plan, the live system): compute runs
after the close, appends nothing to raw data it does not own, updates
the rolling statistics through the same step() the backtest measured,
decides target units per pair, marks the book's actual positions on the
day's closes, and writes the daily report artefact; execute runs next
morning against the broker (execute module). The local book records what
the system believes it holds; every execute run starts by comparing it
with the broker, because a system that cannot say what it owns must not
be allowed to trade.

All state lives as JSON under one operator-local directory (live/ by
default, git-ignored): the deployed-pairs config the owner writes, the
book, the targets the compute job hands to execute, and the append-only
fills and P&L logs. Everything validates through pydantic on read;
corrupt state fails loudly, never silently.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd
from pydantic import BaseModel

from .backtest import BORROW_BPS_PER_ANNUM, COST_BPS_PER_SIDE, TRADING_DAYS_PER_YEAR
from .data import CloseStore
from .signals import (
    ENTRY_Z,
    EXIT_Z,
    LOOKBACK_DAYS,
    MAX_HOLD_DAYS,
    STOP_Z,
    SignalState,
    position_path,
    rolling_z,
    step,
)
from .windows import align_pair

LIMIT_CAP_BPS = 10.0
DECLARED_MAX_DRAWDOWN_PCT = 12.0
Z_SERIES_CONTEXT_DAYS = 30
FILLS_REPORTED = 50
PNL_DAYS_REPORTED = 90


class LivePairConfig(BaseModel):
    ticker1: str
    ticker2: str
    beta: float
    capital: float

    @property
    def key(self) -> str:
        return f"{self.ticker1}-{self.ticker2}"


class LiveConfig(BaseModel):
    paper: bool = True
    pairs: list[LivePairConfig]


class PairBookState(BaseModel):
    units: int = 0
    days_held: int = 0
    stood_down: bool = False


class Reconciliation(BaseModel):
    status: str = "clean"
    checked_at: datetime | None = None
    mismatches: list[dict] = []


class LiveBook(BaseModel):
    pairs: dict[str, PairBookState] = {}
    halted: bool = False
    halt_reason: str | None = None
    reconciliation: Reconciliation = Reconciliation()

    def state_of(self, key: str) -> PairBookState:
        return self.pairs.get(key, PairBookState())


class PairTarget(BaseModel):
    ticker1: str
    ticker2: str
    beta: float
    z: float
    target_units: int
    close1: float
    close2: float
    unit_gross: float


class Targets(BaseModel):
    computed_for: date
    pairs: dict[str, PairTarget]


class Fill(BaseModel):
    filled_on: date
    ticker: str
    shares: int
    price: float
    reference_close: float
    slippage_bps: float


class PnlRow(BaseModel):
    marked_on: date
    daily: float
    cumulative: float
    engine_cumulative: float
    gross_exposure: float


class RuleEvent(BaseModel):
    """One close of a held position, by reason: the exit band, the
    z-stop, or the time stop. Stops fired and round trips count from
    this log."""

    occurred_on: date
    pair: str
    reason: str


class LiveState:
    """The live directory's files, each read validated and written whole."""

    def __init__(self, root: Path):
        self.root = root

    def _path(self, name: str) -> Path:
        return self.root / name

    def load_config(self) -> LiveConfig:
        return LiveConfig.model_validate_json(self._path("config.json").read_text())

    def write_config(self, config: LiveConfig) -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._path("config.json")
        path.write_text(config.model_dump_json(indent=2) + "\n")
        return path

    def load_book(self) -> LiveBook:
        path = self._path("book.json")
        if not path.exists():
            return LiveBook()
        return LiveBook.model_validate_json(path.read_text())

    def write_book(self, book: LiveBook) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self._path("book.json").write_text(book.model_dump_json(indent=2) + "\n")

    def load_targets(self) -> Targets | None:
        path = self._path("targets.json")
        if not path.exists():
            return None
        return Targets.model_validate_json(path.read_text())

    def write_targets(self, targets: Targets) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self._path("targets.json").write_text(targets.model_dump_json(indent=2) + "\n")

    def append_fills(self, fills: list[Fill]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        with self._path("fills.jsonl").open("a") as handle:
            for fill in fills:
                handle.write(fill.model_dump_json() + "\n")

    def load_fills(self) -> list[Fill]:
        path = self._path("fills.jsonl")
        if not path.exists():
            return []
        return [Fill.model_validate_json(line) for line in path.read_text().splitlines() if line]

    def append_pnl(self, rows: list[PnlRow]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        with self._path("pnl.jsonl").open("a") as handle:
            for row in rows:
                handle.write(row.model_dump_json() + "\n")

    def load_pnl(self) -> list[PnlRow]:
        path = self._path("pnl.jsonl")
        if not path.exists():
            return []
        return [PnlRow.model_validate_json(line) for line in path.read_text().splitlines() if line]

    def append_events(self, events: list[RuleEvent]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        with self._path("events.jsonl").open("a") as handle:
            for event in events:
                handle.write(event.model_dump_json() + "\n")

    def load_events(self) -> list[RuleEvent]:
        path = self._path("events.jsonl")
        if not path.exists():
            return []
        return [
            RuleEvent.model_validate_json(line) for line in path.read_text().splitlines() if line
        ]


def expected_shares(config: LiveConfig, book: LiveBook) -> dict[str, int]:
    """The share position the book implies per ticker, the plan's
    reconcile arithmetic: one unit is long one share of the first ticker
    against beta shares of the second, reversed when short."""
    expected: dict[str, int] = {}
    for pair in config.pairs:
        units = book.state_of(pair.key).units
        expected[pair.ticker1] = expected.get(pair.ticker1, 0) + units
        expected[pair.ticker2] = expected.get(pair.ticker2, 0) - round(units * pair.beta)
    return expected


def _pair_frame(store: CloseStore, pair: LivePairConfig) -> pd.DataFrame:
    return align_pair(store.load(pair.ticker1), store.load(pair.ticker2))


def _engine_pnl_series(frame: pd.DataFrame, beta: float) -> np.ndarray:
    """What the rule alone earns on these closes day by day, net of
    modelled costs: the tracking benchmark the plan's POC measures live
    P&L against, and the series the weekly monitor correlates."""
    price1 = frame["price1"].to_numpy()
    price2 = frame["price2"].to_numpy()
    spread = price1 - beta * price2
    z = rolling_z(spread, LOOKBACK_DAYS)
    path = position_path(z, first_tradeable=LOOKBACK_DAYS)
    pnl = np.zeros(len(spread))
    pnl[1:] = path.position[:-1] * np.diff(spread)
    gross = price1 + beta * price2
    traded = np.abs(np.diff(path.position, prepend=0.0))
    pnl -= traded * gross * (COST_BPS_PER_SIDE / 10_000)
    short_leg = np.where(path.position > 0, beta * price2, np.where(path.position < 0, price1, 0.0))
    pnl[1:] -= short_leg[:-1] * (BORROW_BPS_PER_ANNUM / 10_000 / TRADING_DAYS_PER_YEAR)
    return pnl


def _engine_cumulative(frame: pd.DataFrame, beta: float, upto: int) -> float:
    return float(_engine_pnl_series(frame.iloc[: upto + 1], beta).sum())


def run_compute(state: LiveState, store: CloseStore) -> tuple[Targets, LiveBook]:
    """The nightly job: mark the book on every close since the last P&L
    row, walk the rule one step per new close, and hand execute its
    targets. Statistics come from stored daily closes under the same
    rolling rule the backtest measured, never from live quotes."""
    config = state.load_config()
    if not config.pairs:
        raise ValueError("config.json deploys no pairs; nothing to compute")
    for pair in config.pairs:
        if pair.capital <= 0:
            raise ValueError(f"{pair.key} has no capital set; size it in config.json first")
    book = state.load_book()
    pnl_log = state.load_pnl()
    last_marked = pnl_log[-1].marked_on if pnl_log else None

    frames = {pair.key: _pair_frame(store, pair) for pair in config.pairs}
    calendar = sorted(
        set.intersection(*[set(frame.index) for frame in frames.values()])
        if frames
        else set()
    )
    if len(calendar) <= LOOKBACK_DAYS:
        raise ValueError("not enough shared history to compute rolling statistics")

    new_days = [day for day in calendar if last_marked is None or day.date() > last_marked]
    if last_marked is None:
        # First run marks nothing retroactively: the book starts flat
        # today; P&L accrues from the next close on.
        new_days = calendar[-1:]

    new_rows: list[PnlRow] = []
    events: list[RuleEvent] = []
    cumulative = pnl_log[-1].cumulative if pnl_log else 0.0
    targets: dict[str, PairTarget] = {}

    for day in new_days:
        daily = 0.0
        gross_exposure = 0.0
        for pair in config.pairs:
            frame = frames[pair.key]
            if day not in frame.index:
                continue
            index = int(frame.index.get_loc(day))
            if index == 0:
                continue
            held = book.state_of(pair.key).units
            spread_today = float(
                frame["price1"].iloc[index] - pair.beta * frame["price2"].iloc[index]
            )
            spread_prior = float(
                frame["price1"].iloc[index - 1] - pair.beta * frame["price2"].iloc[index - 1]
            )
            daily += held * (spread_today - spread_prior)
            if held != 0:
                short_value = (
                    pair.beta * float(frame["price2"].iloc[index - 1])
                    if held > 0
                    else float(frame["price1"].iloc[index - 1])
                )
                daily -= abs(held) * short_value * (
                    BORROW_BPS_PER_ANNUM / 10_000 / TRADING_DAYS_PER_YEAR
                )
            gross_exposure += abs(held) * float(
                frame["price1"].iloc[index] + pair.beta * frame["price2"].iloc[index]
            )

            # The rule steps only on the latest close; positions do not
            # change on missed marking days (no execute ran either).
            if day == new_days[-1]:
                spread = (frame["price1"] - pair.beta * frame["price2"]).to_numpy()
                z_all = rolling_z(spread, LOOKBACK_DAYS)
                z_today = float(z_all[index])
                prior = book.state_of(pair.key)
                stepped, reason = step(
                    SignalState(
                        held=int(np.sign(prior.units)),
                        days_held=prior.days_held,
                        stood_down=prior.stood_down,
                    ),
                    z_today,
                )
                if reason is not None:
                    events.append(
                        RuleEvent(occurred_on=day.date(), pair=pair.key, reason=reason)
                    )
                close1 = float(frame["price1"].iloc[index])
                close2 = float(frame["price2"].iloc[index])
                unit_gross = close1 + pair.beta * close2
                units = int(pair.capital / unit_gross)
                targets[pair.key] = PairTarget(
                    ticker1=pair.ticker1,
                    ticker2=pair.ticker2,
                    beta=pair.beta,
                    z=round(z_today, 4) if not np.isnan(z_today) else 0.0,
                    target_units=stepped.held * units,
                    close1=close1,
                    close2=close2,
                    unit_gross=unit_gross,
                )
                book.pairs[pair.key] = PairBookState(
                    units=book.state_of(pair.key).units,
                    days_held=stepped.days_held,
                    stood_down=stepped.stood_down,
                )
        cumulative += daily
        engine_total = sum(
            _engine_cumulative(
                frames[pair.key], pair.beta, int(frames[pair.key].index.get_loc(day))
            )
            for pair in config.pairs
            if day in frames[pair.key].index
        )
        new_rows.append(
            PnlRow(
                marked_on=day.date(),
                daily=round(daily, 4),
                cumulative=round(cumulative, 4),
                engine_cumulative=round(engine_total, 4),
                gross_exposure=round(gross_exposure, 2),
            )
        )

    computed_for = calendar[-1].date()
    result = Targets(computed_for=computed_for, pairs=targets)
    state.write_targets(result)
    state.write_book(book)
    state.append_pnl(new_rows)
    state.append_events(events)
    return result, book


def build_daily_report(state: LiveState, store: CloseStore, generated_at: datetime):
    """The nightly artefact: everything the live surface renders, derived
    from the live directory's state and the stored closes. Requires a
    compute run (targets present); reads everything else as it stands."""
    from .artefacts import (
        DAILY_ARTEFACT_KIND,
        DAILY_SCHEMA_VERSION,
        BacktestAssumptions,
        BacktestSeries,
        DailyFill,
        DailyLeg,
        DailyMismatch,
        DailyPairReport,
        DailyPairsReport,
        DailyPnl,
        DailyReconciliation,
    )
    from . import ENGINE_VERSION

    config = state.load_config()
    book = state.load_book()
    targets = state.load_targets()
    if targets is None:
        raise ValueError("no targets.json; run compute first")
    fills = state.load_fills()
    pnl_log = state.load_pnl()
    events = state.load_events()

    pairs = []
    for pair in config.pairs:
        frame = _pair_frame(store, pair)
        spread_all = (frame["price1"] - pair.beta * frame["price2"]).to_numpy()
        z_all = rolling_z(spread_all, LOOKBACK_DAYS)
        valid = ~np.isnan(z_all)
        dates_all = [index.date() for index in frame.index]
        z_dates = [d for d, keep in zip(dates_all, valid) if keep]
        z_values = [round(float(v), 4) for v, keep in zip(z_all, valid) if keep]
        keep = LOOKBACK_DAYS + Z_SERIES_CONTEXT_DAYS
        z_dates, z_values = z_dates[-keep:], z_values[-keep:]

        window = spread_all[-LOOKBACK_DAYS:]
        held = book.state_of(pair.key)
        target = targets.pairs.get(pair.key)
        target_units = 0 if target is None else target.target_units
        unit_gross = (
            float(frame["price1"].iloc[-1] + pair.beta * frame["price2"].iloc[-1])
            if target is None
            else target.unit_gross
        )
        pairs.append(
            DailyPairReport(
                ticker1=pair.ticker1,
                ticker2=pair.ticker2,
                beta=round(pair.beta, 6),
                capital=round(pair.capital, 2),
                z=0.0 if target is None else target.z,
                spread=round(float(spread_all[-1]), 4),
                spread_mean=round(float(np.mean(window)), 4),
                spread_std=round(float(np.std(window, ddof=1)), 4),
                stood_down=held.stood_down,
                days_held=held.days_held,
                held_units=held.units,
                target_units=target_units,
                unit_gross=round(unit_gross, 2),
                legs=[
                    DailyLeg(
                        ticker=pair.ticker1,
                        target_shares=target_units,
                        held_shares=held.units,
                    ),
                    DailyLeg(
                        ticker=pair.ticker2,
                        target_shares=-round(target_units * pair.beta),
                        held_shares=-round(held.units * pair.beta),
                    ),
                ],
                z_series=BacktestSeries(dates=z_dates, values=z_values),
            )
        )

    base = sum(pair.capital for pair in config.pairs)
    cumulative_all = [row.cumulative for row in pnl_log]
    equity = [base + value for value in cumulative_all]
    drawdown_pct = 0.0
    max_drawdown_pct = 0.0
    if equity:
        running_max = np.maximum.accumulate(np.array(equity))
        drawdowns = (np.array(equity) - running_max) / running_max * 100
        drawdown_pct = round(float(drawdowns[-1]), 4)
        max_drawdown_pct = round(float(drawdowns.min()), 4)
    tail = pnl_log[-PNL_DAYS_REPORTED:]
    realised = (
        round(float(np.mean([abs(f.slippage_bps) + COST_BPS_PER_SIDE for f in fills])), 2)
        if fills
        else None
    )
    stops = sum(1 for event in events if event.reason in ("zStop", "timeStop"))

    checked_at = book.reconciliation.checked_at
    status = "unchecked" if checked_at is None else book.reconciliation.status
    return DailyPairsReport(
        artefact=DAILY_ARTEFACT_KIND,
        schema_version=DAILY_SCHEMA_VERSION,
        engine_version=ENGINE_VERSION,
        run_date=targets.computed_for,
        generated_at=generated_at,
        paper=config.paper,
        reconciliation=DailyReconciliation(
            status=status,
            checked_at=checked_at,
            mismatches=[
                DailyMismatch(
                    ticker=str(entry.get("ticker")),
                    book=int(entry.get("book", 0)),
                    broker=int(entry.get("broker", 0)),
                )
                for entry in book.reconciliation.mismatches
            ],
        ),
        assumptions=BacktestAssumptions(
            lookback_days=LOOKBACK_DAYS,
            entry_z=ENTRY_Z,
            exit_z=EXIT_Z,
            stop_z=STOP_Z,
            max_hold_days=MAX_HOLD_DAYS,
            cost_bps_per_side=COST_BPS_PER_SIDE,
            borrow_bps_per_annum=BORROW_BPS_PER_ANNUM,
        ),
        limit_cap_bps=LIMIT_CAP_BPS,
        pairs=pairs,
        fills=[
            DailyFill(
                filled_on=fill.filled_on,
                ticker=fill.ticker,
                shares=fill.shares,
                price=fill.price,
                reference_close=fill.reference_close,
                slippage_bps=fill.slippage_bps,
            )
            for fill in fills[-FILLS_REPORTED:]
        ],
        pnl=DailyPnl(
            dates=[row.marked_on for row in tail],
            daily=[row.daily for row in tail],
            cumulative=[row.cumulative for row in tail],
            engine_cumulative=[row.engine_cumulative for row in tail],
            drawdown_pct=drawdown_pct,
            max_drawdown_pct=max_drawdown_pct,
            declared_max_drawdown_pct=DECLARED_MAX_DRAWDOWN_PCT,
            gross_exposure=tail[-1].gross_exposure if tail else 0.0,
            stops_fired=stops,
            round_trips=len(events),
            realised_cost_bps_per_side=realised,
            modelled_cost_bps_per_side=COST_BPS_PER_SIDE,
        ),
    )


def build_weekly_report(state: LiveState, store: CloseStore, generated_at: datetime):
    """The weekly monitor: has cointegration held, has the hedge ratio
    drifted, do the live pairs still move independently, and does live
    P&L track the engine on the same closes."""
    from statsmodels.tsa.stattools import coint

    from . import ENGINE_VERSION
    from .artefacts import (
        WEEKLY_ARTEFACT_KIND,
        WEEKLY_SCHEMA_VERSION,
        WeeklyCorrelation,
        WeeklyMonitoringReport,
        WeeklyPairRow,
    )
    from .research import half_life, hedge_ratio

    config = state.load_config()
    pnl_log = state.load_pnl()
    base = sum(pair.capital for pair in config.pairs)

    rows = []
    engine_series: dict[str, pd.Series] = {}
    run_date: date | None = None
    for pair in config.pairs:
        frame = _pair_frame(store, pair).tail(504)
        price1 = frame["price1"].to_numpy()
        price2 = frame["price2"].to_numpy()
        _score, p_value, _crit = coint(price1, price2)
        spread = price1 - pair.beta * price2
        days, _valid = half_life(spread)
        refit, _intercept = hedge_ratio(price1, price2)
        drift_pct = (refit - pair.beta) / pair.beta * 100 if pair.beta != 0 else 0.0

        window_rows = pnl_log[-61:]
        live_daily = np.array([row.daily for row in window_rows[1:]])
        engine_daily = np.diff(np.array([row.engine_cumulative for row in window_rows]))
        tracking = None
        if len(live_daily) >= 5 and base > 0:
            tracking = round(float(np.std(live_daily - engine_daily, ddof=1) / base * 10_000), 2)

        rows.append(
            WeeklyPairRow(
                ticker1=pair.ticker1,
                ticker2=pair.ticker2,
                deployed_beta=round(pair.beta, 6),
                p_value_now=round(float(p_value), 6),
                half_life_days_now=None if days is None else round(days, 4),
                refit_beta=round(refit, 6),
                beta_drift_pct=round(drift_pct, 4),
                tracking_error_bps=tracking,
            )
        )
        pnl_series = _engine_pnl_series(frame, pair.beta)
        engine_series[pair.key] = pd.Series(pnl_series[-90:], index=frame.index[-90:])
        run_date = frame.index[-1].date() if run_date is None else max(run_date, frame.index[-1].date())

    correlations = []
    keys = [pair.key for pair in config.pairs]
    for i, key_a in enumerate(keys):
        for key_b in keys[i + 1 :]:
            joined = pd.concat([engine_series[key_a], engine_series[key_b]], axis=1).dropna()
            value = 0.0
            if len(joined) >= 5:
                value = float(joined.iloc[:, 0].corr(joined.iloc[:, 1]))
            correlations.append(
                WeeklyCorrelation(
                    pair_a=key_a, pair_b=key_b, correlation=round(0.0 if np.isnan(value) else value, 4)
                )
            )

    if run_date is None:
        raise ValueError("config.json deploys no pairs; nothing to monitor")
    return WeeklyMonitoringReport(
        artefact=WEEKLY_ARTEFACT_KIND,
        schema_version=WEEKLY_SCHEMA_VERSION,
        engine_version=ENGINE_VERSION,
        run_date=run_date,
        generated_at=generated_at,
        pairs=rows,
        correlations=correlations,
    )
