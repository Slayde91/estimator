"""Private content stays outside code; factory packaging preserves scoped state."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from prepare_desktop_seed import prepare
from build_windows import verify_seed, verify_packaged_content, check_output, DATA_FILES, STATIC_FILES
from estimator.catalog import ValidationError
from estimator.desktop_seed_content import (encoded, export_library_edits, validate_library_edits,
    insert_library_edits, TABLE_COLUMNS)
from estimator.firestopping_library import FirestoppingLibrary
from estimator.storage import Store
from test_firestopping_library import editable_library


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
