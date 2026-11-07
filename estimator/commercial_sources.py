"""Only native selections and the linked folder can register a commercial owner file."""
import hashlib
import os
from pathlib import Path
from uuid import UUID


def source_id(path):
    return hashlib.sha256(('commercial-file\0' + os.path.normcase(str(path))).encode('utf-8')).hexdigest()


class CommercialSources:
    def __init__(self, store, project_details):
        self.store = store
        with store.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS commercial_source_files(
                id TEXT PRIMARY KEY, path TEXT NOT NULL, project TEXT NOT NULL, title TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)''')
            db.execute('CREATE TABLE IF NOT EXISTS commercial_source_aliases(alias TEXT PRIMARY KEY, source_id TEXT NOT NULL)')
            if project_details:
                # First-save numbers were already journalled, including the native
                # destination. Reservations/cancellations never grant file access.
                with project_details.connect() as number_db:
                    saved = number_db.execute("SELECT owner,path FROM saves WHERE state='saved' AND path IS NOT NULL AND owner LIKE 'project:%'").fetchall()
                for owner, path in saved:
                    project = owner.removeprefix('project:')
                    if self.valid(path, project):
                        db.execute('INSERT OR IGNORE INTO commercial_source_files VALUES(?,?,?,?,0)',
                                   (source_id(path), path, project, Path(path).name))

    @staticmethod
    def valid(path, project):
        try:
            return bool(path and Path(path).is_absolute() and '..' not in Path(path).parts and str(UUID(project)) == project)
        except (ValueError, TypeError, AttributeError):
            return False

    def remember(self, files):
        known = [f for f in files if self.valid(f.get('path'), f.get('source_project_id'))]
        if known:
            with self.store.connect() as db:
                db.executemany('''INSERT INTO commercial_source_files VALUES(?,?,?,?,0) ON CONFLICT(id) DO UPDATE
                    SET project=excluded.project, title=excluded.title, deleted=0
                    WHERE project<>excluded.project OR title<>excluded.title OR deleted<>0''',
                    [(source_id(f['path']), f['path'], f['source_project_id'], f['title']) for f in known])
                db.executemany('INSERT OR IGNORE INTO commercial_source_aliases VALUES(?,?)',
                    [(f['id'], source_id(f['path'])) for f in known if f.get('id')])

    def delete(self, path):
        with self.store.connect() as db:
            db.execute('UPDATE commercial_source_files SET deleted=1 WHERE id=?', (source_id(path),))

    def records(self):
        with self.store.connect() as db:
            return db.execute('SELECT id,path,project,title,deleted FROM commercial_source_files ORDER BY path').fetchall()

    def resolve(self, identifier):
        with self.store.connect() as db:
            return db.execute('''SELECT path,project FROM commercial_source_files WHERE deleted=0 AND
                (id=? OR id=(SELECT source_id FROM commercial_source_aliases WHERE alias=?))''', (identifier,identifier)).fetchone()
