"""Seed a deliberate pre-policy unfiled record in one disposable browser fixture.

This is test setup, not an application endpoint or a grant of project creation.
The running server's existing workspace stays uncreated throughout recovery.
"""
import json
from pathlib import Path
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from estimator.commercial_documents import CommercialDocuments, default_fields
from estimator.document_numbers import DocumentNumbers
from tests.commercial_ready_fixtures import complete_quote


folder = Path(sys.argv[1]).resolve()
workspace, project = str(UUID(sys.argv[2])), str(UUID(sys.argv[3]))
if not (folder / 'qa.sqlite3').is_file():
    raise RuntimeError('Use a running disposable browser fixture only.')

class LegacyProject:
    root = folder / 'certification-projects'
    numbering = DocumentNumbers(folder / 'qa-document-numbers.sqlite3')

    def project_id(self, token):
        if token != workspace:
            raise RuntimeError('Unknown fixture workspace')
        return project


service = CommercialDocuments(LegacyProject())
fields = complete_quote(default_fields('quote', {'client': 'Unfiled fixture company', 'site_address': '21 Fixture Street'}))
fields['title'] = 'Unfiled fixture quote'
document = service.save(workspace, {'kind': 'quote', 'status': 'Draft', 'fields': fields},
                        unfiled_context={'estimates': [], 'active_estimate_id': 'estimate-1'})
print(json.dumps({'id': document['id'], 'title': document['fields']['title']}))
