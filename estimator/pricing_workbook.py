"""Values-only pricing workbooks: editable lists, with no executable spreadsheet logic.

An import is a proposed complete catalogue replacement. Persistence belongs to
the caller; parsing never writes configuration or saved quotes.
"""

from copy import deepcopy
import hashlib
from io import BytesIO
import math
import re
from uuid import uuid4
import xml.etree.ElementTree as ET
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile

from openpyxl import Workbook, load_workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation

from .catalog import ValidationError, effective_catalog, validate_configuration


MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_EXPANDED_BYTES = 20 * 1024 * 1024
MAX_ROWS = 5000
MAX_PARTS = 200
XML_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
PROPERTY_HEADERS = {
    "Weight": "weight", "Width (mm)": "width_mm", "Length (mm)": "length_mm",
    "Thickness (mm)": "thickness_mm", "Area (m²)": "sqm", "Diameter (mm)": "diameter_mm",
    "Metres per tube": "metres_per_tube", "Area per box (m²)": "sqm_per_box",
    "Area per drum (m²)": "sqm_per_drum", "Volume (L)": "volume_litres",
    "Volume (mL)": "volume_ml",
}
INVENTORY_HEADERS = (
    "Inventory ID", "Item code", "Product name", "Sales description", "Pricing mode",
    "Supplier price", "Markup", "Sell price", *PROPERTY_HEADERS,
)
RATE_HEADERS = (
    "Rate ID", "Group", "Inventory ID", "Rate name", "Price source",
    "Unit sell rate", "Yield type", "Yield",
)


def _text(value, label, *, optional=False, limit=1000):
    if optional and value in (None, ""):
        return ""
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValidationError(f"{label} must be nonempty text of at most {limit} characters.")
    if any(ord(character) < 32 and character not in "\n\r\t" for character in value):
        raise ValidationError(f"{label} contains unsupported control characters.")
    return value


def _excel_precision(value, previous):
    """Excel saves 15 significant digits; preserve unchanged stored precision."""
    if (isinstance(value, (int, float)) and not isinstance(value, bool)
            and isinstance(previous, (int, float)) and not isinstance(previous, bool)
            and format(value, ".15g") == format(previous, ".15g")):
        return previous
    return value


def _property(value, label):
    if isinstance(value, str):
        if len(value) > 1000:
            raise ValidationError(f"{label} must be at most 1000 characters.")
        return value
    return _number(value, label, optional=True)


def _number(value, label, *, optional=False, minimum=0):
    if optional and value in (None, ""):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"{label} must contain a number, not text or a formula.")
    if not math.isfinite(value) or abs(value) > 1e12 or value < minimum:
        raise ValidationError(f"{label} must be finite, at least {minimum}, and at most 1 trillion.")
    return value


def _identifier(value, label, prefix, seen):
    if value in (None, ""):
        value = f"{prefix}_{uuid4().hex}"
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    value = _text(value, label, limit=120)
    if not re.fullmatch(r"[A-Za-z0-9_.:-]+", value):
        raise ValidationError(f"{label} may use letters, digits, underscores, dots, colons and hyphens only.")
    if value in seen:
        raise ValidationError(f"Duplicate {label}: {value}.")
    seen.add(value)
    return value


def _rate_mode(rate, configuration):
    if "price" in configuration.get("rates", {}).get(rate["id"], {}):
        return "override"
    return rate.get("price_mode", "inventory" if rate.get("inventory_id") else "override")


def _yield_type(value, uses_yield):
    if not uses_yield:
        return "Not used"
    return "Blank" if value is None else "Empty text" if value == "" else "Number"


def _format_sheet(sheet, headers, widths, numeric_columns=(), percent_columns=()):
    sheet.freeze_panes = "E2" if sheet.title == "Inventory" else "E2"
    sheet.auto_filter.ref = sheet.dimensions
    sheet.sheet_view.showGridLines = False
    sheet.row_dimensions[1].height = 36
    for cell in sheet[1]:
        cell.fill = PatternFill("solid", fgColor="8D1726")
        cell.font = Font(name="Calibri", bold=True, color="FFFFFF")
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    for column, width in widths.items():
        sheet.column_dimensions[column].width = width
    for row in sheet.iter_rows(min_row=2):
        sheet.row_dimensions[row[0].row].height = 31
        for cell in row:
            cell.font = Font(name="Calibri", size=11, color="174D8D")
            cell.alignment = Alignment(vertical="center", wrap_text=True)
            cell.fill = PatternFill("solid", fgColor="F0F5FA" if cell.row % 2 == 0 else "FFFFFF")
            if cell.column in numeric_columns:
                cell.number_format = '#,##0.00######;[Red](#,##0.00######);0.00'
            if cell.column in percent_columns:
                cell.number_format = '0.00%;[Red](0.00%);0.00%'
    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.orientation = "landscape"
    sheet.page_setup.paperSize = sheet.PAPERSIZE_A3
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    sheet.print_title_rows = "1:1"


def _validation(sheet, column, choices):
    validation = DataValidation(type="list", formula1='"' + ",".join(choices) + '"')
    validation.errorTitle = "Choose a listed value"
    validation.error = "Use one of the values shown in the dropdown."
    validation.showErrorMessage = True
    validation.errorStyle = "stop"
    sheet.add_data_validation(validation)
    validation.add(f"{column}2:{column}{MAX_ROWS + 1}")


def _serialize_exact(workbook):
    """Retain binary-float round trips instead of openpyxl's 16-digit formatting.

    Cells remain ordinary numeric OOXML cells. Excel can display fewer digits;
    importing the generated file directly must preserve the estimator's values.
    """
    stream = BytesIO()
    workbook.save(stream)
    numbers = {
        f"xl/worksheets/sheet{index}.xml": {
            cell.coordinate: repr(cell.value)
            for row in sheet for cell in row
            if isinstance(cell.value, (int, float)) and not isinstance(cell.value, bool)
        }
        for index, sheet in enumerate(workbook, 1)
    }
    output = BytesIO()
    with ZipFile(stream) as source, ZipFile(output, "w", ZIP_DEFLATED) as target:
        for item in source.infolist():
            content = source.read(item.filename)
            if item.filename in numbers:
                root = ET.fromstring(content)
                for cell in root.iter(f"{{{XML_NS}}}c"):
                    if cell.attrib.get("r") in numbers[item.filename]:
                        cell.find(f"{{{XML_NS}}}v").text = numbers[item.filename][cell.attrib["r"]]
                content = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            target.writestr(item.filename, content)
    return output.getvalue()


def export_pricing_workbook(configuration):
    """Export the current effective library, including unsaved reviewed edits."""
    data = effective_catalog(configuration)
    workbook = Workbook()
    inventory = workbook.active
    inventory.title = "Inventory"
    inventory.append(INVENTORY_HEADERS)
    for item in data["inventory"]:
        inventory.append([
            item["id"], item.get("item_code", ""), item["name"], item["sales_description"],
            "Supplier markup" if item["pricing_mode"] == "supplier_markup" else "Manual",
            item.get("supplier_price"), item["markup"], item["sales_price"],
            *(item.get("properties", {}).get(key) for key in PROPERTY_HEADERS.values()),
        ])
    _format_sheet(inventory, INVENTORY_HEADERS,
                  {"A": 21, "B": 16, "C": 43, "D": 53, "E": 21,
                   **{chr(65 + index): 17 for index in range(5, 19)}},
                  numeric_columns=tuple(range(6, 20)), percent_columns=(7,))
    inventory["A1"].comment = Comment("Keep existing IDs. A blank ID creates a new item; use your own unique ID to link a new item from Rates.", "Ceasefire")
    inventory["H1"].comment = Comment("Editable for Manual pricing. Supplier markup prices recalculate only when supplier price or markup changes; unchanged stored prices are preserved.", "Ceasefire")
    _validation(inventory, "E", ("Supplier markup", "Manual"))

    rates = workbook.create_sheet("Rates")
    rates.append(RATE_HEADERS)
    for group, rows in data["rate_groups"].items():
        uses_yield = bool(data["rate_group_rules"][group]["yield_column"])
        for rate in rows:
            value = rate.get("yield")
            rates.append([
                rate["id"], group, rate.get("inventory_id"), rate["name"],
                _rate_mode(rate, configuration).title(), rate["price"],
                _yield_type(value, uses_yield), value if isinstance(value, (int, float)) else None,
            ])
    _format_sheet(rates, RATE_HEADERS,
                  {"A": 23, "B": 20, "C": 21, "D": 58, "E": 18, "F": 19, "G": 18, "H": 18},
                  numeric_columns=(6, 8))
    _validation(rates, "E", ("Inventory", "Override"))
    _validation(rates, "B", tuple(data["rate_groups"]))
    _validation(rates, "G", ("Number", "Blank", "Empty text", "Not used"))
    rates["E1"].comment = Comment("Inventory follows the linked item's price. Override keeps a separate rate. Editing a unit sell rate automatically makes it an override; changing this source to Inventory restores the link.", "Ceasefire")
    rates["G1"].comment = Comment("Number uses the numeric Yield. Blank is a genuine empty value (zero in Excel lookups); Empty text preserves the distinct empty-string calculation behavior. Use Not used for groups without a yield.", "Ceasefire")

    instructions = workbook.create_sheet("Instructions")
    for row in [
        ["CEASEFIRE PRICING LIBRARY", "How to update your library"],
        ["Save changes", "Import previews this entire workbook. Review additions, removals and updates, then Save pricing in ESTIMATOR to apply it. Existing saved quotes retain their stored prices."],
        ["Complete replacement", "Keep both Inventory and Rates sheets with their headers. Delete a row to remove that product or choice. A removed inventory item must also be removed or unlinked from Rates."],
        ["Add products and choices", "Append rows. Keep existing IDs unchanged. Blank IDs receive new IDs. To link a new product and new rate in the same workbook, enter your own matching unique Inventory ID on both sheets."],
        ["Supplier markup", "Enter supplier price and markup (30% means 0.30). Changing either recalculates the sell price as supplier × (1 + markup). Unchanged inputs preserve the existing sell price exactly."],
        ["Manual pricing", "Choose Manual to enter the Sell price directly. Supplier price may be blank; markup is retained as information."],
        ["Rate prices", "Inventory follows the linked sell price after inventory price changes. Editing Unit sell rate makes an Override. To restore a current Override to the linked inventory price, choose Inventory. An unlinked rate must use Override."],
        ["Yield", "Use Number and enter a nonnegative Yield, or choose Blank / Empty text to preserve supported empty-value behavior. Not used applies only to groups without yield calculations."],
        ["Values only", "Use typed values, not formulas, macros or external links. Text is text even when it starts with an equals sign. Both worksheets are imported in full, including filtered or hidden rows."],
        ["Limits", f"Maximum {MAX_ROWS:,} rows per list, 5 MB file, numeric magnitude up to 1 trillion. Prices and yields cannot be negative; markup cannot be below -100%."],
        ["Group keys", "Use these exact keys in Rates. Choices must have unique names within a group."],
        *[[group, "Yield required" if rule["yield_column"] else "Yield not used"]
          for group, rule in data["rate_group_rules"].items()],
    ]:
        instructions.append(row)
    _format_sheet(instructions, (), {"A": 29, "B": 106})
    instructions.freeze_panes = "A2"
    for row in range(2, 11):
        instructions.row_dimensions[row].height = 49
    instructions.auto_filter.ref = None
    # Never allow a product label beginning '=' to become an Excel formula.
    for sheet in workbook:
        for row in sheet:
            for cell in row:
                if isinstance(cell.value, str):
                    cell.data_type = "s"
    return _serialize_exact(workbook)


def _preflight(payload, filename):
    if not isinstance(filename, str) or not filename.lower().endswith(".xlsx"):
        raise ValidationError("Import an .xlsx pricing workbook exported by ESTIMATOR.")
    if not isinstance(payload, bytes) or not payload or len(payload) > MAX_FILE_BYTES:
        raise ValidationError("Pricing workbooks must be nonempty and no larger than 5 MB.")
    try:
        with ZipFile(BytesIO(payload)) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if len(entries) > MAX_PARTS or len(names) != len(set(names)):
                raise ValidationError("Workbook has too many or duplicate ZIP parts.")
            if sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES:
                raise ValidationError("Workbook expands beyond the 20 MB limit.")
            if "xl/workbook.xml" not in names or "[Content_Types].xml" not in names:
                raise ValidationError("This is not an Excel .xlsx workbook.")
            for entry in entries:
                name = entry.filename.lower()
                if entry.flag_bits & 1 or ".." in name.split("/") or name.startswith(("/", "\\")):
                    raise ValidationError("Encrypted or unsafe workbook ZIP parts are not supported.")
                if any(part in name for part in ("vbaproject", "macrosheet", "externallink", "activex", "embeddings/")):
                    raise ValidationError("Macros, embedded objects and external links are not allowed in pricing workbooks.")
                if not name.endswith((".xml", ".rels")):
                    continue
                content = archive.read(entry)
                if b"\x00" in content or b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
                    raise ValidationError("XML declarations with entities are not supported.")
                root = ET.fromstring(content)
                worksheet_rows = 0
                for element in root.iter():
                    local = element.tag.rsplit("}", 1)[-1]
                    if local == "Relationship":
                        target = element.attrib.get("Target", "")
                        relation = element.attrib.get("Type", "").lower()
                        if element.attrib.get("TargetMode", "").lower() == "external" or "://" in target or target.startswith("//"):
                            raise ValidationError("External links are not allowed in pricing workbooks.")
                        if any(token in relation for token in ("vbaproject", "macrosheet", "oleobject", "activex")):
                            raise ValidationError("Macros and embedded objects are not supported.")
                    if local in {"Override", "Default"} and any(token in element.attrib.get("ContentType", "").lower() for token in ("macroenabled", "vba", "macrosheet")):
                        raise ValidationError("Macro-enabled workbooks are not supported.")
                    if local == "f":
                        raise ValidationError("Excel formulas are not supported. Replace formulas with values before importing.")
                    if name.startswith("xl/worksheets/") and local == "row":
                        worksheet_rows += 1
                        row_index = element.attrib.get("r", str(worksheet_rows))
                        if (worksheet_rows > MAX_ROWS + 1 or not row_index.isdigit()
                                or not 1 <= int(row_index) <= MAX_ROWS + 1):
                            raise ValidationError(f"Each list must have at most {MAX_ROWS:,} rows.")
                    if name.startswith("xl/worksheets/") and local == "c":
                        address = element.attrib.get("r", "")
                        match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]*)", address)
                        if not match or int(match.group(2)) > MAX_ROWS + 1 or len(match.group(1)) > 1:
                            raise ValidationError(f"Each list must have at most {MAX_ROWS:,} rows and only the provided columns.")
    except ValidationError:
        raise
    except (BadZipFile, ET.ParseError, KeyError, RuntimeError, ValueError, OSError, NotImplementedError) as error:
        raise ValidationError("The workbook is damaged or is not a supported .xlsx file.") from error


def _rows(sheet, headers):
    # The optional OOXML dimension is absent in some valid editors' output,
    # and may be stale after a list edit. Derive it from actual bounded cells
    # so a missing dimension cannot fail or a small one silently truncate data.
    sheet.reset_dimensions()
    try:
        sheet.calculate_dimension(force=True)
    except (UnboundLocalError, IndexError) as error:
        raise ValidationError(f"{sheet.title} must contain the exported template headers.") from error
    if sheet.max_row > MAX_ROWS + 1 or sheet.max_column > len(headers):
        raise ValidationError(f"{sheet.title} has too many rows or unexpected columns.")
    rows = sheet.iter_rows(values_only=True)
    actual = tuple(next(rows, ()))
    if actual != tuple(headers):
        raise ValidationError(f"{sheet.title} headers must match the exported template exactly.")
    for row_number, values in enumerate(rows, 2):
        if all(value in (None, "") for value in values):
            continue
        yield row_number, dict(zip(headers, values))


def _inventory_comparison(item):
    return {key: item.get(key) for key in (
        "id", "item_code", "name", "sales_description", "pricing_mode", "supplier_price",
        "markup", "sales_price", "properties",
    )}


def _rate_comparison(group, item, configuration):
    return {"group": group, **{key: item.get(key) for key in ("name", "inventory_id", "price", "yield")},
            "price_mode": _rate_mode(item, configuration)}


def _changes(before, after):
    return {"added": len(after.keys() - before.keys()), "removed": len(before.keys() - after.keys()),
            "updated": sum(before[key] != after[key] for key in before.keys() & after.keys())}


def import_pricing_workbook(payload, filename, current_configuration):
    """Validate a workbook and return a replacement configuration without saving."""
    _preflight(payload, filename)
    current = effective_catalog(current_configuration)
    previous_inventory = {item["id"]: item for item in current["inventory"]}
    previous_rates = {rate["id"]: (group, rate) for group, rows in current["rate_groups"].items() for rate in rows}
    try:
        workbook = load_workbook(BytesIO(payload), read_only=True, data_only=False, keep_links=False)
    except Exception as error:
        raise ValidationError("The workbook could not be read. Export a fresh .xlsx template and try again.") from error
    try:
        if not {"Inventory", "Rates"}.issubset(workbook.sheetnames) or set(workbook.sheetnames) - {"Inventory", "Rates", "Instructions"}:
            raise ValidationError("The workbook must contain Inventory and Rates, with only an optional Instructions sheet.")
        proposed = deepcopy(current)
        proposed["sources"]["pricing_import"] = {
            "filename": filename.replace("\\", "/").rsplit("/", 1)[-1],
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        proposed["inventory"] = []
        proposed["rate_groups"] = {group: [] for group in current["rate_groups"]}
        inventory_ids = set()
        for row_number, row in _rows(workbook["Inventory"], INVENTORY_HEADERS):
            label = f"Inventory row {row_number}"
            identity = _identifier(row["Inventory ID"], "Inventory ID", "inv", inventory_ids)
            old = previous_inventory.get(identity)
            mode = {"Supplier markup": "supplier_markup", "Manual": "manual"}.get(row["Pricing mode"])
            if mode is None:
                raise ValidationError(f"{label}: Pricing mode must be Supplier markup or Manual.")
            item = deepcopy(old) if old else {"source": {}, "status": "Active", "inventory_type": "Untracked"}
            item_code = row["Item code"]
            if item_code is None:
                item_code = ""
            if item_code is not None and (isinstance(item_code, bool) or not isinstance(item_code, (str, int, float))):
                raise ValidationError(f"{label}: Item code must be text or a number.")
            if isinstance(item_code, str) and len(item_code) > 120:
                raise ValidationError(f"{label}: Item code is too long.")
            if isinstance(item_code, (int, float)):
                _number(item_code, f"{label} Item code")
            description = row["Sales description"]
            if description is None:
                description = ""
            if not isinstance(description, str):
                raise ValidationError(f"{label}: Sales description must contain text.")
            item.update({"id": identity, "item_code": item_code,
                         "name": _text(row["Product name"], f"{label} Product name"),
                         "sales_description": description,
                         "pricing_mode": mode,
                         "supplier_price": _number(row["Supplier price"], f"{label} Supplier price", optional=mode == "manual"),
                         "markup": _number(row["Markup"], f"{label} Markup", minimum=-1),
                         "properties": {key: _property(row[header], f"{label} {header}")
                                        for header, key in PROPERTY_HEADERS.items()}})
            entered_sell = _number(row["Sell price"], f"{label} Sell price", optional=mode == "supplier_markup")
            if old:
                for field in ("supplier_price", "markup"):
                    item[field] = _excel_precision(item[field], old.get(field))
                entered_sell = _excel_precision(entered_sell, old["sales_price"])
                for key, value in item["properties"].items():
                    item["properties"][key] = _excel_precision(value, old.get("properties", {}).get(key))
            if mode == "supplier_markup":
                unchanged = old and all(item[key] == old.get(key) for key in ("pricing_mode", "supplier_price", "markup"))
                if unchanged:
                    if entered_sell is not None and entered_sell != old["sales_price"]:
                        raise ValidationError(f"{label}: Sell price is calculated. Edit Supplier price or Markup, or choose Manual pricing.")
                    item["sales_price"] = old["sales_price"]
                else:
                    item["sales_price"] = _number(item["supplier_price"] * (1 + item["markup"]), f"{label} calculated Sell price")
                item["calculated_sell_price"] = item["sales_price"] if not unchanged else old.get("calculated_sell_price", item["sales_price"])
            else:
                item["sales_price"] = entered_sell
            proposed["inventory"].append(item)

        inventory = {item["id"]: item for item in proposed["inventory"]}
        rate_ids = set()
        group_names = {group: set() for group in proposed["rate_groups"]}
        for row_number, row in _rows(workbook["Rates"], RATE_HEADERS):
            label = f"Rates row {row_number}"
            identity = _identifier(row["Rate ID"], "Rate ID", "rate", rate_ids)
            group = row["Group"]
            if group not in proposed["rate_groups"]:
                raise ValidationError(f"{label}: Unknown Group; use an exact group key from Instructions.")
            name = _text(row["Rate name"], f"{label} Rate name")
            if name.casefold() in group_names[group]:
                raise ValidationError(f"{label}: Duplicate rate name {name!r} in {group}.")
            group_names[group].add(name.casefold())
            linked_id = row["Inventory ID"]
            if isinstance(linked_id, int) and not isinstance(linked_id, bool):
                linked_id = str(linked_id)
            if linked_id in (None, ""):
                linked_id = None
            if linked_id is not None and linked_id not in inventory:
                raise ValidationError(f"{label}: Inventory ID {linked_id!r} is missing. Restore the product, change the link, or remove this rate.")
            price_mode = {"Inventory": "inventory", "Override": "override"}.get(row["Price source"])
            if price_mode is None or (price_mode == "inventory" and linked_id is None):
                raise ValidationError(f"{label}: Choose Inventory with a valid Inventory ID, or Override for an independent rate.")
            entered_price = _number(row["Unit sell rate"], f"{label} Unit sell rate", optional=price_mode == "inventory")
            old_pair = previous_rates.get(identity)
            old = old_pair[1] if old_pair else None
            if old:
                entered_price = _excel_precision(entered_price, old["price"])
            if price_mode == "inventory":
                price = inventory[linked_id]["sales_price"]
                if old and _rate_mode(old, current_configuration) == "inventory":
                    if entered_price is not None and entered_price != old["price"]:
                        price_mode, price = "override", entered_price
                    elif linked_id == old.get("inventory_id") and inventory[linked_id]["sales_price"] == previous_inventory[linked_id]["sales_price"]:
                        price = old["price"]
                elif not old and entered_price is not None and entered_price != price:
                    price_mode, price = "override", entered_price
            else:
                price = entered_price
            uses_yield = bool(current["rate_group_rules"][group]["yield_column"])
            yield_type = row["Yield type"]
            if not uses_yield and yield_type != "Not used":
                raise ValidationError(f"{label}: {group} uses Yield type Not used.")
            if uses_yield and yield_type not in {"Number", "Blank", "Empty text"}:
                raise ValidationError(f"{label}: Choose Yield type Number, Blank or Empty text.")
            if yield_type == "Number":
                yield_value = _number(row["Yield"], f"{label} Yield")
                if old:
                    yield_value = _excel_precision(yield_value, old.get("yield"))
            else:
                if row["Yield"] not in (None, ""):
                    raise ValidationError(f"{label}: Clear Yield when Yield type is {yield_type}.")
                yield_value = "" if yield_type == "Empty text" else None
            rate = deepcopy(old) if old else {"source": {}}
            rate.update({"id": identity, "name": name, "inventory_id": linked_id,
                         "price": price, "price_mode": price_mode,
                         "yield": yield_value, "uses_yield": uses_yield})
            if old and old["name"] != name:
                rate.pop("display_name", None)
            proposed["rate_groups"][group].append(rate)

        configuration = validate_configuration({"catalog": proposed, "inventory": {}, "rates": {}})
        summary = {
            "inventory": _changes({key: _inventory_comparison(item) for key, item in previous_inventory.items()},
                                  {key: _inventory_comparison(item) for key, item in inventory.items()}),
            "rates": _changes({key: _rate_comparison(group, item, current_configuration)
                               for key, (group, item) in previous_rates.items()},
                              {item["id"]: _rate_comparison(group, item, {})
                               for group, rows in proposed["rate_groups"].items() for item in rows}),
        }
        return {"configuration": configuration, "summary": summary}
    except ValidationError:
        raise
    except (ValueError, TypeError, KeyError, IndexError, OverflowError, ET.ParseError) as error:
        # Read-only workbooks decode cells lazily during iteration. Malformed
        # numeric cells and XML must fail as a rejected import, not a server 500.
        raise ValidationError("The workbook contains malformed cells. Export a fresh template and copy valid values into it.") from error
    finally:
        workbook.close()
