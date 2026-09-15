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
from openpyxl.utils import coordinate_to_tuple, get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.views import Selection

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
COMBINED_SHEET = "Inventory & Rates"
COMBINED_HEADERS = (
    "Row type", "Name", "Item code", "Group", "Supplier price", "Markup",
    "Sell price / rate", "Price source", "Yield type", "Yield", "Pricing mode",
    "Sales description", "Inventory ID", "Rate ID", "Use order", *PROPERTY_HEADERS,
)
# Both layouts feed the same existing pricing parser. Product values have one
# owner; a use links to that owner explicitly, never by its physical position.
_INVENTORY_COLUMNS = {name: {"Product name": "Name", "Sell price": "Sell price / rate"}.get(name, name)
                      for name in INVENTORY_HEADERS}
_USE_COLUMNS = {name: {"Rate name": "Name", "Unit sell rate": "Sell price / rate"}.get(name, name)
                for name in RATE_HEADERS}


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


def _format_sheet(sheet, headers, widths, numeric_columns=(), percent_columns=(), *, freeze_panes="E2"):
    # Reassigning a two-axis freeze in openpyxl retains the former pane
    # selections. Start clean and place each selection inside its actual pane.
    view = sheet.sheet_view
    view.pane = None
    view.selection = [Selection()]
    sheet.freeze_panes = freeze_panes
    row, column = coordinate_to_tuple(freeze_panes)
    if row > 1 and column > 1:
        positions = (("topRight", f"{get_column_letter(column)}1"),
                     ("bottomLeft", f"A{row}"), ("bottomRight", freeze_panes))
    elif row > 1:
        positions = (("bottomLeft", freeze_panes),)
    elif column > 1:
        positions = (("topRight", freeze_panes),)
    else:
        positions = ((None, "A1"),)
    view.selection = [Selection(pane=pane, activeCell=cell, sqref=cell) for pane, cell in positions]
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
                cell.number_format = '#,##0.00;[Red](#,##0.00);0.00'
            if cell.column in percent_columns:
                cell.number_format = '0.00%;[Red](0.00%);0.00%'
    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.orientation = "landscape"
    sheet.page_setup.paperSize = sheet.PAPERSIZE_A3
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    sheet.print_title_rows = "1:1"


def _validation(sheet, column, choices, *, max_rows=MAX_ROWS, allow_blank=True):
    validation = DataValidation(type="list", formula1='"' + ",".join(choices) + '"', allow_blank=allow_blank)
    validation.errorTitle = "Choose a listed value"
    validation.error = "Use one of the values shown in the dropdown."
    validation.showErrorMessage = True
    validation.errorStyle = "stop"
    sheet.add_data_validation(validation)
    validation.add(f"{column}2:{column}{max_rows + 1}")


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
    """Export one product/use sheet, including unsaved reviewed edits."""
    data = effective_catalog(configuration)
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = COMBINED_SHEET
    sheet.append(COMBINED_HEADERS)
    uses = {}
    for group, rates in data["rate_groups"].items():
        for order, rate in enumerate(rates, 1):
            uses.setdefault(rate.get("inventory_id"), []).append((group, order, rate))

    def append(values):
        sheet.append([values.get(header) for header in COMBINED_HEADERS])

    def append_use(group, order, rate):
        value = rate.get("yield")
        append({"Row type": "Use", "Name": rate["name"], "Group": group,
                "Sell price / rate": rate["price"], "Price source": _rate_mode(rate, configuration).title(),
                "Yield type": _yield_type(value, bool(data["rate_group_rules"][group]["yield_column"])),
                "Yield": value if isinstance(value, (int, float)) else None,
                "Inventory ID": rate.get("inventory_id"), "Rate ID": rate["id"], "Use order": order})

    for item in data["inventory"]:
        append({"Row type": "Inventory", "Name": item["name"], "Item code": item.get("item_code", ""),
                "Supplier price": item.get("supplier_price"), "Markup": item["markup"],
                "Sell price / rate": item["sales_price"],
                "Pricing mode": "Supplier markup" if item["pricing_mode"] == "supplier_markup" else "Manual",
                "Sales description": item["sales_description"], "Inventory ID": item["id"],
                **{header: item.get("properties", {}).get(key) for header, key in PROPERTY_HEADERS.items()}})
        for group, order, rate in uses.get(item["id"], []):
            append_use(group, order, rate)
    for group, order, rate in uses.get(None, []):
        append_use(group, order, rate)

    widths = {"A": 14, "B": 43, "C": 15, "D": 21, "E": 17, "F": 14, "G": 19,
              "H": 17, "I": 17, "J": 17, "K": 21, "L": 48, "M": 21, "N": 24, "O": 13,
              **{get_column_letter(column): 19 for column in range(16, 27)}}
    _format_sheet(sheet, COMBINED_HEADERS, widths, numeric_columns=(5, 6, 7, 10, *range(16, 27)), percent_columns=(6,), freeze_panes="C2")
    sheet.sheet_properties.outlinePr.summaryRight = False
    # Optional dimensions are retained once on each product and can be expanded.
    sheet.column_dimensions.group("P", "Z", outline_level=1, hidden=True)
    sheet.column_dimensions["O"].collapsed = True
    for row in sheet.iter_rows(min_row=2):
        inventory = row[0].value == "Inventory"
        allowed = set(_INVENTORY_COLUMNS.values()) if inventory else set(_USE_COLUMNS.values()) | {"Use order"}
        for header, cell in zip(COMBINED_HEADERS, row):
            cell.fill = PatternFill("solid", fgColor="FFF0DE" if inventory else "F0F5FA")
            if header not in allowed | {"Row type"}:
                cell.fill = PatternFill("solid", fgColor="ECECEC")
            if header == "Name":
                cell.font = Font(name="Calibri", size=11, color="174D8D", bold=inventory)
                cell.alignment = Alignment(vertical="center", wrap_text=True, indent=0 if inventory else 1)
        sheet.cell(row[0].row, 15).number_format = "0"
    comments = {
        "A": "Inventory owns product values. Use rows show Group, Price source, Yield type, Yield, Rate ID and Use order. All rows are visible. Gray cells do not apply to that row type and must stay blank.",
        "G": "Inventory: edit for Manual pricing, otherwise change supplier price/markup. Use: editing this rate creates an Override; choose Inventory in Price source to restore its link.",
        "I": "Number uses Yield. Blank is a genuine empty lookup value; Empty text preserves its distinct calculation behavior. Not used applies to groups without yields.",
        "M": "Keep existing IDs. Each Use links to its Inventory row by this ID, regardless of row order. For new linked rows enter the same new unique ID on both rows. An unlinked Use may leave this blank with Override pricing.",
        "N": "Keep existing Rate IDs. Leave blank to create a new Use, or supply a unique ID. Row position does not identify the rate.",
        "O": "Retains dropdown order within each Group when rows are grouped or sorted. Use unique positive integers within a Group; leave blank for new Uses to append. Clear or update this number when moving a Use to another Group.",
    }
    for column, text in comments.items():
        sheet[f"{column}1"].comment = Comment(text, "Ceasefire")
    for column, choices in (("A", ("Inventory", "Use")), ("D", tuple(data["rate_groups"])),
                            ("H", ("Inventory", "Override")), ("I", ("Number", "Blank", "Empty text", "Not used")),
                            ("K", ("Supplier markup", "Manual"))):
        _validation(sheet, column, choices, max_rows=2 * MAX_ROWS, allow_blank=column != "A")

    instructions = workbook.create_sheet("Instructions")
    for row in [
        ["CEASEFIRE INVENTORY & RATES", "How to update the combined pricing library"],
        ["Save changes", "Import previews this entire workbook. Review additions, removals and updates, then Save pricing in ESTIMATOR. Existing saved quotes retain their own products and prices."],
        ["Inventory rows", "Inventory rows own the product name, item code, supplier/manual price, markup and properties. Group, Price source, Yield type, Yield, Rate ID and Use order do not apply here and stay blank. Optional product properties are in expandable columns P:Z."],
        ["Complete replacement", "Keep the Inventory & Rates sheet and its headers. Delete a Use to remove that choice. To remove an Inventory row, remove or unlink every Use referencing its Inventory ID. Filtered, hidden and collapsed rows are still imported."],
        ["Stable links and sorting", "Row type declares Inventory or Use. Inventory ID links a Use to a product, never proximity or row order. Keep existing IDs. Use order preserves dropdown order within a Group when sorting; leave it blank to append a new Use."],
        ["Add products and uses", "Add an Inventory row and one Use per dropdown group. Enter the same new unique Inventory ID on linked rows. Blank Inventory/Rate IDs allocate new identities; a blank Use Inventory ID means an independent rate and requires Override pricing. Gray fields must remain blank."],
        ["Supplier markup", "On Inventory rows enter supplier price and markup (30% means 0.30). Changing either recalculates sell price as supplier × (1 + markup). Unchanged inputs retain the existing stored sell price exactly."],
        ["Manual pricing", "On Inventory rows choose Manual to enter Sell price / rate directly. Supplier price may be blank; markup remains information. On Use rows choose Inventory for the linked price or Override for an independent price."],
        ["Use rows and yields", "All Use rows are visible. They own Group, Price source, Yield type, Yield, Rate ID and Use order. Editing a Use rate creates an Override; choose Inventory to restore its linked price. Number requires a nonnegative Yield; Blank and Empty text keep distinct empty-value behavior; Not used is for groups without yields."],
        ["Names and groups", "Use Name is the Estimator dropdown selection. Group places it in the existing calculation category. Names must be unique within a Group. These categories reproduce the original selections; they do not establish technical suitability."],
        ["Values only", "Use typed values, not formulas, macros or external links. Prices shown are a snapshot: import evaluates pricing edits in ESTIMATOR. No Excel formulas are required. The earlier Inventory and Rates two-sheet format remains supported for import."],
        ["Limits", f"Maximum {MAX_ROWS:,} Inventory rows plus {MAX_ROWS:,} Use rows, 5 MB file, numeric magnitude up to 1 trillion. Prices/yields cannot be negative; markup cannot be below -100%."],
        ["Group keys", "Use these exact Group keys. New group definitions are not introduced by importing a pricing file."],
        *[[group, "Yield required" if rule["yield_column"] else "Yield not used"]
          for group, rule in data["rate_group_rules"].items()],
    ]:
        instructions.append(row)
    _format_sheet(instructions, (), {"A": 29, "B": 115}, freeze_panes="A2")
    for row in range(2, 13):
        instructions.row_dimensions[row].height = 61
    instructions.auto_filter.ref = None
    # Never allow a product label beginning '=' to become an Excel formula.
    for page in workbook:
        for row in page:
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
            workbook_xml = archive.read("xl/workbook.xml")
            if b"\x00" in workbook_xml or b"<!DOCTYPE" in workbook_xml.upper() or b"<!ENTITY" in workbook_xml.upper():
                raise ValidationError("XML declarations with entities are not supported.")
            sheet_names = {element.attrib.get("name") for element in ET.fromstring(workbook_xml).iter()
                           if element.tag.rsplit("}", 1)[-1] == "sheet"}
            max_rows = 2 * MAX_ROWS if COMBINED_SHEET in sheet_names else MAX_ROWS
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
                        if (worksheet_rows > max_rows + 1 or not row_index.isdigit()
                                or not 1 <= int(row_index) <= max_rows + 1):
                            raise ValidationError(f"A pricing sheet must have at most {max_rows:,} rows.")
                    if name.startswith("xl/worksheets/") and local == "c":
                        address = element.attrib.get("r", "")
                        match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]*)", address)
                        if not match or int(match.group(2)) > max_rows + 1 or len(match.group(1)) > 1:
                            raise ValidationError(f"A pricing sheet must have at most {max_rows:,} rows and only the provided columns.")
    except ValidationError:
        raise
    except (BadZipFile, ET.ParseError, KeyError, RuntimeError, ValueError, OSError, NotImplementedError) as error:
        raise ValidationError("The workbook is damaged or is not a supported .xlsx file.") from error


def _rows(sheet, headers, *, max_rows=MAX_ROWS):
    # The optional OOXML dimension is absent in some valid editors' output,
    # and may be stale after a list edit. Derive it from actual bounded cells
    # so a missing dimension cannot fail or a small one silently truncate data.
    sheet.reset_dimensions()
    try:
        sheet.calculate_dimension(force=True)
    except (UnboundLocalError, IndexError) as error:
        raise ValidationError(f"{sheet.title} must contain the exported template headers.") from error
    if sheet.max_row > max_rows + 1 or sheet.max_column > len(headers):
        raise ValidationError(f"{sheet.title} has too many rows or unexpected columns.")
    rows = sheet.iter_rows(values_only=True)
    actual = tuple(next(rows, ()))
    if actual != tuple(headers):
        raise ValidationError(f"{sheet.title} headers must match the exported template exactly.")
    for row_number, values in enumerate(rows, 2):
        if all(value in (None, "") for value in values):
            continue
        yield row_number, dict(zip(headers, values))


def _pricing_rows(workbook):
    """Adapt either supported file layout to the existing business parser."""
    names = set(workbook.sheetnames)
    if {"Inventory", "Rates"}.issubset(names) and not names - {"Inventory", "Rates", "Instructions"}:
        return list(_rows(workbook["Inventory"], INVENTORY_HEADERS)), list(_rows(workbook["Rates"], RATE_HEADERS))
    if COMBINED_SHEET not in names or names - {COMBINED_SHEET, "Instructions"}:
        raise ValidationError("Use the Inventory & Rates sheet, or the earlier Inventory and Rates sheets, with only an optional Instructions sheet.")
    inventory, uses, orders = [], [], set()
    for number, row in _rows(workbook[COMBINED_SHEET], COMBINED_HEADERS, max_rows=2 * MAX_ROWS):
        kind = row["Row type"]
        if kind not in ("Inventory", "Use"):
            raise ValidationError(f"{COMBINED_SHEET} row {number}: Row type must be Inventory or Use.")
        mapping = _INVENTORY_COLUMNS if kind == "Inventory" else _USE_COLUMNS
        allowed = {"Row type", *mapping.values()} | ({"Use order"} if kind == "Use" else set())
        unexpected = [header for header, value in row.items() if header not in allowed and value not in (None, "")]
        if unexpected:
            raise ValidationError(f"{COMBINED_SHEET} row {number}: {', '.join(unexpected)} must be blank on an {kind} row.")
        record = {header: row[column] for header, column in mapping.items()}
        if kind == "Inventory":
            inventory.append((number, record))
        else:
            order = row["Use order"]
            if order not in (None, ""):
                order = _number(order, f"{COMBINED_SHEET} row {number} Use order", minimum=1)
                if order != int(order) or order > MAX_ROWS:
                    raise ValidationError(f"{COMBINED_SHEET} row {number}: Use order must be a whole number from 1 to {MAX_ROWS}.")
                key = (row["Group"], order)
                if key in orders:
                    raise ValidationError(f"{COMBINED_SHEET} row {number}: Duplicate Use order in {row['Group']}.")
                orders.add(key)
            else:
                order = None
            uses.append((order, number, record))
        if len(inventory) > MAX_ROWS or len(uses) > MAX_ROWS:
            raise ValidationError(f"The library must have at most {MAX_ROWS:,} Inventory rows and {MAX_ROWS:,} Use rows.")
    # Each group keeps its own sequence. Blank orders append in file order;
    # this permits new uses without renumbering existing choices.
    uses.sort(key=lambda item: (item[0] is None, item[0] or 0, item[1]))
    return inventory, [(number, row) for _, number, row in uses]


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
        inventory_rows, rate_rows = _pricing_rows(workbook)
        proposed = deepcopy(current)
        proposed["sources"]["pricing_import"] = {
            "filename": filename.replace("\\", "/").rsplit("/", 1)[-1],
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        proposed["inventory"] = []
        proposed["rate_groups"] = {group: [] for group in current["rate_groups"]}
        inventory_ids = set()
        for row_number, row in inventory_rows:
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
        for row_number, row in rate_rows:
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
