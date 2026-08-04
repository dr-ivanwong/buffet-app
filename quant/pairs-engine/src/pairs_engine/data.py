"""EOD price data: fetch, cache, refresh.

Adjusted closes, always: raw prices drop on every ex-dividend date,
which manufactures fake mean reversion in a backtest and fake signals
live (pairs trading plan, Week 1). The refresh rule is whole-window
replacement, never append: adjustment factors move on every ex-date, so
an appended raw close silently mixes two series (pairs trading plan,
the live system's data note).

The vendor key lives in the environment only, per the house secrets
rule; nothing here reads a config file or stores a credential.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Protocol

import httpx
import pandas as pd

EODHD_BASE_URL = "https://eodhd.com/api"
ASX_SUFFIX = ".AU"
YAHOO_BASE_URL = "https://query1.finance.yahoo.com"
YAHOO_ASX_SUFFIX = ".AX"

# Every close series names where it came from, and the artefacts carry
# the stamp: a research-phase scan can never masquerade as licensed-grade
# later. A new source is a schema change on both sides of the contract.
CLOSE_SOURCES = ("eodhd", "yahoo", "ib", "synthetic")

# A one-day adjusted move beyond this in an ASX large cap is far more
# likely a misapplied split or a missing dividend adjustment than a
# market event; exactly the fake mean reversion the pairs plan warns
# about, so the fetch warns loudly and never silently.
DAILY_MOVE_WARNING_PCT = 30.0


class MissingTickersError(RuntimeError):
    """The scan universe is sacrosanct: a downloader that skips failures
    quietly shrinks it (pairs trading plan, the universe audit), so any
    missing ticker aborts the fetch loudly, all failures listed."""

    def __init__(self, failures: dict[str, str]):
        self.failures = dict(sorted(failures.items()))
        detail = "; ".join(f"{ticker}: {reason}" for ticker, reason in self.failures.items())
        super().__init__(f"no data for {len(self.failures)} ticker(s): {detail}")


@dataclass(frozen=True)
class EodhdClient:
    """Minimal client for the vendor's end-of-day endpoint. Tests inject
    an httpx mock transport; production passes none and talks HTTP."""

    api_key: str
    transport: httpx.BaseTransport | None = None
    pause_seconds: float = 0.2

    def adjusted_closes(self, ticker: str, start: date, end: date) -> pd.Series:
        with httpx.Client(base_url=EODHD_BASE_URL, transport=self.transport, timeout=30.0) as client:
            response = client.get(
                f"/eod/{ticker}{ASX_SUFFIX}",
                params={
                    "api_token": self.api_key,
                    "period": "d",
                    "fmt": "json",
                    "from": start.isoformat(),
                    "to": end.isoformat(),
                },
            )
            response.raise_for_status()
            rows = response.json()
        if not rows:
            return pd.Series(dtype=float, name=ticker)
        frame = pd.DataFrame(rows)
        frame["date"] = pd.to_datetime(frame["date"])
        series = (
            frame.set_index("date")["adjusted_close"]
            .astype(float)
            .dropna()
            .sort_index()
        )
        series = series[~series.index.duplicated(keep="last")]
        series.name = ticker
        return series

    def fetch_universe(
        self, tickers: tuple[str, ...], start: date, end: date
    ) -> dict[str, pd.Series]:
        return fetch_universe(self, tickers, start, end)


class CloseClient(Protocol):
    pause_seconds: float

    def adjusted_closes(self, ticker: str, start: date, end: date) -> pd.Series: ...


def fetch_universe(
    client: CloseClient, tickers: tuple[str, ...], start: date, end: date
) -> dict[str, pd.Series]:
    """One loop for every source: collect all failures, then abort loudly
    listing every missing ticker (the universe audit's rule)."""
    closes: dict[str, pd.Series] = {}
    failures: dict[str, str] = {}
    for ticker in tickers:
        try:
            series = client.adjusted_closes(ticker, start, end)
        except httpx.HTTPError as error:
            failures[ticker] = str(error)
        else:
            if series.empty:
                failures[ticker] = "empty response"
            else:
                closes[ticker] = series
        if client.pause_seconds:
            time.sleep(client.pause_seconds)
    if failures:
        raise MissingTickersError(failures)
    return closes


@dataclass(frozen=True)
class YahooClient:
    """The unofficial research-phase source (owner decision 2026-07-30):
    Yahoo's chart endpoint, no licence and no guarantees, accepted for
    the free research phase only; licensed closes (the EOD plan or the
    broker's historical bars) arrive before paper trading marks a book
    (runbook, the pairs first-scan section). Timestamps convert through
    the exchange's own timezone, because a naive UTC date shifts summer
    sessions back a day."""

    transport: httpx.BaseTransport | None = None
    pause_seconds: float = 0.5

    def adjusted_closes(self, ticker: str, start: date, end: date) -> pd.Series:
        with httpx.Client(
            base_url=YAHOO_BASE_URL,
            transport=self.transport,
            timeout=30.0,
            headers={"User-Agent": "plainsight-pairs-engine/0.1 (personal research)"},
        ) as client:
            response = client.get(
                f"/v8/finance/chart/{ticker}{YAHOO_ASX_SUFFIX}",
                params={
                    "period1": int(pd.Timestamp(start).timestamp()),
                    "period2": int((pd.Timestamp(end) + pd.Timedelta(days=1)).timestamp()),
                    "interval": "1d",
                    "events": "div,splits",
                },
            )
            response.raise_for_status()
            payload = response.json()
        results = payload.get("chart", {}).get("result") or []
        if not results:
            return pd.Series(dtype=float, name=ticker)
        result = results[0]
        timestamps = result.get("timestamp") or []
        adjclose_blocks = result.get("indicators", {}).get("adjclose") or [{}]
        values = adjclose_blocks[0].get("adjclose") or []
        rows = [
            (stamp, value)
            for stamp, value in zip(timestamps, values)
            if value is not None
        ]
        if not rows:
            return pd.Series(dtype=float, name=ticker)
        index = (
            pd.to_datetime([stamp for stamp, _value in rows], unit="s", utc=True)
            .tz_convert("Australia/Sydney")
            .normalize()
            .tz_localize(None)
        )
        series = pd.Series(
            [float(value) for _stamp, value in rows], index=index, name=ticker
        ).sort_index()
        return series[~series.index.duplicated(keep="last")]

    def fetch_universe(
        self, tickers: tuple[str, ...], start: date, end: date
    ) -> dict[str, pd.Series]:
        return fetch_universe(self, tickers, start, end)


def absurd_move_warnings(closes: dict[str, pd.Series]) -> list[str]:
    """Adjusted-series sanity, never fatal: name every one-day move past
    the threshold so a bad adjustment is checked before any statistic
    near it is trusted."""
    warnings: list[str] = []
    for ticker in sorted(closes):
        moves = closes[ticker].pct_change().abs() * 100
        for stamp, move in moves[moves > DAILY_MOVE_WARNING_PCT].items():
            warnings.append(
                f"{ticker}: a {move:.0f}% adjusted move on {stamp.date().isoformat()}; "
                "check the adjustment before trusting statistics near it"
            )
    return warnings


@dataclass(frozen=True)
class CloseStore:
    """Per-ticker CSV cache of adjusted closes under one directory.

    Saving replaces the whole file: the refresh rule above means a fetch
    always supersedes everything previously cached for that ticker.
    """

    root: Path = field(default_factory=lambda: Path("data"))

    def path_for(self, ticker: str) -> Path:
        return self.root / f"{ticker}.csv"

    def save(self, ticker: str, series: pd.Series) -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        path = self.path_for(ticker)
        frame = series.rename("adjustedClose").rename_axis("date").reset_index()
        frame["date"] = frame["date"].dt.date
        frame.to_csv(path, index=False)
        return path

    def load(self, ticker: str) -> pd.Series:
        frame = pd.read_csv(self.path_for(ticker), parse_dates=["date"])
        series = frame.set_index("date")["adjustedClose"].astype(float).sort_index()
        series.name = ticker
        return series

    def load_all(self) -> dict[str, pd.Series]:
        closes: dict[str, pd.Series] = {}
        for path in sorted(self.root.glob("*.csv")):
            ticker = path.stem
            closes[ticker] = self.load(ticker)
        return closes

    def save_source(self, source: str) -> None:
        """The cache remembers which source filled it; every artefact
        built from it carries the stamp."""
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "source.json").write_text(json.dumps({"source": source}) + "\n")

    def load_source(self) -> str | None:
        path = self.root / "source.json"
        if not path.exists():
            return None
        value = json.loads(path.read_text()).get("source")
        return value if isinstance(value, str) else None
