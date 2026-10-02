"""Saved numbered identities cannot be rewritten inside otherwise valid history."""

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_documents import TakeoffDocuments
from estimator.takeoff_model import audit_affected, new_snapshot, upgrade_snapshot
from estimator.takeoff_physical import new_graph, preview_change, apply_change


class NumberedPhysicalAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.documents = TakeoffDocuments(Path(self.temp.name) / 'evidence')
        self.addCleanup(self.documents.close)
        self.initial = new_snapshot()
        graph = new_graph(self.initial['project_id'], version=2)
        command = {'op': 'create', 'kind': 'defect', 'entity': {
            'id': str(uuid4()), 'fields': {}, 'evidence': [],
            'uncertainty': {'state': 'not_assessed', 'note': ''}}}
        preview = preview_change(graph, command)
        graph = apply_change(graph, command, expected_revision=0,
                             preview_digest=preview['preview_digest'])['graph']
        current = upgrade_snapshot(self.initial)
        current['physical'] = graph
        self.current = self.record(self.initial, current)

    def record(self, before, after):
        after = deepcopy(after)
        after['revision'] = before['revision'] + 1
        strip = lambda state: {key: value for key, value in state.items() if key != 'audit_head'}
        event = {'version': 2, 'project_id': before['project_id'], 'revision': after['revision'],
                 'previous': before['audit_head'], 'request_id': str(uuid4()), 'op': 'apply_physical',
                 'at': '2026-10-02T00:00:00Z',
                 'actor': {'kind': 'local-session', 'session_id': str(uuid4())},
                 'before': strip(before), 'after': strip(after), 'affected_ids': audit_affected(before, after)}
        after['audit_head'] = self.documents.put_blob(event)
        return after

    def test_valid_numbered_history_and_updates_are_accepted(self):
        self.documents.validate_audit(self.current)
        updated = deepcopy(self.current)
        updated['physical']['revision'] += 1
        updated['physical']['defects'][0]['revision'] += 1
        updated['physical']['defects'][0]['fields']['label'] = 'Renamed'
        self.documents.validate_audit(self.record(self.current, updated))

    def test_renumbering_uuid_replacement_or_removal_is_rejected(self):
        for mutation in ('renumber', 'replace_uuid', 'remove', 'remove_graph'):
            altered = deepcopy(self.current)
            if mutation == 'renumber':
                altered['physical']['defects'][0]['display_id'] = 'D-0002'
            elif mutation == 'replace_uuid':
                altered['physical']['defects'][0]['id'] = str(uuid4())
            elif mutation == 'remove':
                altered['physical']['defects'] = []
            else:
                altered['physical'] = None
            with self.subTest(mutation=mutation), self.assertRaises(ValidationError):
                self.documents.validate_audit(self.record(self.current, altered))

    def test_silent_schema_reversal_is_rejected(self):
        altered = deepcopy(self.current)
        altered['physical'] = new_graph(self.initial['project_id'], self.current['physical']['id'])
        with self.assertRaisesRegex(ValidationError, 'cannot be replaced'):
            self.documents.validate_audit(self.record(self.current, altered))

    def test_forged_new_serial_cannot_skip_the_sequence(self):
        altered = deepcopy(self.current)
        added = deepcopy(altered['physical']['defects'][0])
        added.update(id=str(uuid4()), display_id='D-0003')
        altered['physical']['defects'].append(added)
        with self.assertRaisesRegex(ValidationError, 'continue the retained sequence'):
            self.documents.validate_audit(self.record(self.current, altered))


if __name__ == '__main__':
    unittest.main()
