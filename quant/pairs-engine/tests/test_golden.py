"""The write side of the contract mirror.

The committed fixture in packages/api-contract is parsed by the Zod
schemas over there; this test pins the engine's serialisation to the
same bytes. Either side drifting fails a suite, never a render. After
an intended schema change, regenerate per the pairs_engine.golden
docstring and land both sides with the fixture in one commit.
"""

from pathlib import Path

from pairs_engine.golden import (
    golden_backtest_json,
    golden_daily_json,
    golden_json,
    golden_weekly_json,
)

FIXTURES = Path(__file__).parents[3] / "packages" / "api-contract" / "fixtures"


def test_committed_golden_fixture_matches_the_engine_byte_for_byte():
    assert (FIXTURES / "pair-scan.golden.json").read_text() == golden_json()


def test_committed_backtest_fixture_matches_the_engine_byte_for_byte():
    assert (FIXTURES / "backtest.golden.json").read_text() == golden_backtest_json()


def test_committed_daily_fixture_matches_the_engine_byte_for_byte():
    assert (FIXTURES / "daily.golden.json").read_text() == golden_daily_json()


def test_committed_weekly_fixture_matches_the_engine_byte_for_byte():
    assert (FIXTURES / "weekly.golden.json").read_text() == golden_weekly_json()
