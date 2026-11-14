"""HTTP and values-only Excel import/export for the Contacts directory."""

import base64
import binascii
from io import BytesIO
import re
from urllib.parse import parse_qs, urlsplit

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

from .catalog import ValidationError
from . import crm_identity
from . import crm_activity
from .account_relations import AccountRelations
from .contact_relations import ContactRelations
from .contacts import ACCOUNT_FIELDS, PERSON_FIELDS, ContactsConflict, ContactsStore, PossibleDuplicateContact, PossibleDuplicateLead
from .pricing_workbook import MAX_FILE_BYTES, _preflight


TEMPLATES = {"contacts": PERSON_FIELDS, "accounts": ACCOUNT_FIELDS}
MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def headers(kind):
    return ["ABN/ACN" if field == "abn_acn" else field.replace("_", " ").title() for field in TEMPLATES[kind]]


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
        actual_headers = list(next(rows, ()))
        fields = TEMPLATES[kind]
        if kind == "accounts" and actual_headers == ["Company", "Billing Address"]:
            fields = ACCOUNT_FIELDS[:2]  # Previously exported workbooks remain importable.
        elif actual_headers != headers(kind):
            raise ValidationError(f"Use the columns from the {kind.title()} template in their original order.")
        records = []
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
    def __init__(self, path, projects, staff_provider=None):
        self.store = ContactsStore(path, staff_provider=staff_provider)
        self.projects = projects
        self.relations = AccountRelations(self.store, projects)
        self.contact_relations = ContactRelations(self.store, projects)
        self.participants = None

    def dispatch(self, handler, route):
        prefix = "/api/contacts/"
        if not route.startswith(prefix):
            return False
        action = route[len(prefix):]
        actor = getattr(handler,'crm_actor',None)
        try:
            workbook = re.fullmatch(r"(accounts|contacts)/(template\.xlsx|import)", action)
            if handler.command == "GET" and action == "directory":
                board = parse_qs(urlsplit(handler.path).query).get('board') == ['1']
                handler.send_payload(200, self.store.list(lead_board=board))
            elif handler.command == 'GET' and action == 'staff':
                handler.send_payload(200, {'staff':[{'id':row['id'],'name':row['name']} for row in self.store.staff_provider()]})
            elif handler.command == 'GET' and action == 'activity':
                query=parse_qs(urlsplit(handler.path).query,keep_blank_values=True)
                if set(query) not in ({'kind','id'},{'kind','id','before'}) or any(len(v)!=1 for v in query.values()):
                    raise ValidationError('Choose one activity timeline.')
                with self.store.connection() as db:
                    db.execute('BEGIN')
                    value=crm_activity.timeline(db,query['kind'][0],query['id'][0],query.get('before',[None])[0])
                    value.update(version=self.store._version(db),metadata=crm_activity.record_metadata(db,query['kind'][0],query['id'][0]))
                handler.send_payload(200,value)
            elif handler.command == "GET" and action == "account-links":
                query = parse_qs(urlsplit(handler.path).query, keep_blank_values=True)
                if set(query) - {"id", "search"} or any(len(values) != 1 for values in query.values()):
                    raise ValidationError("Choose one company and related-record search.")
                account_id=query.get("id",[None])[0]
                result=self.relations.view(account_id, search=query.get("search", [""])[0])
                if self.participants and account_id:
                    result['participant_projects']=self.participants.related('accounts',result.get('party_ids',[account_id]))
                handler.send_payload(200,result)
            elif handler.command == "GET" and action == "contact-links":
                query = parse_qs(urlsplit(handler.path).query, keep_blank_values=True)
                if set(query) != {"id"} or len(query["id"]) != 1:
                    raise ValidationError("Choose one contact to view linked records.")
                contact_id=query["id"][0]
                result=self.contact_relations.view(contact_id)
                if self.participants:
                    result['participant_projects']=self.participants.related('contacts',result.get('party_ids',[contact_id]))
                handler.send_payload(200,result)
            elif handler.command == "GET" and workbook and workbook[2] == "template.xlsx":
                kind = workbook[1]
                handler.send_payload(200, template(kind), MIME,
                                     {"Content-Disposition": f'attachment; filename="CLASSIFIRE-{kind.title()}-Template.xlsx"'})
            elif handler.command == "POST" and handler.headers.get("Sec-Fetch-Site") == "cross-site":
                handler.send_payload(403, {"error": "Open Contacts in the CLASSIFIRE web app."})
            elif handler.command == "POST" and action == 'sync-project-details':
                body = handler.read_json()
                if not isinstance(body,dict):
                    raise ValidationError("Use the fields provided on this form.")
                project = self.projects.participant_project(body.get('project'),directory_only=True)
                handler.send_payload(200,self.store.sync_project_details(project,body,actor))
            elif handler.command == "POST" and action.startswith('identity/'):
                operation = action.split('/', 1)[1]
                body = handler.read_json()
                if not isinstance(body, dict):
                    raise ValidationError('Choose an existing directory record.')
                service = crm_identity.IdentityService(self.store)
                if operation == 'preview':
                    preview = service.preview(body)
                    relations = self.relations if body['kind'] == 'accounts' else self.contact_relations
                    for side in ('source','survivor'):
                        view = relations.view(body[side+'_id'])
                        if view['version'] != preview['version']:
                            raise ContactsConflict('Contacts have changed. Reopen the form to review the latest values.')
                        counts = {key:len(rows) for key, rows in view['linked'].items()}
                        counts.update({key:len(rows) for key, rows in view.get('related', {}).items()})
                        for key in ('converted_leads', 'active_leads'):
                            if key in view:
                                counts[key] = len(view[key])
                        preview[side+'_links'] = {'counts':counts,
                            'scan_pending':view['scan_pending'], 'error_count':view['error_count']}
                    result = preview
                elif operation in ('merge','undo'):
                    result = service.apply(operation, body, actor)
                elif operation == 'suggestions':
                    from .contacts import checked_fields, company_key
                    kind = body.get('kind')
                    if kind not in ('accounts','contacts'):
                        raise ValidationError('Choose an existing directory record.')
                    fields = checked_fields(kind, body.get('fields'))
                    with self.store.connection() as db:
                        db.execute('BEGIN')
                        owner = db.execute('SELECT id FROM accounts WHERE lookup_key=?', (company_key(fields['company']),)).fetchone()
                        result = crm_identity.suggestions(db, kind, fields, body.get('id'), owner[0] if owner and kind == 'contacts' else None,
                                                          merge_sources=body.get('merge_sources') is True and bool(body.get('id')))
                else:
                    handler.send_payload(404, {'error':'Directory action not found.'})
                    return True
                handler.send_payload(200, result)
            elif handler.command == "POST" and action in {"leads", "contacts", "accounts"}:
                body = handler.read_json()
                catalog = None
                if action == "accounts" and isinstance(body, dict) and "links" in body:
                    links = body["links"]
                    catalog = self.relations.view(body.get("id"), include_ids=links if isinstance(links, dict) else None)
                handler.send_payload(200, self.store.save(action, body, link_catalog=catalog,actor=actor))
            elif handler.command == 'POST' and action == 'activity':
                handler.send_payload(200, crm_activity.log_activity(self.store,handler.read_json(),actor,ContactsConflict))
            elif handler.command == "POST" and action == "leads/convert":
                handler.send_payload(200, self.store.convert(handler.read_json(), self.projects.create_from_lead,actor=actor))
            elif handler.command == "POST" and workbook and workbook[2] == "import":
                body = handler.read_json()
                records = read_template(workbook[1], body.get("filename"), body.get("file"))
                handler.send_payload(200, self.store.import_rows(workbook[1], records, body.get("version"),actor=actor))
            else:
                handler.send_payload(404, {"error": "Directory action not found."})
        except crm_identity.DuplicateReview as exc:
            key = 'matching_' + exc.decision['kind']
            handler.send_payload(409, {'error':str(exc), 'duplicate_review':exc.decision,
                                       key:[row['id'] for row in exc.decision['matches']]})
        except crm_identity.IdentityConflict as exc:
            handler.send_payload(409, {'error':str(exc)})
        except PossibleDuplicateContact as exc:
            handler.send_payload(409, {"error": str(exc), "matching_contacts": exc.contact_ids})
        except PossibleDuplicateLead as exc:
            handler.send_payload(409, {"error": str(exc), "matching_leads": exc.lead_ids})
        except ContactsConflict as exc:
            handler.send_payload(409, {"error": str(exc)})
        return True
