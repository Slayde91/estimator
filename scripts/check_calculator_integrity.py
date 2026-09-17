"""Read-only, strict source-to-frozen-catalog audit with bounded diagnostics.

Run ``python scripts/check_calculator_integrity.py --source-directory PATH``.
JSON goes to stdout; progress goes to stderr. Exit status is 0 only when all
three sources match their frozen catalogs and remain unchanged while read.
Use --source ID=PATH to override individual source locations. No source,
catalog, or report files are written by this command.
"""

from __future__ import annotations

import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from estimator.workbook_catalog import CATALOG_SPECS, DATA_DIRECTORY
from scripts.import_calculators import DEFAULT_SOURCE_DIRECTORY, extract_calculator


_MISSING = object()


def _pointer(parts):
    return "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def _category(parts):
    if parts and parts[0] == "source":
        return "source_identity"
    if parts and parts[0] == "styles":
        return "styles"
    if len(parts) >= 3 and parts[0] == "sheets" and isinstance(parts[1], int) and parts[2] == "cells":
        field = parts[4:]
        if field:
            if field[0] == "formula":
                return "formula_text"
            if field[0] == "formula_attributes":
                return "formula_attributes"
            if field[0] == "cached_value":
                return "formula_caches"
            if field[0] == "value":
                return "literal_values"
            if field[0] == "source_value":
                return "source_literal_values"
            if field[0] == "style":
                return "styles"
            if field[0] == "data_type":
                return "data_types"
        return "cell_structure"
    return "workbook_metadata"


def _preview(value, limit):
    if value is _MISSING:
        return {"type": "missing"}
    kind = type(value).__name__
    if isinstance(value, str) and len(value) > limit:
        return {"type": kind, "value": value[:limit], "truncated": True, "length": len(value)}
    # Only leaves or changed container types reach here; never dump a subtree.
    if isinstance(value, (dict, list)):
        return {"type": kind, "length": len(value)}
    return {"type": kind, "value": value}


def _differences(expected, actual, parts=()):
    """Yield every differing leaf without constructing a diff of whole books.

    Lists remain positional (including sheets and style records). Added and
    removed branches are visited to count their individual fields. Container
    and scalar types are checked explicitly, including bool versus number.
    """
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in sorted(expected.keys() | actual.keys()):
            yield from _differences(expected.get(key, _MISSING), actual.get(key, _MISSING), parts + (key,))
    elif isinstance(expected, list) and isinstance(actual, list):
        for index in range(max(len(expected), len(actual))):
            yield from _differences(expected[index] if index < len(expected) else _MISSING,
                                    actual[index] if index < len(actual) else _MISSING, parts + (index,))
    elif expected is _MISSING and isinstance(actual, (dict, list)) and actual:
        entries = sorted(actual.items()) if isinstance(actual, dict) else enumerate(actual)
        for key, value in entries:
            yield from _differences(_MISSING, value, parts + (key,))
    elif actual is _MISSING and isinstance(expected, (dict, list)) and expected:
        entries = sorted(expected.items()) if isinstance(expected, dict) else enumerate(expected)
        for key, value in entries:
            yield from _differences(value, _MISSING, parts + (key,))
    elif type(expected) is not type(actual) or expected != actual:
        yield parts, expected, actual


def compare_catalogs(expected, actual, *, sample_limit=30, value_limit=160):
    """Compare every field; cap diagnostics, never the comparison itself.

    ``matches`` is the strict verdict suitable for a regression assertion.
    ``extracted_content_matches`` excludes only the ``source`` provenance
    object from its separate explanatory verdict, not from the strict verdict.
    No formula, cache, literal, style, ordering, or metadata is excluded.
    Counts describe changed leaf fields, not changed cells.
    """
    if not isinstance(sample_limit, int) or not 0 <= sample_limit <= 1000:
        raise ValueError("sample_limit must be between 0 and 1000")
    if not isinstance(value_limit, int) or not 1 <= value_limit <= 2000:
        raise ValueError("value_limit must be between 1 and 2000")
    counts = Counter()
    samples = []
    category_samples = {}
    total = 0
    for parts, before, after in _differences(expected, actual):
        total += 1
        category = _category(parts)
        counts[category] += 1
        retain = len(samples) < sample_limit
        retain_category = len(category_samples.get(category, [])) < min(3, sample_limit)
        if retain or retain_category:
            detail = {"path": _pointer(parts), "category": category,
                      "kind": "added" if before is _MISSING else "removed" if after is _MISSING else "changed",
                      "expected": _preview(before, value_limit), "actual": _preview(after, value_limit)}
            if len(parts) >= 2 and parts[0] == "sheets" and isinstance(parts[1], int):
                for label, catalog in (("expected_sheet", expected), ("actual_sheet", actual)):
                    sheets = catalog.get("sheets", []) if isinstance(catalog, dict) else []
                    if parts[1] < len(sheets) and isinstance(sheets[parts[1]], dict):
                        detail[label] = sheets[parts[1]].get("name")
            if retain:
                samples.append(detail)
            if retain_category:
                category_samples.setdefault(category, []).append(detail)
    return {"matches": total == 0, "difference_count": total,
            "source_provenance_matches": counts["source_identity"] == 0,
            "extracted_content_matches": total == counts["source_identity"],
            "category_counts": dict(sorted(counts.items())), "samples": samples,
            "category_samples": dict(sorted(category_samples.items())),
            "omitted_samples": total - len(samples), "sample_limit": sample_limit,
            "count_basis": "differing leaf fields; changed container types count once"}


def format_catalog_difference(result):
    """Small assertion message; deliberately does not stringify either book."""
    summary = f"{result['difference_count']} catalog field differences: " + ", ".join(
        f"{category}={count}" for category, count in result["category_counts"].items())
    samples = {item["path"]: item for item in result["samples"]}
    for category in result["category_samples"].values():
        for item in category:
            samples.setdefault(item["path"], item)
    details = [json.dumps(item, ensure_ascii=True, allow_nan=False) for item in samples.values()]
    omitted = result["difference_count"] - len(samples)
    if omitted:
        details.append(f"{omitted} further differences counted; diagnostics capped.")
    return "\n".join([summary, *details])


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def audit_calculator(identifier, source_path, catalog_path, *, sample_limit=30):
    """Read only; compare both extraction and before/after file fingerprints."""
    source_path, catalog_path = Path(source_path), Path(catalog_path)
    result = {"id": identifier, "source_path": str(source_path.resolve()),
              "catalog_path": str(catalog_path.resolve()), "matches": False}
    before = {}
    errors = []
    try:
        before = {"source": _sha256(source_path), "catalog": _sha256(catalog_path)}
        with gzip.open(catalog_path, "rt", encoding="utf-8") as package:
            expected = json.load(package)
        actual = extract_calculator(source_path, identifier)
        result.update(compare_catalogs(expected, actual, sample_limit=sample_limit))
        expected_hash = expected["source"]["sha256"]
        result["byte_identity"] = {
            "matches": before["source"] == actual["source"]["sha256"] == expected_hash,
            "expected_sha256": expected_hash, "actual_sha256": before["source"],
            "extracted_sha256": actual["source"]["sha256"],
        }
    except Exception as error:
        errors.append(f"{type(error).__name__}: {str(error)[:500]}")
    finally:
        for name, path in (("source", source_path), ("catalog", catalog_path)):
            if name in before:
                try:
                    after = _sha256(path)
                    result[name + "_unchanged_during_audit"] = before[name] == after
                    if before[name] != after:
                        errors.append(f"{name} bytes changed while the audit was reading them")
                except Exception as error:
                    result[name + "_unchanged_during_audit"] = False
                    errors.append(f"Cannot verify {name} after reading: {type(error).__name__}: {str(error)[:500]}")
    result["errors"] = errors
    result["matches"] = result["matches"] and not errors and result.get("byte_identity", {}).get("matches", False)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-directory", type=Path, default=DEFAULT_SOURCE_DIRECTORY)
    parser.add_argument("--catalog-directory", type=Path, default=DATA_DIRECTORY)
    parser.add_argument("--source", action="append", default=[], metavar="ID=PATH")
    parser.add_argument("--sample-limit", type=int, default=30)
    args = parser.parse_args(argv)
    if not 0 <= args.sample_limit <= 1000:
        parser.error("--sample-limit must be between 0 and 1000")
    overrides = {}
    for item in args.source:
        identifier, separator, path = item.partition("=")
        if not separator or identifier not in CATALOG_SPECS or not path or identifier in overrides:
            parser.error("--source requires a unique known ID=PATH; IDs: " + ", ".join(CATALOG_SPECS))
        overrides[identifier] = Path(path)
    results = []
    for identifier, spec in CATALOG_SPECS.items():
        print(f"Auditing {identifier}…", file=sys.stderr, flush=True)
        result = audit_calculator(identifier, overrides.get(identifier, args.source_directory / spec["filename"]),
                                  args.catalog_directory / f"{identifier}.json.gz", sample_limit=args.sample_limit)
        results.append(result)
        counts = ", ".join(f"{key}={value}" for key, value in result.get("category_counts", {}).items())
        print(f"{identifier}: {'MATCH' if result['matches'] else 'FAIL'}; "
              f"{result.get('difference_count', 'unknown')} field differences ({counts}); "
              f"{len(result['errors'])} errors", file=sys.stderr, flush=True)
    report = {"schema_version": 1, "matches": all(item["matches"] for item in results),
              "scope": "Every extracted field and source SHA-256; no exclusions or migrations",
              "calculators": results}
    print(json.dumps(report, ensure_ascii=True, allow_nan=False, indent=2))
    return 0 if report["matches"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
