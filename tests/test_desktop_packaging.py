"""Private content stays outside code; factory packaging preserves scoped state."""
from copy import deepcopy
from contextlib import redirect_stderr
import ast
import hashlib
from html.parser import HTMLParser
import io
import inspect
import json
from pathlib import Path
import re
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
            receipt = stage_calculator_evidence(self.source, self.stage)
            self.assertEqual(receipt, {'id':DATASET_ID, 'filename':self.filename,
                'sha256':hashlib.sha256(self.payload).hexdigest(), 'bytes':len(self.payload),
                'report_sha256':'0' * 64})
            self.assertEqual([path.name for path in self.stage.iterdir()], [self.filename])
            self.assertEqual((self.stage / self.filename).read_bytes(), self.payload)
            self.assertEqual(verify_calculator_evidence(self.source, receipt, private_input=True), receipt)
            # Existing staged output must never be overwritten.
            with self.assertRaises(FileExistsError):
                stage_calculator_evidence(self.source, self.stage)

    def test_deliverable_requires_all_six_and_stages_only_verified_snapshots(self):
        from estimator import monokote_hollow, perlifoc_assessment, sc902_assessment, firetex_assessment, promat_spray_assessment
        def synthetic_promat(payload):
            return SimpleNamespace(digest=hashlib.sha256(payload).hexdigest(), report_sha256s=('1' * 64, '2' * 64, '3' * 64))
        with patch('estimator.monokote_hollow.validate_assessment_payload', side_effect=self.synthetic_authority), \
                patch('estimator.perlifoc_assessment.validate_assessment_payload', side_effect=self.synthetic_authority), \
                patch('estimator.sc902_assessment.validate_assessment_payload', side_effect=self.synthetic_authority), \
                patch('estimator.firetex_assessment.Authority.validate_assessment_payload', side_effect=self.synthetic_authority), \
                patch('estimator.promat_spray_assessment.validate_assessment_payload', side_effect=synthetic_promat):
            with self.assertRaisesRegex(ValueError, 'all reviewed'):
                stage_calculator_evidence(self.source, self.stage, required=True)
            self.assertFalse(self.stage.exists())
            perlifoc_payload = b'{"synthetic_perlifoc_packaging_fixture":true}'
            (self.source / perlifoc_assessment.DATASET_FILENAME).write_bytes(perlifoc_payload)
            with self.assertRaisesRegex(ValueError, 'all reviewed'):
                stage_calculator_evidence(self.source, self.stage, required=True)
            self.assertFalse(self.stage.exists())
            sc902_payload = b'{"synthetic_sc902_packaging_fixture":true}'
            (self.source / sc902_assessment.DATASET_FILENAME).write_bytes(sc902_payload)
            for authority in firetex_assessment.AUTHORITIES:
                with self.assertRaisesRegex(ValueError, 'all reviewed'):
                    stage_calculator_evidence(self.source, self.stage, required=True)
                self.assertFalse(self.stage.exists())
                (self.source / authority.DATASET_FILENAME).write_bytes(b'{"synthetic_firetex_fixture":true}')
            with self.assertRaisesRegex(ValueError, 'all reviewed'):
                stage_calculator_evidence(self.source, self.stage, required=True)
            promat_payload = b'{"synthetic_promat_fixture":true}'
            (self.source / promat_spray_assessment.DATASET_FILENAME).write_bytes(promat_payload)
            (self.source / 'private-report.pdf').write_bytes(b'not for packaging')
            receipt = stage_calculator_evidence(self.source, self.stage, required=True)
            self.assertEqual(receipt['schema_version'], 1)
            self.assertEqual([item['id'] for item in receipt['datasets']],
                             [monokote_hollow.DATASET_ID, perlifoc_assessment.DATASET_ID, sc902_assessment.DATASET_ID,
                              *(a.DATASET_ID for a in firetex_assessment.AUTHORITIES), promat_spray_assessment.DATASET_ID])
            self.assertEqual(receipt['datasets'][-1]['report_sha256s'], ['1' * 64, '2' * 64, '3' * 64])
            self.assertEqual({item.name for item in self.stage.iterdir()},
                             {self.filename, perlifoc_assessment.DATASET_FILENAME, sc902_assessment.DATASET_FILENAME,
                              *(a.DATASET_FILENAME for a in firetex_assessment.AUTHORITIES), promat_spray_assessment.DATASET_FILENAME})
            self.assertEqual(verify_calculator_evidence(self.source, receipt), receipt)
            bundle = self.root / 'multi-bundle'
            frozen = bundle / '_internal/calculator-evidence'
            shutil.copytree(self.stage, frozen)
            self.assertEqual(verify_packaged_calculator_evidence(bundle, receipt), receipt)
            for authority, payload in ((perlifoc_assessment, perlifoc_payload), (sc902_assessment, sc902_payload),
                                       *((a, b'{"synthetic_firetex_fixture":true}') for a in firetex_assessment.AUTHORITIES),
                                       (promat_spray_assessment, promat_payload)):
                for directory in (self.source, self.stage, frozen):
                    path = directory / authority.DATASET_FILENAME
                    path.write_bytes(payload + b' ')
                    with self.assertRaisesRegex(ValueError, 'changed during the build'):
                        verify_calculator_evidence(directory, receipt)
                    path.write_bytes(payload)
            (frozen / self.filename).unlink()
            with self.assertRaisesRegex(ValueError, 'missing or unexpected files'):
                verify_packaged_calculator_evidence(bundle, receipt)

    def test_an_optional_single_perlifoc_snapshot_has_a_compatible_receipt(self):
        from estimator import perlifoc_assessment
        (self.source / self.filename).unlink()
        (self.source / perlifoc_assessment.DATASET_FILENAME).write_bytes(self.payload)
        with patch('estimator.perlifoc_assessment.validate_assessment_payload', side_effect=self.synthetic_authority):
            receipt = stage_calculator_evidence(self.source, self.stage)
            self.assertEqual(receipt['id'], perlifoc_assessment.DATASET_ID)
            self.assertEqual(verify_calculator_evidence(self.stage, receipt), receipt)

    def test_optional_single_sc902_uses_its_own_authority_and_bounded_read(self):
        from estimator import sc902_assessment
        (self.source / self.filename).unlink()
        source = self.source / sc902_assessment.DATASET_FILENAME
        source.write_bytes(self.payload)
        with patch('estimator.sc902_assessment.validate_assessment_payload', side_effect=self.synthetic_authority):
            receipt = stage_calculator_evidence(self.source, self.stage)
            self.assertEqual(receipt['id'], sc902_assessment.DATASET_ID)
            self.assertEqual(verify_calculator_evidence(self.stage, receipt), receipt)
        source.write_bytes(b'x' * (sc902_assessment.MAX_DATASET_BYTES + 4096))
        with patch('estimator.sc902_assessment.validate_assessment_payload', side_effect=ValueError('bounded size')) as validate:
            with self.assertRaisesRegex(ValueError, 'bounded size'):
                verify_calculator_evidence(self.source, receipt)
        self.assertEqual(len(validate.call_args.args[0]), sc902_assessment.MAX_DATASET_BYTES + 1)

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
                'J':'Plumbing & Hydraulic','L':'Core Hole','M':'Vertical','N':'-/120/120','P':'Concrete/masonry wall',
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
        for asset in ('classifire-logo.png', 'downloads.css', 'main-layout.js'):
            self.assertIn(asset, STATIC_FILES)
        self.assertIn('icons/navigation-home.png',STATIC_FILES)
        self.assertIn('icons/navigation-help.png',STATIC_FILES)
        self.assertIn('icons/navigation-help.jpg',STATIC_FILES)
        self.assertIn('icons/document.png',STATIC_FILES)
        for asset in ('header-tagline-media.js', 'header-tagline-character.gif', 'header-tagline-character-still.png',
                      'help-glossary.js', 'help-glossary.css'):
            self.assertIn(asset, STATIC_FILES)
        self.assertFalse(any('takeoff' in path or 'pdfjs' in path for path in (*DATA_FILES,*STATIC_FILES)))

    def test_parent_control_icons_remain_full_edition_only(self):
        # The full builder discovers all static assets. The standard bundle
        # deliberately excludes every Takeoffs asset and implementation.
        from estimator.edition import TAKEOFF_ASSETS
        for name in ('takeoff-add-service.png', 'takeoff-add-barrier.png', 'takeoff-transfer.png'):
            self.assertIn('/icons/' + name, TAKEOFF_ASSETS)
            self.assertNotIn('icons/' + name, STATIC_FILES)
            self.assertTrue((ROOT / 'static/icons' / name).is_file())
        for name in ('takeoff-visual-search-icon.png', 'takeoff-ocr-icon.png'):
            self.assertIn('/' + name, TAKEOFF_ASSETS)
            self.assertNotIn(name, STATIC_FILES)
            self.assertTrue((ROOT / 'static' / name).is_file())

    def test_header_menu_audio_is_packaged_with_exact_supplied_bytes(self):
        supplied = {
            'sounds/mgs1-menu-move.mp3': (8313, 'ac2d686c78fa5dabc2415a0f3b39f4ced124f5fc1613ba3918e06daa7b47f8d0'),
            'sounds/mgs-confirm2.mp3': (32391, 'e9e7e156e24a4fde706f922ee135e88df51dc5ba94eed6344e66bbd6298e3e86'),
            # The retained logo URL serves the supplied flame_whoosh.mp3 bytes.
            'sounds/new-explosion.mp3': (161332, '42de6e27397a942bda71b98b9b564c6a4543ebe88473fac35c10e1335099a1b4'),
            'sounds/flame-whoosh.wav': (736916, '988f40b00194f865d8ca84ef30d0d3b882c08a25a8597a9ebe2aa54524ab966b'),
            'sounds/type.mp3': (149760, '0a78627d0f914dd96d222afcc27e06c8d7777a2d219cef872e8f56a16dcb1c14'),
            'sounds/hover.mp3': (5015, '052d0d7f3fb41ddb67766dedd8f4c237b46c8b18745dfad0a73a14c8afb6fad5'),
            'sounds/select.mp3': (11520, '60e089eeac138ce5301fb59dc9d649c0404a556499c8f78c15c81a7cdfde1969'),
            'sounds/select-2.mp3': (192768, '37e5c8645aa76e11dc8039545940436ea9201e533b1c946fbc9dfc3845efeb7b'),
            'sounds/mixkit-vintage-dot-printing-1371.wav': (249332, '5c39082dfe0aa5c24cae5faa0ba616bfb1354d8b7686b0b0784fa32689a9decf'),
            'sounds/checkpoint.ogg': (39539, '60acfb941abf427378e87e7ae6660ae29491f8d5efaae2681d7eb9a52af3c935'),
            'sounds/loading.mp3': (649508, '2c245208c0a4e9668b36e17d16227be81f6409398de1ece8b37be648e0ac60a8'),
        }
        self.assertEqual(STATIC_FILES.count('header-menu-sounds.js'), 1)
        for asset, (size, digest) in supplied.items():
            with self.subTest(asset=asset):
                self.assertEqual(STATIC_FILES.count(asset), 1)
                payload = (ROOT / 'static' / asset).read_bytes()
                self.assertEqual(len(payload), size)
                self.assertEqual(hashlib.sha256(payload).hexdigest(), digest)

    def test_standard_page_scripts_and_styles_are_packaged(self):
        from estimator.edition import render_index

        class Assets(HTMLParser):
            def __init__(self): super().__init__(); self.paths = set()
            def handle_starttag(self, tag, attributes):
                attributes = dict(attributes)
                path = attributes.get('src') if tag == 'script' else attributes.get('href') if tag == 'link' and attributes.get('rel') == 'stylesheet' else None
                if path and path.startswith('/'):
                    self.paths.add(path.lstrip('/'))

        page = Assets()
        page.feed(render_index((ROOT / 'static/index.html').read_bytes(), 'standard').decode('utf-8'))
        self.assertTrue(page.paths)
        self.assertEqual(page.paths - set(STATIC_FILES), set())
        for asset in page.paths:
            self.assertTrue((ROOT / 'static' / asset).is_file(), asset)

    def test_shared_cursor_urls_artwork_and_notices_are_packaged(self):
        references = set()
        stylesheets = [name for name in STATIC_FILES if name.endswith('.css')]
        self.assertTrue(stylesheets)
        for stylesheet in stylesheets:
            css = (ROOT / 'static' / stylesheet).read_text(encoding='utf-8')
            references.update(re.findall(r'url\(\s*[\'\"]?(/cursors/[^\'\"\s)]+)', css))
        # System-cursor styles may have no image URLs; all shipped URLs and
        # the existing artwork/notices must still be covered by the manifest.
        pngs = {path.relative_to(ROOT / 'static').as_posix()
                for path in (ROOT / 'static/cursors').glob('*.png')}
        notices = {'cursors/README.txt', 'cursors/LICENSE.txt', 'cursors/COPYRIGHT.txt'}
        self.assertEqual(len(pngs), 12)
        self.assertLessEqual({url.lstrip('/') for url in references}, pngs)
        packaged = [name for name in STATIC_FILES if name.startswith('cursors/')]
        self.assertCountEqual(packaged, pngs | notices)
        for name in pngs:
            self.assertEqual((ROOT / 'static' / name).read_bytes()[:8], b'\x89PNG\r\n\x1a\n')
        for name in notices:
            self.assertTrue((ROOT / 'static' / name).read_text(encoding='utf-8').strip())

    def test_frozen_cursor_bytes_and_licence_are_verified(self):
        import reportlab
        resources = ['static/' + name for name in STATIC_FILES if name.startswith('cursors/')]
        self.assertEqual(len(resources), 15)
        bundle = self.root / 'cursor-bundle'
        internal = bundle / '_internal'
        for resource in resources:
            target = internal / resource
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / resource, target)
        notices = self.root / 'cursor-notices'
        notices.mkdir()
        shutil.copytree(Path(reportlab.__file__).parent / 'fonts', internal / 'reportlab/fonts')
        prepare(internal / 'factory-seed')
        seed_info = verify_seed(internal / 'factory-seed')
        proof = verify_packaged_content(bundle, resources, seed_info, notices)
        self.assertEqual(proof['matched_assets'], 15 + proof['export_fonts'])
        cursor = internal / 'static/cursors/pointer.png'
        original = cursor.read_bytes()
        cursor.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        with self.assertRaisesRegex(ValueError, 'Frozen asset'):
            verify_packaged_content(bundle, resources, seed_info, notices)
        cursor.write_bytes(original)
        (internal / 'static/cursors/LICENSE.txt').unlink()
        with self.assertRaisesRegex(ValueError, 'Frozen asset'):
            verify_packaged_content(bundle, resources, seed_info, notices)

    def test_signature_and_default_icons_remain_full_edition_only(self):
        from estimator.edition import TAKEOFF_ASSETS
        for asset in ('takeoff-signatures.js', 'takeoff-graphics.js', 'takeoff-graphics-ui.js',
                      'takeoff-pdf-tools.js', 'takeoff-pdf-tools.css', 'icons/default-memory.svg', 'icons/signature.svg'):
            self.assertIn('/' + asset, TAKEOFF_ASSETS)
            self.assertNotIn(asset, STATIC_FILES)
            self.assertTrue((ROOT / 'static' / asset).is_file())

    def test_native_smoke_destinations_resolve_in_the_actual_header_menu(self):
        from estimator.desktop_selftest import self_test

        class Template(HTMLParser):
            def __init__(self): super().__init__(); self.stack = []; self.controls = {}; self.cards = {}; self.parents = {}
            def handle_starttag(self, tag, attributes):
                attributes = dict(attributes)
                if tag == 'div': self.stack.append(attributes.get('id'))
                if tag == 'button' and (attributes.get('id') == 'calculator-navigation-toggle' or 'calculator-navigation-menu' in self.stack):
                    identity = attributes.get('id') or attributes.get('data-calculator-id')
                    self.controls[identity] = attributes
                    self.parents[identity] = tuple(self.stack)
                if tag == 'button' and attributes.get('data-steel-calculator'):
                    self.cards[attributes['data-steel-calculator']] = attributes
            def handle_endtag(self, tag):
                if tag == 'div': self.stack.pop()

        template = Template(); template.feed((ROOT / 'static/index.html').read_text(encoding='utf-8'))
        source = ast.parse(inspect.getsource(self_test))
        journey = next(node for node in ast.walk(source) if isinstance(node, ast.For)
            and isinstance(node.target, ast.Tuple)
            and [value.id for value in node.target.elts] == ['calculator_id', 'label'])
        destinations = ast.literal_eval(journey.iter)
        self.assertEqual({identifier for identifier, _ in destinations}, {'steel_vermiculite', 'steel_board', 'ductwork', 'steel_intumescent'})
        selector = next(node.value for node in journey.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'selector' for target in node.targets))
        self.assertEqual(template.controls['calculator-navigation-toggle']['aria-controls'], 'calculator-navigation-menu')
        self.assertEqual(set(template.cards), {'steel_vermiculite', 'steel_board', 'steel_intumescent', 'steel_factors'})
        self.assertEqual(template.controls['steel-calculator-navigation-toggle']['aria-controls'], 'steel-calculator-navigation-menu')
        self.assertEqual({identifier for identifier, parents in template.parents.items()
                          if 'steel-calculator-navigation-menu' in parents},
                         {'steel_vermiculite', 'steel_board', 'steel_intumescent', 'steel_factors'})
        for identifier, _ in destinations:
            parts = []
            for part in selector.values:
                if isinstance(part, ast.Constant): parts.append(part.value)
                else:
                    self.assertIsInstance(part, ast.FormattedValue)
                    self.assertEqual(part.value.id, 'calculator_id'); parts.append(identifier)
            actual = ''.join(parts)
            self.assertEqual(actual, f'#calculator-navigation-menu button[data-calculator-id="{identifier}"]')
            self.assertEqual(template.controls[identifier]['data-calculator-id'], identifier)
            self.assertIn('calculator-navigation-menu', template.parents[identifier])
        for identifier in template.cards:
            self.assertIn('steel-calculator-navigation-menu', template.parents[identifier])
        self.assertNotIn('steel-calculator-navigation-menu', template.parents['ductwork'])

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
