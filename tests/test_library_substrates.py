"""Synthetic source-bound substrate facets, independent of calculator rules."""

from copy import deepcopy
import unittest
from unittest.mock import patch

from estimator.library_substrates import classify_substrates, classification_evidence


def record(*fields, identifier='synthetic'):
    return {'id': identifier, 'fields': [{'label': label, 'value': value} for label, value in fields]}


def classify(item):
    before = deepcopy(item)
    result = classify_substrates(item, item)
    assert item == before
    return set(result)


class LibrarySubstrateTests(unittest.TestCase):
    def test_named_materials_and_orientation_are_canonical_and_deduplicated(self):
        for value, expected in [
            ('Concrete, Masonry or AAC wall', {'Concrete/masonry wall', 'Hebel wall'}),
            ('Concrete soffit/slab', {'Concrete/masonry floor'}),
            ('FR Plasterboard ceiling', {'Plasterboard ceiling'}),
            ('Dincel 200mm Wall', {'Dincel wall'}),
            ('AFS Rediwall wall', {'AFS wall'}),
            ('Bondek floor', {'Bondek floor'}),
            ('Speedpanel Wall', {'Speedpanel wall'}),
            ('Kingspan K-Roc wall panels', {'Insulated panel wall'}),
            ('Autoclaved aerated concrete wall', {'Hebel wall'}),
            ('Lightweight wall', {'Lightweight wall'}),
        ]:
            with self.subTest(value=value):
                self.assertEqual(classify(record(('Barrier Construction', value))), expected)

    def test_specialty_barriers_and_lining_materials_are_not_generic_substitutions(self):
        cases = [
            ('CLT floor/ceiling lined with fire rated plasterboard on the underside.', {'CLT floor'}),
            ('CLT wall lined with plasterboard on both sides.', {'CLT wall'}),
            ('Wall system consists of AlphaPanel + 13mm plasterboard.', {'AlphaPanel wall'}),
            ('FIREFLYBatt Protected Structural Concrete Wall System.', {'Concrete/masonry wall'}),
            ('Corex ceiling', {'COREX ceiling'}),
            ('Korok wall', {'KOROK wall'}),
        ]
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(classify(record(('Barrier Construction', value))), expected)

    def test_local_construction_clauses_do_not_cross_pair_materials_and_orientations(self):
        item = record(('Barrier Construction', 'Concrete or AAC floor, or Fire Rated Plasterboard ceiling.'))
        self.assertEqual(classify(item), {'Concrete/masonry floor', 'Hebel floor', 'Plasterboard ceiling'})
        item['fields'][0]['value'] = 'Concrete Combined Wall/Floor'
        self.assertEqual(classify(item), {'Concrete/masonry wall', 'Concrete/masonry floor'})
        item['fields'][0]['value'] = 'Concrete floors and plasterboard walls'
        self.assertEqual(classify(item), {'Concrete/masonry floor', 'Plasterboard wall'})

    def test_excluded_substrates_are_not_offered_as_supported_alternatives(self):
        item = record(('Barrier Construction', 'Concrete walls; not approved for CLT floors. Plasterboard wall or Hebel wall.'))
        self.assertEqual(classify(item), {'Concrete/masonry wall', 'Plasterboard wall', 'Hebel wall'})

    def test_nonpenetrated_support_and_service_or_installation_text_are_not_barriers(self):
        item = record(('Barrier Construction', 'Concrete floor. Secondary Support Construction (Vertical, non- penetrated): Plasterboard wall.'),
                      ('Service', 'Copper pipe with concrete insulation through wall'),
                      ('Installation Details', 'Screw into Hebel or Speedpanel wall.'))
        self.assertEqual(classify(item), {'Concrete/masonry floor'})

    def test_approved_table_rows_expand_all_substrates_but_fixing_only_rows_do_not(self):
        item = record(('Barrier Construction', 'CLT wall'))
        item['fields'][0]['tables'] = [
            {'columns': ['Approved Walls', 'FRL'], 'rows': [['Concrete/Masonry Walls', '-/120/120'], ['AFS Rediwall', '-/120/120'], ['Speedpanel 78mm', '-/120/120']]},
            {'columns': ['Substrate to Substrate', 'Fixings & Centres'], 'rows': [['Board to Hebel wall', 'Screws'], ['Board to Plasterboard', 'Screws']]},
            {'columns': ['Approved Walls', 'FRL'], 'rows': [['Plasterboard', 'Not approved'], ['Hebel', 'N/A']]},
        ]
        before = deepcopy(item)
        self.assertEqual(classify(item), {'CLT wall', 'Concrete/masonry wall', 'AFS wall', 'Speedpanel wall'})
        self.assertEqual(item, before)

    def test_selector_pairs_each_selected_substrate_with_its_own_type(self):
        item = record(identifier='trafalgar-example')
        item['selector_provenance'] = {'capture_sha256': 'a' * 64, 'category': 'example', 'record': {'record_id': 'R1', 'query_ids': ['Q1', 'Q2']}}
        capture = {'capture_sha256': 'a' * 64, 'queries': {'example': {
            'Q1': {'query_id': 'Q1', 'record_ids': ['R1'], 'selected_options': {'pa_fire-barrier-type': {'label': 'Walls'}, 'pa_fire-barrier': {'label': 'Hebel'}}},
            'Q2': {'query_id': 'Q2', 'record_ids': ['R1'], 'selected_options': {'pa_fire-barrier-type': {'label': 'Ceilings'}, 'pa_fire-barrier': {'label': 'COREX'}}},
        }}}
        before = deepcopy((item, capture))
        self.assertEqual(set(classify_substrates(item, item, selector_capture=capture)), {'Hebel wall', 'COREX ceiling'})
        self.assertEqual((item, capture), before)
        item['selector_provenance']['record']['query_ids'].pop()
        with self.assertRaisesRegex(ValueError, 'every matched query'):
            classify_substrates(item, item, selector_capture=capture)

    def test_penetration_explicit_construction_bullets_are_included_without_service_words(self):
        item = record(('Substrate', 'Concrete wall'), ('Item(s)', 'Plastic pipe with CLT insulation.\n- Min 100mm Concrete, Masonry or Hebel Wall\n- Speedpanel wall or Dincel Wall'), ('System', 'Fix to plasterboard ceiling.'))
        self.assertEqual(classify(item), {'Concrete/masonry wall', 'Hebel wall', 'Speedpanel wall', 'Dincel wall'})
        item['fields'][1]['value'] = 'Pipe\n- Service wrap: COREX board\n- Copper pipe insulated with plasterboard\n- Fix to Hebel wall using screws'
        self.assertEqual(classify(item), {'Concrete/masonry wall'})

    def test_changed_saved_substrate_does_not_reuse_stale_original_alternative_bullets(self):
        description = 'Pipe\n- Concrete, Masonry or Hebel wall'
        source = record(('Substrate', 'Concrete wall'), ('Item(s)', description))
        source['estimate'] = {'draft': {'rows': [{'inputs': {'P': 'Concrete wall', 'T': description}}]}}
        changed = deepcopy(source)
        changed['fields'][0]['value'] = 'Plasterboard ceiling'
        self.assertEqual(set(classify_substrates(source, changed)), {'Plasterboard ceiling'})
        changed['fields'][1]['value'] = 'Pipe\n- CLT Floor'
        self.assertEqual(set(classify_substrates(source, changed)), {'Plasterboard ceiling', 'CLT floor'})

    def test_local_corex_thickening_is_not_a_second_ceiling_substrate(self):
        item = record(('Substrate', 'Plasterboard ceiling'), ('Item(s)', 'Pipe\n- FR Plasterboard Ceiling; locally thicken with COREX board.'))
        self.assertEqual(classify(item), {'Plasterboard ceiling'})
        for suffix in [' thickenned on the underside with 2x25mm Corex board locally', ' w/local60mm Maxilite patch']:
            item['fields'][1]['value'] = 'Pipe\n-FR Plasterboard ceiling' + suffix
            self.assertEqual(classify(item), {'Plasterboard ceiling'})

    def test_bullets_without_spaces_and_canonical_substrate_aliases_keep_real_alternatives(self):
        description = 'Pipe\n-Min 200mm Concrete or Hebel Floor'
        source = record(('Substrate', 'Concrete/masonry floor'), ('Item(s)', description))
        source['estimate'] = {'draft': {'rows': [{'inputs': {'P': 'Concrete soffit/slab', 'T': description}}]}}
        self.assertEqual(classify(source), {'Concrete/masonry floor', 'Hebel floor'})

    def test_firefly_batt_uses_its_direct_barrier_and_does_not_expand_report_wide_supports(self):
        item = record(('Orientation', 'Horizontal'), ('Service', 'Pipe'), identifier='fas190235-system-synthetic')
        self.assertEqual(classify(item), set(), 'A report-like ID alone is not evidence.')
        item['sources'] = [{'document_id': 'fas190235', 'sha256': 'a61e53af7ad9d54fbec0302ddc90ee261248ac8e73d54504cef5319295722819'}]
        self.assertEqual(classify(item), {'FIREFLYBatt floor'})
        self.assertEqual(classification_evidence(item, item)[0]['source'], 'FAS190235 direct barrier')

    def test_reviewed_inherited_source_cells_require_record_fields_page_and_document_hash(self):
        from estimator.library_substrates import _fingerprint
        item = record(('Support Construction', 'See the supporting table.'), identifier='reviewed-example')
        item['sources'] = [{'document_id': 'source', 'sha256': 'a' * 64, 'page': 2}]
        facts = {'reviewed-example': ('source', _fingerprint(item['fields']), (2,), ('INEX floor',))}
        with patch.dict('estimator.library_substrates._REVIEWED_RECORDS', facts, clear=True), patch.dict('estimator.library_substrates._REVIEWED_DOCUMENTS', {'source': 'a' * 64}, clear=True):
            before = deepcopy(item)
            self.assertEqual(classify(item), {'INEX floor'})
            self.assertEqual(classify_substrates(item, item, source_documents={'source': {'sha256': 'b' * 64}}), [])
            for change in [lambda i:i['sources'][0].update(sha256='b'*64), lambda i:i['sources'][0].update(page=3), lambda i:i['fields'][0].update(value='Different table')]:
                changed = deepcopy(item)
                change(changed)
                self.assertEqual(classify(changed), set())
            self.assertEqual(item, before)

    def test_reviewed_perimeter_support_is_not_the_direct_penetrated_substrate(self):
        from estimator.library_substrates import _fingerprint
        item = record(('Separating Element', 'Any fire resistant wall'), identifier='support-heading-example')
        item['sources'] = [{'document_id': 'source', 'sha256': 'a' * 64, 'page': 2}]
        facts = {'support-heading-example': ('source', _fingerprint(item['fields']), (2,), ('FIREFLYBatt floor',))}
        with patch.dict('estimator.library_substrates._REVIEWED_RECORDS', facts, clear=True), patch.dict('estimator.library_substrates._REVIEWED_DOCUMENTS', {'source': 'a' * 64}, clear=True):
            self.assertEqual(classify(item), {'FIREFLYBatt floor'})
            projected = deepcopy(item)
            projected['fields'] = [{'label': 'Barrier Construction', 'value': '', 'table': {
                'columns': ['Max Aperture Size', 'Separating Element', 'FRL'],
                'rows': [['600 × 600 mm', 'Any fire resistant wall', '-/60/60']]}}]
            self.assertEqual(classify_substrates(item, projected), ['FIREFLYBatt floor'])

    def test_blank_seal_table_classifies_each_separating_element(self):
        item = record(('Orientation', 'Vertical'))
        item['fields'].append({'label': 'Barrier Construction', 'value': '', 'table': {
            'columns': ['Max Aperture Size', 'Separating Element', 'FRL'],
            'rows': [['600 × 600 mm', 'Plasterboard wall', '-/60/60'],
                     ['900 × 900 mm', 'Concrete/masonry wall', '-/120/120']]}})
        self.assertEqual(classify(item), {'Plasterboard wall', 'Concrete/masonry wall'})

    def test_unknown_material_does_not_become_a_known_substrate_from_orientation_alone(self):
        self.assertEqual(classify(record(('Barrier Construction', 'Unspecified proprietary panel'), ('Orientation', 'Vertical'))), set())


if __name__ == '__main__':
    unittest.main()
