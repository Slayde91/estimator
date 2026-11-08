"""Read-only Contact associations from authorized project metadata.

Company membership does not make every Company project a Contact project.
Only canonical Contact IDs and unambiguous saved-file provenance establish a
project/document relationship here; names and filesystem paths are not inputs.
"""

from .account_relations import DOCUMENT_GROUPS, _identity, _project_label
from .catalog import ValidationError
from .commercial_sources import source_id


class ContactRelations:
    def __init__(self, store, projects):
        self.store = store
        self.projects = projects

    def view(self, contact_id):
        directory = self.store.list()
        contact = next((row for row in directory["contacts"] if row["id"] == contact_id), None)
        if not _identity(contact_id) or contact is None:
            raise ValidationError("This contact could not be found. Reload the directory.")
        linked = {kind: {} for kind in ("companies", "projects", "quotes", "work_orders", "purchase_orders")}
        company = next((row for row in directory["accounts"] if row["id"] == contact.get("account_id")), None)
        if company:
            linked["companies"][company["id"]] = {"id": company["id"], "label": company["company"], "available": True}

        # Both snapshots advance only the existing bounded authorized scans.
        # Match document source files before considering a unique-owner fallback:
        # multiple copies of a project can name different Contacts.
        register = self.projects.commercial_register()
        listing = self.projects.account_relation_projects()
        projects, owners, sources = {}, {}, {}
        for row in listing["files"]:
            token = row.get("account_link_id") or row.get("source_project_id")
            if not _identity(token):
                continue
            projects[token] = row
            owner = row.get("source_project_id")
            if _identity(owner):
                owners.setdefault(owner, set()).add(token)
            source = row.get("id") or (source_id(row["path"]) if row.get("path") else None)
            if source:
                sources[source] = token
            if row.get("contact_id") == contact_id:
                linked["projects"][token] = {"id": token, "label": _project_label(row), "available": True}

        for document in register["documents"]:
            group = DOCUMENT_GROUPS.get(document.get("kind"))
            owner, identifier = document.get("project_id"), document.get("id")
            if not group or not _identity(owner) or not _identity(identifier):
                continue
            source = document.get("source_file")
            project_token = sources.get(source)
            candidates = owners.get(owner, set())
            if not source and len(candidates) == 1:
                project_token = next(iter(candidates))
            if project_token not in linked["projects"] or projects[project_token].get("source_project_id") != owner:
                continue
            fields = document.get("fields", {})
            reference = document.get("reference") or document.get("last_number") or fields.get("title") or document["kind"].replace("_", " ").title()
            token = f"{owner}:{identifier}"
            linked[group][token] = {"id": token, "label": " · ".join(filter(None, (reference, _project_label(projects[project_token]))))[:1200], "available": True}

        missing = register.get("unavailable_sources", [])
        errors = [{"name": row.get("name", "Project"), "error": row.get("error", "Project could not be read.")}
                  for row in listing.get("errors", [])[:100]]
        errors.extend({"name": row.get("title", "Project"), "error": "Saved project source is unavailable."} for row in missing[:100])
        return {"version": directory["version"], "linked": {kind: sorted(rows.values(), key=lambda row: (row["label"].casefold(), row["id"])) for kind, rows in linked.items()},
                "scan_pending": bool(listing.get("scan_pending") or register.get("scan_pending")),
                "error_count": max(listing.get("error_count", 0), register.get("error_count", 0)) + len(missing), "errors": errors}
