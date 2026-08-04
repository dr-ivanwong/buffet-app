"""The research-phase source: Yahoo's chart endpoint parsed carefully
(timezone-correct dates, null rows dropped), the cache's source marker,
the artefact stamp, and the adjustment sanity warnings."""

from datetime import date

import httpx
import numpy as np
import pandas as pd
import pytest

from pairs_engine.data import (
    CloseStore,
    MissingTickersError,
    YahooClient,
    absurd_move_warnings,
)

from conftest import make_series

START = date(2026, 1, 5)
END = date(2026, 1, 9)


def chart_payload(timestamps, values):
    return {
        "chart": {
            "result": [
                {"timestamp": timestamps, "indicators": {"adjclose": [{"adjclose": values}]}}
            ],
            "error": None,
        }
    }


def make_client(handler):
    return YahooClient(transport=httpx.MockTransport(handler), pause_seconds=0)


def test_adjusted_closes_convert_through_the_exchange_timezone():
    # An AEDT summer session opens at 23:00 UTC the previous calendar
    # day; a naive UTC date would shift it back one. 2026-01-05 10:00
    # AEDT is 2026-01-04 23:00 UTC.
    monday_open_utc = 1767567600  # 2026-01-04T23:00:00Z
    tuesday_open_utc = monday_open_utc + 86_400

    def handler(request):
        assert request.url.path == "/v8/finance/chart/BHP.AX"
        assert request.url.params["interval"] == "1d"
        return httpx.Response(200, json=chart_payload([monday_open_utc, tuesday_open_utc], [40.1, 40.6]))

    series = make_client(handler).adjusted_closes("BHP", START, END)
    assert list(series.index.strftime("%Y-%m-%d")) == ["2026-01-05", "2026-01-06"]
    assert list(series.values) == [40.1, 40.6]
    assert series.name == "BHP"


def test_null_rows_drop_and_an_empty_chart_is_an_empty_series():
    def handler(request):
        return httpx.Response(
            200, json=chart_payload([1767567600, 1767654000, 1767740400], [40.1, None, 40.9])
        )

    series = make_client(handler).adjusted_closes("BHP", START, END)
    assert len(series) == 2

    def empty_handler(request):
        return httpx.Response(200, json={"chart": {"result": None, "error": None}})

    assert make_client(empty_handler).adjusted_closes("BHP", START, END).empty


def test_fetch_universe_aborts_listing_every_missing_ticker():
    def handler(request):
        if "CCC" in request.url.path:
            return httpx.Response(404, json={"chart": {"result": None, "error": "not found"}})
        return httpx.Response(200, json=chart_payload([1767567600], [40.1]))

    with pytest.raises(MissingTickersError) as excinfo:
        make_client(handler).fetch_universe(("AAA", "CCC"), START, END)
    assert set(excinfo.value.failures) == {"CCC"}


def test_the_cache_remembers_its_source(tmp_path):
    store = CloseStore(tmp_path)
    assert store.load_source() is None
    store.save_source("yahoo")
    assert store.load_source() == "yahoo"
    store.save_source("eodhd")
    assert store.load_source() == "eodhd"


def test_absurd_moves_warn_and_calm_series_stay_quiet():
    calm = make_series(np.linspace(40.0, 42.0, 30), name="AAA")
    values = np.linspace(40.0, 42.0, 30)
    values[15] = values[14] * 1.6  # a misapplied adjustment's signature
    jumpy = make_series(values, name="BBB")

    warnings = absurd_move_warnings({"AAA": calm, "BBB": jumpy})
    assert len(warnings) >= 1
    assert all(warning.startswith("BBB") for warning in warnings)
    assert "check the adjustment" in warnings[0]
    assert absurd_move_warnings({"AAA": calm}) == []


def test_scan_artefact_carries_the_cache_source(tmp_path, capsys):
    from pairs_engine.cli import main
    from pairs_engine.golden import golden_closes

    store = CloseStore(tmp_path / "data")
    for ticker, series in golden_closes().items():
        store.save(ticker, series)
    store.save_source("yahoo")
    out_dir = tmp_path / "artefacts"
    assert main(["scan", "--data-dir", str(store.root), "--out-dir", str(out_dir)]) == 0
    import json

    artefact = json.loads(next(out_dir.glob("pair-scan-*.json")).read_text())
    assert artefact["closesSource"] == "yahoo"
