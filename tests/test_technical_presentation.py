from copy import deepcopy
import tempfile
from pathlib import Path
import unittest

from estimator.library_facets import classify_facets, facet_options
from estimator.reference_library import ReferenceLibrary
from estimator.technical_presentation import present_options, technical_title
from tests.test_reference_library import sample_library


def field(label, value):
    return {'label': label, 'value': value}


class TechnicalPresentationTests(unittest.TestCase):
    def test_barrier_ratings_pair_by_identifiers_not_text_order(self):
        item = {'fields': [field('Barrier Construction', 'Source option 2: Wall B\n\nSource option 1: Wall A'),
                           field('FRL', 'Source option 1: -/180/180\n\nSource option 2: -/120/120')]}
        original = deepcopy(item['fields'])
        item['technical_basis'] = {'source_fields': original}
        present_options(item)
        barrier, rating = item['fields']
        self.assertEqual(barrier['table']['rows'], [['Wall A', '-/180/180'], ['Wall B', '-/120/120']])
        self.assertEqual(rating['value'], '-/120/120 to -/180/180')
        self.assertEqual(rating['table_links'], [{'field': 'Barrier Construction', 'table_index': 0}])
        self.assertEqual(item['technical_basis']['source_fields'], original)
        self.assertEqual(classify_facets(item)['frl'], ['-/120/120', '-/180/180'])
        again = deepcopy(item)
        present_options(again)
        self.assertEqual(again, item)

    def test_shared_options_and_conditions_remain_with_each_row(self):
        item = {'fields': [field('Barrier Construction', 'Common note\nSource option 1: Wall A\nSource options 2, 3: Wall B'),
                           field('FRL', '-/120/120'),
                           field('Installation Details', 'Source option 3: Strap\nSource options 1 and 2: Seal') ]}
        present_options(item)
        self.assertEqual(item['fields'][0]['value'], 'Common note')
        self.assertEqual(item['fields'][0]['table']['rows'],
                         [['Wall A', 'Seal', '-/120/120'], ['Wall B', 'Seal', '-/120/120'], ['Wall B', 'Strap', '-/120/120']])
        self.assertEqual(item['fields'][2]['value'], '')
        self.assertTrue(item['fields'][2]['table_links'])

    def test_qualified_ratings_stay_in_table_and_missing_cells_stay_blank(self):
        item = {'fields': [field('Barrier Construction', 'Source option 1: Wall A\nSource option 2: Wall B'),
                           field('FRL', 'Source option 1: -/120/120 (subject to wall rating)')]}
        present_options(item)
        self.assertEqual(item['fields'][1]['value'], '')
        self.assertEqual(item['fields'][0]['table']['rows'],
                         [['Wall A', '-/120/120 (subject to wall rating)'], ['Wall B', '']])

    def test_wrap_variants_share_configuration_table_without_losing_common_content(self):
        item = {'fields': [field('Service Size / Configuration', 'Common service size'),
                           field('FRL', 'Source option 1: -/240/-\nSource option 2: -/240/120'),
                           field('Service Wrap', 'Source option 1: None\nSource options 1, 2: Retained shared text')],
                'images': [{'id': 'a', 'caption': 'Source option 1: Diagram'}]}
        present_options(item)
        self.assertEqual(item['fields'][0]['value'], 'Common service size')
        self.assertEqual(item['fields'][0]['table']['rows'][0], ['-/240/-', 'None\n\nRetained shared text'])
        self.assertEqual(item['images'][0]['caption'], 'Diagram')

    def test_missing_rating_does_not_borrow_the_other_barriers_rating(self):
        item = {'fields': [field('Barrier Construction', 'Source option 1: Wall A\nSource option 2: Wall B'),
                           field('FRL', 'Source option 1: -/120/120')]}
        present_options(item)
        self.assertEqual(item['fields'][1]['value'], '')
        self.assertEqual(item['fields'][0]['table']['rows'][1], ['Wall B', ''])

    def test_new_table_appends_without_redirecting_existing_links(self):
        owner = field('Barrier Construction', 'Source option 1: Another wall')
        owner.update(table={'columns': ['Barrier', 'FRL'], 'rows': [['Original wall', '-/60/60']]},
                     table_row_ids=[['old']], table_captions=['Existing table'])
        rating = field('FRL', 'Source option 1: -/90/90')
        rating['table_links'] = [{'field': 'Barrier Construction', 'table_index': 0}]
        item = {'fields': [owner, rating]}
        present_options(item)
        self.assertEqual([v['table_index'] for v in rating['table_links']], [0, 1])
        self.assertEqual(owner['table_row_ids'], [['old'], ['option-1']])
        self.assertEqual(owner['tables'][0]['rows'], [['Another wall', '-/90/90']])

    def test_title_uses_all_observed_ratings_without_internal_promat_selector_id(self):
        item = {'id': 'promat-123456', 'fields': [field('ID', 'sys_var_123456_au'), field('Service', 'Metal pipe')],
                'filter_values': {'manufacturer': ['Promat'], 'frl': ['-/120/120', '-/30/30', '-/90/90'], 'orientation': ['Vertical']}}
        original = deepcopy(item)
        self.assertEqual(technical_title(item), 'Promat — Metal pipe — -/30/30 to -/120/120 — Vertical')
        self.assertEqual(item, original)
        item['filter_values']['frl'] = ['-/120/-']
        self.assertIn(' — -/120/- — ', technical_title(item))
        item['fields'][0]['value'] += ' (+3 variants listed below)'
        self.assertTrue(technical_title(item).startswith('Promat — '))
        self.assertEqual(item['fields'][0]['value'], 'sys_var_123456_au (+3 variants listed below)')

    def test_blank_seal_title_uses_classified_service_without_inventing_identity(self):
        item = {'id': 'sample', 'fields': [field('ID', 'V1')], 'filter_values': {
            'manufacturer': ['Firefly'], 'services': ['Blank Seal'], 'frl': ['-/60/60'], 'orientation': ['Vertical']}}
        self.assertEqual(technical_title(item), 'Firefly: V1 — Blank Seal — -/60/60 — Vertical')

    def test_selector_api_titles_and_subtitles_hide_import_metadata_without_source_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            data, _, _ = sample_library(Path(folder))
            data['libraries']['technical']['filters'].append({'key': 'manufacturer', 'label': 'Manufacturer'})
            records = data['libraries']['technical']['items']
            for key, manufacturer, identity in (('promat-1138716', 'Promat', 'sys_var_1138716_au'),
                                                  ('trafalgar-selector-1165', 'Trafalgar', '1165')):
                item = deepcopy(records[0])
                item.update(id=key, subtitle='Penetration seal · 9 selector variants · Vertical')
                item['fields'] = [field('ID', identity), field('Manufacturer', manufacturer),
                                  field('Service', 'Copper pipe 25 mm'), field('FRL', '-/120/120')]
                item['filter_values']['manufacturer'] = [manufacturer]
                records.append(item)
            original = deepcopy(data['libraries'])
            ReferenceLibrary(Path(folder))._validate(data)
            for key, manufacturer in (('promat-1138716', 'Promat'), ('trafalgar-selector-1165', 'Trafalgar')):
                projected = data['_records']['technical'][key]
                self.assertTrue(projected['title'].startswith(manufacturer + ' — Copper pipe — '))
                self.assertEqual(next(f['value'] for f in projected['fields'] if f['label'] == 'Service Size / Configuration'),
                                 'Copper pipe 25 mm')
                self.assertEqual(projected['subtitle'], 'Penetration seal · Vertical')
                self.assertTrue(any(f['label'] == 'ID' for f in projected['technical_basis']['source_fields']))
            self.assertEqual(data['libraries'], original)

    def test_title_without_technical_id_does_not_fall_back_to_internal_record_key(self):
        item = {'id': 'private-storage-key', 'fields': [field('Manufacturer', 'Example'), field('Service', 'Copper pipe')],
                'filter_values': {'frl': ['-/120/120'], 'orientation': ['Vertical']}}
        self.assertEqual(technical_title(item), 'Example — Copper pipe — -/120/120 — Vertical')

    def test_removed_dropdown_values_cannot_reappear_from_source_data(self):
        options = facet_options('frl', ['-/120/0', '-/180/80', 'N/A', 'Not specified', '-/120/-'])
        self.assertFalse({'-/120/0', '-/180/80', 'N/A', 'Not specified'} & set(options))
        self.assertIn('-/120/-', options)

    def test_live_projection_titles_links_and_filters_share_corrected_fields(self):
        with tempfile.TemporaryDirectory() as folder:
            data, _, _ = sample_library(Path(folder))
            library = data['libraries']['technical']
            library['filters'].append({'key': 'trafalgar_category', 'label': 'Trafalgar Category'})
            item = library['items'][0]
            item['filter_values']['trafalgar_category'] = ['Fire Rated Access Panels']
            item['fields'] = [field('ID', '123'), field('Manufacturer', 'Trafalgar'), field('FRL', '-/120/120')]
            original = deepcopy(data)
            result = data
            ReferenceLibrary(Path(folder))._validate(result)
            projected = result['_records']['technical'][item['id']]
            self.assertIn('Trafalgar: 123 — Access Panel — -/120/120 — ', projected['title'])
            self.assertEqual(projected['filter_values']['services'], ['Access Panel'])
            self.assertNotIn('trafalgar_category', [f['key'] for f in result['_filters']['technical']])
            self.assertIn(projected['title'].casefold(), result['_searches']['technical'][item['id']])
            self.assertEqual(result['libraries'], original['libraries'])
