"""Directory links to authorized project and document identities, never paths."""

from uuid import UUID

from .catalog import ValidationError
from .commercial_sources import source_id
from .contacts import LINK_KINDS, company_key


MAX_CHOICES = 1000
DOCUMENT_GROUPS = {"quote": "quotes", "work_order": "work_orders", "purchase_order": "purchase_orders"}
SUPPLEMENTAL_GROUPS = {"certification": "certifications", "swms": "swms"}


def _identity(value):
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def _project_label(row):
    return " · ".join(str(row.get(key, "")) for key in ("project_no", "client", "site_address") if row.get(key)) or row.get("title") or "Project"


def project_document_cards(register, projects):
    """Retain cards already indexed in exact saved files during a bounded scan."""
    documents = list(register['documents'])
    seen = {(row.get('source_file'), row.get('project_id'), row.get('id')) for row in documents}
    for row in projects:
        owner = row.get('source_project_id')
        source = row.get('id') or (source_id(row['path']) if row.get('path') else None)
        for card in (*row.get('commercial_cards', []), *row.get('directory_cards', [])):
            key = (source, owner, card.get('id'))
            if not _identity(owner) or card.get('project_id') != owner or key in seen:
                continue
            documents.append({**card, 'source_file': source})
            seen.add(key)
    return documents


class AccountRelations:
    def __init__(self, store, projects):
        self.store = store
        self.projects = projects

    def view(self, account_id=None, *, search="", include_ids=None):
        if not isinstance(search, str) or len(search) > 500:
            raise ValidationError("Search related records using up to 500 characters.")
        directory = self.store.list()
        accounts = {row["id"]: row for row in directory["accounts"]}
        if account_id is not None and (not _identity(account_id) or account_id not in accounts):
            raise ValidationError("This company could not be found. Reload the directory.")
        account = accounts.get(account_id)
        records = {kind: {} for kind in LINK_KINDS}
        automatic = {kind: set() for kind in LINK_KINDS}
        for contact in directory["contacts"]:
            owner = accounts.get(contact["account_id"])
            entry = {"id": contact["id"], "label": " · ".join(filter(None, (contact["name"], contact["company"]))),
                     "available": True, "account_id": contact["account_id"], "account_label": owner["company"] if owner else ""}
            records["contacts"][entry["id"]] = entry
            if account_id is not None and contact["account_id"] == account_id:
                automatic["contacts"].add(entry["id"])

        # Each library call advances only its existing bounded scan. The metadata
        # snapshot contains already authorized IDs, including registered sources;
        # this endpoint never accepts a filesystem path or opens one itself.
        register = self.projects.commercial_register()
        listing = self.projects.account_relation_projects()
        project_rows, owner_links, source_links = {}, {}, {}
        for row in listing["files"]:
            token = row.get("account_link_id") or row.get("source_project_id")
            if not _identity(token):
                continue
            project_rows.setdefault(token, row)
            owner = row.get("source_project_id")
            if _identity(owner):
                owner_links.setdefault(owner, set()).add(token)
            source = row.get("id") or (source_id(row["path"]) if row.get("path") else None)
            if source:
                source_links[source] = token
        for token, row in project_rows.items():
            records["projects"][token] = {"id": token, "label": _project_label(row), "available": True}
            primary = row.get("account_id", "")
            matches = (primary == account_id if primary else account is not None
                       and company_key(row.get("client", "")) == company_key(account["company"]))
            if account_id is not None and matches:
                automatic["projects"].add(token)
        certificate_records = {'documents':[], 'errors':[], 'scan_pending':False}
        if hasattr(self.projects, 'directory_certificate_cards'):
            certificate_records = self.projects.directory_certificate_cards([row for token,row in project_rows.items() if token in automatic['projects']])
            register = {**register, 'documents':[*register['documents'], *certificate_records['documents']]}
        supplemental = {kind: {} for kind in SUPPLEMENTAL_GROUPS.values()}
        for document in project_document_cards(register, listing['files']):
            owner, document_id = document.get("project_id"), document.get("id")
            group = DOCUMENT_GROUPS.get(document.get("kind")) or SUPPLEMENTAL_GROUPS.get(document.get('kind'))
            if not group or not _identity(owner) or not _identity(document_id):
                continue
            token = f"{owner}:{document_id}"
            fields = document.get("fields", {})
            reference = document.get("reference") or document.get("last_number") or fields.get("title") or document.get('title') or document["kind"].replace("_", " ").title()
            candidates = owner_links.get(owner, set())
            project_token = source_links.get(document.get("source_file"))
            if not document.get('source_file') and len(candidates) == 1:
                project_token = next(iter(candidates))
            if project_token is not None and project_rows[project_token].get('source_project_id') != owner:
                continue
            if document.get('source_file') and project_token is None:
                continue
            project = project_rows.get(project_token, fields.get("details", {}))
            label = " · ".join(filter(None, (reference, _project_label(project))))[:1200]
            entry = {"id": token, "label": label, "available": True}
            if group in supplemental:
                if project_token in automatic['projects']:
                    supplemental[group][token] = entry
                continue
            if token in automatic[group] and project_token not in automatic['projects']:
                continue  # A foreign copy must not relabel this company's exact document.
            records[group][token] = entry
            details = fields.get("details", {})
            legacy_match = (not candidates and account is not None
                            and company_key(details.get("client", "")) == company_key(account["company"]))
            if project_token in automatic["projects"] or legacy_match:
                automatic[group].add(token)

        linked = {kind: {} for kind in LINK_KINDS}
        for kind in LINK_KINDS:
            for token in automatic[kind]:
                # Contact ownership remains editable; an account cannot sever a
                # project's primary Account association through a secondary link.
                linked[kind][token] = {**records[kind][token], **({"automatic": True} if kind != "contacts" else {})}
        for saved in self.store.saved_links(account_id) if account_id is not None else []:
            kind, token = saved["kind"], saved["target_id"]
            if kind not in linked or kind == "contacts":
                continue
            linked[kind][token] = {**records[kind].get(token, {"id": token, "label": saved["label"], "available": False}),
                                  **({"automatic": True} if token in automatic[kind] else {}), "manual": True}

        needle = search.strip().casefold()
        choices, truncated = {}, False
        for kind in LINK_KINDS:
            entries = sorted(records[kind].values(), key=lambda row: (row["label"].casefold(), row["id"]))
            matching = [entry for entry in entries if not needle or needle in entry["label"].casefold()]
            truncated = truncated or len(matching) > MAX_CHOICES
            chosen = {entry["id"]: entry for entry in matching[:MAX_CHOICES]}
            # POST validation includes requested IDs even when a search found them
            # outside the first page. This is server-side inclusion, not authority
            # supplied by the request: IDs still must exist in the known catalog.
            requested = (include_ids or {}).get(kind, ())
            for token in requested[:1000] if isinstance(requested, list) else ():
                if isinstance(token, str) and token in records[kind]:
                    chosen[token] = records[kind][token]
            choices[kind] = list(chosen.values())
        errors = [{"name": row.get("name", "Project"), "error": row.get("error", "Project could not be read.")}
                  for row in listing.get("errors", [])[:100]]
        errors.extend(certificate_records['errors'])
        missing = register.get("unavailable_sources", [])
        errors.extend({"name": row.get("title", "Project"), "error": "Saved project source is unavailable."} for row in missing[:100])
        return {"version": directory["version"], "linked": {kind: sorted(rows.values(), key=lambda row: (row["label"].casefold(), row["id"])) for kind, rows in linked.items()},
                "related": {kind: sorted(rows.values(), key=lambda row: (row['label'].casefold(), row['id'])) for kind, rows in supplemental.items()},
                "choices": choices, "scan_pending": bool(listing.get("scan_pending") or register.get("scan_pending") or certificate_records['scan_pending']),
                "truncated": truncated, "error_count": max(listing.get("error_count", 0), register.get("error_count", 0)) + len(missing) + len(certificate_records['errors']),
                "errors": errors}
