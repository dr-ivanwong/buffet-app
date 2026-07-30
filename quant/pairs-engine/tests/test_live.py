"""The live jobs against scripted state: the compute-execute cycle, the
reconcile-first halt, and the daily and weekly artefacts."""

import json

import pytest

from pairs_engine.data import CloseStore
from pairs_engine.execute import HaltedError, clear_halt, run_execute
from pairs_engine.golden import (
    GOLDEN_GENERATED_AT,
    _ScriptedBroker,
    golden_closes,
    golden_live_state,
)
from pairs_engine.live import (
    LiveConfig,
    LivePairConfig,
    LiveState,
    build_daily_report,
    build_weekly_report,
    expected_shares,
    run_compute,
)


def make_state(tmp_path, capital=30_000.0):
    state = LiveState(tmp_path / "live")
    state.write_config(
        LiveConfig(
            paper=True,
            pairs=[LivePairConfig(ticker1="AAA", ticker2="BBB", beta=2.5, capital=capital)],
        )
    )
    store = CloseStore(tmp_path / "data")
    closes = golden_closes()
    store.save("AAA", closes["AAA"])
    store.save("BBB", closes["BBB"])
    return state, store


def test_compute_refuses_an_unsized_pair(tmp_path):
    state, store = make_state(tmp_path, capital=0.0)
    with pytest.raises(ValueError, match="no capital"):
        run_compute(state, store)


def test_first_compute_starts_flat_and_writes_targets(tmp_path):
    state, store = make_state(tmp_path)
    targets, book = run_compute(state, store)
    assert "AAA-BBB" in targets.pairs
    assert book.state_of("AAA-BBB").units == 0
    pnl = state.load_pnl()
    assert len(pnl) == 1
    assert pnl[0].cumulative == pnl[0].daily


def test_the_scripted_paper_run_cycles_and_reconciles(tmp_path):
    state, store = golden_live_state(tmp_path)
    book = state.load_book()
    targets = state.load_targets()
    assert targets is not None
    # Execute synced the book to the last targets, and the broker ledger
    # matches the book's implied shares by construction.
    assert book.state_of("AAA-BBB").units == targets.pairs["AAA-BBB"].target_units
    assert not book.halted
    assert book.reconciliation.status == "clean"
    assert len(state.load_pnl()) == 40
    assert len(state.load_fills()) > 0
    assert len(state.load_events()) >= 1


def test_a_forced_mismatch_halts_with_no_orders_and_clears_by_hand(tmp_path):
    state, store = golden_live_state(tmp_path)
    config = state.load_config()
    book = state.load_book()

    broker = _ScriptedBroker()
    broker.shares = dict(expected_shares(config, book))
    broker.shares["BBB"] = broker.shares.get("BBB", 0) + 3  # the forced mismatch
    closes = golden_closes()
    broker.quotes = {"AAA": float(closes["AAA"].iloc[-1]), "BBB": float(closes["BBB"].iloc[-1])}

    with pytest.raises(HaltedError, match="mismatch"):
        run_execute(state, broker, now=GOLDEN_GENERATED_AT)
    halted = state.load_book()
    assert halted.halted
    assert halted.reconciliation.status == "halted"
    assert halted.reconciliation.mismatches[0]["ticker"] == "BBB"

    # While halted, execute refuses before touching the broker at all.
    with pytest.raises(HaltedError, match="clear-halt"):
        run_execute(state, broker, now=GOLDEN_GENERATED_AT)

    # The daily artefact carries the halt loudly.
    report = build_daily_report(state, store, GOLDEN_GENERATED_AT)
    assert report.reconciliation.status == "halted"

    clear_halt(state)
    broker.shares["BBB"] -= 3
    run_execute(state, broker, now=GOLDEN_GENERATED_AT)
    assert state.load_book().reconciliation.status == "clean"


def test_daily_report_shapes_and_determinism(tmp_path):
    state, store = golden_live_state(tmp_path)
    report = build_daily_report(state, store, GOLDEN_GENERATED_AT)
    again = build_daily_report(state, store, GOLDEN_GENERATED_AT)
    assert report.model_dump_json(by_alias=True) == again.model_dump_json(by_alias=True)

    parsed = json.loads(report.model_dump_json(by_alias=True))
    assert parsed["artefact"] == "dailyPairsReport"
    assert parsed["paper"] is True
    pair = parsed["pairs"][0]
    assert len(pair["zSeries"]["dates"]) == len(pair["zSeries"]["values"])
    assert pair["legs"][1]["ticker"] == "BBB"
    assert parsed["pnl"]["declaredMaxDrawdownPct"] == 12.0
    assert parsed["pnl"]["modelledCostBpsPerSide"] == 15.0
    assert len(parsed["pnl"]["dates"]) == len(parsed["pnl"]["cumulative"])
    assert parsed["limitCapBps"] == 10.0


def test_weekly_report_monitors_the_planted_pair(tmp_path):
    state, store = golden_live_state(tmp_path)
    report = build_weekly_report(state, store, GOLDEN_GENERATED_AT)
    row = report.pairs[0]
    # The planted cointegration still holds on the trailing window, the
    # refit hedge ratio sits near the deployed one, and live P&L tracks
    # the engine within a few basis points on scripted fills.
    assert row.p_value_now < 0.05
    assert abs(row.beta_drift_pct) < 5
    assert row.tracking_error_bps is not None
    assert row.tracking_error_bps < 50
    assert report.correlations == []
