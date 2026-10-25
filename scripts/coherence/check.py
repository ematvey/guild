#!/usr/bin/env python3
"""Coherence check: a floor on counters, plus a domain model that must stay true.

Decoherence is the accumulation of locally valid but incompatible designs.
It lives in two places, and this tool checks both.

  Counters   Files, lines, shims, copies. Cheap symptoms. They may go down,
             never up. This stops the cheapest rot.

  Model      A committed map of the domain: one record per concept, its
             canonical home, and every other place that represents it.
             The tool cannot judge the model. It can prove that the model
             still matches the tree, that no word means two things, and
             that every representation has a declared translation.

Usage:
    check.py check     exit 1 on any failure (CI and pre-commit)
    check.py report    counters, seams, duplicates, model summary
    check.py update    rewrite floor.json from the current tree
    check.py seams     list every declared seam and its state
    check.py model     list model gaps and alias collisions

Declare a seam next to the code that carries it:

    // coherence:seam owner=@handle until=2026-12-31 reason="dual write during migration"

See README.md.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
FLOOR = HERE / "floor.json"
MODELS = HERE / "models"

SCAN_ROOTS = ("apps", "crates", "packages")
SKIP_DIRS = {
    ".git",
    ".next",
    ".venv",
    "__pycache__",
    "bin",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "obj",
    "bindings",
    "data-test",
    "target",
    "vendor",
}
SOURCE_EXTS = {".rs", ".ts", ".tsx"}

# Counters that must not rise. Everything here is a symptom of decoherence.
FLOOR_COUNTERS = (
    "files",
    "loc",
    "seams",
    "shims",
    "duplicate_files",
    "translation_gaps",
    "unmodeled_types",
    "unmapped_files",
)

SEAM_RE = re.compile(r"coherence:seam\s+(.*)$")
KV_RE = re.compile(r'(\w+)=("([^"]*)"|\S+)')

# Declarations that carry a second design beside the first.
SHIM_RES = (
    re.compile(r"^\s*pub\s+fn\s+\w*(?:Legacy|Compat|Shim|Deprecated)\w*"),
    re.compile(r"^\s*(?:pub\s+)?(?:struct|enum)\s+\w*(?:Legacy|Compat|Shim|Deprecated)\w*\s"),
    re.compile(
        r"^\s*(?:export\s+)?(?:const|let|function|class|type|interface|enum)\s+\w*(?:Legacy|Compat|Shim|Deprecated)\w*"
    ),
    re.compile(r"^\s*(?://|/\*|\*)\s*@?[Dd]eprecated\b"),
)

RUST_TYPE_RE = re.compile(r"^\s*pub\s+(?:struct|enum)\s+([A-Z]\w*)")
# Generated TS bindings mirror the Rust types; the Rust source is the truth.

# Two files with identical content are one design kept in two places. They
# drift apart from the day they are copied, and each copy becomes a separate
# thing to learn. This is the cheapest reliable duplicate signal.
MIN_DUPLICATE_BYTES = 200


def rel(p: Path) -> str:
    return str(p.relative_to(REPO))


def iter_sources():
    for root_name in SCAN_ROOTS:
        root = REPO / root_name
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for name in sorted(filenames):
                p = Path(dirpath) / name
                if p.suffix in SOURCE_EXTS:
                    yield p


def parse_seam(line: str) -> dict | None:
    m = SEAM_RE.search(line)
    if not m:
        return None
    # KV_RE groups are (key, full value, quoted value).
    return {k: quoted or full for k, full, quoted in KV_RE.findall(m.group(1))}


# Files that cannot carry a domain concept, by rule. Everything else must be
# either referenced by a concept or listed in a fragment's "no_concept" list
# with a reason. That is what makes "every file studied" checkable.
NO_CONCEPT_RULES = (
    re.compile(r"(^|/)(__tests__|__mocks__|testdata|fixtures)/"),
    re.compile(r"(^|/)test/"),
    re.compile(r"_test\.go$"),
    re.compile(r"\.(test|spec)\.(ts|tsx|js|jsx)$"),
    re.compile(r"\.d\.ts$"),
    re.compile(r"(^|/)(vite-env|global|setupTests)\.(d\.)?ts$"),
)


# A file may be declared as carrying no domain concept, but only under one of
# these reasons. A free-text reason would let an agent file away 200 components
# with one sentence; a fixed set keeps the excuse countable.
NO_CONCEPT_REASONS = {
    "presentational",  # renders props, names no domain noun
    "infrastructure",  # build, config, entry point, routing, tooling
    "barrel",          # re-export only
    "types-only",      # type declarations with no domain rule
    "style",           # stylesheet or asset module
}


def carries_no_concept(path: str) -> bool:
    return any(rule.search(path) for rule in NO_CONCEPT_RULES)


def load_model() -> dict:
    """Merge every fragment in models/.

    Fragments exist so that several agents can extend the domain model in
    parallel without fighting over one file. Each fragment owns one area.
    A conflict between two fragments is a real finding, not a merge accident:
    the same concept or the same word appearing in two areas.
    """
    merged: dict = {
        "model_roots": [], "concepts": [], "sources": [], "no_concept": {}, "attaches": [],
        "shared_canonical": set(), "types_no_concept": {},
    }
    if not MODELS.is_dir():
        return merged
    for path in sorted(MODELS.glob("*.json")):
        try:
            frag = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            merged.setdefault("errors", []).append(f"{path.name}: {exc}")
            continue
        merged["sources"].append(path.name)
        for root in frag.get("model_roots", []):
            if root not in merged["model_roots"]:
                merged["model_roots"].append(root)
        for concept in frag.get("concepts", []):
            concept.setdefault("_source", path.name)
            merged["concepts"].append(concept)
        for entry in frag.get("attaches", []):
            where = entry.get("where")
            concept = entry.get("concept")
            if where and concept:
                merged["attaches"].append(
                    {"where": where, "concept": concept, "role": entry.get("role", "ui")}
                )
        for where in frag.get("shared_canonical", []):
            merged["shared_canonical"].add(where)
        for entry in frag.get("types_no_concept", []):
            name = entry.get("type") if isinstance(entry, dict) else entry
            reason = entry.get("reason", "") if isinstance(entry, dict) else ""
            if not name:
                continue
            if reason not in NO_CONCEPT_REASONS:
                merged.setdefault("errors", []).append(
                    f"{path.name}: types_no_concept {name} has reason {reason!r}, "
                    f"want one of {sorted(NO_CONCEPT_REASONS)}"
                )
                continue
            merged["types_no_concept"][name] = reason
        for entry in frag.get("no_concept", []):
            where = entry.get("where") if isinstance(entry, dict) else entry
            reason = entry.get("reason", "") if isinstance(entry, dict) else ""
            if not where:
                continue
            if reason not in NO_CONCEPT_REASONS:
                merged.setdefault("errors", []).append(
                    f"{path.name}: no_concept {where} has reason {reason!r}, "
                    f"want one of {sorted(NO_CONCEPT_REASONS)}"
                )
                continue
            merged["no_concept"][where] = reason
    return merged


def scan():
    files = 0
    loc = 0
    shims = 0
    seams: list[dict] = []
    by_digest: dict[str, list[str]] = {}

    for path in iter_sources():
        files += 1
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        text = raw.decode("utf-8", errors="replace")
        lines = text.splitlines()
        loc += sum(1 for line in lines if line.strip())

        if len(raw) >= MIN_DUPLICATE_BYTES:
            by_digest.setdefault(hashlib.sha256(raw).hexdigest(), []).append(rel(path))

        for lineno, line in enumerate(lines, 1):
            seam = parse_seam(line)
            if seam is not None:
                seams.append({"file": rel(path), "line": lineno, **seam})
            if any(r.search(line) for r in SHIM_RES):
                shims += 1

    duplicate_groups = sorted(
        (sorted(paths) for paths in by_digest.values() if len(paths) > 1),
        key=lambda g: g[0],
    )

    counts = {
        "files": files,
        "loc": loc,
        "seams": len(seams),
        "shims": shims,
        "duplicate_files": sum(len(g) - 1 for g in duplicate_groups),
    }
    return counts, seams, duplicate_groups


def model_types(model: dict) -> tuple[set[str], list[str]]:
    """Every exported Rust type under a declared model root, and the roots."""
    found: set[str] = set()
    roots = model.get("model_roots", [])
    for root in roots:
        d = REPO / root
        if not d.is_dir():
            continue
        for path in sorted(d.rglob("*.rs")):
            if path.name.endswith("_test.rs"):
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for line in text.splitlines():
                m = RUST_TYPE_RE.match(line)
                if m:
                    found.add(m.group(1))
    return found, roots


def analyze_model(model: dict):
    """Return (problems, gaps, collisions, stats)."""
    problems: list[str] = []
    collisions: list[str] = []

    problems.extend(model.get("errors", []))
    concepts = model.get("concepts", [])
    if not concepts:
        return problems, 0, 0, collisions, {
            "concepts": 0, "representations": 0, "translations": 0, "modeled_types": 0,
        }

    known_types, roots = model_types(model)
    for root in roots:
        if not (REPO / root).is_dir():
            problems.append(f"model root does not exist: {root}")

    alias_owner: dict[str, str] = {}
    canonical_owner: dict[str, str] = {}
    id_owner: dict[str, str] = {}
    claimed: set[str] = set()
    gaps = 0
    representations = 0
    translations = 0

    for c in concepts:
        cid = c.get("id")
        if not cid:
            problems.append("concept without id")
            continue
        source = c.get("_source", "?")
        if cid in id_owner:
            problems.append(
                f"{cid}: concept defined in two fragments: {id_owner[cid]} and {source}"
            )
        id_owner[cid] = source
        for field in ("definition", "canonical"):
            if not c.get(field):
                problems.append(f"{cid}: missing {field}")

        canonical = c.get("canonical")
        if canonical:
            if not (REPO / canonical).is_file():
                problems.append(f"{cid}: canonical path missing: {canonical}")
            if canonical in canonical_owner and canonical not in model.get("shared_canonical", set()):
                problems.append(f"{cid}: same canonical as {canonical_owner[canonical]}: {canonical}")
            canonical_owner[canonical] = cid

        # One word must mean one thing. Compare case- and punctuation-blind so
        # that "Patient", "patient", and "patient_record" collide as they should.
        for name in [cid, *c.get("aliases", [])]:
            key = alias_key(name)
            if not key:
                continue
            if key in alias_owner and alias_owner[key] != cid:
                collisions.append(f"{key}: {alias_owner[key]} and {cid} (as {name!r})")
            elif key in alias_owner and alias_owner[key] == cid:
                pass
            alias_owner[key] = cid

        reps = c.get("representations", [])
        representations += len(reps)
        roles = set()
        for rep in reps:
            where = rep.get("where")
            role = rep.get("role")
            if not where or not role:
                problems.append(f"{cid}: representation without where/role")
                continue
            roles.add(role)
            if not (REPO / where).is_file():
                problems.append(f"{cid}: representation missing: {where}")
            stem = Path(where).stem
            if stem in known_types:
                claimed.add(stem)

        for t in c.get("translations", []):
            translations += 1
            for side in ("from", "to"):
                if t.get(side) not in roles:
                    problems.append(f"{cid}: translation {side}={t.get(side)!r} is not a declared role")

        # A conversion is needed between distinct layers, not between files.
        # Ten ui files of one concept need no conversion at all; a domain and
        # a wire form need one. Count roles, not representations.
        needed = max(0, len(roles) - 1)
        gaps += max(0, needed - len(c.get("translations", [])))

    # A concept owns the Go types that carry it. Sub-types belong to the same
    # concept: PatientDoctor and PatientStatus are parts of Patient, not
    # separate designs.
    for c in concepts:
        claimed.update(c.get("types", []))
    for name, reason in model.get("types_no_concept", {}).items():
        if name not in known_types:
            problems.append(f"types_no_concept {name} is not a type under a model root")
        claimed.add(name)
    unmodeled = len(known_types - claimed)

    ids = {c.get("id") for c in concepts}
    for entry in model.get("attaches", []):
        if entry["concept"] not in ids:
            problems.append(
                f"attaches {entry['where']}: unknown concept {entry['concept']!r}"
            )
        elif not (REPO / entry["where"]).is_file():
            problems.append(f"attaches: file missing {entry['where']}")

    stats = {
        "concepts": len(concepts),
        "representations": representations,
        "translations": translations,
        "modeled_types": len(known_types),
    }
    return problems, gaps, unmodeled, collisions, stats


def alias_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def seam_state(seam: dict, today: dt.date) -> tuple[str, str]:
    missing = [k for k in ("owner", "until", "reason") if not seam.get(k)]
    if missing:
        return "invalid", f"missing {', '.join(missing)}"
    try:
        until = dt.date.fromisoformat(seam["until"])
    except ValueError:
        return "invalid", f"bad date {seam['until']!r}, want YYYY-MM-DD"
    if until < today:
        return "expired", f"expired {until.isoformat()}"
    return "ok", f"{(until - today).days}d left"


def load_floor() -> dict:
    if not FLOOR.is_file():
        return {}
    return json.loads(FLOOR.read_text(encoding="utf-8"))


def cmd_report() -> int:
    counts, seams, dupes = scan()
    model = load_model()
    problems, gaps, unmodeled, collisions, stats = analyze_model(model)
    counts["translation_gaps"] = gaps
    counts["unmodeled_types"] = unmodeled
    _areas, unmapped = coverage(model)
    counts["unmapped_files"] = len(unmapped)
    floor = load_floor().get("counts", {})
    today = dt.date.today()

    width = max(len(k) for k in counts)
    print(f"{'counter'.ljust(width)}  {'now':>10}  {'floor':>10}  {'delta':>8}")
    for key, value in counts.items():
        base = floor.get(key)
        delta = "" if base is None else f"{value - base:+d}"
        base_s = "—" if base is None else str(base)
        print(f"{key.ljust(width)}  {value:>10}  {base_s:>10}  {delta:>8}")

    print()
    if not seams:
        print("seams: none declared")
    else:
        print(f"seams: {len(seams)}")
        for seam in seams:
            state, note = seam_state(seam, today)
            print(f"  [{state:7}] {seam['file']}:{seam['line']}  {note}  {seam.get('reason', '')}")

    print()
    print(
        f"model: {stats['concepts']} concepts, {stats['representations']} representations, "
        f"{stats['translations']} translations, {stats['modeled_types']} types under model roots"
    )
    if problems:
        print(f"  {len(problems)} problem(s) - run `check`")
    if collisions:
        print(f"  {len(collisions)} alias collision(s) - run `model`")

    if dupes:
        print()
        print(f"duplicate files: {len(dupes)} groups")
        for group in dupes[:20]:
            print(f"  {len(group)} copies")
            for path in group:
                print(f"    {path}")
        if len(dupes) > 20:
            print(f"  ... and {len(dupes) - 20} more")
    return 0


def cmd_check() -> int:
    counts, seams, _dupes = scan()
    model = load_model()
    problems, gaps, unmodeled, collisions, _stats = analyze_model(model)
    counts["translation_gaps"] = gaps
    counts["unmodeled_types"] = unmodeled
    _areas, unmapped = coverage(model)
    counts["unmapped_files"] = len(unmapped)
    floor = load_floor().get("counts", {})
    today = dt.date.today()
    failed = False

    invalid, expired = [], []
    for seam in seams:
        state, note = seam_state(seam, today)
        if state == "expired":
            expired.append((seam, note))
        elif state == "invalid":
            invalid.append((seam, note))

    if invalid:
        failed = True
        print("FAIL invalid seam declarations:")
        for seam, note in invalid:
            print(f"  {seam['file']}:{seam['line']}  {note}")

    if expired:
        failed = True
        print("FAIL expired seams (delete the seam, or move the date and say why):")
        for seam, note in expired:
            print(f"  {seam['file']}:{seam['line']}  {note}  owner={seam.get('owner')}  {seam.get('reason', '')}")

    if problems:
        failed = True
        print("FAIL model does not match the tree:")
        for problem in problems:
            print(f"  {problem}")

    if collisions:
        failed = True
        print("FAIL one word, two meanings:")
        for collision in collisions:
            print(f"  {collision}")

    rises = []
    if not floor:
        print("note: no floor.json yet, counters are not ratcheted. Run `update`.")
    else:
        for key in FLOOR_COUNTERS:
            value = counts.get(key, 0)
            base = floor.get(key)
            if base is not None and value > base:
                rises.append((key, base, value))
    if rises:
        failed = True
        print("FAIL floor raised (remove something to pay for the addition):")
        for key, base, value in rises:
            print(f"  {key}: {base} -> {value}  (+{value - base})")

    drops = [(k, floor[k], counts[k]) for k in FLOOR_COUNTERS if k in floor and counts.get(k, 0) < floor[k]]
    if drops:
        print("floor dropped. Run `update` and commit floor.json:")
        for key, base, value in drops:
            print(f"  {key}: {base} -> {value}  ({value - base})")

    if failed:
        return 1

    print(f"ok  {len(FLOOR_COUNTERS)} counters at or below floor, {len(seams)} seams valid, model consistent")
    return 0


def cmd_update() -> int:
    counts, seams, _dupes = scan()
    model = load_model()
    _problems, gaps, unmodeled, _collisions, _stats = analyze_model(model)
    counts["translation_gaps"] = gaps
    counts["unmodeled_types"] = unmodeled
    _areas, unmapped = coverage(model)
    counts["unmapped_files"] = len(unmapped)
    payload = {
        "comment": "Coherence floor. Counters may go down, never up. See README.md.",
        "updated": dt.date.today().isoformat(),
        "counts": {k: counts.get(k, 0) for k in FLOOR_COUNTERS},
        "declared_seams": len(seams),
    }
    FLOOR.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {rel(FLOOR)}")
    for key in FLOOR_COUNTERS:
        print(f"  {key}: {counts.get(key, 0)}")
    return 0


def cmd_seams() -> int:
    _, seams, _dupes = scan()
    today = dt.date.today()
    if not seams:
        print("no seams declared")
        return 0
    for seam in seams:
        state, note = seam_state(seam, today)
        print(f"[{state}] {seam['file']}:{seam['line']}")
        print(f"    owner  {seam.get('owner', '-')}")
        print(f"    until  {seam.get('until', '-')}  ({note})")
        print(f"    reason {seam.get('reason', '-')}")
    return 0


def coverage(model: dict) -> tuple[dict, list[str]]:
    """Every scannable source file, split into mapped and unmapped.

    A file is mapped when a concept names it as canonical or as a
    representation, or when a fragment lists it in no_concept with a reason.
    Everything else is unmapped and must be driven to zero by reading it.
    """
    referenced: set[str] = set()
    for c in model.get("concepts", []):
        if c.get("canonical"):
            referenced.add(c["canonical"])
        for rep in c.get("representations", []):
            if rep.get("where"):
                referenced.add(rep["where"])
    for entry in model.get("attaches", []):
        if entry.get("where"):
            referenced.add(entry["where"])
    excluded = model.get("no_concept", {})

    areas: dict[str, dict[str, int]] = {}
    unmapped: list[str] = []
    for path in iter_sources():
        rel_path = rel(path)
        if carries_no_concept(rel_path):
            continue
        parts = rel_path.split("/")
        area = "/".join(parts[:2]) if parts[0] == "apps" else "/".join(parts[:2])
        bucket = areas.setdefault(area, {"total": 0, "mapped": 0, "excluded": 0})
        bucket["total"] += 1
        if rel_path in referenced:
            bucket["mapped"] += 1
        elif rel_path in excluded:
            bucket["excluded"] += 1
        else:
            unmapped.append(rel_path)
    return areas, sorted(unmapped)


def cmd_coverage(prefix: str = "") -> int:
    model = load_model()
    areas, unmapped = coverage(model)
    excluded = model.get("no_concept", {})
    if prefix:
        unmapped = [u for u in unmapped if u.startswith(prefix)]
        areas = {a: b for a, b in areas.items() if a.startswith(prefix) or prefix.startswith(a)}
    print(f"{'area':40} {'total':>7} {'mapped':>7} {'no-obj':>7} {'unmapped':>9}")
    for area in sorted(areas, key=lambda a: -(areas[a]["total"] - areas[a]["mapped"] - areas[a]["excluded"])):
        b = areas[area]
        left = b["total"] - b["mapped"] - b["excluded"]
        print(f"{area:40} {b['total']:>7} {b['mapped']:>7} {b['excluded']:>7} {left:>9}")
    total = sum(b["total"] for b in areas.values())
    mapped = sum(b["mapped"] for b in areas.values())
    excl = sum(b["excluded"] for b in areas.values())
    print()
    print(f"total {total}  mapped {mapped}  no-concept {excl}  unmapped {len(unmapped)}")
    if excluded:
        from collections import Counter
        print("no-concept by reason:", dict(Counter(excluded.values())))
    if unmapped:
        print()
        print("unmapped files (first 40):")
        for path in unmapped[:40]:
            print(f"  {path}")
        if len(unmapped) > 40:
            print(f"  ... and {len(unmapped) - 40} more")
    return 0


def cmd_model() -> int:
    model = load_model()
    if not model or not model.get("concepts"):
        print(f"no model fragments in {rel(MODELS)}")
        return 0
    problems, gaps, unmodeled, collisions, stats = analyze_model(model)
    known_types, _roots = model_types(model)

    print(f"fragments: {', '.join(model.get('sources', [])) or 'none'}")
    print(
        f"{stats['concepts']} concepts, {stats['representations']} representations, "
        f"{stats['translations']} translations"
    )
    print(f"types under model roots: {len(known_types)}")
    print(f"translation gaps: {gaps}")
    print(f"unmodeled types: {unmodeled}")
    print()

    if collisions:
        print("alias collisions (one word, two meanings):")
        for collision in collisions:
            print(f"  {collision}")
        print()

    if problems:
        print("model problems:")
        for problem in problems:
            print(f"  {problem}")
        print()

    claimed = {c.get("id") for c in model.get("concepts", [])}
    for c in model.get("concepts", []):
        claimed.update(c.get("aliases", []))
        claimed.update(c.get("types", []))

    claimed.update(model.get("types_no_concept", {}).keys())
    missing = sorted(known_types - claimed)
    if missing:
        print(f"types with no concept ({len(missing)}):")
        for name in missing:
            print(f"  {name}")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("check", "report", "update", "seams", "model", "coverage"))
    parser.add_argument("--prefix", default="", help="limit `coverage` to paths starting with this prefix")
    args = parser.parse_args(argv)
    if args.command == "coverage":
        return cmd_coverage(args.prefix)
    return {
        "check": cmd_check,
        "report": cmd_report,
        "update": cmd_update,
        "seams": cmd_seams,
        "model": cmd_model,
    }[args.command]()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
