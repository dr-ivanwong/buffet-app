"""The morning execute job: reconcile first, then work the deltas.

Every run starts by comparing the local book with the broker, and halts
with no orders on any mismatch, because a system that cannot say what it
owns must not be allowed to trade (pairs trading plan, the live system).
Orders are capped limit orders per leg, worked to completion; fills are
appended to the log with their slippage against the close the targets
were computed from.

The broker is a narrow protocol; tests drive it with a fake, and the
real adapter speaks to a paper or live TWS login through ib_async, an
optional dependency installed with the live extra. Paper and live are
different TWS logins on different ports (paper 7497, live 7496); the
port and the login select which, nothing here does.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from .live import (
    Fill,
    LIMIT_CAP_BPS,
    LiveState,
    Reconciliation,
    Targets,
    expected_shares,
)

PAPER_PORT = 7497
LIVE_PORT = 7496


@dataclass(frozen=True)
class BrokerFill:
    ticker: str
    shares: int
    price: float


class Broker(Protocol):
    def positions(self) -> dict[str, int]: ...

    def place_capped_limit(self, ticker: str, shares: int, cap_bps: float) -> BrokerFill: ...


class HaltedError(RuntimeError):
    pass


def run_execute(
    state: LiveState,
    broker: Broker,
    now: datetime,
    cap_bps: float = LIMIT_CAP_BPS,
) -> list[Fill]:
    """Reconcile, then work each leg's delta as a capped limit order."""
    config = state.load_config()
    book = state.load_book()
    if book.halted:
        raise HaltedError(
            f"the book is halted: {book.halt_reason or 'unresolved mismatch'}; "
            "resolve it and run clear-halt"
        )
    targets = state.load_targets()
    if targets is None:
        raise ValueError("no targets.json; run compute first")

    expected = expected_shares(config, book)
    broker_positions = broker.positions()
    mismatches = [
        {"ticker": ticker, "book": want, "broker": int(broker_positions.get(ticker, 0))}
        for ticker, want in sorted(expected.items())
        if int(broker_positions.get(ticker, 0)) != want
    ]
    if mismatches:
        book.halted = True
        book.halt_reason = "book and broker disagree; halting with no orders until a human resolves it"
        book.reconciliation = Reconciliation(
            status="halted", checked_at=now, mismatches=mismatches
        )
        state.write_book(book)
        raise HaltedError(
            "book/broker mismatch on "
            + ", ".join(str(entry["ticker"]) for entry in mismatches)
            + "; halting with no orders until a human resolves it"
        )
    book.reconciliation = Reconciliation(status="clean", checked_at=now, mismatches=[])

    fills: list[Fill] = []
    for key, target in targets.pairs.items():
        held = book.state_of(key).units
        delta_units = target.target_units - held
        if delta_units == 0:
            continue
        # The second leg works the difference of rounded totals, not the
        # rounded difference: rounding increments drifts from the book's
        # round(units times beta) reconcile expectation, and the invariant
        # must hold by construction.
        legs = (
            (target.ticker1, delta_units, target.close1),
            (
                target.ticker2,
                round(held * target.beta) - round(target.target_units * target.beta),
                target.close2,
            ),
        )
        for ticker, shares, reference_close in legs:
            if shares == 0:
                continue
            fill = broker.place_capped_limit(ticker, shares, cap_bps)
            direction = 1 if shares > 0 else -1
            slippage_bps = (
                (fill.price - reference_close) / reference_close * 10_000 * direction
            )
            fills.append(
                Fill(
                    filled_on=targets.computed_for,
                    ticker=ticker,
                    shares=shares,
                    price=round(fill.price, 4),
                    reference_close=round(reference_close, 4),
                    slippage_bps=round(slippage_bps, 2),
                )
            )
        current = book.state_of(key)
        book.pairs[key] = current.model_copy(update={"units": target.target_units})

    state.append_fills(fills)
    state.write_book(book)
    return fills


def clear_halt(state: LiveState) -> None:
    """The human's reset after resolving a mismatch by hand: the next
    execute run re-reconciles from scratch and will halt again if the
    books still disagree."""
    book = state.load_book()
    book.halted = False
    book.halt_reason = None
    state.write_book(book)


def ib_broker(port: int = PAPER_PORT, host: str = "127.0.0.1", client_id: int = 1) -> Broker:
    """The real adapter, constructed lazily: ib_async is the live extra
    (uv sync --extra live), never a test or CI dependency."""
    try:
        from ib_async import IB, LimitOrder, Stock  # type: ignore[import-not-found]
    except ImportError as error:
        raise RuntimeError(
            "ib_async is not installed; install the live extra (uv sync --extra live) "
            "and run TWS or IB Gateway with the paper login first"
        ) from error

    ib = IB()
    ib.connect(host, port, clientId=client_id)

    class IbBroker:
        def positions(self) -> dict[str, int]:
            return {
                position.contract.symbol: int(position.position)
                for position in ib.positions()
            }

        def place_capped_limit(self, ticker: str, shares: int, cap_bps: float) -> BrokerFill:
            contract = Stock(ticker, "ASX", "AUD")
            ib.qualifyContracts(contract)
            quote = ib.reqMktData(contract, "", snapshot=True)
            ib.sleep(1.0)
            reference = quote.last if quote.last == quote.last else quote.close
            if reference != reference:
                raise RuntimeError(f"no quote for {ticker}; check the market data subscription")
            cap = reference * (1 + cap_bps / 10_000 * (1 if shares > 0 else -1))
            order = LimitOrder("BUY" if shares > 0 else "SELL", abs(shares), round(cap, 3))
            trade = ib.placeOrder(contract, order)
            while not trade.isDone():
                ib.sleep(0.5)
            price = trade.orderStatus.avgFillPrice or cap
            return BrokerFill(ticker=ticker, shares=shares, price=float(price))

    return IbBroker()
