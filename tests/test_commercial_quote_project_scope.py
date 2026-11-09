"""New Work Orders must not link a Quote recorded against another Project."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialDocuments, default_fields
from tests.test_commercial_documents import Projects
from tests.test_certification import pdf
from tests.commercial_ready_fixtures import complete_quote


class CommercialQuoteProjectScopeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.projects = Projects(Path(temporary.name))
        self.workspace = self.projects.add()
        self.store = CommercialDocuments(self.projects, renderer=lambda *args, **kwargs: pdf('Issued fixture'))

    def quote(self, project_no, workspace=None):
        workspace = workspace or self.workspace
        fields = complete_quote(default_fields('quote', {'project_no': project_no}))
        saved = self.store.save(workspace, {'id':str(uuid4()), 'version':0,
            'kind':'quote', 'status':'Draft', 'fields':fields})
        return self.store.issue(workspace, saved['id'], saved['version'], str(uuid4()))['document']

    def test_new_link_rejects_a_different_project_before_allocating_a_reference(self):
        foreign = self.quote('PN-OTHER', self.projects.add())
        fields = default_fields('work_order', {'project_no':'PN-CURRENT'})
        fields['order']['quote_id'] = foreign['id']
        before = deepcopy(self.store.capture(self.workspace))
        with self.assertRaises(ValidationError):
            self.store.save(self.workspace, {'id':str(uuid4()), 'version':0,
                'kind':'work_order', 'status':'Draft', 'fields':fields})
        self.assertEqual(self.store.capture(self.workspace), before)

    def test_same_project_is_linkable_and_retains_its_issued_quote_number(self):
        quote = self.quote('PN-CURRENT')
        fields = default_fields('work_order', {'project_no':'PN-CURRENT'})
        fields['order']['quote_id'] = quote['id']
        saved = self.store.save(self.workspace, {'id':str(uuid4()), 'version':0,
            'kind':'work_order', 'status':'Draft', 'fields':fields})
        self.assertEqual(saved['fields']['order']['quote_id'], quote['id'])
        self.assertEqual(saved['fields']['order']['quote_reference'], quote['last_number'])


if __name__ == '__main__':
    unittest.main()
