"""Immutable packaged source models for the three additional calculators.

Workbook formula caches are retained for regression evidence only. Runtime
calculations must use ``formula`` and literal ``value`` fields, never caches.
Public loaders return independent copies so an estimate cannot mutate defaults.
"""

from copy import deepcopy
from functools import lru_cache
import gzip
import json
from pathlib import Path
import re

from .catalog import ValidationError


DATA_DIRECTORY = Path(__file__).resolve().parent.parent / "data" / "calculators"
SCHEMA_VERSION = 1

# These boundaries come from each workbook's input shading, validation and
# protection. The board workbook's Settings page is exposed at the user's
# request, including its labelled source constants; reference tables stay fixed.
CATALOG_SPECS = {
    "steel_vermiculite": {
        "title": "Structural Steel (vermiculite)",
        "filename": "Ceasefire_Steel_Vermiculite_Estimator_NEW.xlsx",
        "input_ranges": {
            "CALCULATOR": ["D6:D12", "D14:D17"],
            "SCHEDULE": ["A10:L1009"],
            "BAGS": ["D6:D8"],
        },
        "setting_ranges": {"SETTINGS": [
            "D10:D14", "D36:D39", "D42", "D69:D72", "D75",
            "D101:D104", "D107", "D178:D181", "D184",
            "D234:D237", "D240", "D346:D348", "D358:D362", "D372",
        ]},
        "schedule": {"sheet": "SCHEDULE", "first_row": 10, "last_row": 1009,
                     "header_row": 9, "first_column": "A", "last_column": "Y",
                     "input_last_column": "L", "line_id_column": "Z"},
        "page_ranges": {"CALCULATOR": "A1:N41", "SCHEDULE": "A1:Y1009",
                        "BAGS": "A1:N29"},
        "extra_pages": [],
    },
    "ductwork": {
        "title": "Ductwork",
        "filename": "Ceasefire_Duct_Estimator_NEW.xlsx",
        "input_ranges": {"CALCULATOR": ["B11:I310"]},
        "setting_ranges": {"PRODUCT SETTINGS": [
            "B35", "B44:B46", "B65", "B73", "B90:B92", "B97", "B100",
        ]},
        "schedule": {"sheet": "CALCULATOR", "first_row": 11, "last_row": 310,
                     "header_row": 10, "first_column": "A", "last_column": "CL",
                     "input_last_column": "I", "line_id_column": "A"},
        "page_ranges": {},
        "extra_pages": [],
    },
    "steel_board": {
        "title": "Structural Steel (board)",
        "filename": "Ceasefire_Structural_Steel_Board_Estimator_NEW.xlsx",
        "input_ranges": {
            "CALCULATOR": ["A9:X208"],
            "EXTRA BOARDS": ["A6:I45", "N6:N45"],
        },
        "setting_ranges": {"SETTINGS": ["B6:B21", "B23:B34"]},
        "schedule": {"sheet": "CALCULATOR", "first_row": 9, "last_row": 208,
                     "header_row": 8, "first_column": "A", "last_column": "AI",
                     "input_last_column": "X", "advanced_first_column": "M"},
        "page_ranges": {"CALCULATOR": "A1:AI208"},
        "extra_pages": ["SETTINGS", "EXTRA BOARDS"],
    },
}


def column_number(column):
    """Convert an A1 column to its one-based index without spreadsheet tools."""
    if not isinstance(column, str) or not re.fullmatch(r"[A-Z]{1,3}", column):
        raise ValidationError("Invalid calculator column.")
    number = 0
    for character in column:
        number = number * 26 + ord(character) - 64
    if number > 16384:
        raise ValidationError("Invalid calculator column.")
    return number


def column_name(number):
    if isinstance(number, bool) or not isinstance(number, int) or not 1 <= number <= 16384:
        raise ValidationError("Invalid calculator column.")
    name = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        name = chr(65 + remainder) + name
    return name


def range_addresses(reference):
    """Yield bounded, canonical A1 cells for a source range."""
    if not isinstance(reference, str):
        raise ValidationError("Invalid calculator range.")
    match = re.fullmatch(r"\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?", reference)
    if not match:
        raise ValidationError("Invalid calculator range.")
    first_column = column_number(match[1])
    first_row = int(match[2])
    last_column = column_number(match[3] or match[1])
    last_row = int(match[4] or match[2])
    if last_row > 1048576 or last_row < first_row or last_column < first_column:
        raise ValidationError("Invalid calculator range.")
    if (last_row - first_row + 1) * (last_column - first_column + 1) > 1000000:
        raise ValidationError("Calculator range is too large.")
    for row in range(first_row, last_row + 1):
        for column in range(first_column, last_column + 1):
            yield f"{column_name(column)}{row}"


def _require_id(workbook_id):
    if not isinstance(workbook_id, str) or workbook_id not in CATALOG_SPECS:
        raise ValidationError("Choose an available calculator.")
    return workbook_id


@lru_cache(maxsize=3)
def _load(workbook_id):
    _require_id(workbook_id)
    with gzip.open(DATA_DIRECTORY / f"{workbook_id}.json.gz", "rt", encoding="utf-8") as source:
        data = json.load(source)
    if data.get("schema_version") != SCHEMA_VERSION or data.get("id") != workbook_id:
        raise ValueError("Packaged calculator schema does not match the application.")
    return data


def load_workbook_catalog(workbook_id):
    """Return an independent full model; modifications never change defaults."""
    return deepcopy(_load(_require_id(workbook_id)))


def list_workbook_catalogs():
    """Return small public metadata without loading any workbook formula graph."""
    data = json.loads((DATA_DIRECTORY / "index.json").read_text(encoding="utf-8"))
    if data.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("Packaged calculator index schema does not match the application.")
    return data["calculators"]


@lru_cache(maxsize=32)
def _editable_cells(workbook_id, sheet):
    specification = CATALOG_SPECS[workbook_id]
    ranges = specification["input_ranges"].get(sheet, []) + specification["setting_ranges"].get(sheet, [])
    return frozenset(address for reference in ranges for address in range_addresses(reference))


def editable_cells(workbook_id, sheet):
    """Return the immutable allowlist for both estimating and settings inputs."""
    _require_id(workbook_id)
    if not isinstance(sheet, str):
        raise ValidationError("Invalid calculator worksheet.")
    return _editable_cells(workbook_id, sheet)


def setting_cells(workbook_id, sheet):
    specification = CATALOG_SPECS[_require_id(workbook_id)]
    if not isinstance(sheet, str):
        raise ValidationError("Invalid calculator worksheet.")
    return frozenset(address for reference in specification["setting_ranges"].get(sheet, [])
                     for address in range_addresses(reference))
