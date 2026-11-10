"""Compare what the two SDKs reported. Usage: compare.py <dir>"""
import json, sys
d = sys.argv[1]
load = lambda name: json.load(open(f"{d}/{name}.json"))
bad = 0
def same(a, b, where, tol_usd=True):
    global bad
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            bad += 1; print("KEYS DIFFER", where, sorted(set(a) ^ set(b))); return
        for k in a:
            if tol_usd and k.startswith("usd") and isinstance(a[k], (int, float)):
                if abs(a[k] - b[k]) > 1e-9: bad += 1; print("DIFF", f"{where}.{k}", a[k], b[k])
            else: same(a[k], b[k], f"{where}.{k}")
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            bad += 1; print("LEN DIFFERS", where, len(a), len(b), "\n   ", json.dumps(a)[:300], "\n   ", json.dumps(b)[:300]); return
        for i, (x, y) in enumerate(zip(a, b)): same(x, y, f"{where}[{i}]")
    elif a != b:
        bad += 1; print("DIFF", where, "\n   ", json.dumps(a, ensure_ascii=False)[:400], "\n   ", json.dumps(b, ensure_ascii=False)[:400])
def expect(what, got, want):
    global bad
    if got != want: bad += 1; print("UNEXPECTED", what, "\n    got ", json.dumps(got, ensure_ascii=False)[:400], "\n    want", json.dumps(want, ensure_ascii=False)[:400])
# the journal is named after a random session and holds timings, so it is left out of the seed comparison
def strip_versions(listing): return {k: [[p, s] for p, s, _ in v if "/journal/" not in p] for k, v in listing.items()}

for seeder, changer in (("py", "ts"), ("ts", "py")):
    seed, check, verify = load(f"{seeder}-seed-{seeder}"), load(f"{seeder}-check-{changer}"), load(f"{seeder}-verify-{seeder}")
    tag = f"[{seeder} seeds, {changer} changes]"
    # the second SDK sees exactly what the first one left: same files, sizes, versions, plans, fingerprints
    for key in ("listing", "plans", "errors_fingerprint", "errors_fresh", "manifest", "describe", "issue_files"):
        same(seed[key], check[key], f"{tag} seed vs check: {key}")
    expect(f"{tag} view built by {seeder} is fresh for {changer}", check["errors_fresh"], True)
    expect(f"{tag} skills recipe unchanged", check["sync_skills_same"], {"written": 0, "unchanged": 3, "deleted": 0, "into": "work/skills"})
    expect(f"{tag} issues recipe unchanged", check["sync_issues_same"], {"written": 0, "unchanged": 2, "deleted": 0, "into": "team/issues"})
    expect(f"{tag} feed cursor honoured", check["feed_empty"], True)
    expect(f"{tag} fresh view not rebuilt", check["errors_refresh_ran"], False)
    expect(f"{tag} feed sees the new writer", check["feed_added"], ["logs/api/2026-11-09/14/ts-1.ndjson"])
    expect(f"{tag} count view", check["count_first"].strip(), "32")
    expect(f"{tag} skills changed", check["sync_skills_changed"], {"written": 1, "unchanged": 2, "deleted": 0, "into": "work/skills"})
    expect(f"{tag} commit", check["commit"], [["work/from-ts.md"], ["work/from-py.md"], 1])
    expect(f"{tag} conflict caused by {seeder}'s write", check["conflict"], ["work/contested-ts.md"])
    # and back again
    same(check["after"], verify["listing"], f"{tag} after vs verify: listing")
    expect(f"{tag} view built by {changer} is fresh for {seeder}", verify["count_fresh"], True)
    expect(f"{tag} errors view is stale after the new log file", verify["errors_fresh"], False)
    expect(f"{tag} ack by {changer} honoured by {seeder}", verify["feed_empty_after_ts_ack"], True)
    expect(f"{tag} skills unchanged again", verify["sync_skills_again"], {"written": 0, "unchanged": 3, "deleted": 0, "into": "work/skills"})
    expect(f"{tag} issues unchanged again", verify["sync_issues_again"], {"written": 0, "unchanged": 2, "deleted": 0, "into": "team/issues"})
    expect(f"{tag} frozen", [verify["frozen_modes"], verify["frozen_read"]], [["frozen"], "ts\n"])
    expect(f"{tag} journal kinds", verify["journal_kinds"], ["commit", "sh", "sync"])
    expect(f"{tag} log rows", verify["log_sql"], [{"n": 32, "ids": 32, "stamps": 3}])
    expect(f"{tag} tx manifest", verify["ts_tx_manifest"], "W\tfrom-ts.md\nD\tfrom-py.md\n")
    expect(f"{tag} conflict caused by {changer}'s write", verify["conflict"], ["work/contested.md"])
    expect(f"{tag} contested file is the direct write", verify["contested"], "ts\n")
    print(tag, "journal:", verify["journal_sql"])
    print(tag, "view state written by", changer, ":", verify["ts_view_state"][:60], "…")

# the two seeds, on separate roots: everything but the timestamps must agree
py, ts = load("py-seed-py"), load("ts-seed-ts")
for key in ("view_first", "feed_added", "sync_skills", "sync_issues", "commit", "apply_script", "apply_mounts", "tx_manifest", "manifest", "describe", "issue_files"):
    same(py[key], ts[key], f"seeds: {key}")
same(strip_versions(py["listing"]), strip_versions(ts["listing"]), "seeds: listing without versions")
for name in py["plans"]:
    if name != "grep-all":  # its size estimate includes the journal
        same(py["plans"][name], ts["plans"][name], f"seeds: plan {name}")
print("apply script:\n" + ts["apply_script"])
print("\nPROBLEMS:", bad)
sys.exit(1 if bad else 0)
