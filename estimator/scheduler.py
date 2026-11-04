"""Local Scheduler accounts, durable time records and explicit pay-rule calculation.

The HTTP adapter must enforce the application's same-origin request policy and
transport session tokens only in an HttpOnly SameSite cookie. Location submissions
always belong to the authenticated worker's current, consented clock session.
"""

from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
import hmac
import json
import math
from pathlib import Path
import secrets
import sqlite3
import uuid
from zoneinfo import ZoneInfo


UTC = timezone.utc
SYDNEY = ZoneInfo('Australia/Sydney')
DEFAULT_SETTINGS = {
    'version': 1, 'timezone': 'Australia/Sydney', 'rounding_minutes': 0,
    'rounding_mode': 'nearest',
    'breaks': [{'name': 'Lunch', 'minutes': 30, 'paid': False},
               {'name': 'Rest', 'minutes': 10, 'paid': True}],
    'pay_rules_confirmed': True, 'overlap_rule': 'highest',
    'weekly_hours': 'all', 'shift_rule': 'start_window',
}
WRITE_FIELDS = {
    'setup': {'name', 'email', 'password'},
    'login': {'email', 'password'},
    'logout': set(),
    'members/save': {'id', 'version', 'name', 'email', 'password', 'role', 'active', 'base_rate'},
    'shifts/save': {'id', 'version', 'updated_at', 'title', 'start', 'end', 'member_ids', 'project_id', 'project_name', 'location', 'notes', 'color', 'published'},
    'entries/save': {'id', 'version', 'updated_at', 'member_id', 'start', 'end', 'breaks', 'project_id', 'project_name', 'notes', 'base_rate', 'source', 'location_consent'},
    'shifts/delete': {'id', 'version'},
    'entries/delete': {'id', 'version'},
    'settings': set(DEFAULT_SETTINGS),
    'clock/in': {'project_id', 'project_name', 'notes', 'location_consent'},
    'clock/out': {'entry_id', 'version'},
    'clock/break': {'entry_id', 'version', 'action', 'paid'},
    'locations': {'latitude', 'longitude', 'accuracy', 'captured_at'},
}


class SchedulerError(ValueError):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


def _text(value, label, limit=500, required=False):
    if not isinstance(value, str) or len(value) > limit or '\x00' in value:
        raise SchedulerError(f'{label} must be text of at most {limit} characters.')
    value = value.strip()
    if required and not value:
        raise SchedulerError(f'{label} is required.')
    return value


def _boolean(value, label):
    if type(value) is not bool:
        raise SchedulerError(f'{label} must be true or false.')
    return value


def _number(value, label, minimum=0, maximum=100000):
    if isinstance(value, bool):
        raise SchedulerError(f'{label} must be a number.')
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise SchedulerError(f'{label} must be a number.') from None
    if not result.is_finite() or not minimum <= result <= maximum:
        raise SchedulerError(f'{label} must be between {minimum} and {maximum}.')
    return result


def _timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        raise SchedulerError('Include a valid date and time.')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise SchedulerError('Include a valid date and time.') from None
    if parsed.tzinfo is None:
        first = parsed.replace(tzinfo=SYDNEY, fold=0)
        second = parsed.replace(tzinfo=SYDNEY, fold=1)
        if first.astimezone(UTC).astimezone(SYDNEY).replace(tzinfo=None) != parsed:
            raise SchedulerError('That Sydney time does not exist during the daylight saving change.')
        if first.utcoffset() != second.utcoffset():
            raise SchedulerError('That Sydney time occurs twice. Include an explicit UTC offset.')
        parsed = first
    if not 2000 <= parsed.year <= 2100:
        raise SchedulerError('Dates must be between 2000 and 2100.')
    return parsed.astimezone(UTC).replace(microsecond=0)


def _iso(value):
    return value.astimezone(UTC).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def _json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':'))


def _password(value, salt=None):
    if not isinstance(value, str) or not 12 <= len(value) <= 256:
        raise SchedulerError('Use a password between 12 and 256 characters.')
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(value.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return salt, digest


def _public_member(row, include_rate=True):
    member = {key: row[key] for key in ('id', 'name', 'email', 'role', 'version')}
    member['active'] = bool(row['active'])
    if include_rate:
        member['base_rate'] = row['base_rate']
    return member


class SchedulerStore:
    def __init__(self, path, *, now=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.now = now or (lambda: datetime.now(UTC))
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS scheduler_members (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
                    role TEXT NOT NULL, active INTEGER NOT NULL, base_rate TEXT NOT NULL,
                    salt TEXT NOT NULL, password_hash TEXT NOT NULL, version INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS scheduler_sessions (
                    token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, expires_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS scheduler_login_attempts (
                    email TEXT PRIMARY KEY, failures INTEGER NOT NULL, locked_until TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS scheduler_settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS scheduler_records (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL, member_id TEXT,
                    start TEXT NOT NULL, end TEXT, version INTEGER NOT NULL, data TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS scheduler_record_dates ON scheduler_records(kind,start,end);
                CREATE UNIQUE INDEX IF NOT EXISTS scheduler_one_clock ON scheduler_records(member_id)
                    WHERE kind='entry' AND end IS NULL;
                CREATE TABLE IF NOT EXISTS scheduler_locations (
                    id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, member_id TEXT NOT NULL,
                    captured_at TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
                    accuracy REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS scheduler_location_entry ON scheduler_locations(entry_id,captured_at);
                CREATE TABLE IF NOT EXISTS scheduler_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
                    action TEXT NOT NULL, target TEXT NOT NULL, before_data TEXT, after_data TEXT
                );
            ''')
            db.execute('INSERT OR IGNORE INTO scheduler_settings VALUES(1,?)', (_json(DEFAULT_SETTINGS),))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def _audit(self, db, actor, action, target, before=None, after=None):
        db.execute('INSERT INTO scheduler_audit(at,actor,action,target,before_data,after_data) VALUES(?,?,?,?,?,?)',
                   (_iso(self.now()), actor, action, target,
                    _json(before) if before is not None else None,
                    _json(after) if after is not None else None))

    def _user(self, db, token, required=True):
        row = None
        if isinstance(token, str) and 32 <= len(token) <= 200:
            row = db.execute('''SELECT m.* FROM scheduler_sessions s JOIN scheduler_members m ON m.id=s.member_id
                WHERE s.token_hash=? AND s.expires_at>? AND m.active=1''',
                (hashlib.sha256(token.encode()).hexdigest(), _iso(self.now()))).fetchone()
        if row is None and required:
            raise SchedulerError('Sign in to use Scheduler.', 401)
        return row

    @staticmethod
    def _admin(user):
        if user['role'] != 'admin':
            raise SchedulerError('An administrator account is required.', 403)

    @staticmethod
    def _record(db, record_id, kind):
        row = db.execute('SELECT data FROM scheduler_records WHERE id=? AND kind=?', (record_id, kind)).fetchone()
        if row is None:
            raise SchedulerError('The record no longer exists. Refresh Scheduler.', 404)
        return json.loads(row['data'])

    @staticmethod
    def _current(db, member_id):
        row = db.execute("SELECT data FROM scheduler_records WHERE kind='entry' AND member_id=? AND end IS NULL", (member_id,)).fetchone()
        return json.loads(row['data']) if row else None

    def _save_record(self, db, user, kind, value, previous=None):
        value['version'] = previous['version'] + 1 if previous else 1
        value['updated_at'] = _iso(self.now())
        db.execute('''INSERT INTO scheduler_records(id,kind,member_id,start,end,version,data) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET member_id=excluded.member_id,start=excluded.start,end=excluded.end,
            version=excluded.version,data=excluded.data''',
            (value['id'], kind, value.get('member_id'), value['start'], value.get('end'), value['version'], _json(value)))
        self._audit(db, user['id'], kind + ('.update' if previous else '.create'), value['id'], previous, value)
        return value

    @staticmethod
    def _version(payload, previous):
        if previous and (type(payload.get('version')) is not int or payload['version'] != previous['version']):
            raise SchedulerError('This record changed in another session. Refresh before saving.', 409)

    def read(self, action, query=None, token=None):
        query = query or {}
        with self.connect() as db:
            user = self._user(db, token, required=action != 'bootstrap')
            if action == 'bootstrap':
                return {'setup_required': not bool(db.execute('SELECT 1 FROM scheduler_members LIMIT 1').fetchone()),
                        'user': _public_member(user) if user else None}
            if action == 'state':
                return self._state(db, user, query)
            if action == 'locations':
                entry = self._record(db, _text(query.get('entry_id', ''), 'Entry', required=True), 'entry')
                if entry['member_id'] != user['id']:
                    raise SchedulerError('Location history is available only to its signed-in owner.', 403)
                rows = db.execute('SELECT id,entry_id,captured_at,latitude,longitude,accuracy FROM scheduler_locations WHERE entry_id=? ORDER BY captured_at,id LIMIT 10000', (entry['id'],))
                return {'locations': [dict(row) for row in rows]}
            raise SchedulerError('Scheduler endpoint not found.', 404)

    def _state(self, db, user, query):
        today = self.now().astimezone(SYDNEY).date()
        start_date = _timestamp(query.get('start', str(today - timedelta(days=today.weekday()))))
        end_date = _timestamp(query.get('end', str(today + timedelta(days=7-today.weekday()))))
        if not timedelta(0) < end_date - start_date <= timedelta(days=93):
            raise SchedulerError('Select a date range of at most 93 days.')
        members = [_public_member(row, user['role'] == 'admin' or row['id'] == user['id'])
                   for row in db.execute('SELECT * FROM scheduler_members ORDER BY name,id')]
        records = [json.loads(row['data']) | {'_kind': row['kind']} for row in db.execute(
            'SELECT kind,data FROM scheduler_records WHERE start<? AND (end IS NULL OR end>?) ORDER BY start,id',
            (_iso(end_date), _iso(start_date)))]
        shifts = []
        entries = []
        for record in records:
            kind = record.pop('_kind')
            if kind == 'shift' and (user['role'] == 'admin' or record['published'] and user['id'] in record['member_ids']):
                shifts.append(record)
            if kind == 'entry' and (user['role'] == 'admin' or record['member_id'] == user['id']):
                entries.append(record)
        settings = json.loads(db.execute('SELECT data FROM scheduler_settings WHERE id=1').fetchone()[0])
        # Whole weeks supply context for overtime even when the visible range starts midweek.
        local_start = start_date.astimezone(SYDNEY)
        week_start = (local_start - timedelta(days=local_start.weekday())).replace(hour=0, minute=0, second=0)
        payroll_entries = [json.loads(row['data']) for row in db.execute(
            "SELECT data FROM scheduler_records WHERE kind='entry' AND end IS NOT NULL AND start<? AND end>? ORDER BY start,id",
            (_iso(end_date), _iso(week_start)))]
        if user['role'] != 'admin':
            payroll_entries = [entry for entry in payroll_entries if entry['member_id'] == user['id']]
        return {'user': _public_member(user), 'members': members, 'shifts': shifts, 'entries': entries,
                'settings': settings, 'active_entry': self._current(db, user['id']),
                'payroll': calculate_payroll(payroll_entries, settings, start_date, end_date)}

    def write(self, action, payload=None, token=None):
        payload = payload or {}
        if not isinstance(payload, dict):
            raise SchedulerError('Scheduler requests must be JSON objects.')
        if action not in WRITE_FIELDS:
            raise SchedulerError('Scheduler endpoint not found.', 404)
        if set(payload) - WRITE_FIELDS[action]:
            raise SchedulerError('The Scheduler request contains unknown fields.')
        if action == 'login':
            return self._login(payload)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if action == 'setup':
                return self._setup(db, payload)
            user = self._user(db, token)
            if action == 'logout':
                db.execute('DELETE FROM scheduler_sessions WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))
                return {'signed_out': True}
            if action == 'members/save':
                return self._member_save(db, user, payload)
            if action in ('shifts/save', 'entries/save'):
                return self._record_save(db, user, payload, 'shift' if action.startswith('shifts') else 'entry')
            if action in ('shifts/delete', 'entries/delete'):
                return self._delete(db, user, payload, 'shift' if action.startswith('shifts') else 'entry')
            if action == 'settings':
                return self._settings(db, user, payload)
            if action.startswith('clock/'):
                return self._clock(db, user, action, payload)
            if action == 'locations':
                return self._location(db, user, payload)
            raise SchedulerError('Scheduler endpoint not found.', 404)

    def _session(self, db, user):
        token = secrets.token_urlsafe(32)
        db.execute('DELETE FROM scheduler_sessions WHERE expires_at<=?', (_iso(self.now()),))
        db.execute('INSERT INTO scheduler_sessions VALUES(?,?,?)',
                   (hashlib.sha256(token.encode()).hexdigest(), user['id'], _iso(self.now() + timedelta(hours=12))))
        return {'token': token, 'user': _public_member(user)}

    def _setup(self, db, payload):
        if db.execute('SELECT 1 FROM scheduler_members LIMIT 1').fetchone():
            raise SchedulerError('Scheduler already has an administrator. Sign in.', 409)
        value = self._member_save(db, {'id': 'setup', 'role': 'admin'},
                                  {**payload, 'role': 'admin', 'active': True, 'base_rate': '0'})
        user = db.execute('SELECT * FROM scheduler_members WHERE id=?', (value['id'],)).fetchone()
        return self._session(db, user)

    def _login(self, payload):
        email = _text(payload.get('email', ''), 'Email', 254, True).casefold()
        password = payload.get('password', '')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            attempt = db.execute('SELECT * FROM scheduler_login_attempts WHERE email=?', (email,)).fetchone()
            if attempt and attempt['locked_until'] > _iso(self.now()):
                raise SchedulerError('Too many sign-in attempts. Try again in 15 minutes.', 429)
            user = db.execute('SELECT * FROM scheduler_members WHERE email=?', (email,)).fetchone()
            # Equal password work for unknown identities avoids a cheap account probe.
            salt = user['salt'] if user else '0' * 32
            try:
                _, digest = _password(password, salt)
            except SchedulerError:
                _, digest = _password('invalid-password', salt)
                digest = ''
            valid = user is not None and user['active'] and hmac.compare_digest(digest, user['password_hash'])
            if valid:
                db.execute('DELETE FROM scheduler_login_attempts WHERE email=?', (email,))
                return self._session(db, user)
            failures = attempt['failures'] + 1 if attempt and attempt['locked_until'] == '' else 1
            locked_until = _iso(self.now() + timedelta(minutes=15)) if failures >= 5 else ''
            db.execute('INSERT INTO scheduler_login_attempts VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until',
                       (email, failures, locked_until))
        # Commit throttling before raising a rejected sign-in.
        raise SchedulerError('Email or password is incorrect.', 401)

    def _member_save(self, db, user, payload):
        self._admin(user)
        member_id = _text(payload.get('id', ''), 'Member ID', 100) or str(uuid.uuid4())
        previous = db.execute('SELECT * FROM scheduler_members WHERE id=?', (member_id,)).fetchone()
        if payload.get('id') and not previous:
            raise SchedulerError('Member no longer exists.', 404)
        self._version(payload, previous)
        name = _text(payload.get('name', ''), 'Name', 120, True)
        email = _text(payload.get('email', ''), 'Email', 254, True).casefold()
        if email.count('@') != 1 or any(char.isspace() for char in email):
            raise SchedulerError('Include a valid email address.')
        role = payload.get('role', 'worker')
        if role not in ('admin', 'worker'):
            raise SchedulerError('Role must be admin or worker.')
        active = _boolean(payload.get('active', True), 'Active')
        rate_value = _number(payload.get('base_rate', 0), 'Hourly base rate')
        if rate_value.as_tuple().exponent < -4:
            raise SchedulerError('Hourly base rates support up to four decimal places.')
        rate = str(rate_value)
        if previous and previous['role'] == 'admin' and previous['active'] and (role != 'admin' or not active):
            if db.execute("SELECT count(*) FROM scheduler_members WHERE role='admin' AND active=1").fetchone()[0] <= 1:
                raise SchedulerError('Keep at least one active administrator.')
        if previous and not active and self._current(db, member_id):
            raise SchedulerError('Clock this member out before deactivating their account.')
        if payload.get('password') or not previous:
            salt, password_hash = _password(payload.get('password'))
        else:
            salt, password_hash = previous['salt'], previous['password_hash']
        version = previous['version'] + 1 if previous else 1
        try:
            db.execute('''INSERT INTO scheduler_members VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,email=excluded.email,role=excluded.role,active=excluded.active,
                base_rate=excluded.base_rate,salt=excluded.salt,password_hash=excluded.password_hash,version=excluded.version''',
                (member_id, name, email, role, int(active), rate, salt, password_hash, version))
        except sqlite3.IntegrityError:
            raise SchedulerError('That email already belongs to a team member.', 409) from None
        if previous and (payload.get('password') or not active or role != previous['role']):
            db.execute('DELETE FROM scheduler_sessions WHERE member_id=?', (member_id,))
        value = _public_member(db.execute('SELECT * FROM scheduler_members WHERE id=?', (member_id,)).fetchone())
        self._audit(db, user['id'], 'member.save', member_id, _public_member(previous) if previous else None, value)
        return value

    def _record_save(self, db, user, payload, kind):
        self._admin(user)
        record_id = _text(payload.get('id', ''), 'Record ID', 100)
        previous = self._record(db, record_id, kind) if record_id else None
        self._version(payload, previous)
        if previous and previous.get('end') is None:
            raise SchedulerError('Clock out before editing this time entry.')
        start, end = _timestamp(payload.get('start')), _timestamp(payload.get('end'))
        if not timedelta(0) < end-start <= timedelta(days=7):
            raise SchedulerError('End must follow start, within seven days.')
        value = {'id': previous['id'] if previous else str(uuid.uuid4()), 'start': _iso(start), 'end': _iso(end),
                 'project_id': _text(payload.get('project_id', ''), 'Project', 1000),
                 'project_name': _text(payload.get('project_name', ''), 'Project name', 1000),
                 'notes': _text(payload.get('notes', ''), 'Notes', 4000)}
        if kind == 'shift':
            member_ids = payload.get('member_ids', [])
            if not isinstance(member_ids, list) or len(member_ids) > 500 or any(not isinstance(x, str) for x in member_ids):
                raise SchedulerError('Select valid team members.')
            member_ids = list(dict.fromkeys(member_ids))
            for member_id in member_ids:
                self._active_member(db, member_id)
            color = payload.get('color', '#2196f3')
            if not isinstance(color, str) or len(color) != 7 or color[0] != '#' or any(c not in '0123456789abcdefABCDEF' for c in color[1:]):
                raise SchedulerError('Choose a six-digit colour.')
            value.update(title=_text(payload.get('title', ''), 'Title', 250, True), member_ids=member_ids,
                         location=_text(payload.get('location', ''), 'Location', 500), color=color,
                         published=_boolean(payload.get('published', False), 'Published'))
        else:
            member = self._active_member(db, _text(payload.get('member_id', ''), 'Member', 100, True))
            self._no_overlap(db, member['id'], start, end, value['id'])
            for field in ('base_rate', 'source', 'location_consent'):
                if field in payload and (not previous or payload[field] != previous[field]):
                    raise SchedulerError('Captured hourly rates, clock source and location consent cannot be edited.')
            if previous and previous.get('location_consent') and previous['member_id'] != member['id']:
                raise SchedulerError('A location-linked time entry cannot be reassigned to another person.')
            if previous:
                pins = db.execute('SELECT min(captured_at),max(captured_at) FROM scheduler_locations WHERE entry_id=?', (previous['id'],)).fetchone()
                if pins[0] and (start > _timestamp(pins[0]) or end < _timestamp(pins[1])):
                    raise SchedulerError('Keep all recorded locations inside the edited time entry.')
            breaks = self._validate_breaks(payload.get('breaks', []), start, end)
            retained_rate = previous['base_rate'] if previous and previous['member_id'] == member['id'] else member['base_rate']
            value.update(member_id=member['id'], breaks=breaks, base_rate=retained_rate,
                         location_consent=previous.get('location_consent', False) if previous else False,
                         source=previous.get('source', 'manual') if previous else 'manual')
        return self._save_record(db, user, kind, value, previous)

    @staticmethod
    def _active_member(db, member_id):
        member = db.execute('SELECT * FROM scheduler_members WHERE id=? AND active=1', (member_id,)).fetchone()
        if member is None:
            raise SchedulerError('Select an active team member.')
        return member

    @staticmethod
    def _no_overlap(db, member_id, start, end, record_id=''):
        overlap = db.execute("SELECT id FROM scheduler_records WHERE kind='entry' AND member_id=? AND id<>? AND (end IS NULL OR end>?) AND start<? LIMIT 1",
                             (member_id, record_id, _iso(start), _iso(end))).fetchone()
        if overlap:
            raise SchedulerError('Time entries for the same person cannot overlap.', 409)

    @staticmethod
    def _validate_breaks(items, start, end):
        if not isinstance(items, list) or len(items) > 50:
            raise SchedulerError('Include at most 50 breaks.')
        breaks = []
        for item in items:
            if not isinstance(item, dict):
                raise SchedulerError('Breaks must contain start, end and paid fields.')
            begin, finish = _timestamp(item.get('start')), _timestamp(item.get('end'))
            if not start <= begin < finish <= end:
                raise SchedulerError('Each break must fit inside its time entry.')
            breaks.append({'start': _iso(begin), 'end': _iso(finish), 'paid': _boolean(item.get('paid', False), 'Paid break')})
        breaks.sort(key=lambda item: item['start'])
        if any(left['end'] > right['start'] for left, right in zip(breaks, breaks[1:])):
            raise SchedulerError('Breaks cannot overlap.')
        return breaks

    def _delete(self, db, user, payload, kind):
        self._admin(user)
        previous = self._record(db, _text(payload.get('id', ''), 'Record ID', 100, True), kind)
        self._version(payload, previous)
        if previous.get('end') is None:
            raise SchedulerError('Clock out before deleting this entry.')
        db.execute('DELETE FROM scheduler_records WHERE id=?', (previous['id'],))
        self._audit(db, user['id'], kind + '.delete', previous['id'], previous)
        return {'deleted': True}

    def _settings(self, db, user, payload):
        self._admin(user)
        previous = json.loads(db.execute('SELECT data FROM scheduler_settings WHERE id=1').fetchone()[0])
        self._version(payload, previous)
        value = {**previous, **payload}
        if set(value) - set(DEFAULT_SETTINGS):
            raise SchedulerError('Unknown Scheduler setting.')
        if value['timezone'] != 'Australia/Sydney':
            raise SchedulerError('This schedule uses Australia/Sydney time.')
        if type(value['rounding_minutes']) is not int or value['rounding_minutes'] not in (0, 5, 6, 10, 15, 30):
            raise SchedulerError('Choose rounding of 0, 5, 6, 10, 15 or 30 minutes.')
        if value['rounding_mode'] not in ('nearest', 'up', 'down'):
            raise SchedulerError('Choose nearest, up or down rounding.')
        if value['overlap_rule'] != 'highest' or value['weekly_hours'] != 'all' or value['shift_rule'] != 'start_window':
            raise SchedulerError('The supported pay policy uses highest rate, all worked hours and shift start windows.')
        _boolean(value['pay_rules_confirmed'], 'Pay rules confirmed')
        if not isinstance(value['breaks'], list) or len(value['breaks']) > 20:
            raise SchedulerError('Include at most 20 break choices.')
        value['breaks'] = [{'name': _text(item.get('name', ''), 'Break name', 80, True),
                            'minutes': int(_number(item.get('minutes'), 'Break minutes', 1, 180)),
                            'paid': _boolean(item.get('paid'), 'Paid break')} for item in value['breaks'] if isinstance(item, dict)]
        if len(value['breaks']) != len(payload.get('breaks', previous['breaks'])):
            raise SchedulerError('Break choices must contain name, minutes and paid.')
        if any(Decimal(str(item['minutes'])) != normalized['minutes'] for item, normalized in zip(payload.get('breaks', previous['breaks']), value['breaks'])):
            raise SchedulerError('Break durations must be whole minutes.')
        value['version'] += 1
        db.execute('UPDATE scheduler_settings SET data=? WHERE id=1', (_json(value),))
        self._audit(db, user['id'], 'settings.save', 'settings', previous, value)
        return value

    def _clock(self, db, user, action, payload):
        previous = self._current(db, user['id'])
        now = self.now().replace(microsecond=0)
        if action == 'clock/in':
            if previous:
                raise SchedulerError('You are already clocked in.', 409)
            self._no_overlap(db, user['id'], now, datetime(2100, 12, 31, tzinfo=UTC))
            value = {'id': str(uuid.uuid4()), 'member_id': user['id'], 'start': _iso(now), 'end': None,
                     'breaks': [], 'base_rate': user['base_rate'], 'source': 'clock',
                     'project_id': _text(payload.get('project_id', ''), 'Project', 1000),
                     'project_name': _text(payload.get('project_name', ''), 'Project name', 1000),
                     'notes': _text(payload.get('notes', ''), 'Notes', 4000),
                     'location_consent': _boolean(payload.get('location_consent', False), 'Location consent')}
            return self._save_record(db, user, 'entry', value)
        if previous is None:
            raise SchedulerError('Clock in first.', 409)
        if payload.get('entry_id') and payload['entry_id'] != previous['id']:
            raise SchedulerError('Your clock session changed. Refresh before continuing.', 409)
        if 'version' in payload:
            self._version(payload, previous)
        value = json.loads(_json(previous))
        open_break = value['breaks'][-1] if value['breaks'] and value['breaks'][-1]['end'] is None else None
        if now <= _timestamp(value['start']):
            raise SchedulerError('Clock time must follow the entry start.', 409)
        if action == 'clock/out':
            value['end'] = _iso(now)
            if open_break:
                open_break['end'] = _iso(now)
        elif action == 'clock/break':
            if payload.get('action') == 'start':
                if open_break:
                    raise SchedulerError('A break is already running.', 409)
                if len(value['breaks']) >= 50:
                    raise SchedulerError('A time entry supports at most 50 breaks.')
                value['breaks'].append({'start': _iso(now), 'end': None, 'paid': _boolean(payload.get('paid', False), 'Paid break')})
            elif payload.get('action') == 'end':
                if not open_break:
                    raise SchedulerError('No break is running.', 409)
                if now <= _timestamp(open_break['start']):
                    raise SchedulerError('Break end must follow its start.', 409)
                open_break['end'] = _iso(now)
            else:
                raise SchedulerError('Choose start or end for the break.')
        else:
            raise SchedulerError('Clock action not found.', 404)
        return self._save_record(db, user, 'entry', value, previous)

    def _location(self, db, user, payload):
        entry = self._current(db, user['id'])
        if not entry or not entry['location_consent']:
            raise SchedulerError('Location recording needs consent and an active clock session.', 403)
        latitude = float(_number(payload.get('latitude'), 'Latitude', -90, 90))
        longitude = float(_number(payload.get('longitude'), 'Longitude', -180, 180))
        accuracy = float(_number(payload.get('accuracy'), 'Accuracy', 0, 100000))
        captured = _timestamp(payload['captured_at']) if payload.get('captured_at') else self.now()
        if not _timestamp(entry['start']) <= captured <= self.now() or captured < self.now()-timedelta(minutes=5):
            raise SchedulerError('Location timestamps must be current and inside this clock session.')
        latest = db.execute('SELECT captured_at FROM scheduler_locations WHERE entry_id=? ORDER BY captured_at DESC LIMIT 1', (entry['id'],)).fetchone()
        if latest and captured < _timestamp(latest['captured_at']) + timedelta(seconds=10):
            return {'recorded': False, 'reason': 'A recent location is already recorded.'}
        location_id = str(uuid.uuid4())
        db.execute('INSERT INTO scheduler_locations VALUES(?,?,?,?,?,?,?)',
                   (location_id, entry['id'], user['id'], _iso(captured), latitude, longitude, accuracy))
        return {'recorded': True, 'id': location_id, 'entry_id': entry['id']}


def _rounded(value, settings):
    seconds = settings['rounding_minutes'] * 60
    if not seconds:
        return value
    quotient = value.timestamp() / seconds
    mode = settings['rounding_mode']
    rounded = math.floor(quotient + 0.5) if mode == 'nearest' else (math.ceil(quotient) if mode == 'up' else math.floor(quotient))
    return datetime.fromtimestamp(rounded * seconds, UTC)


def _paid_intervals(entry, settings):
    start, end = _rounded(_timestamp(entry['start']), settings), _rounded(_timestamp(entry['end']), settings)
    cursor = start
    for item in entry['breaks']:
        if item['paid']:
            continue
        begin, finish = max(start, _timestamp(item['start'])), min(end, _timestamp(item['end']))
        if finish <= begin:
            continue
        if begin > cursor:
            yield cursor, begin
        cursor = max(cursor, finish)
    if cursor < end:
        yield cursor, end


def calculate_payroll(entries, settings, visible_start=None, visible_end=None):
    """Apply confirmed screenshot rules once per paid second, preserving raw entries.

    Daily and weekly totals accumulate per member across entries. Calendar boundaries
    use Sydney time while durations use UTC, including daylight saving transitions.
    Highest matching multiplier wins. All matching rule names remain on each segment
    so equal-rate classifications are visible instead of guessing an export pay item.
    """
    if not settings['pay_rules_confirmed']:
        return {'status': 'confirmation_required', 'rows': [], 'message':
                'Confirm overlapping rates, weekly counting and shift windows in Scheduler settings before calculating pay.'}
    daily, weekly = defaultdict(int), defaultdict(int)
    rows = {}
    for entry in sorted(entries, key=lambda item: (item['start'], item['id'])):
        if not entry.get('end'):
            continue
        member_id = entry['member_id']
        local_start = _timestamp(entry['start']).astimezone(SYDNEY)
        shift = 'Afternoon shift' if 13 <= local_start.hour < 15 else ('Night shift' if 15 <= local_start.hour < 23 else None)
        for begin, finish in _paid_intervals(entry, settings):
            cursor = begin
            while cursor < finish:
                local = cursor.astimezone(SYDNEY)
                day_key = member_id, local.date()
                week_key = member_id, local.date() - timedelta(days=local.weekday())
                midnight = datetime.combine(local.date() + timedelta(days=1), datetime.min.time(), SYDNEY).astimezone(UTC)
                boundary = min(finish, midnight)
                for threshold in (2 * 3600, 8 * 3600, 10 * 3600):
                    if daily[day_key] < threshold:
                        boundary = min(boundary, cursor + timedelta(seconds=threshold-daily[day_key]))
                if weekly[week_key] < 40 * 3600:
                    boundary = min(boundary, cursor + timedelta(seconds=40*3600-weekly[week_key]))
                if visible_start and cursor < visible_start < boundary:
                    boundary = visible_start
                if visible_end and cursor < visible_end < boundary:
                    boundary = visible_end
                rules = [(Decimal('1'), 'Ordinary')]
                if daily[day_key] >= 8*3600:
                    rules.append((Decimal('1.5'), 'Daily overtime after 8 hours'))
                if daily[day_key] >= 10*3600:
                    rules.append((Decimal('2'), 'Daily overtime after 10 hours'))
                if local.weekday() == 5:
                    rules.append((Decimal('1.5') if daily[day_key] < 2*3600 else Decimal('2'), 'Saturday'))
                if local.weekday() == 6:
                    rules.append((Decimal('2'), 'Sunday'))
                if weekly[week_key] >= 40*3600:
                    rules.append((Decimal('1.5'), 'Weekly overtime after 40 hours'))
                if shift:
                    rules.append((Decimal('1.5'), shift))
                multiplier = max(rate for rate, name in rules)
                seconds = int((boundary-cursor).total_seconds())
                daily[day_key] += seconds
                weekly[week_key] += seconds
                if (visible_start is None or cursor >= visible_start) and (visible_end is None or cursor < visible_end):
                    row = rows.setdefault(member_id, {'member_id': member_id, 'seconds': 0, 'gross': Decimal(0), 'segments': []})
                    amount = Decimal(seconds) / Decimal(3600) * Decimal(entry['base_rate']) * multiplier
                    row['seconds'] += seconds
                    row['gross'] += amount
                    row['segments'].append({'entry_id': entry['id'], 'start': _iso(cursor), 'end': _iso(boundary),
                                            'seconds': seconds, 'multiplier': str(multiplier), 'base_rate': entry['base_rate'],
                                            'rules': [name for rate, name in rules if rate == multiplier],
                                            'amount': str(amount.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))})
                cursor = boundary
    for row in rows.values():
        row['hours'] = str((Decimal(row['seconds']) / Decimal(3600)).quantize(Decimal('0.0001')))
        row['gross'] = str(row['gross'].quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))
    return {'status': 'calculated', 'rows': list(rows.values()), 'message': 'Sydney calendar days; highest matching rate; all paid hours count toward weekly overtime. Gross pay excludes tax and superannuation.'}
