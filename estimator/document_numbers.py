"""Shared document series. Allocate inside the transaction saving the owning document."""
from contextlib import closing
from pathlib import Path
import re
import sqlite3

from .catalog import ValidationError


SERIES = {'quote': ('Q', 6), 'work_order': ('WO', 2), 'purchase_order': ('PO', 2),
          'swms': ('SWMS', 2), 'certification': ('CERT', 2)}
LIMIT = 9999999999
LABEL = re.compile(r'([A-Z]{1,12})-([0-9]{2,10})\Z')


def valid_reference(label):
    return isinstance(label, str) and bool(LABEL.fullmatch(label)) and 0 < int(label.rsplit('-', 1)[1]) <= LIMIT


def validated_counters(value, kinds):
    if not isinstance(value, dict) or len(value) > len(kinds):
        raise ValidationError('Invalid saved document number counters.')
    for kind, prefixes in value.items():
        if kind not in kinds or not isinstance(prefixes, dict) or len(prefixes) > 10000:
            raise ValidationError('Invalid saved document numbering series.')
        for prefix, number in prefixes.items():
            if not isinstance(prefix,str) or not re.fullmatch(r'[A-Z]{1,12}',prefix) or type(number) is not int or not 1 <= number <= LIMIT:
                raise ValidationError('Invalid saved document series counter.')
    return value


class DocumentNumbers:
    def __init__(self, path):
        self.path = Path(path)
        with closing(sqlite3.connect(self.path, timeout=30)) as db, db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS settings(kind TEXT PRIMARY KEY,prefix TEXT NOT NULL,start INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS series(kind TEXT NOT NULL,prefix TEXT NOT NULL,high INTEGER NOT NULL,
                    PRIMARY KEY(kind,prefix));
                CREATE TABLE IF NOT EXISTS assignments(kind TEXT NOT NULL,owner TEXT NOT NULL,reference TEXT NOT NULL,
                    PRIMARY KEY(kind,owner),UNIQUE(kind,reference));
            ''')
            db.executemany('INSERT OR IGNORE INTO settings VALUES(?,?,1)', [(k, v[0]) for k, v in SERIES.items()])

    def attach(self, db):
        db.execute('ATTACH DATABASE ? AS numbook', (str(self.path),))

    @staticmethod
    def initialize_history(db):
        db.execute('CREATE TABLE IF NOT EXISTS document_number_history(project TEXT,kind TEXT,prefix TEXT,high INTEGER NOT NULL,'
                   'PRIMARY KEY(project,kind,prefix))')

    @staticmethod
    def history(db, project):
        result = {}
        for kind,prefix,number in db.execute('SELECT kind,prefix,high FROM document_number_history WHERE project=?',(project,)):
            result.setdefault(kind,{})[prefix] = number
        return result

    @staticmethod
    def remember(db, project, kind, prefix, number):
        db.execute('INSERT INTO document_number_history VALUES(?,?,?,?) ON CONFLICT(project,kind,prefix) '
                   'DO UPDATE SET high=max(high,excluded.high)', (project,kind,prefix,number))

    @classmethod
    def restore_history(cls, db, project, counters):
        for kind, prefixes in counters.items():
            for prefix, number in prefixes.items():
                cls.observe(db,kind,prefix,number)
                cls.remember(db,project,kind,prefix,number)

    def settings(self):
        with closing(sqlite3.connect(self.path, timeout=30)) as db:
            return {k: {'prefix': p, 'start_number': s, 'next_reference': f'{p}-{max(s,h+1):0{SERIES[k][1]}d}'}
                    for k,p,s,h in db.execute('SELECT s.kind,s.prefix,s.start,COALESCE(n.high,0) FROM settings s '
                        'LEFT JOIN series n ON n.kind=s.kind AND n.prefix=s.prefix')}

    def save_settings(self, values):
        if not isinstance(values, dict) or set(values) != set(SERIES):
            raise ValidationError('Include the prefix and starting number for every document type.')
        rows = []
        for k, value in values.items():
            if not isinstance(value, dict) or set(value) != {'prefix','start_number'}:
                raise ValidationError('Provide a prefix and a starting number.')
            prefix, start = value['prefix'], value['start_number']
            if not isinstance(prefix, str) or not re.fullmatch(r'[A-Za-z]{1,12}', prefix.strip()):
                raise ValidationError('Prefixes must contain 1 to 12 letters.')
            if type(start) is not int or not 1 <= start <= LIMIT:
                raise ValidationError('Starting numbers must be positive whole numbers up to 9999999999.')
            rows.append((prefix.strip().upper(), start, k))
        with closing(sqlite3.connect(self.path, timeout=30)) as db, db:
            db.executemany('UPDATE settings SET prefix=?,start=? WHERE kind=?',rows)
        return self.settings()

    @staticmethod
    def observe(db, kind, prefix, number):
        db.execute('INSERT INTO numbook.series VALUES(?,?,?) ON CONFLICT(kind,prefix) '
                   'DO UPDATE SET high=max(high,excluded.high)', (kind,prefix,number))

    @classmethod
    def assign(cls, db, kind, owner, existing='', *, reconcile=False):
        row = db.execute('SELECT reference FROM numbook.assignments WHERE kind=? AND owner=?',(kind,owner)).fetchone()
        if row:
            if existing and row[0] != existing and not reconcile:
                raise ValidationError('This document has a different recorded reference. Reopen the original project.')
            return row[0]
        if existing and reconcile and db.execute('SELECT 1 FROM numbook.assignments WHERE kind=? AND reference=?',(kind,existing)).fetchone():
            existing = ''
        if existing:
            if not valid_reference(existing):
                raise ValidationError('Invalid document reference.')
            prefix, serial = existing.rsplit('-',1)
            number = int(serial)
            label = existing
        else:
            prefix, start, high = db.execute('SELECT s.prefix,s.start,COALESCE(n.high,0) FROM numbook.settings s '
                  'LEFT JOIN numbook.series n ON n.kind=s.kind AND n.prefix=s.prefix WHERE s.kind=?',(kind,)).fetchone()
            number = max(start, high+1)
            if number > LIMIT:
                raise ValidationError('This document number sequence is exhausted. Choose another prefix.')
            label = f'{prefix}-{number:0{SERIES[kind][1]}d}'
        try:
            db.execute('INSERT INTO numbook.assignments VALUES(?,?,?)',(kind,owner,label))
        except sqlite3.IntegrityError as error:
            raise ValidationError('This reference is already assigned to another document in this organisation.') from error
        cls.observe(db, kind, prefix, number)
        if kind != 'certification':
            cls.remember(db,owner.split(':',1)[0],kind,prefix,number)
        return label


def migrate_saved_orders(projects):
    """Persist assigned references in linked files using the normal compare-and-replace operation."""
    from .commercial_documents import CommercialConflict, validate_commercial_documents
    register = projects.commercial_register()
    result = {'scan_pending': register['scan_pending'], 'updated_files': 0, 'updated_orders': 0,
              'errors': [], 'unreadable_files': register['error_count']}
    if register['scan_pending']:
        return result
    files = {}
    for card in register['documents']:
        if card['kind'] in ('work_order','purchase_order'):
            files.setdefault((card['source_file'],card['source_revision']), {})[card['id']] = card
    for (identifier, revision), cards in sorted(files.items()):
        try:
            with projects.commercial_file(identifier, revision) as (_, snapshot, __, commit):
                commercial = snapshot['commercial_documents']
                validate_commercial_documents(commercial)
                changed = 0
                for doc in commercial['documents']:
                    card = cards.get(doc['id'])
                    if not card:
                        continue
                    order = doc['fields']['order']
                    linked = card['fields']['order']['work_order_reference']
                    if doc.get('reference') != card['reference'] or order['work_order_reference'] != linked:
                        doc['reference'] = card['reference']
                        order['work_order_reference'] = linked
                        changed += 1
                if changed:
                    validate_commercial_documents(commercial)
                    commit()
                    result['updated_files'] += 1
                    result['updated_orders'] += changed
        except (ValidationError, CommercialConflict, OSError) as error:
            result['errors'].append({'file_id':identifier, 'error':str(error)})
    return result
