"""Replay conformance.json. The TypeScript SDK replays the same file, so the two agree on what a statement means."""

import json
import sys
from pathlib import Path

import pytest

import seaway as archil
from seaway.plan import canonical
from seaway.shell import Glob, quote, render, sql_literal
from seaway.statement import REDUCERS, describe_param

ROOT = Path(__file__).resolve().parents[2] / "conformance"
sys.path.insert(0, str(ROOT))
import harness  # noqa: E402

SPEC = json.loads((ROOT / "conformance.json").read_text())


def same(got, want, where="") -> None:
    """Equal, except that numbers named usd* may differ by rounding."""
    if isinstance(want, dict):
        assert isinstance(got, dict) and set(got) == set(want), where
        for key in want:
            if key.startswith("usd"):
                assert got[key] == pytest.approx(want[key], abs=1e-9), f"{where}.{key}"
            else:
                same(got[key], want[key], f"{where}.{key}")
    elif isinstance(want, list):
        assert isinstance(got, list) and len(got) == len(want), where
        for i, (g, w) in enumerate(zip(got, want)):
            same(g, w, f"{where}[{i}]")
    else:
        assert got == want, where


@pytest.fixture(scope="module")
def ctx(tmp_path_factory):
    backend = archil.LocalBackend(root=tmp_path_factory.mktemp("conformance"))
    return harness.build(backend, SPEC["disks"], SPEC["context"])


@pytest.mark.parametrize("case", SPEC["cases"], ids=lambda c: c["name"])
def test_plan(ctx, case):
    plan = harness.statement(ctx, case).explain()
    same(plan.to_dict(), case["plan"], case["name"])
    assert str(plan) == case["text"]


def test_manifest_and_describe(ctx):
    assert ctx.manifest() == SPEC["manifest"] and ctx.describe() == SPEC["describe"]
    n = SPEC["narrowed"]
    narrowed = ctx.narrow(*n["paths"], read_only=n["readOnly"])
    assert narrowed.manifest() == n["manifest"] and narrowed.describe() == n["describe"]
    again = archil.from_manifest(n["manifest"], backend=ctx.backend)
    assert again.manifest() == n["manifest"]


def test_quoting_and_templates():
    for q in SPEC["quote"]:
        assert quote(q["value"]) == q["shell"]
    for q in SPEC["sqlLiteral"]:
        assert sql_literal(q["value"]) == q["sql"]
    for r in SPEC["render"]:
        assert render(r["template"], r["params"], lambda name, value: f"<{value}>") == r["out"]
    for c in SPEC["canonical"]:
        assert canonical(c["value"]) == c["json"]


def test_globs():
    for g in SPEC["globs"]:
        glob = Glob("m", g["pattern"][2:])
        assert glob.static_prefix() == g["prefix"]
        assert [p for p in g["paths"] if glob.regex().match(p)] == g["matches"]


def test_reducers():
    for r in SPEC["reducers"]:
        if "error" in r:
            with pytest.raises(archil.Error) as exc:
                REDUCERS[r["reduce"]](r["outputs"])
            assert exc.value.code == r["error"]
        else:
            value, stdout = REDUCERS[r["reduce"]](r["outputs"])
            assert value == r["value"] and stdout == r["stdout"]
            if isinstance(value, dict):
                assert list(value) == list(r["value"])  # key order is part of the result


def test_parameters_as_text(ctx):
    for d in SPEC["describeParam"]:
        assert describe_param(harness.param(ctx, d["param"])) == d["text"]


def test_pricing():
    prices, want = archil.PriceSheet(), SPEC["pricing"]
    assert prices.as_of == want["asOf"] and prices.call_usd == pytest.approx(want["callUsd"])
    for c in want["callUnits"]:
        assert prices.call_units(c["vcpu"], c["memMib"]) == c["units"]
    assert prices.active_usd(1024**3) == pytest.approx(want["activeUsd1GiB"])
    assert prices.egress_usd(1000**3) == pytest.approx(want["egressUsd1GB"])
    assert prices.sandbox_hour_usd(2, 4096) == pytest.approx(want["sandboxHourUsd"])
    assert prices.breakeven_calls_per_hour() == want["breakevenCallsPerHour"]
