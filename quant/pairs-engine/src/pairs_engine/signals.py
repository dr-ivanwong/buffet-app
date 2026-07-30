"""The position rule, one code path for backtest and live.

The state machine the pairs trading plan pins (Week 2's engine and the
live system alike): enter beyond the entry threshold, hold until the
z-score returns inside the exit band, abandon on the z-stop or the time
stop, and after either stop stand down until the spread has actually
normalised, so a still-stretched spread cannot re-enter on the next bar.
The backtest module consumes this over history; the live compute job
consumes it over the trailing window. Splitting that arithmetic is the
live-trades-a-different-strategy risk the plan warns against, which is
why it lives here once.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

LOOKBACK_DAYS = 60
ENTRY_Z = 2.0
EXIT_Z = 0.5
STOP_Z = 3.5
MAX_HOLD_DAYS = 60

EXIT_BAND = "exitBand"
Z_STOP = "zStop"
TIME_STOP = "timeStop"
WINDOW_END = "windowEnd"


@dataclass(frozen=True)
class SignalState:
    """One pair's rule state after a close: the held direction, the days
    it has been held, and whether the pair stands down after a stop."""

    held: int = 0
    days_held: int = 0
    stood_down: bool = False


def step(
    state: SignalState,
    z: float,
    entry_z: float = ENTRY_Z,
    exit_z: float = EXIT_Z,
    stop_z: float = STOP_Z,
    max_hold_days: int = MAX_HOLD_DAYS,
) -> tuple[SignalState, str | None]:
    """One day of the rule, the single code path backtest and live share:
    today's close decides the direction to hold from here, plus the close
    reason when a held position returned to zero today.

    The comparison order mirrors the plan's engine exactly, including its
    treatment of a not-a-number z-score (every comparison false, so an
    open position rides with its day counted and a flat pair stays flat).
    """
    if state.stood_down:
        if abs(z) < exit_z:
            return SignalState(0, 0, False), None
        return state, None
    if state.held == 0:
        if z > entry_z:
            return SignalState(-1, 0, False), None
        if z < -entry_z:
            return SignalState(1, 0, False), None
        return SignalState(0, 0, False), None
    days_held = state.days_held + 1
    if abs(z) >= stop_z:
        return SignalState(0, 0, True), Z_STOP
    if days_held >= max_hold_days:
        return SignalState(0, 0, True), TIME_STOP
    if abs(z) < exit_z:
        return SignalState(0, 0, False), EXIT_BAND
    return SignalState(state.held, days_held, False), None


@dataclass(frozen=True)
class PositionPath:
    """Per-day position in spread units, plus the close reasons keyed by
    the day the position returned to zero."""

    position: np.ndarray
    close_reasons: dict[int, str]


def position_path(
    z: np.ndarray,
    first_tradeable: int,
    entry_z: float = ENTRY_Z,
    exit_z: float = EXIT_Z,
    stop_z: float = STOP_Z,
    max_hold_days: int = MAX_HOLD_DAYS,
) -> PositionPath:
    """Walk the z-score series through step(); the backtest's view of the
    same arithmetic the live compute applies one close at a time.

    first_tradeable is the first index with valid rolling statistics
    (the lookback boundary); everything before it stays flat. A stood-down
    day holds the flat position without counting anything, exactly the
    plan's continue branch.
    """
    position = np.zeros(len(z))
    close_reasons: dict[int, str] = {}
    state = SignalState()
    for t in range(first_tradeable, len(z)):
        state, reason = step(
            state,
            float(z[t]),
            entry_z=entry_z,
            exit_z=exit_z,
            stop_z=stop_z,
            max_hold_days=max_hold_days,
        )
        position[t] = float(state.held)
        if reason is not None:
            close_reasons[t] = reason
    return PositionPath(position=position, close_reasons=close_reasons)


def rolling_z(spread: np.ndarray, lookback: int = LOOKBACK_DAYS) -> np.ndarray:
    """The rolling z-score, sample deviation, exactly the plan's
    spread.rolling(lookback) statistics; the first lookback minus one
    entries are not-a-number and never tradeable."""
    import pandas as pd

    series = pd.Series(spread, dtype=float)
    mean = series.rolling(lookback).mean()
    std = series.rolling(lookback).std()
    return ((series - mean) / std).to_numpy()
