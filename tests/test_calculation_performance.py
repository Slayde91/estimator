"""Parity and lifecycle contracts for bounded, source-independent reuse."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import math
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from estimator import excel_engine as excel
from estimator import penetration_calculator as penetration
from estimator.calculation_work import CalculationBusy, CalculationGate, EvaluationLock
from estimator.firestopping_library import FirestoppingLibrary
from estimator.storage import Store
from estimator.workbook_calculators import calculator_engine
from tests.test_firestopping_library import editable_library
from tests.test_penetration_calculator import source_example


class ScalarCacheTests(unittest.TestCase):
    def setUp(self):
        excel._cached_scalar_criteria.cache_clear()

    def test_exact_types_blanks_errors_wildcards_and_numbers_match_original(self):
        values=[None,'',0,0.,-0.,1,1.,True,False,-1,1e-20,1e100,'0','1',' 1 ','Steel','steel','STEEL','*','?','~','a\nb','Σ','ß','SS',float('nan'),float('inf'),2**200,'x'*129]
        criteria=values+['=0','<>0','>0','>=1','<1','<=1','~*','~?','~~','S*','<>Steel','>=Steel','<>','=', '=1e-20', '>1e100']
        def outcome(matcher,value,criterion):
            try:return ('result',matcher(value,criterion))
            except Exception as error:return ('error',type(error),str(error))
        for _ in range(2):
            for value in values:
                for criterion in criteria:
                    self.assertEqual(outcome(excel.criteria_matches,value,criterion),outcome(excel.steel_criteria_matches,value,criterion),(value,criterion))
        self.assertGreater(excel._cached_scalar_criteria.cache_info().hits,0)

    def test_cache_is_entry_and_key_bounded_and_bypasses_non_scalar_objects(self):
        for n in range(9000):excel.steel_criteria_matches(str(n),'=0')
        self.assertEqual(excel._cached_scalar_criteria.cache_info().currsize,8192)
        before=excel._cached_scalar_criteria.cache_info()
        for value in ('x'*129,2**100,float('nan'),float('inf')):
            excel.steel_criteria_matches(value,'=0')
        self.assertEqual(excel.steel_criteria_matches({},'>0'),excel.criteria_matches({},'>0'))
        self.assertEqual(excel._cached_scalar_criteria.cache_info(),before)

    def test_only_steel_uses_scalar_cache(self):
        for identity in ('steel_board','steel_vermiculite','ductwork'):
            engine=calculator_engine(identity,{})
            self.assertIs(engine.criteria_matcher,excel.criteria_matches if identity=='ductwork' else excel.steel_criteria_matches)


class AdmissionTests(unittest.TestCase):
    def wait_pending(self,gate,count):
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            with gate.condition:
                if len(gate.pending)==count:return
            time.sleep(.001)
        self.fail('Worker did not reach the admission queue')

    def test_fifo_exact_snapshots_reentrancy_capacity_and_exception_recovery(self):
        gate=CalculationGate(max_pending=2);order=[]
        def worker(value):
            with gate:
                with gate:order.append(value)
                return value
        with ThreadPoolExecutor(max_workers=3) as pool:
            with gate:
                first=pool.submit(worker,'export snapshot');self.wait_pending(gate,1)
                second=pool.submit(worker,'latest edit');self.wait_pending(gate,2)
                rejected=pool.submit(worker,'over capacity')
                with self.assertRaises(CalculationBusy):rejected.result(timeout=3)
            self.assertEqual(first.result(timeout=3),'export snapshot')
            self.assertEqual(second.result(timeout=3),'latest edit')
        self.assertEqual(order,['export snapshot','latest edit'])
        with self.assertRaisesRegex(RuntimeError,'fixture'):
            with gate:raise RuntimeError('fixture')
        with gate:self.assertEqual(gate.depth,1)
        self.assertIsNone(gate.owner);self.assertFalse(gate.pending)

    def test_evaluator_locks_preserve_nested_same_thread_use(self):
        first,second=EvaluationLock(),EvaluationLock()
        with first:
            with first:
                with second:pass
        with first:pass


class FirestoppingReuseTests(unittest.TestCase):
    def test_inventory_is_built_once_and_custom_services_only_change_definition(self):
        draft=source_example();before=deepcopy(draft)
        with patch.object(penetration,'inventory_lists',wraps=penetration.inventory_lists) as inventory, patch.object(penetration,'resolve_labour',wraps=penetration.resolve_labour) as labour:
            original=penetration.calculate(draft)
            self.assertEqual(inventory.call_count,1)
            # Normalization resolves defaults; evaluation reuses its own exact
            # normalized labour record when constructing the response.
            self.assertEqual(labour.call_count,2*len(draft['rows']))
        custom=penetration.calculate(draft,service_types=['Fixture service'])
        self.assertEqual(custom.pop('definition'),penetration.definition(service_types=['Fixture service']))
        original.pop('definition');self.assertEqual(custom,original);self.assertEqual(draft,before)

    def test_invalid_draft_precedes_inventory_work(self):
        with patch.object(penetration,'inventory_lists',side_effect=AssertionError('inventory must not be reached')):
            with self.assertRaises(penetration.ValidationError):penetration.calculate({'rows':'invalid'})


class LibraryAdmissionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        editable_library(root / 'library')
        self.store = Store(root / 'test.sqlite3')
        self.library = FirestoppingLibrary(root / 'library', self.store)
        self.opened = self.library.edit('pkb-001')

    def body(self):
        return {key: deepcopy(self.opened[key]) for key in ('draft', 'revision', 'pricing_token')}

    def create_body(self):
        body = {'idempotency_key': 'admission-fixture-0001', 'configuration': {},
                'draft': deepcopy(self.opened['draft'])}
        body['draft']['rows'][0]['inputs'].update(
            J='Mechanical', L='Core Hole', M='Vertical', N='-/120/120',
            P='Concrete/masonry wall', O=1)
        return body

    def dump(self):
        with self.store.connect() as database:
            return list(database.iterdump())

    def test_saturated_mutations_leave_all_persisted_state_unchanged(self):
        with patch('estimator.calculation_work.evaluation_gate') as gate:
            gate.__enter__.side_effect = CalculationBusy('fixture capacity')
            for action in ('save', 'refresh-pricing', 'create'):
                with self.subTest(action=action):
                    before = self.dump()
                    with self.assertRaises(CalculationBusy):
                        if action == 'create':
                            self.library.create(self.create_body())
                        else:
                            self.library.action('pkb-001', action, self.body())
                    self.assertEqual(self.dump(), before)

    def test_mutations_keep_admission_until_persisted_response_is_complete(self):
        class OneAdmissionGate(CalculationGate):
            """Model other requests filling capacity after the first admission."""
            admissions = 0

            def __enter__(self):
                if self.owner is None:
                    if self.admissions:
                        raise CalculationBusy('fixture capacity filled after first calculation')
                    self.admissions += 1
                return super().__enter__()

        for action in ('save', 'refresh-pricing', 'create'):
            with self.subTest(action=action):
                self.opened = self.library.edit('pkb-001')
                gate = OneAdmissionGate()
                with patch('estimator.calculation_work.evaluation_gate', gate):
                    if action == 'create':
                        response = self.library.create(self.create_body())
                        self.assertTrue(response['created'])
                    else:
                        response = self.library.action('pkb-001', action, self.body())
                self.assertEqual(gate.admissions, 1)
                self.assertIsNone(gate.owner)
                self.assertEqual(gate.depth, 0)
                reopened = self.library.edit(response['id'])
                if action != 'refresh-pricing':
                    self.assertEqual(reopened['revision'], response['revision'])
                    self.assertEqual(reopened['result'], response['result'])
                else:
                    self.assertEqual(self.library.edits.snapshot(response['pricing_token'])['basis'], 'shared')

    def test_delete_does_not_require_calculation_admission(self):
        with patch('estimator.calculation_work.evaluation_gate') as gate:
            gate.__enter__.side_effect = CalculationBusy('fixture capacity')
            self.assertTrue(self.library.action('pkb-001', 'delete', {})['deleted'])
            gate.__enter__.assert_not_called()
