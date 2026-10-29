"""The standard desktop must retain its shared cover/certificate PDF dependency."""
import ast
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from build_windows import verify_bundle


class PdfCoverPackagingTests(unittest.TestCase):
    def test_certification_cold_start_never_imports_takeoffs(self):
        # A fresh interpreter prevents earlier full-edition tests from hiding a
        # forbidden dependency in sys.modules, as happened in the frozen smoke.
        source = textwrap.dedent('''
            import builtins
            from pathlib import Path
            import tempfile

            original_import = builtins.__import__
            def standard_import(name, *args, **kwargs):
                if any(part.startswith('takeoff') for part in name.split('.')):
                    raise AssertionError('Standard Certification imported ' + name)
                return original_import(name, *args, **kwargs)
            builtins.__import__ = standard_import
            from estimator.certification import CertificationService
            from estimator.certification_projects import CertificationProjects
            from estimator.storage import Store
            with tempfile.TemporaryDirectory() as directory:
                projects = CertificationProjects(CertificationService(Store(Path(directory) / 'state.sqlite3')))
                workspace = projects.new()
                assert workspace['items'] == []
                assert workspace['snapshot']['document_count'] == 0
            print('Certification cold start preserves the standard edition boundary')
        ''')
        result = subprocess.run([sys.executable, '-c', source], cwd=ROOT,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('preserves the standard edition boundary', result.stdout)

    def test_takeoff_evidence_helpers_keep_their_shared_exports(self):
        from estimator import evidence_files, takeoff_documents
        for name in ('HASH', '_digest', '_directory', '_hash_stream', '_identity',
                     '_linked', '_open_regular', '_verified'):
            self.assertIs(getattr(takeoff_documents, name), getattr(evidence_files, name), name)

    def test_standard_spec_keeps_pinned_pdf_dependency(self):
        requirements = (ROOT/'requirements-desktop.txt').read_text(encoding='utf-8').splitlines()
        self.assertIn('-r requirements.txt', requirements)
        self.assertIn('pypdf==6.10.0', (ROOT/'requirements.txt').read_text(encoding='utf-8').splitlines())
        self.assertIn('tzdata==2026.5', (ROOT/'requirements.txt').read_text(encoding='utf-8').splitlines())
        source = ast.parse((ROOT/'packaging/windows/estimator.spec').read_text(encoding='utf-8'))
        excluded = next(node.value for node in source.body if isinstance(node, ast.Assign)
                        and any(isinstance(t, ast.Name) and t.id == 'excluded' for t in node.targets))
        self.assertNotIn('pypdf', ast.literal_eval(excluded.right))
        analysis = next(node for node in ast.walk(source) if isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Name) and node.func.id == 'Analysis')
        hidden = next(item.value for item in analysis.keywords if item.arg == 'hiddenimports')
        self.assertIn('pypdf', ast.literal_eval(hidden))
        self.assertIn('tzdata', ast.literal_eval(hidden))
        self.assertIn('tzdata.zoneinfo', ast.literal_eval(hidden))
        self.assertIn('tzdata.zoneinfo.Australia', ast.literal_eval(hidden))
        data_collections = [node for node in ast.walk(source) if isinstance(node, ast.Call)
                            and isinstance(node.func, ast.Name) and node.func.id == 'collect_data_files']
        self.assertTrue(any(node.args[0].value == 'tzdata'
                            and any(keyword.arg == 'includes' and 'zoneinfo/**' in ast.literal_eval(keyword.value)
                                    for keyword in node.keywords) for node in data_collections))

    @staticmethod
    def frozen_archive(names):
        return SimpleNamespace(open_embedded_archive=lambda name: SimpleNamespace(toc={value: None for value in names}))

    def test_missing_frozen_pdf_dependency_fails_before_shipping(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory)
            reader = SimpleNamespace(CArchiveReader=lambda path: self.frozen_archive(['estimator.server']))
            with patch.dict(sys.modules, {'PyInstaller.archive.readers': reader}):
                with self.assertRaisesRegex(ValueError, 'requires pypdf'):
                    verify_bundle(bundle)

    def test_frozen_dependency_present_and_takeoff_exclusion_remains_strict(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory)
            reader = SimpleNamespace(CArchiveReader=lambda path: self.frozen_archive(['pypdf', 'pypdf._reader', 'estimator.server']))
            with patch.dict(sys.modules, {'PyInstaller.archive.readers': reader}):
                receipt = verify_bundle(bundle)
                self.assertEqual(receipt['pdf_cover_modules'], 2)
                self.assertEqual(receipt['takeoff_modules'], 0)
            reader = SimpleNamespace(CArchiveReader=lambda path: self.frozen_archive(['pypdf', 'estimator.takeoff_http']))
            with patch.dict(sys.modules, {'PyInstaller.archive.readers': reader}):
                with self.assertRaisesRegex(ValueError, 'TAKEOFFS modules'):
                    verify_bundle(bundle)


if __name__ == '__main__':
    unittest.main()
