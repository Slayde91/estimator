"""The standard desktop must retain its shared cover/certificate PDF dependency."""
import ast
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from build_windows import verify_bundle


class PdfCoverPackagingTests(unittest.TestCase):
    def test_standard_spec_keeps_pinned_pdf_dependency(self):
        requirements = (ROOT/'requirements-desktop.txt').read_text(encoding='utf-8').splitlines()
        self.assertIn('-r requirements.txt', requirements)
        self.assertIn('pypdf==6.10.0', (ROOT/'requirements.txt').read_text(encoding='utf-8').splitlines())
        source = ast.parse((ROOT/'packaging/windows/estimator.spec').read_text(encoding='utf-8'))
        excluded = next(node.value for node in source.body if isinstance(node, ast.Assign)
                        and any(isinstance(t, ast.Name) and t.id == 'excluded' for t in node.targets))
        self.assertNotIn('pypdf', ast.literal_eval(excluded.right))
        analysis = next(node for node in ast.walk(source) if isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Name) and node.func.id == 'Analysis')
        hidden = next(item.value for item in analysis.keywords if item.arg == 'hiddenimports')
        self.assertIn('pypdf', ast.literal_eval(hidden))

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
