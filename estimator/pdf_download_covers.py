"""Global, versioned cover sheets for a finite catalog of authored PDF exports."""
from datetime import datetime, timezone
import json

from .catalog import ValidationError
from .pdf_cover import validate_cover_pdf

KINDS = (
    ('certification', 'Certification'),
    ('estimate', 'Estimate'),
    ('full_schedule', 'Full project schedule'),
    ('full_product_summary', 'Full project product summary'),
    ('technical_library_item', 'Technical Library item'),
    ('firestopping_library_item', 'Firestopping Library item'),
    ('firestopping_schedule', 'Firestopping schedule'),
    ('steel_vermiculite_schedule', 'Steel spray schedule'),
    ('steel_vermiculite_product_summary', 'Steel spray product summary'),
    ('steel_intumescent_schedule', 'Steel intumescent schedule'),
    ('steel_intumescent_product_summary', 'Steel intumescent product summary'),
    ('steel_board_schedule', 'Steel board schedule'),
    ('steel_board_product_summary', 'Steel board product summary'),
    ('ductwork_schedule', 'Ductwork schedule'),
    ('ductwork_product_summary', 'Ductwork product summary'),
    ('takeoff_markups', 'Takeoff markups'),
    ('physical_matrix', 'Passive fire matrix'),
    ('pdf_tools', 'PDF tools'),
)
LABELS = dict(KINDS)


class PdfCoverConflict(ValidationError):
    """A different window saved this download's cover first."""


class PdfDownloadCovers:
    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('''CREATE TABLE IF NOT EXISTS pdf_download_covers (
                kind TEXT PRIMARY KEY, cover_pdf TEXT, cover_pdf_name TEXT NOT NULL,
                version INTEGER NOT NULL CHECK(version >= 1), updated_at TEXT NOT NULL,
                provenance TEXT NOT NULL
            )''')
            for kind, _ in KINDS:
                if db.execute('SELECT 1 FROM pdf_download_covers WHERE kind=?', (kind,)).fetchone():
                    continue
                cover, name, provenance = None, '', {'source': 'empty_initial_default'}
                # The old local cover is migrated once, without changing its
                # document or frozen revisions. An existing/cleared global row
                # is authoritative and can never revive a hidden local cover.
                if kind == 'certification':
                    columns = {row[1] for row in db.execute('PRAGMA table_info(certification_documents)')}
                    if {'id', 'options', 'updated_at'} <= columns:
                        for identity, raw in db.execute('SELECT id,options FROM certification_documents ORDER BY updated_at DESC,id'):
                            selected = json.loads(raw)
                            if selected.get('cover_pdf'):
                                cover, name = validate_cover_pdf(selected['cover_pdf'], selected.get('cover_pdf_name', ''))
                                provenance = {'source': 'legacy_certificate_cover', 'document_id': identity}
                                break
                db.execute('INSERT INTO pdf_download_covers VALUES(?,?,?,?,?,?)',
                           (kind, cover, name, 1, datetime.now(timezone.utc).isoformat(), json.dumps(provenance, sort_keys=True)))

    @staticmethod
    def _get(db, kind, *, metadata_only=False):
        if kind not in LABELS:
            raise ValidationError('Choose a supported PDF download cover.')
        first = '(cover_pdf IS NOT NULL)' if metadata_only else 'cover_pdf'
        row = db.execute('SELECT '+first+',cover_pdf_name,version,updated_at,provenance FROM pdf_download_covers WHERE kind=?', (kind,)).fetchone()
        if row is None:
            raise ValidationError('The saved PDF cover settings are unavailable.')
        value = {'kind': kind, 'label': LABELS[kind], 'cover_pdf_name': row[1],
                 'version': row[2], 'updated_at': row[3], 'provenance': json.loads(row[4])}
        value.update({'has_cover': bool(row[0])} if metadata_only else {'cover_pdf': row[0]})
        return value

    def get(self, kind):
        with self.store.connect() as db:
            return self._get(db, kind)

    @staticmethod
    def metadata(value):
        return {**{key: item for key, item in value.items() if key != 'cover_pdf'},
                'has_cover': value['cover_pdf'] is not None}

    def list(self):
        with self.store.connect() as db:
            db.execute('BEGIN')
            # Never transfer up to 18 PDF blobs to the browser just to display
            # names and Save/Trash controls. Internal get() owns PDF access.
            return {'items': [self._get(db, kind, metadata_only=True) for kind, _ in KINDS]}

    def save(self, kind, cover_pdf, cover_pdf_name, expected_version):
        if kind not in LABELS:
            raise ValidationError('Choose a supported PDF download cover.')
        if type(expected_version) is not int or not 1 <= expected_version <= 2_147_483_647:
            raise ValidationError('Include the current PDF cover version.')
        cover_pdf, cover_pdf_name = validate_cover_pdf(cover_pdf, cover_pdf_name)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current = self._get(db, kind)
            if current['cover_pdf'] == cover_pdf and current['cover_pdf_name'] == cover_pdf_name:
                return current
            if current['version'] != expected_version:
                raise PdfCoverConflict('This PDF cover changed in another window. Reload the saved cover before saving again.')
            db.execute('UPDATE pdf_download_covers SET cover_pdf=?,cover_pdf_name=?,version=version+1,updated_at=?,provenance=? WHERE kind=?',
                       (cover_pdf, cover_pdf_name, datetime.now(timezone.utc).isoformat(),
                        json.dumps({'source': 'settings'}, sort_keys=True), kind))
            return self._get(db, kind)
