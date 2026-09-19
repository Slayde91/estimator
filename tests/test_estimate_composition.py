"""Whole-quote Firestopping inclusion without rewriting either source model."""

from copy import deepcopy
import http.client
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from pypdf import PdfReader

from estimator.calculator import calculate as base_calculate
from estimator.catalog import ValidationError, baseline
from estimator.estimate_composition import calculate
from estimator.penetration_calculator import calculate as schedule_calculate, definition
from estimator.project_file import export_project, load_project_bytes
from estimator.project_library import ProjectLibrary
from estimator.report import render_quote_pdf, _Report
from estimator.server import create_server
from estimator.storage import Store


def schedule():
    spec = definition({})
    choices = {field['column']: field.get('options', []) for field in spec['row_fields']}
    return {'globals': {'J': 'Yes', 'K': 4, 'L': .8, 'M': .9}, 'rows': [
        {'id': 'scheduled-item', 'library_item_id': 'fixture-item', 'inputs': {
            'O': 3.125, 'W': choices['W'][0], 'X': choices['X'][0],
            'Y': choices['Y'][0], 'AA': choices['AA'][0], 'AB': choices['AB'][0],
            'AE': choices['AE'][0], 'AW': 600, 'AX': 450, 'AY': 1, 'AZ': .125,
            'AL': 40, 'AM': 300, 'AN': 1, 'AO': .1, 'AC': .5,
            'AF': .75, 'AG': .125, 'AH': .25, 'AI': 12.3456789, 'AJ': 25,
            'T': 'Synthetic combined quote service'}}]}


class EstimateCompositionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = Store(Path(self.temporary.name) / 'test.sqlite3')

    def test_combines_canonical_totals_once_preserving_cells_and_all_task_hours(self):
        inputs = {'B15': 5.123456789, 'B8': 20, 'B26': .4, 'B27': .3, 'B28': 17}
        source = base_calculate(inputs)
        base = base_calculate({**inputs, 'B26': 0, 'B27': 0})
        draft = schedule()
        before = deepcopy(draft)
        fire = schedule_calculate(draft)
        result = calculate(inputs, {}, {'draft': draft})
        self.assertEqual(result['calculation_policy'], 'combined-global-cost-adjustments-v1')
        self.assertEqual(draft, before)
        self.assertEqual(base_calculate(inputs), source)
        self.assertEqual(result['inputs'], source['inputs'])
        for cell, value in base['cells'].items():
            if cell not in {'B26', 'B27', 'F2', 'F3', 'F6', 'F7', 'F8'}:
                self.assertEqual(result['cells'][cell], value, cell)
        self.assertEqual(result['cells']['B26'], .4)
        self.assertEqual(result['cells']['B27'], .3)
        self.assertEqual(result['base_summary'], base['summary'])
        combined_material = base['summary']['material'] + fire['summary']['materials']
        combined_labour = base['summary']['labour'] + fire['summary']['labour']
        material_adjustment = result['global_adjustments']['material']
        labour_adjustment = result['global_adjustments']['labour']
        self.assertEqual((material_adjustment['percent'], material_adjustment['base'], material_adjustment['amount']),
                         (.4, combined_material, combined_material * .4))
        self.assertEqual((labour_adjustment['percent'], labour_adjustment['base'], labour_adjustment['amount']),
                         (.3, combined_labour, combined_labour * .3))
        self.assertAlmostEqual(material_adjustment['total'], combined_material * 1.4)
        self.assertAlmostEqual(labour_adjustment['total'], combined_labour * 1.3)
        self.assertAlmostEqual(result['summary']['material'], combined_material * 1.4)
        self.assertAlmostEqual(result['summary']['labour'], combined_labour * 1.3)
        self.assertEqual(result['summary']['access'], base['summary']['access'] + (fire['summary']['access'] or 0))
        self.assertEqual(result['summary']['travel'], base['summary']['travel'] + (fire['summary']['travel_lafha'] or 0))
        self.assertEqual(result['summary']['days'], base['summary']['days'] + fire['summary']['total_days'])
        expected_subtotal = sum(result['summary'][key] for key in ('labour', 'material', 'access', 'travel'))
        self.assertEqual(result['summary']['subtotal'], expected_subtotal)
        self.assertEqual(result['summary']['total'], expected_subtotal + 17)
        self.assertEqual(result['summary']['rate'], result['summary']['total'] / 20)
        self.assertEqual(result['materials'][:9], base['materials'])
        self.assertEqual(result['materials'][9:-1], fire['material_breakdown'])
        self.assertEqual(result['materials'][-1]['name'], 'Global material adjustment')
        self.assertEqual(result['materials'][-1]['total'], combined_material * .4)
        self.assertAlmostEqual(sum(task['days'] for task in result['labour']['firestopping_tasks']), fire['summary']['labour_hours'] / 8)
        self.assertEqual(result['labour']['total_days'], result['summary']['days'])
        self.assertEqual(result['labour']['task_days'], base['labour']['task_days'] + fire['summary']['labour_hours'] / 8)
        self.assertGreater(next(task['task_hours'] for task in result['labour']['firestopping_tasks'] if task['name'].endswith('Labour')), 0)
        tasks = {task['name']: task for task in result['labour']['firestopping_tasks']}
        self.assertEqual(len(tasks), 8)
        self.assertEqual(tasks['Firestopping · Additional Labour']['task_hours'], .25 * 3.125)
        self.assertEqual(tasks['Firestopping · Register allowance']['task_hours'], .25 * 3.125)
        self.assertEqual(tasks['Firestopping · Other']['task_hours'], 0)
        self.assertEqual(tasks['Firestopping · Other']['total'], 0)
        main_only = calculate(inputs)
        self.assertEqual(main_only['global_adjustments']['material']['base'], base['summary']['material'])
        self.assertEqual(main_only['global_adjustments']['labour']['base'], base['summary']['labour'])
        self.assertAlmostEqual(main_only['summary']['material'], base['summary']['material'] * 1.4)
        self.assertAlmostEqual(main_only['summary']['labour'], base['summary']['labour'] * 1.3)

    def test_empty_schedule_adds_no_template_cost_or_hours(self):
        base = base_calculate({'B8': 1})
        result = calculate({'B8': 1}, {}, {'draft': {'globals': {'J': 'Yes', 'K': 9}, 'rows': []}})
        self.assertEqual(result['summary'], base['summary'])
        self.assertEqual(result['materials'], base['materials'])
        self.assertEqual(result['firestopping']['result']['rows'], [])

    def test_saved_quotes_freeze_schedule_pricing_and_omitted_updates_preserve_it(self):
        quote = self.store.save_quote({'title': 'Combined quote', 'inputs': {'B8': 1}, 'penetration': {'draft': schedule()}})
        self.assertIn('Firestopping schedule: 1 line;', quote['work_summary'])
        self.assertIn(f"quote total ${quote['result']['summary']['total']:,.2f}", quote['work_summary'])
        self.assertIn(f"total project duration {quote['result']['summary']['days']:,.2f} days", quote['work_summary'])
        changed = baseline()
        for item in changed['inventory']:
            for key in ('sales_price', 'supplier_price'):
                if isinstance(item.get(key), (int, float)):
                    item[key] *= 7
        with patch('estimator.catalog.baseline', return_value=changed):
            reloaded = Store(self.store.path).quote(quote['id'])
            updated = self.store.save_quote({'title': 'Revised name'}, quote['id'])
        self.assertEqual(reloaded, quote)
        self.assertEqual(updated['result'], quote['result'])
        self.assertEqual(updated['penetration'], quote['penetration'])
        self.assertEqual(self.store.configuration(), {'inventory': {}, 'rates': {}})
        cleared = self.store.save_quote({'penetration': {'draft': {'rows': []}}}, quote['id'])
        self.assertEqual(cleared['penetration']['draft']['rows'], [])
        self.assertEqual(cleared['result']['summary'], base_calculate(cleared['inputs'], cleared['configuration'])['summary'])

    def test_project_roundtrip_uses_schedule_only_and_preserves_composer_and_precision(self):
        draft = schedule()
        composer = deepcopy(draft)
        composer['rows'][0]['inputs']['O'] = 999.123456789
        payload = export_project(self.store, {'estimate': {'title': 'Portable'},
            'penetration': {'draft': draft, 'composer': composer, 'library_tracking_version': 1}})
        saved = json.loads(payload)
        self.assertNotIn('penetration', saved['estimate'])
        self.assertNotIn('result', saved['estimate'])
        loaded = load_project_bytes(self.store, payload)
        self.assertEqual(loaded['penetration']['composer']['rows'][0]['inputs']['O'], 999.123456789)
        result = loaded['estimate']['result']
        self.assertEqual(result['firestopping']['draft']['rows'][0]['inputs']['O'], 3.125)
        self.assertEqual(result['firestopping']['draft']['rows'][0]['inputs']['AI'], 12.3456789)
        self.assertEqual(result['firestopping']['draft']['rows'][0]['library_item_id'], 'fixture-item')
        second = load_project_bytes(self.store, payload)
        self.assertEqual(second['estimate']['result'], result)
        self.assertEqual(self.store.list_quotes(), [])

    def test_invalid_snapshot_is_atomic_and_source_versions_are_guarded(self):
        for invalid in (None, {}, {'draft': {'rows': []}, 'composer': {}},
                        {'draft': {'rows': []}, 'result': {}},
                        {'draft': {'rows': []}, 'source_sha256': '0' * 64},
                        {'draft': {'rows': [{'id': 'x', 'inputs': {'O': 'oops'}}]}}):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                self.store.save_quote({'title': 'Invalid', 'penetration': invalid})
        self.assertEqual(self.store.list_quotes(), [])

    def historical_project(self):
        payload = export_project(self.store, {'estimate': {'inputs': {'B20': 123.123456789, 'D4': '1 Team - 1x'}},
            'penetration': {'draft': schedule(), 'composer': {'rows': [{'id': 'composer', 'inputs': {'O': 17.25}}]}}})
        snapshot = json.loads(payload)
        snapshot['estimate']['inputs']['D4'] = 'N/A'
        return snapshot

    def test_historical_missing_team_project_opens_for_correction_but_cannot_be_saved(self):
        from test_project_library import Chooser, database_rows
        snapshot = self.historical_project()
        payload = json.dumps(snapshot).encode()
        path = Path(self.temporary.name) / 'historical.json'
        path.write_bytes(payload)
        dialogs = Chooser()
        dialogs.opened = str(path)
        projects = ProjectLibrary(self.store, dialogs)
        self.addCleanup(projects.close)
        before = database_rows(self.store)
        loaded = load_project_bytes(self.store, payload)
        self.assertEqual(loaded['estimate']['inputs'], snapshot['estimate']['inputs'])
        self.assertEqual(loaded['estimate']['configuration'], snapshot['estimate']['configuration'])
        self.assertEqual(loaded['penetration'], snapshot['penetration'])
        self.assertIn('Select Teams', loaded['estimate']['result']['errors'].values())
        self.assertIn('quote total unavailable', loaded['estimate']['work_summary'])
        self.assertTrue(all(value is None for value in loaded['estimate']['result']['summary'].values()))
        self.assertEqual(loaded['estimate']['result']['materials'], [])
        opened = projects.open_file()
        self.assertEqual(opened['estimate']['inputs']['B20'], 123.123456789)
        request = {'save_token': opened['file']['save_token'], 'estimate': snapshot['estimate'],
            'calculators': {key: {'inputs': value['inputs'], 'schedule_rows': value['schedule_rows']}
                            for key, value in snapshot['calculators'].items()},
            'penetration': {key: snapshot['penetration'][key] for key in ('draft', 'composer')}}
        request['penetration']['library_tracking_version'] = 1
        with self.assertRaisesRegex(ValidationError, 'Select Teams'):
            projects.save(request)
        with self.assertRaisesRegex(ValidationError, 'Select Teams'):
            self.store.prepare_quote({**snapshot['estimate'], 'penetration': {'draft': schedule()}})
        with self.assertRaisesRegex(ValidationError, 'Select Teams'):
            calculate(snapshot['estimate']['inputs'], snapshot['estimate']['configuration'], {'draft': schedule()})
        self.assertEqual(path.read_bytes(), payload)
        self.assertEqual(database_rows(self.store), before)
        request['estimate']['inputs']['D4'] = '1 Team - 1x'
        fixed = projects.save(request)
        self.assertIsInstance(fixed['project']['estimate']['result']['summary']['total'], (int, float))
        self.assertEqual(fixed['project']['estimate']['inputs']['B20'], 123.123456789)
        self.assertEqual(fixed['project']['penetration'], snapshot['penetration'])

    def test_missing_team_load_fallback_does_not_relax_other_validation(self):
        mutations = [
            lambda data: data['estimate']['inputs'].update(B20=float('nan')),
            lambda data: data['estimate']['inputs'].update(B20=-1e13),
            lambda data: data['estimate']['inputs'].update(B20='not a number'),
            lambda data: data['estimate']['inputs'].update(F7=123),
            lambda data: data['estimate']['configuration'].update(unknown=True),
            lambda data: data['penetration']['draft']['rows'][0]['inputs'].update(O='invalid'),
            lambda data: data['penetration']['composer']['rows'][0]['inputs'].update(O=float('inf')),
        ]
        original = self.historical_project()
        for mutate in mutations:
            candidate = deepcopy(original)
            mutate(candidate)
            with self.subTest(mutate=mutate), self.assertRaises(ValidationError):
                load_project_bytes(self.store, json.dumps(candidate).encode())
        self.assertEqual(self.store.list_quotes(), [])

    def test_source_errors_remain_unavailable_and_do_not_become_healthy_zero(self):
        fire = schedule_calculate(schedule())
        fire['summary'].update(labour='#VALUE!', grand_total='#VALUE!', labour_hours='#VALUE!', total_days='#VALUE!')
        fire['errors'].append({'row_id': 'scheduled-item', 'cell': 'DK4', 'message': '#VALUE!'})
        with patch('estimator.estimate_composition.calculate_firestopping', return_value=fire):
            result = calculate({'B8': 2}, {}, {'draft': schedule()})
        self.assertIsNone(result['summary']['labour'])
        self.assertIsNone(result['summary']['total'])
        self.assertIsNone(result['summary']['rate'])
        self.assertIsNone(result['summary']['days'])
        self.assertEqual(result['labour']['firestopping_days'], '#VALUE!')
        self.assertIn('#VALUE!', result['errors'].values())

    def test_quote_pdf_uses_frozen_combined_totals_and_material_and_setup_rows(self):
        quote = self.store.prepare_quote({'title': 'Combined report', 'inputs': {'B8': 1}, 'penetration': {'draft': schedule()}})
        before = deepcopy(quote)
        with (patch('estimator.estimate_composition.calculate', side_effect=AssertionError('Report recalculated')),
              patch('estimator.catalog.baseline', side_effect=AssertionError('Report read live pricing'))):
            payload = render_quote_pdf(quote)
        text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(payload)).pages)
        compact = ''.join(text.split())
        fire_materials = [item['name'] for item in quote['result']['materials']
                          if item.get('source') == 'firestopping']
        for token in ('Material breakdown', 'Base units', 'Wastage %', '/ units',
                      'Firestopping Labour', 'Material adjustment',
                      *fire_materials, f"${quote['result']['summary']['total']:,.2f}"):
            self.assertIn(''.join(token.split()), compact)
        self.assertNotIn('Firestopping schedule materials', text)
        positions = [compact.index(''.join(item['name'].split())) for item in quote['result']['materials']]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(quote, before)
        report = _Report(quote)
        self.assertEqual(report.summary_value('total', 'F7', money=True), f"${quote['result']['summary']['total']:,.2f}")


class EstimateCompositionRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.server = create_server(0, Path(cls.temporary.name) / 'http.sqlite3')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temporary.cleanup()

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=30)
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None,
                               {'Content-Type': 'application/json'})
            response = connection.getresponse()
            payload = response.read()
            return response.status, payload
        finally:
            connection.close()

    def test_calculate_save_reopen_current_and_saved_exports_share_one_schedule(self):
        body = {'title': 'HTTP combined', 'inputs': {'B8': 2}, 'penetration': {'draft': schedule()}}
        status, payload = self.request('POST', '/api/calculate', {key: body[key] for key in ('inputs', 'penetration')})
        self.assertEqual(status, 200)
        result = json.loads(payload)
        status, payload = self.request('POST', '/api/quotes', body)
        self.assertEqual(status, 201)
        quote = json.loads(payload)
        self.assertEqual(quote['result']['summary'], result['summary'])
        status, payload = self.request('GET', '/api/quotes/' + quote['id'])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload)['result'], quote['result'])
        for route, request in [('/api/quote-report', body), ('/api/quotes/' + quote['id'] + '/report.pdf', None)]:
            status, payload = self.request('POST' if request is not None else 'GET', route, request)
            self.assertEqual(status, 200)
            text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(payload)).pages)
            compact = ''.join(text.split())
            self.assertIn(f"${result['summary']['total']:,.2f}", text)
            self.assertIn('Material breakdown', text)
            self.assertNotIn('Firestopping schedule materials', text)
            for item in result['materials']:
                self.assertIn(''.join(str(item['name']).split()), compact)
        for value in (None, {'draft': {'rows': []}, 'composer': {}}):
            self.assertEqual(self.request('POST', '/api/calculate', {'penetration': value})[0], 400)


if __name__ == '__main__':
    unittest.main()
