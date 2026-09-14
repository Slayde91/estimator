"""Package exact workbook formulas, data and presentation metadata for runtime.

This developer-only reader never opens Excel, executes VBA or writes to its
sources. Shared formulas are expanded with the existing OOXML translator.
Formula caches are separate evidence fields, not application calculation data.
"""

from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
import gzip
import json
from pathlib import Path
import posixpath
import re
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from estimator.workbook_catalog import CATALOG_SPECS, SCHEMA_VERSION, column_name, column_number, range_addresses
from scripts.import_workbooks import SourceWorkbook, NS, DOC_REL_NS


DEFAULT_SOURCE_DIRECTORY = Path.home() / "OneDrive - Ceasefire PFP" / "Quotes" / "Quote Estimates" / "Ceasefire Calculators"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


def xml_data(node):
    if node is None:
        return None
    return {"tag": node.tag.split("}")[-1], "attributes": dict(node.attrib),
            "text": node.text, "children": [xml_data(child) for child in node]}


def normalize_literal_text(node, value, inherited_space="default"):
    """Match native Excel loading of literal OOXML ``t=str`` values.

    Verified with Excel16/build20326: XML whitespace at the edges is discarded
    unless xml:space=preserve is effective. Internal spaces and NBSP remain.
    Shared/inline strings and formula-returned strings are separate OOXML cases
    and are intentionally untouched here. The caller retains changed raw text.
    """
    if node.attrib.get("t") != "str" or node.find("x:f", NS) is not None or not isinstance(value, str):
        return value
    raw = node.find("x:v", NS)
    if raw is None:
        return value
    space = raw.attrib.get(XML_SPACE, node.attrib.get(XML_SPACE, inherited_space))
    return value if space == "preserve" else value.strip(" \t\r\n")


def _styles(book):
    # openpyxl is already a pinned application dependency; use its published
    # built-in format map only while extracting, never to recalculate formulas.
    from openpyxl.styles.numbers import BUILTIN_FORMATS
    root = ET.fromstring(book.archive.read("xl/styles.xml"))
    number_formats = dict(BUILTIN_FORMATS)
    number_formats.update({int(node.attrib["numFmtId"]): node.attrib["formatCode"]
                           for node in root.findall("x:numFmts/x:numFmt", NS)})
    fonts = [xml_data(node) for node in root.findall("x:fonts/x:font", NS)]
    fills = [xml_data(node) for node in root.findall("x:fills/x:fill", NS)]
    styles = []
    for node in root.findall("x:cellXfs/x:xf", NS):
        protection = node.find("x:protection", NS)
        alignment = node.find("x:alignment", NS)
        styles.append({
            "number_format_id": int(node.attrib.get("numFmtId", 0)),
            "number_format": number_formats.get(int(node.attrib.get("numFmtId", 0)), "General"),
            "font": fonts[int(node.attrib.get("fontId", 0))],
            "fill": fills[int(node.attrib.get("fillId", 0))],
            "alignment": dict(alignment.attrib) if alignment is not None else {},
            "locked": protection is None or protection.attrib.get("locked", "1") != "0",
            "attributes": dict(node.attrib),
        })
    return {"number_formats": {str(key): value for key, value in number_formats.items()},
            "cell_styles": styles, "xml": xml_data(root)}


def _validations(root):
    result = []
    for node in root.findall("x:dataValidations/x:dataValidation", NS):
        entry = dict(node.attrib)
        for key in ("formula1", "formula2"):
            formula = node.find(f"x:{key}", NS)
            if formula is not None:
                entry[key] = formula.text or ""
        result.append(entry)
    return result


def _used_dimension(cells, merges):
    """Some supplied sheets omit OOXML dimension; derive their actual extent."""
    addresses = list(cells)
    for reference in merges:
        addresses.extend(reference.replace("$", "").split(":"))
    if not addresses:
        return "A1"
    coordinates = [(column_number(re.match(r"[A-Z]+", address)[0]), int(re.search(r"\d+$", address)[0]))
                   for address in addresses]
    first_column = min(value[0] for value in coordinates)
    last_column = max(value[0] for value in coordinates)
    first_row = min(value[1] for value in coordinates)
    last_row = max(value[1] for value in coordinates)
    return f"{column_name(first_column)}{first_row}:{column_name(last_column)}{last_row}"


def _tables(book, sheet_name, root):
    """Resolve table parts so structured references retain their true ranges."""
    parts = root.findall("x:tableParts/x:tablePart", NS)
    if not parts:
        return {}
    sheet_path = book.sheet_paths[sheet_name]
    directory, filename = posixpath.split(sheet_path)
    relationships_path = posixpath.join(directory, "_rels", filename + ".rels")
    relationships = ET.fromstring(book.archive.read(relationships_path))
    targets = {node.attrib["Id"]: node.attrib["Target"] for node in relationships}
    tables = {}
    for part in parts:
        target = targets[part.attrib[f"{{{DOC_REL_NS}}}id"]]
        table_path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(directory, target))
        table = ET.fromstring(book.archive.read(table_path))
        name = table.attrib.get("name", table.attrib["displayName"])
        tables[name] = {
            "name": name, "display_name": table.attrib["displayName"],
            "sheet": sheet_name, "ref": table.attrib["ref"],
            "header_row_count": int(table.attrib.get("headerRowCount", 1)),
            "totals_row_count": int(table.attrib.get("totalsRowCount", 0)),
            "columns": [{"id": int(column.attrib["id"]), "name": column.attrib["name"]}
                        for column in table.findall("x:tableColumns/x:tableColumn", NS)],
            "metadata": xml_data(table),
        }
    return tables


def _field_type(sheet, address, validation_map, label=""):
    validation = validation_map.get(address)
    if validation and validation.get("type") == "list":
        return "select"
    if validation and validation.get("type") in ("decimal", "whole"):
        return "number"
    value = sheet["cells"].get(address, {}).get("value")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "number"
    if any(word in label.casefold() for word in ("quantity", "thickness", "depth", "width", "length", "height", "diameter", "girth", "area", "count", "waste", "yield", "density", "mass", "temperature", "perimeter")):
        return "number"
    return "text"


def _fields(data, specification):
    sheets = {sheet["name"]: sheet for sheet in data["sheets"]}
    validation_maps = {}
    for name, sheet in sheets.items():
        validation_maps[name] = {}
        for validation in sheet["validations"]:
            for reference in validation.get("sqref", "").split():
                for address in range_addresses(reference):
                    validation_maps[name][address] = validation
    schedule = deepcopy(specification["schedule"])
    sheet = sheets[schedule["sheet"]]
    schedule["columns"] = []
    ranges = specification["input_ranges"].get(sheet["name"], [])
    editable = {address for reference in ranges for address in range_addresses(reference)}
    for index in range(column_number(schedule["first_column"]), column_number(schedule["last_column"]) + 1):
        column = column_name(index)
        address = f"{column}{schedule['first_row']}"
        label = sheet["cells"].get(f"{column}{schedule['header_row']}", {}).get("value") or column
        field = {"column": column, "label": label, "type": _field_type(sheet, address, validation_maps[sheet["name"]], str(label)),
                 "editable": address in editable}
        if address in validation_maps[sheet["name"]]:
            field["validation"] = validation_maps[sheet["name"]][address]
        if schedule.get("advanced_first_column"):
            field["advanced"] = index >= column_number(schedule["advanced_first_column"]) and address in editable
        schedule["columns"].append(field)
    data["schedule"] = schedule
    data["fields"] = {}
    for name in sheets:
        if name not in specification["input_ranges"] and name not in specification["setting_ranges"]:
            continue
        if name == schedule["sheet"] or name == "EXTRA BOARDS":
            continue
        sheet = sheets[name]
        references = specification["input_ranges"].get(name, []) + specification["setting_ranges"].get(name, [])
        fields = []
        for reference in references:
            for address in range_addresses(reference):
                row = re.search(r"\d+$", address).group()
                label = sheet["cells"].get(f"A{row}", {}).get("value") or address
                field = {"cell": address, "label": label, "type": _field_type(sheet, address, validation_maps[name], str(label)),
                         "setting": name in specification["setting_ranges"]}
                if address in validation_maps[name]:
                    field["validation"] = validation_maps[name][address]
                if name == "SETTINGS" and data["id"] == "steel_vermiculite":
                    field["notes"] = sheet["cells"].get(f"G{row}", {}).get("value") or ""
                elif name in specification["setting_ranges"]:
                    field["units"] = sheet["cells"].get(f"C{row}", {}).get("value") or ""
                    field["notes"] = sheet["cells"].get(f"D{row}", {}).get("value") or ""
                fields.append(field)
        data["fields"][name] = fields


def extract_calculator(path, workbook_id):
    """Read a single immutable source snapshot into the runtime schema."""
    specification = CATALOG_SPECS[workbook_id]
    book = SourceWorkbook(Path(path))
    try:
        workbook = ET.fromstring(book.archive.read("xl/workbook.xml"))
        names = [{"name": node.attrib["name"], "formula": node.text or "", "attributes": dict(node.attrib)}
                 for node in workbook.findall("x:definedNames/x:definedName", NS)]
        data = {
            "schema_version": SCHEMA_VERSION, "id": workbook_id, "title": specification["title"],
            "source": {"filename": Path(path).name, "sha256": book.sha256,
                       "size": len(book.archive.fp.getvalue())},
            "defined_names": {name["name"]: name["formula"] for name in names if "localSheetId" not in name["attributes"]},
            "defined_name_records": names, "styles": _styles(book),
            "input_ranges": deepcopy(specification["input_ranges"]),
            "setting_ranges": deepcopy(specification["setting_ranges"]),
            "sheets": [], "pages": [], "tables": {},
            "source_features": {
                "vba": any(name.lower().endswith("vbaproject.bin") for name in book.archive.namelist()),
                "external_links": [name for name in book.archive.namelist() if name.startswith("xl/externalLinks/")],
                "connections": [name for name in book.archive.namelist() if "connections" in name.lower()],
                "calculation": xml_data(workbook.find("x:calcPr", NS)),
                "protection": xml_data(workbook.find("x:workbookProtection", NS)),
            },
        }
        functions = Counter()
        formula_count = 0
        errors = []
        for sheet_node in workbook.findall("x:sheets/x:sheet", NS):
            name = sheet_node.attrib["name"]
            root = ET.fromstring(book.archive.read(book.sheet_paths[name]))
            data["tables"].update(_tables(book, name, root))
            source_cells = book.sheet(name)
            nodes, inherited_spaces = {}, {}
            sheet_data = root.find("x:sheetData", NS)
            sheet_space = root.attrib.get(XML_SPACE, "default")
            data_space = sheet_data.attrib.get(XML_SPACE, sheet_space) if sheet_data is not None else sheet_space
            for row_node in root.findall("x:sheetData/x:row", NS):
                row_space = row_node.attrib.get(XML_SPACE, data_space)
                for node in row_node.findall("x:c", NS):
                    nodes[node.attrib["r"]] = node
                    if row_space != "default":
                        inherited_spaces[node.attrib["r"]] = row_space
            cells = {}
            for address, entry in source_cells.items():
                node = nodes[address]
                kind = node.attrib.get("t", "n")
                output = {"data_type": kind, "style": entry["style"]}
                if entry["has_formula"]:
                    output["formula"] = entry["formula"]
                    if node.find("x:v", NS) is not None:
                        output["cached_value"] = entry["value"]
                    formula = node.find("x:f", NS)
                    if formula.attrib:
                        output["formula_attributes"] = dict(formula.attrib)
                    formula_count += 1
                    functions.update(function.upper() for function in re.findall(r"([A-Za-z_][A-Za-z_0-9.]*)\s*\(", re.sub(r'"(?:[^"]|"")*"', "", entry["formula"])))
                elif node.find("x:v", NS) is not None or node.find("x:is", NS) is not None:
                    output["value"] = normalize_literal_text(node, entry["value"], inherited_spaces.get(address, "default"))
                    if output["value"] != entry["value"]:
                        output["source_value"] = entry["value"]
                if kind == "e":
                    errors.append({"sheet": name, "cell": address, "error": entry["value"]})
                cells[address] = output
            dimension = root.find("x:dimension", NS)
            merges = [node.attrib["ref"] for node in root.findall("x:mergeCells/x:mergeCell", NS)]
            sheet = {
                "name": name, "state": sheet_node.attrib.get("state", "visible"),
                "dimension": _used_dimension(cells, merges),
                "source_dimension": dimension.attrib["ref"] if dimension is not None else None,
                "cells": cells,
                "rows": {row.attrib["r"]: dict(row.attrib) for row in root.findall("x:sheetData/x:row", NS)},
                "columns": [dict(column.attrib) for column in root.findall("x:cols/x:col", NS)],
                "merges": merges,
                "validations": _validations(root),
                "protection": xml_data(root.find("x:sheetProtection", NS)),
                "metadata": [xml_data(node) for node in root if node.tag.split("}")[-1] != "sheetData"],
            }
            sheet["page_range"] = specification["page_ranges"].get(name, sheet["dimension"])
            data["sheets"].append(sheet)
            if sheet["state"] == "visible" or name in specification["extra_pages"]:
                data["pages"].append(name)
        data["counts"] = {"formulas": formula_count, "cells": sum(len(sheet["cells"]) for sheet in data["sheets"]),
                          "sheets": len(data["sheets"]), "functions": dict(sorted(functions.items()))}
        data["cached_errors"] = errors
        _fields(data, specification)
        # Keep comments and source hyperlinks as evidence; they are never code.
        data["comments"] = {name: xml_data(ET.fromstring(book.archive.read(name))) for name in book.archive.namelist()
                            if "comments" in name.lower() and name.endswith(".xml")}
        data["relationships"] = {name: xml_data(ET.fromstring(book.archive.read(name))) for name in book.archive.namelist()
                                 if name.endswith(".rels")}
        return data
    finally:
        book.archive.close()


def write_catalog(data, output_directory):
    output_directory = Path(output_directory)
    output_directory.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    target = output_directory / f"{data['id']}.json.gz"
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_bytes(gzip.compress(encoded, compresslevel=9, mtime=0))
    temporary.replace(target)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-directory", type=Path, default=DEFAULT_SOURCE_DIRECTORY)
    parser.add_argument("--output-directory", type=Path, default=ROOT / "data" / "calculators")
    arguments = parser.parse_args()
    index = {"schema_version": SCHEMA_VERSION, "calculators": []}
    for workbook_id, specification in CATALOG_SPECS.items():
        data = extract_calculator(arguments.source_directory / specification["filename"], workbook_id)
        target = write_catalog(data, arguments.output_directory)
        index["calculators"].append({key: data[key] for key in ("id", "title", "source", "pages", "counts")})
        print(f"{workbook_id}: {data['counts']['formulas']:,} formulas, {target.stat().st_size:,} packaged bytes")
    (arguments.output_directory / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
