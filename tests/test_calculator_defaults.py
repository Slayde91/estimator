"""Reviewed material assumptions and the application/source boundary."""

from copy import deepcopy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from estimator.calculator_defaults import default_calculator_inputs, yield_review
from estimator.schedule_rows import blank_schedule_defaults, empty_schedule_inputs
from estimator.catalog import ValidationError
from estimator.calculator_report import project_calculator_report
from estimator.server import create_server
from estimator.storage import Store
from estimator.workbook_calculators import calculator_session, calculate_page, normalize_calculator_inputs, source_model


IDENTITY = 'steel_vermiculite'
# User-selected startup assumptions; yields are calculated by the workbook.
BASES = [('D36', 'D37', 'D38', 'D40', 20, 308),
         ('D69', 'D70', 'D71', 'D73', 20, 388),
         ('D101', 'D102', 'D103', 'D105', 20, 645),
         ('D178', 'D179', 'D180', 'D182', 17, 410),
         ('D234', 'D235', 'D236', 'D238', 21.8, 344),
         ('D561', 'D562', 'D563', 'D565', 22.2, 325)]


class CalculatorDefaultsTests(unittest.TestCase):
    def test_user_selected_blank_direct_yields_and_density_fallback(self):
        inputs = default_calculator_inputs(IDENTITY)
        self.assertEqual(len(inputs['SETTINGS']), 23)
        _, engine, lock = calculator_session(IDENTITY, inputs)
        with lock:
            for mass_cell, direct_cell, density_cell, used_cell, mass, density in BASES:
                with self.subTest(yield_cell=used_cell):
                    self.assertEqual(engine.value('SETTINGS', mass_cell), mass)
                    self.assertIn(engine.value('SETTINGS', direct_cell), (None, ''))
                    self.assertAlmostEqual(engine.value('SETTINGS', used_cell), mass / density, places=14)
                    self.assertEqual(engine.value('SETTINGS', density_cell), density)

    def test_original_source_calculations_are_still_available_with_explicit_empty_inputs(self):
        _, engine, lock = calculator_session(IDENTITY, {})
        with lock:
            self.assertEqual(engine.value('SETTINGS', 'D36'), 20)
            self.assertEqual(engine.value('SETTINGS', 'D38'), 390)
            self.assertEqual(engine.value('SETTINGS', 'D40'), 20 / 390)
            self.assertEqual(engine.value('SETTINGS', 'D234'), 21.9)

    def test_direct_yield_priority_and_density_fallback_keep_workbook_rules(self):
        inputs = default_calculator_inputs(IDENTITY)
        for mass, direct, density, used, mass_value, density_value in BASES:
            fallback = deepcopy(inputs)
            fallback['SETTINGS'][direct] = None
            _, engine, lock = calculator_session(IDENTITY, fallback)
            with lock:
                self.assertAlmostEqual(engine.value('SETTINGS', used), mass_value / density_value, places=14)
            override = deepcopy(inputs)
            override['SETTINGS'].update({direct: .123456789, density: 900, mass: 10})
            _, engine, lock = calculator_session(IDENTITY, override)
            with lock:
                self.assertEqual(engine.value('SETTINGS', used), .123456789)
            override['SETTINGS'][direct] = 0
            _, engine, lock = calculator_session(IDENTITY, override)
            with lock:
                self.assertEqual(engine.value('SETTINGS', used), '', 'Explicit zero is not a blank fallback')

    def test_z106_reuses_mk6_technical_results_but_has_own_bags(self):
        base = default_calculator_inputs(IDENTITY)
        member = {'A10': 'Test member', 'C10': 'Re-entrant - 3 sides', 'D10': 620,
                  'E10': 'Section', 'F10': '410UB54', 'H10': 120, 'I10': 165, 'J10': 2}
        results = {}
        for product in ('MONOKOTE MK-6 HY', 'MONOKOTE Z106'):
            inputs = deepcopy(base)
            inputs['SCHEDULE'] = {**member, 'B10': product}
            inputs['CALCULATOR'] = {'D6': product}
            _, engine, lock = calculator_session(IDENTITY, inputs)
            with lock:
                results[product] = {
                    'technical': tuple(engine.value('ENGINE', f'{column}3')
                                       for column in ('L', 'AD', 'AE', 'AF')),
                    'quick': tuple(engine.value('ENGINE', f'{column}2')
                                   for column in ('L', 'AD', 'AE', 'AF')),
                    'quick_yield': engine.value('ENGINE', 'AH2'),
                    'volume': engine.value('SCHEDULE', 'S10'),
                    'yield': engine.value('ENGINE', 'AH3'),
                    'bags': engine.value('SCHEDULE', 'T10'),
                    'status': engine.value('SCHEDULE', 'W10'),
                    'order': engine.value('BAGS', 'G25'),
                }
        mk6, z106 = (results[product] for product in ('MONOKOTE MK-6 HY', 'MONOKOTE Z106'))
        self.assertEqual(z106['technical'], mk6['technical'])
        self.assertEqual(z106['quick'], mk6['quick'])
        self.assertEqual(z106['quick_yield'], 22.2 / 325)
        self.assertNotEqual(z106['quick_yield'], mk6['quick_yield'])
        self.assertEqual(z106['volume'], mk6['volume'])
        self.assertEqual(z106['yield'], 22.2 / 325)
        self.assertAlmostEqual(z106['bags'], z106['volume'] / z106['yield'])
        self.assertNotEqual(z106['bags'], mk6['bags'])
        self.assertEqual(z106['status'], 'QUANTIFIED - ESTIMATE')
        self.assertEqual(z106['order'], 183)

        # A saved project can change only Z106 consumption, leaving MK-6 alone.
        changed = deepcopy(base)
        changed['SETTINGS']['D563'] = 400
        changed['SCHEDULE'] = {**member, 'B10': 'MONOKOTE Z106'}
        _, engine, lock = calculator_session(IDENTITY, changed)
        with lock:
            self.assertAlmostEqual(engine.value('SCHEDULE', 'T10'), z106['volume'] / (22.2 / 400))
            self.assertEqual(engine.value('SETTINGS', 'D238'), 21.8 / 344)
        _, older_engine, lock = calculator_session(IDENTITY, {'SETTINGS': {'D236': 500}})
        with lock:
            self.assertEqual(older_engine.value('SETTINGS', 'D563'), 325)
            self.assertEqual(older_engine.value('SETTINGS', 'D565'), 22.2 / 325)
            self.assertEqual(older_engine.value('SETTINGS', 'D236'), 500)
        report = project_calculator_report(IDENTITY, {**base, 'SCHEDULE': {**member, 'B10': 'MONOKOTE Z106'}})
        self.assertEqual(report['summaries'][0]['rows'][-1]['values']['A'], 'MONOKOTE Z106')
        self.assertEqual(report['summaries'][0]['rows'][-1]['values']['G'], 183)
        last_row = {address.replace('10', '1009'): value for address, value in member.items()}
        last_row['B1009'] = 'MONOKOTE Z106'
        _, engine, lock = calculator_session(IDENTITY, {**base, 'SCHEDULE': last_row})
        with lock:
            self.assertEqual(engine.value('ENGINE', 'AG1002'), 6)
            self.assertEqual(engine.value('SCHEDULE', 'S1009'), z106['volume'])
            self.assertEqual(engine.value('SCHEDULE', 'T1009'), z106['bags'])

    def test_defaults_and_evidence_are_caller_owned(self):
        defaults = default_calculator_inputs(IDENTITY)
        defaults['SETTINGS']['D36'] = 999
        self.assertEqual(default_calculator_inputs(IDENTITY)['SETTINGS']['D36'], 20)
        review = yield_review(IDENTITY)
        self.assertEqual(len(review['products']), 6)
        self.assertTrue(all(p['sources'] and p['basis'] and p['confidence'] for p in review['products']))
        review['products'][0]['sources'].clear()
        self.assertTrue(yield_review(IDENTITY)['products'][0]['sources'])
        for identity in ('ductwork', 'steel_board'):
            self.assertEqual(default_calculator_inputs(identity), {})
            self.assertIsNone(yield_review(identity))

    def test_new_state_prefills_without_writing_and_saved_settings_remain_exact(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Store(Path(temporary) / 'defaults.sqlite3')
            self.assertEqual(store.calculator_state(IDENTITY)['inputs'], empty_schedule_inputs(IDENTITY))
            with store.connect() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM calculator_states').fetchone()[0], 0)
            for inputs in ({}, {'SETTINGS': {'D36': 24, 'D37': .05123456789}}, default_calculator_inputs(IDENTITY)):
                saved = store.save_calculator_state(IDENTITY, inputs)
                self.assertEqual(store.calculator_state(IDENTITY), saved)
                self.assertEqual(saved['inputs'], blank_schedule_defaults(IDENTITY, inputs))

    def test_historical_material_references_render_readonly_and_retain_valid_multiline_text(self):
        for address in ('D42', 'D75', 'D107', 'D184', 'D240'):
            inputs = {'SETTINGS': {address: 'Project evidence\nSecond line\r\nThird line'}}
            self.assertEqual(normalize_calculator_inputs(IDENTITY, inputs), inputs)
            row = int(address[1:])
            cells = calculate_page(IDENTITY, inputs, 'SETTINGS', row, 1)['rows'][0]['cells']
            field = next(cell for cell in cells if cell['address'] == address)
            self.assertFalse(field['editable'])
            self.assertTrue(field['read_only'] and field['output'] and field['multiline'])
            self.assertEqual(field['value'], inputs['SETTINGS'][address])
            for bad in ('null\x00', 'tab\t', 'x' * 2001):
                with self.assertRaises(ValidationError):
                    normalize_calculator_inputs(IDENTITY, {'SETTINGS': {address: bad}})
        with self.assertRaises(ValidationError):
            normalize_calculator_inputs(IDENTITY, {'SCHEDULE': {'A10': 'item\nother'}})


class CalculatorDefaultsHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.store = Store(Path(cls.temp.name) / 'defaults-http.sqlite3')
        cls.server = create_server(0, cls.store.path)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, method, endpoint='', payload=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=120)
        try:
            connection.request(method, f'/api/calculators/{IDENTITY}{endpoint}',
                               None if payload is None else json.dumps(payload), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            result = response.read()
            self.assertEqual(response.status, 200, result[:500])
            return json.loads(result)
        finally:
            connection.close()

    def test_new_definition_and_live_product_totals_follow_same_draft_engine(self):
        definition = self.request('GET')
        self.assertEqual(definition['inputs'], definition['defaults'])
        self.assertEqual(definition['yield_review']['products'][0]['bag_mass_kg'], 20)
        results = []
        for direct in (.0651, .1302, 0):
            # Exercise pooled source-example quantities explicitly. New drafts
            # now have one blank row and therefore no material quantities.
            inputs = default_calculator_inputs(IDENTITY)
            model = source_model(IDENTITY)
            schedule = model['schedule']
            sheet = next(item for item in model['sheets'] if item['name'] == schedule['sheet'])
            editable = {field['column'] for field in schedule['columns'] if field.get('editable')}
            inputs[schedule['sheet']] = {
                address: cell['value'] for address, cell in sheet['cells'].items()
                if ''.join(filter(str.isalpha, address)) in editable
                and schedule['first_row'] <= int(''.join(filter(str.isdigit, address))) <= schedule['last_row']
                and cell.get('value') not in (None, '')
            }
            inputs['SETTINGS']['D37'] = direct
            worksheet = self.request('POST', '/worksheet', {'sheet': 'SCHEDULE', 'inputs': inputs})
            totals = worksheet['product_totals']
            self.assertEqual(len(totals), 6)
            _, engine, lock = calculator_session(IDENTITY, inputs)
            with lock:
                for row, product in enumerate(totals, 20):
                    self.assertEqual(product, {'product': engine.value('BAGS', f'A{row}'),
                                              'net_bags': engine.value('BAGS', f'E{row}'),
                                              'whole_bags': engine.value('BAGS', f'G{row}'),
                                              'status': engine.value('BAGS', f'I{row}')})
            results.append(totals[0])
        self.assertAlmostEqual(results[0]['net_bags'], results[1]['net_bags'] * 2)
        self.assertEqual(results[2]['whole_bags'], 'INCOMPLETE')
        self.assertNotEqual(results[2]['status'], 'ESTIMATING QUANTITY COMPLETE')
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM calculator_states').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
