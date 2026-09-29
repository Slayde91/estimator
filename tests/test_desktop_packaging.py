"""Private content stays outside code; factory packaging preserves scoped state."""
from copy import deepcopy
from contextlib import redirect_stderr
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from prepare_desktop_seed import prepare
from build_windows import (verify_seed, verify_packaged_content, runtime_provenance,
    verify_runtime_fingerprints, check_output, DATA_FILES, STATIC_FILES,
    stage_calculator_evidence, verify_calculator_evidence, verify_packaged_calculator_evidence)
from estimator.catalog import ValidationError
from estimator.desktop_seed_content import (encoded, export_library_edits, validate_library_edits,
    insert_library_edits, TABLE_COLUMNS)
from estimator.firestopping_library import FirestoppingLibrary
from estimator.reference_library import ReferenceLibrary
from estimator.storage import Store
from test_firestopping_library import editable_library


class CalculatorEvidencePackagingTests(unittest.TestCase):
    """Exercise packaging with a stub authority; private assessment rows stay local."""
    def setUp(self):
        from estimator.monokote_hollow import DATASET_FILENAME
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'private-evidence'
        self.source.mkdir()
        self.filename = DATASET_FILENAME
        self.payload = b'{"synthetic_packaging_fixture":true}'
        (self.source / self.filename).write_bytes(self.payload)
        self.stage = self.root / 'staged'

    @staticmethod
    def synthetic_authority(payload):
        # Deliberately accepts any bytes so fingerprint tests independently prove
        # that a later accepted revision cannot replace the recorded build input.
        return SimpleNamespace(digest=hashlib.sha256(payload).hexdigest(), report_sha256='0' * 64)

    def test_stages_only_expected_file_and_records_exact_identity(self):
        from estimator.monokote_hollow import DATASET_ID
        (self.source / 'source-report.pdf').write_bytes(b'private neighboring report')
        (self.source / 'unrelated.json').write_text('{}')
        with patch('estimator.monokote_hollow.validate_assessment_payload', side_effect=self.synthetic_authority):
            receipt = stage_calculator_evidence(self.source, self.stage, required=True)
            self.assertEqual(receipt, {'id':DATASET_ID, 'filename':self.filename,
                'sha256':hashlib.sha256(self.payload).hexdigest(), 'bytes':len(self.payload),
                'report_sha256':'0' * 64})
            self.assertEqual([path.name for path in self.stage.iterdir()], [self.filename])
            self.assertEqual((self.stage / self.filename).read_bytes(), self.payload)
            self.assertEqual(verify_calculator_evidence(self.source, receipt, private_input=True), receipt)
            # Existing staged output must never be overwritten.
            with self.assertRaises(FileExistsError):
                stage_calculator_evidence(self.source, self.stage)

    def test_synthetic_omission_is_explicit_but_deliverable_requires_evidence(self):
        self.assertIsNone(stage_calculator_evidence(None, self.stage))
        self.assertFalse(self.stage.exists())
        with self.assertRaisesRegex(ValueError, '--calculator-evidence'):
            stage_calculator_evidence(None, self.stage, required=True)
        bundle = self.root / 'bundle'
        self.assertIsNone(verify_packaged_calculator_evidence(bundle, None))
        (bundle / '_internal/calculator-evidence').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'Unexpected calculator evidence'):
            verify_packaged_calculator_evidence(bundle, None)

    def test_full_installer_rejects_missing_explicit_evidence_before_build(self):
        import build_windows
        args = ['build_windows.py', '--output', str(self.root / 'out'), '--seed', str(self.source),
            '--iscc', 'compiler.exe', '--webview2-installer', 'runtime-x64.exe',
            '--webview2-arm64-installer', 'runtime-arm64.exe']
        error = io.StringIO()
        with patch('build_windows.os', SimpleNamespace(name='nt')), patch.object(sys, 'argv', args), \
                patch('build_windows.runtime_provenance') as runtimes, redirect_stderr(error):
            with self.assertRaises(SystemExit):
                build_windows.main()
            runtimes.assert_not_called()
        self.assertIn('--calculator-evidence', error.getvalue())

    def test_unreviewed_evidence_is_rejected_by_real_runtime_validator(self):
        with self.assertRaisesRegex(ValueError, 'reviewed digest'):
            stage_calculator_evidence(self.source, self.stage)
        self.assertFalse(self.stage.exists())

    def test_input_and_stage_must_remain_outside_source_checkout(self):
        with patch('build_windows.ROOT', self.source):
            with self.assertRaisesRegex(ValueError, 'outside the repository'):
                stage_calculator_evidence(self.source, self.stage)
        with patch('build_windows.ROOT', self.stage), \
                patch('estimator.monokote_hollow.validate_assessment_payload', side_effect=self.synthetic_authority):
            with self.assertRaisesRegex(ValueError, 'outside the repository'):
                stage_calculator_evidence(self.source, self.stage)
        self.assertFalse(self.stage.exists())

    def test_missing_and_nonregular_evidence_are_rejected(self):
        (self.source / self.filename).unlink()
        with self.assertRaises(FileNotFoundError):
            stage_calculator_evidence(self.source, self.stage)
        (self.source / self.filename).mkdir()
        with self.assertRaisesRegex(ValueError, 'nonregular file'):
            stage_calculator_evidence(self.source, self.stage)

    def test_evidence_read_is_bounded_before_validation(self):
        from estimator.monokote_hollow import MAX_DATASET_BYTES
        (self.source / self.filename).write_bytes(b'x' * (MAX_DATASET_BYTES + 4096))
        with patch('estimator.monokote_hollow.validate_assessment_payload', side_effect=ValueError('bounded size')) as validate:
            with self.assertRaisesRegex(ValueError, 'bounded size'):
                stage_calculator_evidence(self.source, self.stage)
        self.assertEqual(len(validate.call_args.args[0]), MAX_DATASET_BYTES + 1)
        self.assertFalse(self.stage.exists())

    def test_source_stage_and_frozen_mutations_fail_against_recorded_snapshot(self):
        with patch('estimator.monokote_hollow.validate_assessment_payload', side_effect=self.synthetic_authority):
            receipt = stage_calculator_evidence(self.source, self.stage)
            bundle = self.root / 'bundle'
            frozen = bundle / '_internal/calculator-evidence'
            shutil.copytree(self.stage, frozen)
            self.assertEqual(verify_packaged_calculator_evidence(bundle, receipt), receipt)
            for directory in (self.source, self.stage, frozen):
                file = directory / self.filename
                file.write_bytes(self.payload.replace(b'true', b'null'))
                with self.assertRaisesRegex(ValueError, 'changed during the build'):
                    verify_calculator_evidence(directory, receipt)
                file.write_bytes(self.payload)
            extra = frozen / 'unreviewed.json'
            extra.write_text('{}')
            with self.assertRaisesRegex(ValueError, 'unexpected files'):
                verify_packaged_calculator_evidence(bundle, receipt)
            extra.unlink()
            (frozen / self.filename).unlink()
            with self.assertRaisesRegex(ValueError, 'missing or unexpected files'):
                verify_packaged_calculator_evidence(bundle, receipt)


class DesktopPackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library_dir = self.root / 'library'
        editable_library(self.library_dir)
        self.store = Store(self.root / 'source.sqlite3')
        self.library = FirestoppingLibrary(self.library_dir, self.store)

    def saved_payload(self, basis='workbook'):
        edit = self.library.edit('pkb-001')
        snapshot = {'basis':basis,'label':'Factory test pricing','source_sha256':'a'*64,
            'configuration':{'inventory':{},'rates':{}}}
        token = hashlib.sha256(encoded(snapshot).encode()).hexdigest()
        saved = {'amount':12.5,'draft':edit['draft'],'pricing_token':token}
        self.library.edits.save('pkb-001',0,'a'*64,saved,snapshot)
        with self.store.connect() as db:
            return export_library_edits(db)

    def test_preserves_saved_item_and_only_referenced_price_snapshots(self):
        value=self.saved_payload()
        self.library.edits.capture({'basis':'shared','label':'Unrelated history','source_sha256':'b'*64,
            'configuration':{'inventory':{},'rates':{}}})
        with self.store.connect() as db:
            exported=export_library_edits(db)
        self.assertEqual(exported,value)
        validate_library_edits(value,self.library_dir)
        target=Store(self.root/'target.sqlite3')
        insert_library_edits(target,value)
        copied=FirestoppingLibrary(self.library_dir,target)
        self.assertEqual(copied.edits.all(),self.library.edits.all())
        with target.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM quotes').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT count(*) FROM calculator_states').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT count(*) FROM app_preferences').fetchone()[0],0)

    def test_captured_pricing_basis_from_native_created_items_is_supported(self):
        # FirestoppingLibrary.create emits captured; it is distinct from shared/workbook.
        value=self.saved_payload('captured')
        self.assertIs(validate_library_edits(value,self.library_dir),value)

    def test_reused_source_validates_once_but_still_checks_saved_prices_and_changes(self):
        value=self.saved_payload()
        reference=ReferenceLibrary(self.library_dir)
        with patch.object(reference,'_validate',wraps=reference._validate) as validate:
            validate_library_edits(value,self.library_dir,reference)
            validate_library_edits(value,self.library_dir,reference)
            self.assertEqual(validate.call_count,1)
            damaged=deepcopy(value)
            damaged['tables']['firestopping_prices'][0]['data']='{}'
            with self.assertRaises(ValidationError):
                validate_library_edits(damaged,self.library_dir,reference)
            self.assertEqual(validate.call_count,1)
            (self.library_dir/'library.json').write_text('{"schema_version":999}')
            with self.assertRaises(ValidationError):
                validate_library_edits(value,self.library_dir,reference)
            self.assertEqual(validate.call_count,2)

    def test_reused_source_requires_exact_library_directory_and_read_only_type(self):
        value=self.saved_payload()
        other=self.root/'other-library'
        editable_library(other)
        with self.assertRaises(ValidationError):
            validate_library_edits(value,self.library_dir,ReferenceLibrary(other))
        # A FirestoppingLibrary overlays DB records and is not an immutable source.
        with self.assertRaises(ValidationError):
            validate_library_edits(value,self.library_dir,self.library)

    def test_created_item_validation_preserves_reused_source_cache(self):
        self.library.create({'idempotency_key':'desktop-seed-create-001','configuration':{},'draft':{
            'globals':{'J':'No','K':None,'L':0.125,'M':0},
            'rows':[{'id':'created-test-row','inputs':{'K':'Saved copper service','T':'65 mm copper',
                'Q':None,'O':1,'AH':2,'AI':50,'AJ':100,'AL':65,'AO':0}}]}})
        with self.store.connect() as database:
            value=export_library_edits(database)
        reference=ReferenceLibrary(self.library_dir)
        cached=reference._load()
        before=deepcopy(cached)
        with patch.object(reference,'_validate',wraps=reference._validate) as validate:
            validate_library_edits(value,self.library_dir,reference)
            self.assertEqual(validate.call_count,1)
            self.assertIs(reference._load(),cached)
            self.assertEqual(cached,before)
            damaged=deepcopy(value)
            created=json.loads(damaged['tables']['firestopping_created'][0]['data'])
            created['item']['title']=123
            damaged['tables']['firestopping_created'][0]['data']=encoded(created)
            with self.assertRaises(ValidationError):
                validate_library_edits(damaged,self.library_dir,reference)
            self.assertEqual(validate.call_count,2)
            self.assertIs(reference._load(),cached)
            self.assertEqual(cached,before)

    def test_rejects_extra_database_tables(self):
        value=self.saved_payload()
        value['tables']['quotes']=[]
        with self.assertRaises(ValidationError):validate_library_edits(value,self.library_dir)

    def test_rejects_tampered_frozen_prices(self):
        value=self.saved_payload()
        snapshot=json.loads(value['tables']['firestopping_prices'][0]['data'])
        snapshot['label']='Changed'
        value['tables']['firestopping_prices'][0]['data']=encoded(snapshot)
        with self.assertRaises(ValidationError):validate_library_edits(value,self.library_dir)

    def test_rejects_missing_price_reference_and_dangling_item(self):
        value=self.saved_payload()
        value['tables']['firestopping_prices']=[]
        with self.assertRaises(ValidationError):validate_library_edits(value,self.library_dir)
        value=self.saved_payload_from_existing()
        value['tables']['firestopping_items'][0]['id']='missing-item'
        with self.assertRaises(ValidationError):validate_library_edits(value,self.library_dir)

    def saved_payload_from_existing(self):
        with self.store.connect() as db:return export_library_edits(db)

    def test_import_refuses_existing_user_library_data(self):
        value=self.saved_payload()
        with self.assertRaises(ValidationError):insert_library_edits(self.store,value)
        self.assertEqual(self.saved_payload_from_existing(),value)

    def test_factory_export_manifest_verifies_and_contains_no_database(self):
        self.saved_payload()
        self.store.set_project_folder('C:/private/project-path')
        output=self.root/'seed'
        result=prepare(output,self.library_dir,self.store.path)
        self.assertEqual(verify_seed(output)['id'],result['id'])
        files={p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()}
        self.assertFalse(any(name.endswith(('.sqlite3','.db')) for name in files))
        text=(output/'library-edits.json').read_text()
        self.assertNotIn('project-path',text)
        self.assertNotIn('app_preferences',text)
        self.assertEqual(set(json.loads(text)['tables']),set(TABLE_COLUMNS))

    def test_extra_file_and_tampered_asset_fail_build(self):
        output=self.root/'seed'
        prepare(output)
        (output/'secret.txt').write_text('not allowed')
        with self.assertRaises(ValueError):verify_seed(output)
        (output/'secret.txt').unlink()
        (output/'pricing.json').write_text('{}')
        with self.assertRaises(ValueError):verify_seed(output)

    def test_no_private_outputs_can_be_written_inside_source(self):
        with self.assertRaises(ValueError):check_output(ROOT/'dist'/'test')
        with self.assertRaises(ValueError):prepare(ROOT/'dist'/'private-seed-test')

    def test_asset_allowlist_contains_calculators_fonts_and_flame(self):
        self.assertIn('calculators/steel_vermiculite.json.gz',DATA_FILES)
        self.assertIn('penetration.json.gz',DATA_FILES)
        self.assertIn('fonts/Montserrat-Variable.ttf',STATIC_FILES)
        self.assertIn('ceasefire-app.ico',STATIC_FILES)
        self.assertFalse(any('takeoff' in path or 'pdfjs' in path for path in (*DATA_FILES,*STATIC_FILES)))

    def test_native_runtime_inputs_require_both_distinct_verified_packages(self):
        x64=self.root/'runtime-x64.exe'
        arm64=self.root/'runtime-arm64.exe'
        x64.write_bytes(b'synthetic x64 runtime')
        arm64.write_bytes(b'synthetic ARM64 runtime')
        with self.assertRaises(ValueError):
            runtime_provenance({'x64':x64})
        with patch('build_windows.vendor_signature',return_value={'status':'Valid'}) as verify:
            proof=runtime_provenance({'x64':x64,'arm64':arm64})
            self.assertEqual(verify.call_count,2)
            self.assertNotEqual(proof['x64']['sha256'],proof['arm64']['sha256'])
            verify_runtime_fingerprints({'x64':x64,'arm64':arm64},proof)
            arm64.write_bytes(x64.read_bytes())
            with self.assertRaisesRegex(ValueError,'changed during the build'):
                verify_runtime_fingerprints({'x64':x64,'arm64':arm64},proof)
            with self.assertRaises(ValueError):
                runtime_provenance({'x64':x64,'arm64':arm64})
        with patch('build_windows.vendor_signature',side_effect=[{'status':'Valid'},ValueError('Invalid signature')]):
            with self.assertRaisesRegex(ValueError,'Invalid signature'):
                runtime_provenance({'x64':x64,'arm64':arm64})

    def test_frozen_content_requires_exact_resources_fonts_and_private_seed(self):
        import reportlab
        source=self.root/'source'
        source.mkdir()
        (source/'calculator.json').write_text('{"retained":true}')
        notices=self.root/'notices'
        notices.mkdir()
        (notices/'LICENSE.txt').write_text('Synthetic licence')
        bundle=self.root/'bundle'
        internal=bundle/'_internal'
        internal.mkdir(parents=True)
        shutil.copyfile(source/'calculator.json',internal/'calculator.json')
        shutil.copytree(notices,internal/'THIRD_PARTY_LICENSES')
        shutil.copytree(Path(reportlab.__file__).parent/'fonts',internal/'reportlab/fonts')
        prepare(internal/'factory-seed')
        seed_info=verify_seed(internal/'factory-seed')
        with patch('build_windows.ROOT',source):
            proof=verify_packaged_content(bundle,['calculator.json'],seed_info,notices)
            self.assertGreater(proof['export_fonts'],0)
            (internal/'calculator.json').write_text('{"retained":false}')
            with self.assertRaisesRegex(ValueError,'Frozen asset'):
                verify_packaged_content(bundle,['calculator.json'],seed_info,notices)
            shutil.copyfile(source/'calculator.json',internal/'calculator.json')
            (internal/'factory-seed/pricing.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'fingerprint'):
                verify_packaged_content(bundle,['calculator.json'],seed_info,notices)


if __name__=='__main__':unittest.main()
