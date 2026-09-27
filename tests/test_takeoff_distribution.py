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
                         'scripts/install_reference_library.py', 'docs/TAKEOFFS.md',
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
                self.assertFalse(any('.ceasefire-evidence' in name for name in names))


if __name__ == '__main__':
    unittest.main()
