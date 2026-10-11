"""Initial Pages settings link only exact audited visual members, atomically."""
from copy import deepcopy
from io import BytesIO
import unittest
from unittest.mock import patch
from uuid import uuid4

from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.takeoff_initial_pages import apply_initial_pages, validate_initial_pages_history
from estimator.takeoff_initial_links import OriginSummary, linked_members
from estimator.takeoff_model import validate_snapshot
from tests import test_takeoff_project as project_fixtures
from tests import test_takeoff_stamp_initial_pages as stamp_fixtures
from tests.test_takeoff_graphics import proposal


class InitialPagesLinkTests(unittest.TestCase):
    command = stamp_fixtures.StampInitialPagesTests.command
    upload_mixed = stamp_fixtures.StampInitialPagesTests.upload_mixed
    initials = stamp_fixtures.StampInitialPagesTests.initials
    export = stamp_fixtures.StampInitialPagesTests.export
    assert_authorities_same = stamp_fixtures.StampInitialPagesTests.assert_authorities_same

    @classmethod
    def setUpClass(cls):
        project_fixtures.TakeoffProjectTests.setUpClass()

    def setUp(self):
        self.case = project_fixtures.TakeoffProjectTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.document = self.case.session['snapshot']['documents'][0]

    def batch(self, *, legacy=False, **values):
        self.upload_mixed()
        value = self.initials(strokes=[[[0, 0], [.4, .8], [1, 1]]], signature_ratio=2, **values)
        if legacy:
            def old_batch(snapshot, request):
                result = apply_initial_pages(snapshot, request)
                for key in ('graphics', 'signatures'):
                    ids = result['created_graphic_ids' if key == 'graphics' else 'created_signature_ids']
                    for row in snapshot.get(key, {}).get('records', []):
                        if row['id'] in ids:
                            row.pop('initial_pages')
                return result
            with patch('estimator.takeoff_initial_pages.apply_initial_pages', side_effect=old_batch):
                return self.command('initial_pages', initials=value)
        return self.command('initial_pages', initials=value)

    def rows(self, key='graphics'):
        return self.case.session['snapshot'][key]['records']

    def test_birth_metadata_exact_role_source_pages_and_rich_settings_fanout_preserve_geometry_authority(self):
        result = self.batch(); before = deepcopy(result['snapshot'])
        graphics, signatures = self.rows(), self.rows('signatures')
        group = graphics[0]['initial_pages']['group_id']
        self.assertEqual({row['initial_pages']['group_id'] for row in graphics+signatures}, {group})
        self.assertEqual({row['initial_pages']['role'] for row in graphics}, {'text'})
        self.assertEqual({row['initial_pages']['role'] for row in signatures}, {'signature'})
        content = {'version': 1, 'blocks': [{'kind': 'bullet', 'runs': [{'text': 'ST', 'bold': True, 'italic': True, 'underline': True}]}]}
        self.command('update_graphic', graphic_id=graphics[1]['id'], changes={
            'text': 'ST', 'text_content': content, 'appearance': {'font_color': '#123456', 'font_size': 4,
            'stroke_color': '#654321', 'stroke_width': .5, 'opacity': .5, 'fill_enabled': True, 'fill_color': '#ABCDEF'}})
        after = self.case.session['snapshot']
        self.assertEqual(after['revision'], before['revision']+1)
        self.assertEqual(after['signatures'], before['signatures'])
        for old, new in zip(before['graphics']['records'], self.rows()):
            self.assertEqual(new['id'], old['id']); self.assertEqual(new['version'], 2)
            self.assertEqual(new['geometry'], old['geometry']); self.assertEqual(new['initial_pages'], old['initial_pages'])
            self.assertEqual(new['text_content'], content); self.assertEqual(new['text'], 'ST')
            self.assertEqual(new['appearance']['font_color'], '#123456'); self.assertEqual(new['appearance']['font_size'], 4)
        self.assert_authorities_same(before, after)
        event = self.case.documents.get_blob(after['audit_head'])
        self.assertEqual(event['affected_ids']['graphics'], sorted(result['created_graphic_ids']))
        self.assertEqual(event['affected_ids']['signatures'], [])
        self.case.documents.validate_audit(after)

    def test_signature_redraw_and_style_fanout_only_signature_role_and_undo_restores_batch(self):
        self.batch(); before = deepcopy(self.case.session['snapshot'])
        strokes = [[[0, 1], [.2, .4], [1, 0]], [[.5, .5]]]
        self.command('update_signature', signature_id=self.rows('signatures')[2]['id'], changes={
            'strokes': strokes, 'appearance': {'stroke_color': '#234567', 'stroke_width': 3, 'opacity': .6}})
        after = deepcopy(self.case.session['snapshot'])
        self.assertEqual(after['graphics'], before['graphics'])
        for old, new in zip(before['signatures']['records'], self.rows('signatures')):
            self.assertEqual(new['quad_pdf'], old['quad_pdf']); self.assertEqual(new['strokes'], strokes)
            self.assertEqual(new['appearance'], {'stroke_color': '#234567', 'stroke_width': 3, 'opacity': .6})
            self.assertEqual(new['version'], 2)
        self.assert_authorities_same(before, after)
        self.command('undo')
        for old, new in zip(before['signatures']['records'], self.rows('signatures')):
            self.assertEqual({key: value for key, value in new.items() if key != 'version'},
                             {key: value for key, value in old.items() if key != 'version'})
            self.assertEqual(new['version'], 3)

    def test_local_text_resize_scales_only_its_ink_then_shared_colour_still_fans_out(self):
        self.batch(); before = deepcopy(self.case.session['snapshot'])
        selected = before['graphics']['records'][0]; quad = selected['geometry']['quad_pdf']; origin = quad[0]
        geometry = {'quad_pdf': [[origin[i]+(p[i]-origin[i])*1.2 for i in (0, 1)] for p in quad], 'text_scale': 1.2}
        self.command('update_graphic', graphic_id=selected['id'], changes={'geometry': geometry})
        after = deepcopy(self.case.session['snapshot'])
        for old, new in zip(before['graphics']['records'], after['graphics']['records']):
            self.assertEqual(new['appearance'], old['appearance']); self.assertEqual(new['text'], old['text'])
            self.assertEqual(new['initial_pages'], old['initial_pages'])
            self.assertEqual(new['geometry'], geometry if new['id'] == selected['id'] else old['geometry'])
        self.assert_authorities_same(before, after)
        self.command('update_graphic', graphic_id=selected['id'], changes={'appearance': {'font_color': '#123456'}})
        for old, new in zip(after['graphics']['records'], self.rows()):
            self.assertEqual(new['geometry'], old['geometry']); self.assertEqual(new['appearance']['font_size'], old['appearance']['font_size'])
            self.assertEqual(new['appearance']['font_color'], '#123456')
        self.case.documents.validate_audit(self.case.session['snapshot'])
        self.assertEqual(len(PdfReader(BytesIO(self.export())).pages), len(self.document['pages']))
        self.case.documents.validate_audit(self.case.session['snapshot'])

    def test_local_geometry_and_selected_delete_do_not_move_or_remove_siblings(self):
        self.batch(); before = deepcopy(self.case.session['snapshot'])
        selected = self.rows()[0]
        quad = deepcopy(selected['geometry']['quad_pdf'])
        for point in quad:
            point[0] += 1
        self.command('update_graphic', graphic_id=selected['id'], changes={'geometry': {'quad_pdf': quad}})
        self.assertEqual(self.rows()[0]['geometry']['quad_pdf'], quad)
        self.assertEqual(self.rows()[1:], before['graphics']['records'][1:])
        self.command('delete_graphic', graphic_id=selected['id'])
        self.assertEqual([row['id'] for row in self.rows()], [row['id'] for row in before['graphics']['records'][1:]])
        self.command('undo')
        self.assertEqual(len(self.rows()), 4)
        self.command('delete_graphic', graphic_id=selected['id'])
        self.command('update_graphic', graphic_id=self.rows()[0]['id'], changes={'text': 'CD'})
        self.assertEqual({row['text'] for row in self.rows()}, {'CD'})
        self.assertEqual(self.rows('signatures'), before['signatures']['records'])
        self.command('undo')
        self.assertEqual(len(self.rows()), 3)
        self.case.documents.validate_audit(self.case.session['snapshot'])

    def test_copy_has_fresh_unlinked_identity_and_same_text_is_never_origin(self):
        self.batch()
        selected = deepcopy(self.rows()[0])
        copied = {key: value for key, value in selected.items() if key not in ('id', 'version', 'initial_pages')}
        response = self.command('create_graphic', graphic=copied); copy_id = response['created_graphic_id']
        self.command('update_graphic', graphic_id=selected['id'], changes={'text': 'NEW'})
        copy_row = next(row for row in self.rows() if row['id'] == copy_id)
        self.assertEqual(copy_row['text'], 'AB'); self.assertNotIn('initial_pages', copy_row)
        self.assertEqual(copy_row['version'], 1)
        self.command('update_graphic', graphic_id=copy_id, changes={'text': 'COPY'})
        self.assertEqual({row['text'] for row in self.rows() if row['id'] != copy_id}, {'NEW'})
        self.case.documents.validate_audit(self.case.session['snapshot'])

    def test_update_retry_stale_and_any_page_fit_or_audit_failure_are_atomic(self):
        self.batch(); before = deepcopy(self.case.session['snapshot'])
        identifier = self.rows()[0]['id']; case = self.case
        for changes in ({'appearance': {'font_size': 144}}, {'text': 'W'*4000}, {'text': 'unsupported \u2603'}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.command('update_graphic', graphic_id=identifier, changes=changes)
            self.assertEqual(case.service.get(case.session['session_id'])['snapshot'], before)
        with patch.object(case.documents, 'put_blob', side_effect=ValidationError('audit failure')), self.assertRaisesRegex(ValidationError, 'audit failure'):
            self.command('update_graphic', graphic_id=identifier, changes={'text': 'CD'})
        self.assertEqual(case.service.get(case.session['session_id'])['snapshot'], before)
        request = {'op': 'update_graphic', 'graphic_id': identifier, 'changes': {'text': 'CD'},
                   'request_id': str(uuid4()), 'expected_revision': before['revision']}
        result = case.service.command(case.session['session_id'], request)
        self.assertEqual(case.service.command(case.session['session_id'], request), result)
        case.session = result
        with self.assertRaisesRegex(ValidationError, 'changed'):
            case.service.command(result['session_id'], {**request, 'request_id': str(uuid4())})
        self.assertEqual({row['version'] for row in self.rows()}, {2})

    def test_same_value_settings_and_complete_style_payload_update_all_members_with_fitted_birth_sizes(self):
        self.batch(text='A'*20)
        sizes = {row['appearance']['font_size'] for row in self.rows()}
        self.assertGreater(len(sizes), 1, 'Mixed pages require different automatic birth font sizes')
        selected = self.rows()[0]['id']
        self.command('update_graphic', graphic_id=selected, changes={'appearance': {'font_color': '#000000'}})
        self.assertEqual({row['version'] for row in self.rows()}, {2})
        self.assertEqual({row['appearance']['font_size'] for row in self.rows()}, sizes)
        style = deepcopy(min(self.rows(), key=lambda row: row['appearance']['font_size'])['appearance'])
        self.command('update_graphic', graphic_id=selected, changes={'appearance': style})
        self.assertTrue(all(row['appearance'] == style for row in self.rows()))
        self.assertEqual({row['version'] for row in self.rows()}, {3})
        self.command('update_signature', signature_id=self.rows('signatures')[0]['id'], changes={'appearance': {'opacity': 1}})
        self.assertEqual({row['version'] for row in self.rows('signatures')}, {2})
        self.case.documents.validate_audit(self.case.session['snapshot'])

    def test_saved_reopened_links_edit_and_actual_marked_pdf_text_on_every_page(self):
        self.batch(); case = self.case
        state = deepcopy(case.session['snapshot'])
        case.request.update(takeoffs=state); case.library.save_as(case.request)
        case.dialogs.opened = str(case.target); reopened = case.library.open_file()
        self.assertEqual(reopened['takeoffs']['graphics'], state['graphics'])
        self.assertEqual(reopened['takeoffs']['signatures'], state['signatures'])
        self.assertEqual(reopened['takeoffs_issues'], [])
        case.session = case.service.get(reopened['takeoffs_session_id'])
        self.command('update_graphic', graphic_id=self.rows()[0]['id'], changes={'text': 'REOPENED', 'appearance': {'font_size': 4}})
        pages = PdfReader(BytesIO(self.export())).pages
        self.assertEqual(len(pages), 4)
        for page in pages:
            self.assertIn('REOPENED', page.extract_text())
        case.documents.validate_audit(case.session['snapshot'])

    def test_metadata_rejected_in_create_update_and_cross_role_source_page_tampering(self):
        self.batch(); before = deepcopy(self.case.session['snapshot'])
        link = self.rows()[0]['initial_pages']
        with self.assertRaises(ValidationError):
            self.command('create_graphic', graphic=proposal(self.document, 'textbox', initial_pages=link))
        with self.assertRaises(ValidationError):
            self.command('update_graphic', graphic_id=self.rows()[0]['id'], changes={'initial_pages': {**link, 'group_id': str(uuid4())}})
        signature = {key: deepcopy(value) for key, value in self.rows('signatures')[0].items() if key not in ('id', 'version')}
        with self.assertRaises(ValidationError):
            self.command('create_signature', signature=signature)
        with self.assertRaises(ValidationError):
            self.command('update_signature', signature_id=self.rows('signatures')[0]['id'], changes={'initial_pages': signature['initial_pages']})
        foreign = before['documents'][0]
        for mutate in (lambda row: row['initial_pages'].update(role='signature'),
                       lambda row: row['initial_pages'].update(version=True),
                       lambda row: row.update(page=1), lambda row: row.update(mode='duct'),
                       lambda row: row.update(document_id=foreign['id'], source_sha256=foreign['sha256'], page=1)):
            invalid = deepcopy(before); mutate(invalid['graphics']['records'][1])
            with self.subTest(mutate=mutate), self.assertRaises(ValidationError):
                validate_snapshot(invalid)
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)

    def test_history_rejects_partial_setting_update_reassignment_and_foreign_group_reuse(self):
        self.batch(); self.command('update_graphic', graphic_id=self.rows()[0]['id'], changes={'text': 'CD'})
        event = self.case.documents.get_blob(self.case.session['snapshot']['audit_head'])
        for mutation in ('omit', 'reassign', 'remove', 'geometry'):
            invalid = deepcopy(event)
            if mutation == 'omit':
                invalid['after']['graphics']['records'][1] = deepcopy(invalid['before']['graphics']['records'][1])
            elif mutation == 'reassign':
                invalid['after']['graphics']['records'][0]['initial_pages']['group_id'] = str(uuid4())
            elif mutation == 'remove':
                invalid['after']['graphics']['records'][0].pop('initial_pages')
            else:
                for row in invalid['after']['graphics']['records'][:2]:
                    for point in row['geometry']['quad_pdf']:
                        point[0] += 1
            bad = deepcopy(self.case.session['snapshot']); bad['audit_head'] = self.case.documents.put_blob(invalid)
            with self.subTest(mutation=mutation), self.assertRaises(ValidationError):
                self.case.documents.validate_audit(bad)
        self.command('initial_pages', initials=self.initials())
        event = self.case.documents.get_blob(self.case.session['snapshot']['audit_head'])
        invalid = deepcopy(event)
        old_group = invalid['before']['graphics']['records'][0]['initial_pages']['group_id']
        old_ids = {row['id'] for row in invalid['before']['graphics']['records']}
        for row in invalid['after']['graphics']['records']:
            if row['id'] not in old_ids:
                row['initial_pages']['group_id'] = old_group
        with self.assertRaisesRegex(ValidationError, 'fresh group'):
            validate_initial_pages_history(invalid)

    def test_forged_ordinary_birth_membership_rejected_by_complete_audit(self):
        self.command('create_graphic', graphic=proposal(self.document, 'textbox'))
        event = self.case.documents.get_blob(self.case.session['snapshot']['audit_head'])
        event['after']['graphics']['records'][0]['initial_pages'] = {'version': 1, 'group_id': str(uuid4()), 'role': 'text'}
        snapshot = deepcopy(event['after']); snapshot['audit_head'] = self.case.documents.put_blob(event)
        with self.assertRaisesRegex(ValidationError, 'Only Initial Pages'):
            self.case.documents.validate_audit(snapshot)

    def test_deleted_group_slots_cannot_be_reused_and_undo_cannot_invent_linked_birth(self):
        self.batch(); original = deepcopy(self.case.session['snapshot'])
        group = self.rows()[0]['initial_pages']['group_id']
        for key, id_key, op in (('graphics', 'graphic_id', 'delete_graphic'), ('signatures', 'signature_id', 'delete_signature')):
            for row in list(self.rows(key)):
                self.command(op, **{id_key: row['id']})
        self.command('initial_pages', initials=self.initials())
        event = self.case.documents.get_blob(self.case.session['snapshot']['audit_head'])
        for row in event['after']['graphics']['records']:
            row['initial_pages']['group_id'] = group
        snapshot = deepcopy(event['after']); snapshot['audit_head'] = self.case.documents.put_blob(event)
        with self.assertRaisesRegex(ValidationError, 'cannot be reused'):
            self.case.documents.validate_audit(snapshot)
        # Reusing even the same deleted IDs/slots is a second forbidden birth.
        for index, row in enumerate(event['after']['graphics']['records']):
            row['id'] = original['graphics']['records'][index]['id']
        from estimator.takeoff_model import audit_affected
        event['affected_ids'] = audit_affected(event['before'], event['after'])
        snapshot = deepcopy(event['after']); snapshot['audit_head'] = self.case.documents.put_blob(event)
        with self.assertRaisesRegex(ValidationError, 'exactly one retained creation event'):
            self.case.documents.validate_audit(snapshot)
        # An invented Undo with a fresh group and fresh IDs has no birth anywhere.
        event = self.case.documents.get_blob(original['audit_head']); event['op'] = 'undo'
        snapshot = deepcopy(event['after']); snapshot['audit_head'] = self.case.documents.put_blob(event)
        with self.assertRaisesRegex(ValidationError, 'complete retained Initial Pages creation event'):
            self.case.documents.validate_audit(snapshot)

    def test_legacy_exact_birth_surviving_ids_link_without_migration_and_undo_restores_old_divergence(self):
        self.batch(legacy=True); original = deepcopy(self.case.session['snapshot'])
        # This legal old history edited one row before linked settings existed.
        with patch('estimator.takeoff_initial_links.linked_members', side_effect=lambda snapshot, row, *args: [row]):
            self.command('update_graphic', graphic_id=self.rows()[0]['id'], changes={'text': 'OLD'})
        self.case.documents.validate_audit(self.case.session['snapshot'])
        selected = self.rows()[0]['id']; copied = {key: deepcopy(value) for key, value in self.rows()[0].items() if key not in ('id', 'version')}
        copy_id = self.command('create_graphic', graphic=copied)['created_graphic_id']
        removed = self.rows()[1]['id']; self.command('delete_graphic', graphic_id=removed)
        before = deepcopy(self.case.session['snapshot'])
        self.command('update_graphic', graphic_id=selected, changes={'text': 'LINKED', 'appearance': {'font_color': '#112233'}})
        rows = self.rows(); born_ids = {row['id'] for row in original['graphics']['records']} - {removed}
        self.assertEqual({row['text'] for row in rows if row['id'] in born_ids}, {'LINKED'})
        self.assertEqual(next(row['text'] for row in rows if row['id'] == copy_id), 'OLD')
        self.assertTrue(all('initial_pages' not in row for row in rows))
        self.assertEqual(self.rows('signatures'), before['signatures']['records'])
        self.command('undo')
        for a, b in zip(before['graphics']['records'], self.rows()):
            self.assertEqual({key: value for key, value in a.items() if key != 'version'}, {key: value for key, value in b.items() if key != 'version'})
        self.case.documents.validate_audit(self.case.session['snapshot'])

    def test_legacy_reopen_signature_redraw_role_fanout_and_cache_rechecks_bytes(self):
        self.batch(legacy=True); case = self.case
        state = deepcopy(case.session['snapshot']); case.request.update(takeoffs=state)
        case.library.save_as(case.request); case.dialogs.opened = str(case.target)
        reopened = case.library.open_file(); self.assertEqual(reopened['takeoffs_issues'], [])
        case.session = case.service.get(reopened['takeoffs_session_id'])
        birth = case.documents.initial_pages_origin(state['audit_head'])
        self.assertIsInstance(birth, OriginSummary)
        with patch.object(case.documents, 'get_blob', side_effect=AssertionError('Cached history must not parse JSON again')):
            members = linked_members(case.session['snapshot'], self.rows('signatures')[0], 'signatures', case.documents.initial_pages_origin)
        self.assertEqual({row['id'] for row in members}, {row['id'] for row in self.rows('signatures')})
        self.command('update_signature', signature_id=self.rows('signatures')[0]['id'], changes={'strokes': [[[0, 1], [1, 0]]], 'appearance': {'stroke_color': '#112233'}})
        self.assertEqual(self.rows(), state['graphics']['records'])
        self.assertTrue(all(row['strokes'] == [[[0, 1], [1, 0]]] and row['appearance']['stroke_color'] == '#112233' for row in self.rows('signatures')))
        self.assertTrue(all('initial_pages' not in row for row in self.rows()+self.rows('signatures')))
        path = case.documents.root / 'audit' / (state['audit_head']+'.json')
        original = path.read_bytes()
        try:
            path.write_bytes(original+b' ')
            with self.assertRaises(ValidationError):
                case.documents.initial_pages_origin(state['audit_head'])
        finally:
            path.write_bytes(original)
        case.documents.validate_audit(case.session['snapshot'])

    def test_existing_repository_adapter_without_optional_cache_uses_verified_raw_origin(self):
        self.batch(legacy=True); case = self.case; original = deepcopy(case.session['snapshot'])
        class ExistingAdapter:
            def __getattr__(self, name):
                if name == 'initial_pages_origin':
                    raise AttributeError(name)
                return getattr(case.documents, name)
        case.service.documents = ExistingAdapter()
        self.command('update_graphic', graphic_id=self.rows()[0]['id'], changes={'text': 'RAW'})
        self.assertEqual({row['text'] for row in self.rows()}, {'RAW'})
        self.command('update_signature', signature_id=self.rows('signatures')[0]['id'], changes={'strokes': [[[0, 1], [1, 0]]]})
        self.assertTrue(all(row['strokes'] == [[[0, 1], [1, 0]]] for row in self.rows('signatures')))
        self.assertTrue(all('initial_pages' not in row for row in self.rows()+self.rows('signatures')))
        self.assert_authorities_same(original, case.session['snapshot'])
        case.documents.validate_audit(case.session['snapshot'])

    def test_legacy_origin_missing_broken_join_or_budget_never_infers_copy_or_siblings(self):
        self.batch(legacy=True); snapshot = deepcopy(self.case.session['snapshot']); row = snapshot['graphics']['records'][0]
        self.assertEqual(linked_members(snapshot, row, 'graphics'), [row])
        birth = self.case.documents.get_blob(snapshot['audit_head'])
        invalid = deepcopy(birth); invalid['after']['graphics']['records'][0]['text'] = 'FORGED'
        with self.assertRaisesRegex(ValidationError, 'complete joined history'):
            linked_members(snapshot, row, 'graphics', lambda _: invalid)
        with patch('estimator.takeoff_documents.MAX_AUDIT_BYTES', 1), self.assertRaisesRegex(ValidationError, 'read budget'):
            linked_members(snapshot, row, 'graphics', self.case.documents.get_blob)
        with patch('estimator.takeoff_documents.MAX_AUDIT_EVENTS', 0), self.assertRaisesRegex(ValidationError, 'review limit'):
            linked_members(snapshot, row, 'graphics', self.case.documents.get_blob)
        cyclic = deepcopy(birth); cyclic['op'] = 'undo'; cyclic['previous'] = snapshot['audit_head']
        with self.assertRaisesRegex(ValidationError, 'cyclic'):
            linked_members(snapshot, row, 'graphics', lambda _: cyclic)
        invalid_birth = deepcopy(birth); invalid_birth['after']['graphics']['records'].pop()
        broken = {**invalid_birth['after'], 'audit_head': snapshot['audit_head']}
        with self.assertRaisesRegex(ValidationError, 'every exact source page'):
            linked_members(broken, broken['graphics']['records'][0], 'graphics', lambda _: invalid_birth)
        invalid_birth = deepcopy(birth)
        for member in invalid_birth['after']['graphics']['records']:
            member['source_sha256'] = '0'*64
        broken = {**invalid_birth['after'], 'audit_head': snapshot['audit_head']}
        with self.assertRaisesRegex(ValidationError, 'exact retained source PDF'):
            linked_members(broken, broken['graphics']['records'][0], 'graphics', lambda _: invalid_birth)
        forged = deepcopy(birth); forged['op'] = 'create_graphic'
        self.assertEqual(linked_members(snapshot, row, 'graphics', lambda _: forged), [row])


if __name__ == '__main__':
    unittest.main()
