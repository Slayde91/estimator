"""HTTP and values-only Excel import/export for the Contacts directory."""

import base64
import binascii
from io import BytesIO
import re

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

from .catalog import ValidationError
from .contacts import ACCOUNT_FIELDS, PERSON_FIELDS, ContactsConflict, ContactsStore
from .pricing_workbook import MAX_FILE_BYTES, _preflight


TEMPLATES = {"contacts": PERSON_FIELDS, "accounts": ACCOUNT_FIELDS}
MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def headers(kind):
    return [field.replace("_", " ").title() for field in TEMPLATES[kind]]


def template(kind):
    book = Workbook()
    sheet = book.active
    sheet.title = kind.title()
    sheet.append(headers(kind))
    for column, cell in enumerate(sheet[1], 1):
        cell.font = Font(name="Montserrat", bold=True, color="FFFFFF")
        cell.fill = PatternFill(fill_type="solid", fgColor="B4001B")
        dim = sheet.column_dimensions[get_column_letter(column)]
        dim.width = 45 if cell.value in {"Billing Address", "Email"} else 30
        dim.number_format = "@"
    sheet.freeze_panes = "A2"
    output = BytesIO()
    book.save(output)
    book.close()
    return output.getvalue()


def read_template(kind, filename, encoded):
    if not isinstance(filename, str) or not filename.lower().endswith(".xlsx"):
        raise ValidationError("Choose an .xlsx file exported from this page.")
    if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_FILE_BYTES + 2) // 3):
        raise ValidationError("Choose an Excel workbook no larger than 5 MB.")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValidationError("The uploaded Excel file could not be decoded.") from exc
    try:
        _preflight(payload, filename)
    except ValidationError as exc:
        raise ValidationError(str(exc).replace("pricing", "directory").replace("Pricing", "Directory")) from exc
    from .schedule_workbook import _check_order
    try:
        _check_order(payload)
    except ValidationError as exc:
        raise ValidationError("Workbook rows or cells are duplicated, out of order or outside the template.") from exc
    book = None
    try:
        book = load_workbook(BytesIO(payload), read_only=True, data_only=False, keep_links=False)
        if book.sheetnames != [kind.title()]:
            raise ValidationError(f"Use the exported {kind.title()} template.")
        sheet = book.active
        sheet.reset_dimensions()
        rows = sheet.iter_rows(values_only=True)
        if list(next(rows, ())) != headers(kind):
            raise ValidationError(f"Use the columns from the {kind.title()} template in their original order.")
        records = []
        fields = TEMPLATES[kind]
        for number, row in enumerate(rows, 2):
            if all(value is None or value == "" for value in row):
                continue
            if any(value is not None for value in row[len(fields):]):
                raise ValidationError(f"Row {number}: remove data outside the template columns.")
            values = {}
            for field, value in zip(fields, row):
                if field == "phone" and type(value) in {int, float}:
                    value = str(value)
                if value is not None and not isinstance(value, str):
                    raise ValidationError(f"Row {number}: enter {field} as text.")
                values[field] = value or ""
            records.append((number, values))
        if not records:
            raise ValidationError("Enter at least one record below the column headings.")
        return records
    except ValidationError:
        raise
    except (TypeError, ValueError, IndexError, KeyError, OSError, AttributeError) as exc:
        raise ValidationError("The Excel workbook could not be read.") from exc
    finally:
        if book is not None:
            book.close()


class ContactsHTTP:
    def __init__(self, path, projects):
        self.store = ContactsStore(path)
        self.projects = projects

    def dispatch(self, handler, route):
        prefix = "/api/contacts/"
        if not route.startswith(prefix):
            return False
        action = route[len(prefix):]
        try:
            workbook = re.fullmatch(r"(accounts|contacts)/(template\.xlsx|import)", action)
            if handler.command == "GET" and action == "directory":
                handler.send_payload(200, self.store.list())
            elif handler.command == "GET" and workbook and workbook[2] == "template.xlsx":
                kind = workbook[1]
                handler.send_payload(200, template(kind), MIME,
                                     {"Content-Disposition": f'attachment; filename="CLASSIFIRE-{kind.title()}-Template.xlsx"'})
            elif handler.command == "POST" and handler.headers.get("Sec-Fetch-Site") == "cross-site":
                handler.send_payload(403, {"error": "Open Contacts in the CLASSIFIRE web app."})
            elif handler.command == "POST" and action in {"leads", "contacts", "accounts"}:
                handler.send_payload(200, self.store.save(action, handler.read_json()))
            elif handler.command == "POST" and action == "leads/convert":
                handler.send_payload(200, self.store.convert(handler.read_json(), self.projects.create_from_lead))
            elif handler.command == "POST" and workbook and workbook[2] == "import":
                body = handler.read_json()
                records = read_template(workbook[1], body.get("filename"), body.get("file"))
                handler.send_payload(200, self.store.import_rows(workbook[1], records, body.get("version")))
            else:
                handler.send_payload(404, {"error": "Directory action not found."})
        except ContactsConflict as exc:
            handler.send_payload(409, {"error": str(exc)})
        return True
