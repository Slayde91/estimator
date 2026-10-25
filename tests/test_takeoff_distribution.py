"""Private companion evidence must never enter the public distribution."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from scripts import build


class TakeoffDistributionTests(unittest.TestCase):
    def test_companion_folders_are_excluded_even_below_packaged_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('README.md', 'requirements.txt', 'Start-Estimator.cmd', 'Start-Estimator.ps1',
                         'scripts/install_reference_library.py', 'scripts/build_language_catalog.py',
                         'scripts/install_library_replicas.py', 'docs/LIBRARY_REPLICAS.md',
                         'scripts/import_boss_matrix.py', 'docs/BOSS_MATRIX_IMPORT.md',
                         'docs/TAKEOFFS.md', 'docs/LANGUAGES.md', 'docs/PERLIFOC_ASSESSMENT.md', 'docs/NULLIFIRE_SC902.md', 'docs/FIRETEX_ASSESSMENTS.md',
                          'docs/CALCULATOR_REPORT_UPDATES.md', 'docs/MONOKOTE_DUCT_ASSESSMENT.md',
                          'scripts/import_promat_spray_assessments.py', 'requirements-import.txt',
                         'estimator/__init__.py', 'static/takeoffs.js', 'data/public.json'):
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('')
            for name in ('estimator', 'static', 'data'):
                private = root / name / '.ceasefire-evidence' / 'project-id' / 'original.pdf'
                private.parent.mkdir(parents=True); private.write_bytes(b'synthetic private evidence')
            with patch.object(build, 'ROOT', root):
                build.main()
            with zipfile.ZipFile(root / 'dist' / 'ceasefire-estimator.zip') as archive:
                names = archive.namelist()
                self.assertIn('static/takeoffs.js', names)
                self.assertIn('docs/TAKEOFFS.md', names)
                self.assertIn('docs/LANGUAGES.md', names)
                self.assertIn('docs/PERLIFOC_ASSESSMENT.md', names)
                self.assertIn('docs/NULLIFIRE_SC902.md', names)
                self.assertIn('docs/FIRETEX_ASSESSMENTS.md', names)
                self.assertIn('docs/CALCULATOR_REPORT_UPDATES.md', names)
                self.assertIn('docs/MONOKOTE_DUCT_ASSESSMENT.md', names)
                self.assertIn('scripts/import_promat_spray_assessments.py', names)
                self.assertIn('requirements-import.txt', names)
                self.assertIn('scripts/build_language_catalog.py', names)
                self.assertIn('scripts/install_library_replicas.py', names)
                self.assertIn('docs/LIBRARY_REPLICAS.md', names)
                self.assertIn('scripts/import_boss_matrix.py', names)
                self.assertIn('docs/BOSS_MATRIX_IMPORT.md', names)
                self.assertFalse(any('.ceasefire-evidence' in name for name in names))


if __name__ == '__main__':
    unittest.main()
