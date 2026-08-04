"""End to end: a synthetic cache scans into a valid artefact.

Five tickers: one cointegrated pair planted, two independent walks, and
one short-history ticker whose pairs must all be skipped, so the counts
reconcile exactly: tested plus skipped equals ten choose-two pairs.
"""

import json

import numpy as np

from pairs_engine.cli import main
from pairs_engine.data import CloseStore

from conftest import cointegrated_pair, make_series, random_walk


def build_cache(tmp_path):
    store = CloseStore(tmp_path / "data")
    rng = np.random.default_rng(17)
    price1, price2 = cointegrated_pair(rng, 800, beta=2.5)
    store.save("AAA", make_series(price1, name="AAA"))
    store.save("BBB", make_series(price2, name="BBB"))
    store.save("CCC", make_series(random_walk(rng, 800), name="CCC"))
    store.save("DDD", make_series(random_walk(rng, 800), name="DDD"))
    store.save("EEE", make_series(random_walk(rng, 300), name="EEE"))
    return store


def test_scan_writes_a_reconciling_artefact(tmp_path, capsys):
    store = build_cache(tmp_path)
    out_dir = tmp_path / "artefacts"

    exit_code = main(["scan", "--data-dir", str(store.root), "--out-dir", str(out_dir)])
    assert exit_code == 0

    artefacts = list(out_dir.glob("pair-scan-*.json"))
    assert len(artefacts) == 1
    report = json.loads(artefacts[0].read_text())

    assert report["universe"] == ["AAA", "BBB", "CCC", "DDD", "EEE"]
    assert report["pairsTested"] + len(report["skipped"]) == 10
    skipped_tickers = {(row["ticker1"], row["ticker2"]) for row in report["skipped"]}
    assert all("EEE" in pair for pair in skipped_tickers)
    assert len(skipped_tickers) == 4

    planted = [
        row
        for row in report["candidates"]
        if {row["ticker1"], row["ticker2"]} == {"AAA", "BBB"}
    ]
    assert len(planted) == 1
    assert abs(planted[0]["beta"] - 2.5) < 0.05

    summary = capsys.readouterr().out
    assert "pairs tested" in summary
    assert "holdout" in summary


def test_scan_with_an_empty_cache_fails_loudly(tmp_path, capsys):
    exit_code = main(["scan", "--data-dir", str(tmp_path / "nothing"), "--out-dir", str(tmp_path)])
    assert exit_code == 1
    assert "run fetch first" in capsys.readouterr().err


def test_fetch_without_a_key_refuses_and_points_at_the_runbook(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("EODHD_API_KEY", raising=False)
    exit_code = main(["fetch", "--source", "eodhd", "--data-dir", str(tmp_path)])
    assert exit_code == 2
    assert "EODHD_API_KEY" in capsys.readouterr().err


def test_fetch_requires_an_explicit_source(tmp_path, capsys):
    # No silent default: the operator names the source every fetch, so a
    # research-phase cache can never be mistaken for a licensed one.
    with __import__("pytest").raises(SystemExit):
        main(["fetch", "--data-dir", str(tmp_path)])
    assert "--source" in capsys.readouterr().err
