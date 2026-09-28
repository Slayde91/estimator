"""First-run publication verifies private seed bytes and preserves user upgrades."""
import hashlib
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from estimator.desktop_seed import initialize_data, verified_manifest
from estimator.desktop_selftest import synthetic_seed


class DesktopSeedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.seed, self.user = self.root / 'seed', self.root / 'user'
        synthetic_seed(self.seed)

    def test_first_run_publishes_valid_empty_factory_and_second_run_preserves_every_byte(self):
        result = initialize_data(self.seed, self.user)
        self.assertTrue(result['initialized'])
        database = self.user / 'estimator.sqlite3'
        with closing(sqlite3.connect(database)) as connection, connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM quotes').fetchone()[0], 0)
            connection.execute("INSERT INTO app_preferences VALUES('keep','user choice')")
        before = database.read_bytes()
        (self.user / 'reference-library' / 'user-note.txt').write_text('preserve')
        (self.seed / 'pricing.json').write_text('damaged new installer seed')
        self.assertEqual(initialize_data(self.seed, self.user), {'initialized': False})
        self.assertEqual(database.read_bytes(), before)
        self.assertEqual((self.user / 'reference-library' / 'user-note.txt').read_text(), 'preserve')

    def test_tampered_seed_never_publishes_database_or_library(self):
        (self.seed / 'pricing.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'size|integrity'):
            initialize_data(self.seed, self.user)
        self.assertFalse((self.user / 'estimator.sqlite3').exists())
        self.assertFalse((self.user / 'reference-library').exists())
        self.assertEqual(list(self.root.glob('.estimator-first-run-*')), [])

    def test_disk_exhaustion_and_interrupted_database_build_leave_user_destination_absent(self):
        with patch('estimator.desktop_seed.shutil.disk_usage', return_value=type('Usage', (), {'free': 0})()):
            with self.assertRaisesRegex(OSError, 'free space'):
                initialize_data(self.seed, self.user)
        with patch('estimator.desktop_seed.Store.save_configuration', side_effect=OSError('disk failed')):
            with self.assertRaisesRegex(OSError, 'disk failed'):
                initialize_data(self.seed, self.user)
        self.assertFalse(self.user.exists())

    def test_incomplete_publication_retry_does_not_replace_existing_library(self):
        self.user.mkdir()
        library = self.user / 'reference-library'
        library.mkdir()
        content = (self.seed / 'reference-library' / 'library.json').read_bytes()
        (library / 'library.json').write_bytes(content)
        (library / 'user-added.txt').write_text('retained')
        self.assertTrue(initialize_data(self.seed, self.user)['initialized'])
        self.assertEqual((library / 'library.json').read_bytes(), content)
        self.assertEqual((library / 'user-added.txt').read_text(), 'retained')

    def test_manifest_traversal_and_duplicate_case_are_rejected_even_with_recomputed_hash(self):
        manifest = json.loads((self.seed / 'manifest.json').read_text())
        for name in ('../pricing.json', 'reference-library/documents/../x.pdf', 'reference-library/images/C:evil.png'):
            invalid = json.loads(json.dumps(manifest))
            invalid['files'][0]['path'] = name
            identity = {key: value for key, value in invalid.items() if key != 'id'}
            invalid['id'] = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
            (self.seed / 'manifest.json').write_text(json.dumps(invalid))
            with self.assertRaises(ValueError): verified_manifest(self.seed)

    def test_linked_sqlite_sidecar_rejected_before_upgrade_return(self):
        initialize_data(self.seed, self.user)
        victim = self.root / 'other'; victim.write_text('unchanged')
        sidecar = self.user / 'estimator.sqlite3-wal'
        try:
            sidecar.symlink_to(victim)
        except OSError:
            self.skipTest('Creating test symbolic links requires Windows developer mode or permission.')
        with self.assertRaises(ValueError): initialize_data(self.seed, self.user)
        self.assertEqual(victim.read_text(), 'unchanged')


if __name__ == '__main__': unittest.main()
