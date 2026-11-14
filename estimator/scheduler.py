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
import re
from pathlib import Path
import secrets
import sqlite3
import uuid
from functools import lru_cache
from zoneinfo import ZoneInfo, available_timezones


UTC = timezone.utc
SYDNEY = ZoneInfo('Australia/Sydney')
DEFAULT_OVERTIME_RULES = [
    {'id': 'daily-eight', 'name': 'Daily overtime after 8 hours', 'type': 'daily', 'days': list(range(7)), 'threshold_hours': '8', 'multiplier': '1.5', 'pay_item': 'Overtime 1.5x'},
    {'id': 'daily-ten', 'name': 'Daily overtime after 10 hours', 'type': 'daily', 'days': list(range(7)), 'threshold_hours': '10', 'multiplier': '2', 'pay_item': 'Overtime 2x'},
    {'id': 'saturday-first', 'name': 'Saturday first 2 hours', 'type': 'daily', 'days': [5], 'threshold_hours': '0', 'multiplier': '1.5', 'pay_item': 'Weekend 1.5x'},
    {'id': 'saturday-later', 'name': 'Saturday after 2 hours', 'type': 'daily', 'days': [5], 'threshold_hours': '2', 'multiplier': '2', 'pay_item': 'Weekend 2x'},
    {'id': 'sunday', 'name': 'Sunday', 'type': 'daily', 'days': [6], 'threshold_hours': '0', 'multiplier': '2', 'pay_item': 'Weekend 2x'},
    {'id': 'afternoon', 'name': 'Afternoon shift', 'type': 'time', 'days': list(range(7)), 'start_time': '13:00', 'end_time': '15:00', 'run_late': True, 'multiplier': '1.5', 'pay_item': 'Afternoon Shift 1.5x'},
    {'id': 'night', 'name': 'Night shift', 'type': 'time', 'days': list(range(7)), 'start_time': '15:00', 'end_time': '23:00', 'run_late': True, 'multiplier': '1.5', 'pay_item': 'Night Shift 1.5x'},
    {'id': 'weekly-forty', 'name': 'Weekly overtime after 40 hours', 'type': 'weekly', 'days': list(range(7)), 'threshold_hours': '40', 'multiplier': '1.5', 'pay_item': 'Overtime Hours'},
]
DEFAULT_SETTINGS = {
    'version': 1, 'timezone': 'Australia/Sydney', 'rounding_minutes': 0,
    'rounding_mode': 'nearest',
    'breaks': [{'name': 'Lunch', 'minutes': 30, 'paid': False},
               {'name': 'Rest', 'minutes': 10, 'paid': True}],
    'pay_rules_confirmed': True, 'overlap_rule': 'highest',
    'weekly_hours': 'all', 'shift_rule': 'start_window',
    'rules_schema_version': 2, 'overtime_rules': DEFAULT_OVERTIME_RULES,
}
WRITE_FIELDS = {
    'setup': {'name', 'email', 'password'},
    'login': {'email', 'password'},
    'logout': set(),
    'members/save': {'timezone', 'id', 'version', 'name', 'email', 'password', 'role', 'active', 'base_rate'},
    'shifts/save': {'input_timezone', 'id', 'version', 'updated_at', 'title', 'start', 'end', 'member_ids', 'project_id', 'project_name', 'work_order', 'location', 'notes', 'site_contact_note', 'color', 'published', 'request_id'},
    'entries/save': {'input_timezone', 'id', 'version', 'updated_at', 'member_id', 'start', 'end', 'breaks', 'project_id', 'project_name', 'work_order', 'notes', 'base_rate', 'source', 'location_consent'},
    'shifts/delete': {'id', 'version'},
    'entries/delete': {'id', 'version'},
    'settings': set(DEFAULT_SETTINGS),
    'organization': {'timezone', 'version'},
    'clock/in': {'project_id', 'project_name', 'work_order', 'notes', 'location_consent', 'location'},
    'clock/out': {'entry_id', 'version', 'location'},
    'clock/break': {'entry_id', 'version', 'action', 'paid', 'rule_id'},
    'locations': {'entry_id', 'latitude', 'longitude', 'accuracy', 'captured_at'},
    'locations/enable': {'entry_id', 'latitude', 'longitude', 'accuracy', 'captured_at'},
}
READ_FIELDS = {'work-orders': {'offset'}, 'shift-site-contacts': {'id','revision'}, 'bootstrap': set(), 'organization': set(), 'state': {'start', 'end'}, 'reports': {'start','end'}, 'locations': {'entry_id'}}


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


@lru_cache(maxsize=1)
def organization_zones():
    return tuple(sorted(available_timezones() - {'localtime', 'Factory'}))


def _timestamp(value, zone=SYDNEY):
    if not isinstance(value, str) or len(value) > 40:
        raise SchedulerError('Include a valid date and time.')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise SchedulerError('Include a valid date and time.') from None
    if parsed.tzinfo is None:
        first = parsed.replace(tzinfo=zone, fold=0)
        second = parsed.replace(tzinfo=zone, fold=1)
        if first.astimezone(UTC).astimezone(zone).replace(tzinfo=None) != parsed:
            raise SchedulerError(f'That {zone.key} time does not exist during the daylight saving change.')
        if first.utcoffset() != second.utcoffset():
            raise SchedulerError(f'That {zone.key} time occurs twice. Include an explicit UTC offset.')
        parsed = first
    if not 2000 <= parsed.year <= 2100:
        raise SchedulerError('Dates must be between 2000 and 2100.')
    return parsed.astimezone(UTC).replace(microsecond=0)


def _iso(value):
    return value.astimezone(UTC).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def _range_boundary(value, zone):
    # A calendar date starts at its first instant even where DST jumps at
    # midnight. Typed shift times still reject ambiguous or nonexistent times.
    if isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        try:
            midnight = datetime.fromisoformat(value)
        except ValueError:
            raise SchedulerError('Include a valid calendar date.') from None
        if 2000 <= midnight.year <= 2100:
            return midnight.replace(tzinfo=zone).astimezone(UTC)
    return _timestamp(value, zone)


def _json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':'))


def _days(value):
    if not isinstance(value, list) or not value or any(type(day) is not int or day not in range(7) for day in value):
        raise SchedulerError('Select at least one valid day of the week.')
    return sorted(set(value))


def _hours(value, label, minimum=0, maximum=168):
    number = _number(value, label, minimum, maximum)
    if number * 3600 != (number * 3600).to_integral_value():
        raise SchedulerError(f'{label} must resolve to whole seconds.')
    return str(number)


def normalize_settings(settings):
    """Upgrade older saved choices without enabling new automatic deductions."""
    value = json.loads(_json({**DEFAULT_SETTINGS, **settings}))
    value['rules_schema_version'] = 2
    for field in ('breaks', 'overtime_rules'):
        if not isinstance(value[field], list) or any(not isinstance(rule, dict) for rule in value[field]):
            raise SchedulerError('Break and overtime rules must be lists of rule objects.')
    for index, rule in enumerate(value['breaks']):
        defaults = {'id': f'legacy-break-{index}', 'code': '', 'member_ids': [], 'automatic': False,
                    'after_hours': '4', 'repeat_hours': None, 'days': list(range(7)), 'placement': 'middle',
                    'manual': True, 'auto_end': False, 'minimum': False, 'notify_minutes': 0}
        value['breaks'][index] = {**defaults, **rule}
    for rule in value['overtime_rules']:
        rule.setdefault('enabled', True)
        rule.setdefault('threshold_hours', '0')
        rule.setdefault('start_time', '13:00')
        rule.setdefault('end_time', '15:00')
        rule.setdefault('run_late', False)
    return value


def validate_rules(settings, member_ids):
    value = normalize_settings(settings)
    if not isinstance(value['overtime_rules'], list) or len(value['overtime_rules']) > 50:
        raise SchedulerError('Include at most 50 overtime rules.')
    seen = set()
    for rule in value['overtime_rules']:
        if not isinstance(rule, dict) or set(rule) - {'id', 'name', 'type', 'days', 'threshold_hours', 'multiplier', 'pay_item', 'start_time', 'end_time', 'run_late', 'enabled'}:
            raise SchedulerError('An overtime rule contains unsupported fields.')
        rule['id'] = _text(rule.get('id'), 'Rule ID', 100, True)
        if rule['id'] in seen:
            raise SchedulerError('Overtime rule IDs must be unique.')
        seen.add(rule['id'])
        rule['name'] = _text(rule.get('name'), 'Rule name', 120, True)
        rule['pay_item'] = _text(rule.get('pay_item', ''), 'Pay item', 120)
        if rule.get('type') not in ('daily', 'weekly', 'time'):
            raise SchedulerError('Choose daily, weekly or time-of-day overtime.')
        rule['days'] = _days(rule.get('days'))
        rule['threshold_hours'] = _hours(rule.get('threshold_hours'), 'Overtime threshold')
        rule['multiplier'] = str(_number(rule.get('multiplier'), 'Rate multiplier', 1, 10))
        for field in ('start_time', 'end_time'):
            if not isinstance(rule.get(field), str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', rule[field]):
                raise SchedulerError('Time-of-day rules use HH:MM times.')
        if rule['type'] == 'time' and rule['start_time'] == rule['end_time']:
            raise SchedulerError('Time-of-day start and end must differ.')
        _boolean(rule['run_late'], 'Allow shift to run late')
        _boolean(rule['enabled'], 'Rule enabled')
    if not isinstance(value['breaks'], list) or len(value['breaks']) > 20:
        raise SchedulerError('Include at most 20 break rules.')
    seen = set()
    fields = {'id', 'name', 'code', 'minutes', 'paid', 'member_ids', 'automatic', 'after_hours', 'repeat_hours', 'days', 'placement', 'manual', 'auto_end', 'minimum', 'notify_minutes'}
    for rule in value['breaks']:
        if set(rule) - fields:
            raise SchedulerError('A break rule contains unsupported fields.')
        for field, limit, required in [('id', 100, True), ('name', 80, True), ('code', 20, False)]:
            rule[field] = _text(rule.get(field), 'Break ' + field, limit, required)
        if rule['id'] in seen:
            raise SchedulerError('Break rule IDs must be unique.')
        seen.add(rule['id'])
        for field in ('paid', 'automatic', 'manual', 'auto_end', 'minimum'):
            _boolean(rule.get(field), 'Break ' + field)
        minutes = rule.get('minutes')
        if minutes is not None:
            number = _number(minutes, 'Break minutes', 1, 180)
            if number != number.to_integral_value():
                raise SchedulerError('Break durations must be whole minutes.')
            rule['minutes'] = int(number)
        rule['days'] = _days(rule.get('days'))
        selected = rule.get('member_ids')
        if not isinstance(selected, list) or len(selected) > 500 or any(not isinstance(item, str) or item not in member_ids for item in selected):
            raise SchedulerError('Choose existing team members for a break rule.')
        rule['member_ids'] = list(dict.fromkeys(selected))
        rule['after_hours'] = _hours(rule.get('after_hours'), 'Automatic break threshold', minimum=Decimal('0.01'))
        if rule.get('repeat_hours') is not None:
            rule['repeat_hours'] = _hours(rule['repeat_hours'], 'Break repeat interval', minimum=Decimal('0.01'))
        if rule['placement'] not in ('middle', 'after_threshold'):
            raise SchedulerError('Choose middle of shift or after threshold for automatic breaks.')
        notify = rule.get('notify_minutes')
        if type(notify) is not int or not 0 <= notify <= 180:
            raise SchedulerError('Break notification minutes must be between 0 and 180.')
        if minutes is None and (rule['automatic'] or rule['auto_end'] or rule['minimum'] or notify):
            raise SchedulerError('Automatic breaks, auto-end, minimum duration and notifications need a set length.')
        if minutes is not None:
            if notify >= minutes:
                raise SchedulerError('Notify before break end must be shorter than the break.')
            if rule['automatic'] and (Decimal(rule['after_hours']) * 60 < minutes or rule['repeat_hours'] is not None and Decimal(rule['repeat_hours']) * 60 < minutes):
                raise SchedulerError('Automatic break thresholds must allow the full break length.')
    return value


def _password(value, salt=None):
    if not isinstance(value, str) or not 12 <= len(value) <= 256:
        raise SchedulerError('Use a password between 12 and 256 characters.')
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(value.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return salt, digest


def _public_member(row, zone_name):
    member = {key: row[key] for key in ('id', 'name', 'email', 'role', 'version')}
    member['active'] = bool(row['active'])
    member['timezone'] = zone_name
    member['base_rate'] = row['base_rate']
    return member


class SchedulerStore:
    def __init__(self, path, *, now=None, work_orders=None, work_order_lookup=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.now = now or (lambda: datetime.now(UTC))
        self.work_orders = work_orders
        self.work_order_lookup = work_order_lookup
        self.shift_site_contacts = None
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
                CREATE TABLE IF NOT EXISTS scheduler_requests (
                    actor TEXT NOT NULL, action TEXT NOT NULL, request_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, response TEXT NOT NULL,
                    PRIMARY KEY(actor,action,request_id)
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
        query = {} if query is None else query
        if action not in READ_FIELDS:
            raise SchedulerError('Scheduler endpoint not found.', 404)
        if not isinstance(query, dict) or set(query) - READ_FIELDS[action]:
            raise SchedulerError('The Scheduler request contains unknown filters.')
        with self.connect() as db:
            user = self._user(db, token, required=action != 'bootstrap')
            if action == 'shift-site-contacts':
                self._admin(user)
                identity = _text(query.get('id'), 'Work Order', 175, True)
                revision = _text(query.get('revision'), 'Work Order revision', 64, True)
                try:
                    contacts = self.shift_site_contacts(identity, revision) if self.shift_site_contacts else []
                except (ValueError, OSError) as error:
                    raise SchedulerError('This Work Order changed or is unavailable. Refresh the list and select it again.', 409) from error
                return {'contacts':contacts}
            if action == 'work-orders':
                raw = str(query.get('offset', '0'))
                if not re.fullmatch(r'0|[1-9][0-9]{0,8}', raw):
                    raise SchedulerError('Use a valid Work Order page.')
                if self.work_orders is None:
                    return {'orders': [], 'matched': 0, 'scan_pending': False, 'error_count': 0}
                try:
                    return self.work_orders(int(raw))
                except (ValueError, OSError) as error:
                    raise SchedulerError('Work Order choices are unavailable. Refresh the list.', 409) from error
            if action == 'organization':
                settings = self._read_settings(db)
                return {'timezone': settings['timezone'], 'version': settings['version'], 'zones': organization_zones()}
            if action == 'bootstrap':
                zone_name = self._read_settings(db)['timezone']
                return {'setup_required': not bool(db.execute('SELECT 1 FROM scheduler_members LIMIT 1').fetchone()),
                        'timezone': zone_name,
                        'user': _public_member(user, zone_name) if user else None}
            if action == 'state':
                db.execute('BEGIN IMMEDIATE')
                self._settle_breaks(db)
                return self._state(db, user, query)
            if action == 'reports':
                from .scheduler_reports import report
                db.execute('BEGIN')
                return report(db, user, self._read_settings(db), query)
            if action == 'locations':
                entry = self._record(db, _text(query.get('entry_id', ''), 'Entry', required=True), 'entry')
                if entry['member_id'] != user['id'] and user['role'] != 'admin':
                    raise SchedulerError('Location history is available only to its owner or an administrator.', 403)
                rows = db.execute('SELECT id,entry_id,captured_at,latitude,longitude,accuracy FROM scheduler_locations WHERE entry_id=? ORDER BY captured_at,id LIMIT 10000', (entry['id'],))
                points = [dict(row) for row in rows]
                return {'locations': points, 'coverage': self._location_coverage(entry, points),
                        'entry': self._entry_view(entry, self._read_settings(db))}
            raise SchedulerError('Scheduler endpoint not found.', 404)

    def _state(self, db, user, query):
        settings = self._read_settings(db)
        zone = ZoneInfo(settings['timezone'])
        today = self.now().astimezone(zone).date()
        start_date = _range_boundary(query.get('start', str(today - timedelta(days=today.weekday()))), zone)
        end_date = _range_boundary(query.get('end', str(today + timedelta(days=7-today.weekday()))), zone)
        if end_date <= start_date or end_date.astimezone(zone) - start_date.astimezone(zone) > timedelta(days=93):
            raise SchedulerError('Select a date range of at most 93 days.')
        members = [_public_member(row, zone.key) for row in db.execute('SELECT * FROM scheduler_members ORDER BY name,id')
                   if user['role'] == 'admin' or row['id'] == user['id']]
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
        active = self._current(db, user['id'])
        summaries = {row['entry_id']: dict(row) for row in db.execute('''SELECT l.entry_id,count(*) AS count,
            min(l.captured_at) AS first_at,max(l.captured_at) AS last_at FROM scheduler_locations l
            JOIN scheduler_records r ON r.id=l.entry_id
            WHERE ((r.start<? AND (r.end IS NULL OR r.end>?)) OR r.id=?) AND (?='admin' OR r.member_id=?)
            GROUP BY l.entry_id''', (_iso(end_date), _iso(start_date), active['id'] if active else '', user['role'], user['id']))}
        entries = [{**self._entry_view(entry, settings), 'location_summary': summaries.get(entry['id'], {'count': 0, 'first_at': None, 'last_at': None})} for entry in entries]
        # Whole weeks supply context for overtime even when the visible range starts midweek.
        local_start = start_date.astimezone(zone)
        week_start = (local_start - timedelta(days=local_start.weekday())).replace(hour=0, minute=0, second=0)
        payroll_entries = [json.loads(row['data']) for row in db.execute(
            "SELECT data FROM scheduler_records WHERE kind='entry' AND end IS NOT NULL AND start<? AND end>? ORDER BY start,id",
            (_iso(end_date), _iso(week_start)))]
        if user['role'] != 'admin':
            payroll_entries = [entry for entry in payroll_entries if entry['member_id'] == user['id']]
        if active:
            active = {**active, 'location_summary': summaries.get(active['id'], {'count': 0, 'first_at': None, 'last_at': None})}
        return {'user': _public_member(user, zone.key), 'members': members, 'shifts': shifts, 'entries': entries,
                'settings': settings, 'active_entry': active,
                'location_policy': {'required': True, 'interval_minutes': 30, 'history_access': 'owner_and_administrator'},
                'payroll': calculate_payroll(payroll_entries, settings, start_date, end_date)}

    @staticmethod
    def _read_settings(db):
        return normalize_settings(json.loads(db.execute('SELECT data FROM scheduler_settings WHERE id=1').fetchone()[0]))

    @staticmethod
    def _entry_view(entry, settings):
        if not entry.get('end'):
            return entry
        effective, warnings = effective_breaks(entry, settings)
        return {**entry, 'effective_breaks': effective, 'break_warnings': warnings,
                'paid_seconds': sum(int((end-start).total_seconds()) for start, end in _paid_intervals(entry, settings)),
                'rules_version': settings['version']}

    def _settle_breaks(self, db):
        for row in db.execute("SELECT data FROM scheduler_records WHERE kind='entry' AND end IS NULL").fetchall():
            previous = json.loads(row['data'])
            value = json.loads(row['data'])
            if self._end_due_break(value, self.now()):
                self._save_record(db, {'id': 'system'}, 'entry', value, previous)

    @staticmethod
    def _end_due_break(entry, now):
        if not entry['breaks']:
            return False
        item = entry['breaks'][-1]
        if item.get('end') is None and item.get('auto_end_at') and _timestamp(item['auto_end_at']) <= now:
            item['end'] = item['auto_end_at']
            return True
        return False

    def _assignment(self, value, payload, previous=None):
        prior = previous or {}
        # The old clients submit project id/name, sometimes even on an unrelated
        # edit. They may keep an existing assignment; only a Work Order can be new.
        if value['project_id'] and value['project_id'] != prior.get('project_id'):
            raise SchedulerError('Choose a saved Work Order instead of a project.')
        if value['project_name'] and value['project_name'] != prior.get('project_name'):
            raise SchedulerError('Choose a saved Work Order instead of entering a project name.')
        selected = payload.get('work_order')
        if 'work_order' not in payload:
            value.update(project_id=prior.get('project_id',''), project_name=prior.get('project_name',''))
            if prior.get('work_order'):
                value['work_order'] = prior['work_order']
            return None
        value.update(project_id='', project_name='')
        if selected is None:
            return None
        saved = prior.get('work_order')
        if saved and (selected == saved or selected == {key:saved[key] for key in ('id','revision')}):
            value['work_order'] = saved
            return None
        if not isinstance(selected, dict) or set(selected) != {'id','revision'} or self.work_order_lookup is None:
            raise SchedulerError('Choose a saved Work Order from the list.')
        try:
            identity = _text(selected['id'], 'Work Order', 175, True)
            revision = _text(selected['revision'], 'Work Order revision', 64, True)
            choice = self.work_order_lookup(identity, revision)
        except (ValueError, OSError, KeyError) as error:
            raise SchedulerError('This Work Order changed or is unavailable. Refresh the list and select it again.', 409) from error
        value['work_order'] = choice
        return choice


    def write(self, action, payload=None, token=None):
        payload = {} if payload is None else payload
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
            if action == 'organization':
                user = self._user(db, token)
                self._admin(user)
                previous = self._read_settings(db)
                self._version(payload, previous)
                name = payload.get('timezone')
                if not isinstance(name, str) or name not in organization_zones():
                    raise SchedulerError('Choose a listed IANA time zone.')
                settings = {**previous, 'timezone': name, 'version': previous['version'] + 1}
                db.execute('UPDATE scheduler_settings SET data=? WHERE id=1', (_json(settings),))
                self._audit(db, user['id'], 'organization.timezone', 'settings', previous, settings)
                return {'timezone': name, 'version': settings['version']}
            user = self._user(db, token)
            if action == 'logout':
                db.execute('DELETE FROM scheduler_sessions WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))
                return {'signed_out': True}
            if action == 'members/save':
                return self._member_save(db, user, payload)
            if action == 'shifts/save':
                return self._shift_save(db, user, payload)
            if action == 'entries/save':
                return self._record_save(db, user, payload, 'entry')
            if action in ('shifts/delete', 'entries/delete'):
                return self._delete(db, user, payload, 'shift' if action.startswith('shifts') else 'entry')
            if action == 'settings':
                return self._settings(db, user, payload)
            if action.startswith('clock/'):
                return self._clock(db, user, action, payload)
            if action in {'locations', 'locations/enable'}:
                result = self._location(db, user, payload, enable=action == 'locations/enable')
                # An active shift can exceed twelve hours. A successful location
                # heartbeat renews only this existing session, not its permissions.
                db.execute('UPDATE scheduler_sessions SET expires_at=? WHERE token_hash=?',
                           (_iso(self.now() + timedelta(hours=12)), hashlib.sha256(token.encode()).hexdigest()))
                return result
            raise SchedulerError('Scheduler endpoint not found.', 404)

    def _shift_save(self, db, user, payload):
        """Commit a new shift and its retry receipt in the same transaction."""
        self._admin(user)
        if 'request_id' not in payload:
            return self._record_save(db, user, payload, 'shift')
        request_id = _text(payload['request_id'], 'Request ID', 36, True)
        try:
            if str(uuid.UUID(request_id)) != request_id:
                raise ValueError()
        except ValueError:
            raise SchedulerError('Use a canonical UUID for the shift request ID.') from None
        if payload.get('id'):
            raise SchedulerError('Request IDs apply only when creating a new shift.')
        semantic = {key: value for key, value in payload.items() if key != 'request_id'}
        try:
            canonical = json.dumps(semantic, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(',', ':'))
        except (TypeError, ValueError):
            raise SchedulerError('The shift request must contain valid JSON values.') from None
        fingerprint = hashlib.sha256(canonical.encode()).hexdigest()
        receipt = db.execute("SELECT fingerprint,response FROM scheduler_requests WHERE actor=? AND action='shifts/save' AND request_id=?",
                             (user['id'], request_id)).fetchone()
        if receipt:
            if receipt['fingerprint'] != fingerprint:
                raise SchedulerError('This shift request was already saved with different details. Refresh the schedule before trying again.', 409)
            return json.loads(receipt['response'])
        result = self._record_save(db, user, semantic, 'shift')
        db.execute("INSERT INTO scheduler_requests(actor,action,request_id,fingerprint,response) VALUES(?,'shifts/save',?,?,?)",
                   (user['id'], request_id, fingerprint, _json(result)))
        return result

    def _session(self, db, user):
        token = secrets.token_urlsafe(32)
        db.execute('DELETE FROM scheduler_sessions WHERE expires_at<=?', (_iso(self.now()),))
        db.execute('INSERT INTO scheduler_sessions VALUES(?,?,?)',
                   (hashlib.sha256(token.encode()).hexdigest(), user['id'], _iso(self.now() + timedelta(hours=12))))
        return {'token': token, 'user': _public_member(user, self._read_settings(db)['timezone'])}

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
        zone_name = self._read_settings(db)['timezone']
        if payload.get('timezone', zone_name) != zone_name:
            raise SchedulerError('Team members inherit the organization time zone.', 409)
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
        value = _public_member(db.execute('SELECT * FROM scheduler_members WHERE id=?', (member_id,)).fetchone(), zone_name)
        self._audit(db, user['id'], 'member.save', member_id, _public_member(previous, zone_name) if previous else None, value)
        return value

    def _record_save(self, db, user, payload, kind):
        self._admin(user)
        record_id = _text(payload.get('id', ''), 'Record ID', 100)
        previous = self._record(db, record_id, kind) if record_id else None
        self._version(payload, previous)
        if previous and previous.get('end') is None:
            raise SchedulerError('Clock out before editing this time entry.')
        zone = ZoneInfo(self._read_settings(db)['timezone'])
        if payload.get('input_timezone', zone.key) != zone.key:
            raise SchedulerError('The organization time zone changed. Reopen the editor to review its local times.', 409)
        start, end = _timestamp(payload.get('start'), zone), _timestamp(payload.get('end'), zone)
        if not timedelta(0) < end-start <= timedelta(days=7):
            raise SchedulerError('End must follow start, within seven days.')
        value = {'id': previous['id'] if previous else str(uuid.uuid4()), 'start': _iso(start), 'end': _iso(end),
                 'project_id': _text(payload.get('project_id', ''), 'Project', 1000),
                 'project_name': _text(payload.get('project_name', ''), 'Project name', 1000),
                 'notes': _text(payload.get('notes', ''), 'Notes', 4000)}
        selected_order = self._assignment(value, payload, previous)
        if kind == 'shift':
            if selected_order and selected_order['status'] != 'In progress':
                raise SchedulerError('Choose an In progress Work Order for this shift.', 409)
            # Remember only an intact auto-inserted prefix for this assignment.
            # Older editors may omit the marker when updating unrelated fields.
            old_prefix = (previous or {}).get('site_contact_note', '') if not selected_order else ''
            prefix = _text(payload.get('site_contact_note',old_prefix), 'Notes', 4000)
            if value.get('work_order') and prefix and (value['notes'] == prefix or value['notes'].startswith(prefix + '\n')):
                value['site_contact_note'] = prefix
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
            if selected_order and not value['location']:
                value['location'] = _text(selected_order.get('site_address', ''), 'Site address', 500)
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
                if pins[0] and (start > max(_timestamp(pins[0]), _timestamp(previous['start'])) or end < _timestamp(pins[1])):
                    raise SchedulerError('Keep all recorded locations inside the edited time entry.')
            breaks = self._validate_breaks(payload.get('breaks', []), start, end, zone)
            if previous:
                for item in breaks:
                    original = next((old for old in previous['breaks'] if old['start'] == item['start'] and old['end'] == item['end'] and old['paid'] == item['paid']), None)
                    if original:
                        item.update({key: original[key] for key in ('rule_id', 'name', 'code', 'expected_end_at', 'auto_end_at', 'min_end_at', 'notify_at') if key in original})
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
    def _validate_breaks(items, start, end, zone):
        if not isinstance(items, list) or len(items) > 50:
            raise SchedulerError('Include at most 50 breaks.')
        breaks = []
        for item in items:
            if not isinstance(item, dict):
                raise SchedulerError('Breaks must contain start, end and paid fields.')
            begin, finish = _timestamp(item.get('start'), zone), _timestamp(item.get('end'), zone)
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
        previous = self._read_settings(db)
        self._version(payload, previous)
        value = {**previous, **payload}
        if set(value) - set(DEFAULT_SETTINGS):
            raise SchedulerError('Unknown Scheduler setting.')
        if value['timezone'] != previous['timezone']:
            raise SchedulerError('Change the organization time zone in Application Settings.')
        if type(value['rounding_minutes']) is not int or value['rounding_minutes'] not in (0, 5, 6, 10, 15, 30):
            raise SchedulerError('Choose rounding of 0, 5, 6, 10, 15 or 30 minutes.')
        if value['rounding_mode'] not in ('nearest', 'up', 'down'):
            raise SchedulerError('Choose nearest, up or down rounding.')
        if value['overlap_rule'] != 'highest' or value['weekly_hours'] != 'all' or value['shift_rule'] != 'start_window':
            raise SchedulerError('The supported pay policy uses highest rate, all worked hours and shift start windows.')
        _boolean(value['pay_rules_confirmed'], 'Pay rules confirmed')
        if value['rules_schema_version'] != 2:
            raise SchedulerError('This Scheduler supports rule schema version 2.')
        if isinstance(value['breaks'], list):
            retained = []
            for rule in value['breaks']:
                if isinstance(rule, dict) and 'id' not in rule:
                    matches = [old for old in previous['breaks'] if old['name'] == rule.get('name')]
                    if len(matches) == 1:
                        rule = {**matches[0], **rule}
                retained.append(rule)
            value['breaks'] = retained
        value = validate_rules(value, {row['id'] for row in db.execute('SELECT id FROM scheduler_members')})
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
            if not _boolean(payload.get('location_consent', False), 'Location consent'):
                raise SchedulerError('Location is required to clock in. Enable location access and try again.')
            first_location = self._validated_location(payload.get('location'), ZoneInfo(self._read_settings(db)['timezone']), freshness=timedelta(minutes=2))
            self._no_overlap(db, user['id'], now, datetime(2100, 12, 31, tzinfo=UTC))
            value = {'id': str(uuid.uuid4()), 'member_id': user['id'], 'start': _iso(now), 'end': None,
                     'breaks': [], 'base_rate': user['base_rate'], 'source': 'clock',
                     'project_id': _text(payload.get('project_id', ''), 'Project', 1000),
                     'project_name': _text(payload.get('project_name', ''), 'Project name', 1000),
                     'notes': _text(payload.get('notes', ''), 'Notes', 4000),
                     'location_consent': True}
            self._assignment(value, payload)
            saved = self._save_record(db, user, 'entry', value)
            # Preserve the actual GPS capture time, including the few seconds
            # spent obtaining the fix before the server creates the clock entry.
            self._insert_location(db, saved, user, first_location)
            return saved
        if previous is None:
            raise SchedulerError('Clock in first.', 409)
        if payload.get('entry_id') and payload['entry_id'] != previous['id']:
            raise SchedulerError('Your clock session changed. Refresh before continuing.', 409)
        if 'version' in payload:
            self._version(payload, previous)
        value = json.loads(_json(previous))
        auto_ended = self._end_due_break(value, now)
        open_break = value['breaks'][-1] if value['breaks'] and value['breaks'][-1]['end'] is None else None
        if now <= _timestamp(value['start']):
            raise SchedulerError('Clock time must follow the entry start.', 409)
        final_location = None
        if action == 'clock/out':
            if open_break and open_break.get('min_end_at') and now < _timestamp(open_break['min_end_at']):
                raise SchedulerError('Complete the required break duration before clocking out.', 409)
            if 'location' in payload:
                final_location = self._validated_location(payload['location'], ZoneInfo(self._read_settings(db)['timezone']), freshness=timedelta(minutes=2))
                if final_location[3] < _timestamp(value['start']):
                    raise SchedulerError('Location timestamps must be current and inside this clock session.')
            value['end'] = _iso(now)
            if open_break:
                open_break['end'] = _iso(now)
        elif action == 'clock/break':
            if payload.get('action') == 'start':
                if open_break:
                    raise SchedulerError('A break is already running.', 409)
                if len(value['breaks']) >= 50:
                    raise SchedulerError('A time entry supports at most 50 breaks.')
                rule_id = payload.get('rule_id')
                if rule_id is not None:
                    rule = next((item for item in self._read_settings(db)['breaks'] if item['id'] == rule_id), None)
                    if rule is None or not rule['manual'] or rule['member_ids'] and user['id'] not in rule['member_ids']:
                        raise SchedulerError('Choose a manual break available to this team member today.')
                    item = {'start': _iso(now), 'end': None, 'paid': rule['paid'], 'rule_id': rule['id'], 'name': rule['name'], 'code': rule['code']}
                    if rule['minutes'] is not None:
                        end_at = now + timedelta(minutes=rule['minutes'])
                        item['expected_end_at'] = _iso(end_at)
                        if rule['auto_end']:
                            item['auto_end_at'] = _iso(end_at)
                        if rule['minimum']:
                            item['min_end_at'] = _iso(end_at)
                        if rule['notify_minutes']:
                            item['notify_at'] = _iso(end_at - timedelta(minutes=rule['notify_minutes']))
                else:
                    # Older clients have only a paid/unpaid choice. They retain
                    # compatibility without gaining a way around minimum rules.
                    choices = [item for item in self._read_settings(db)['breaks'] if item['manual'] and (not item['member_ids'] or user['id'] in item['member_ids']) and item['paid'] == payload.get('paid', False)]
                    if not choices or any(item['minimum'] or item['auto_end'] for item in choices):
                        raise SchedulerError('Select a named break rule before starting a break.')
                    item = {'start': _iso(now), 'end': None, 'paid': _boolean(payload.get('paid', False), 'Paid break')}
                value['breaks'].append(item)
            elif payload.get('action') == 'end':
                if auto_ended:
                    return self._save_record(db, user, 'entry', value, previous)
                if not open_break:
                    raise SchedulerError('No break is running.', 409)
                if now <= _timestamp(open_break['start']):
                    raise SchedulerError('Break end must follow its start.', 409)
                if open_break.get('min_end_at') and now < _timestamp(open_break['min_end_at']):
                    raise SchedulerError('The required break duration has not finished.', 409)
                open_break['end'] = _iso(now)
            else:
                raise SchedulerError('Choose start or end for the break.')
        else:
            raise SchedulerError('Clock action not found.', 404)
        saved = self._save_record(db, user, 'entry', value, previous)
        if final_location:
            # The clock-out fix is an explicit shift boundary, independent of
            # the periodic cadence. Save it atomically with the closed entry.
            latest = db.execute('SELECT captured_at FROM scheduler_locations WHERE entry_id=? ORDER BY captured_at DESC LIMIT 1', (saved['id'],)).fetchone()
            if not latest or final_location[3] > _timestamp(latest['captured_at']):
                self._insert_location(db, saved, user, final_location)
        return saved

    def _validated_location(self, payload, zone, *, freshness=timedelta(minutes=5)):
        keys = {'latitude', 'longitude', 'accuracy', 'captured_at'}
        if not isinstance(payload, dict) or set(payload) != keys:
            raise SchedulerError('A fresh browser location is required, including its capture time and accuracy.')
        latitude = float(_number(payload.get('latitude'), 'Latitude', -90, 90))
        longitude = float(_number(payload.get('longitude'), 'Longitude', -180, 180))
        accuracy = float(_number(payload.get('accuracy'), 'Accuracy', 0, 100000))
        captured = _timestamp(payload['captured_at'], zone)
        if not self.now()-freshness <= captured <= self.now():
            raise SchedulerError('The location is not current. Enable location access and obtain a new location.')
        return latitude, longitude, accuracy, captured

    @staticmethod
    def _insert_location(db, entry, user, location):
        latitude, longitude, accuracy, captured = location
        location_id = str(uuid.uuid4())
        db.execute('INSERT INTO scheduler_locations VALUES(?,?,?,?,?,?,?)',
                   (location_id, entry['id'], user['id'], _iso(captured), latitude, longitude, accuracy))
        return {'recorded': True, 'id': location_id, 'entry_id': entry['id'], 'captured_at': _iso(captured)}

    def _location(self, db, user, payload, *, enable=False):
        entry = self._current(db, user['id'])
        if not entry or not entry['location_consent'] and not enable:
            raise SchedulerError('Location recording needs an active clock session with location enabled.', 403)
        entry_id = _text(payload.get('entry_id', ''), 'Entry ID', 100, True)
        if entry_id != entry['id']:
            raise SchedulerError('The location belongs to a different clock session. Refresh before recording locations.', 409)
        location = self._validated_location({key: value for key, value in payload.items() if key != 'entry_id'}, ZoneInfo(self._read_settings(db)['timezone']))
        captured = location[3]
        if captured < _timestamp(entry['start']):
            raise SchedulerError('Location timestamps must be current and inside this clock session.')
        if not entry['location_consent']:
            entry = self._save_record(db, user, 'entry', {**entry, 'location_consent': True}, entry)
        latest = db.execute('SELECT captured_at FROM scheduler_locations WHERE entry_id=? ORDER BY captured_at DESC LIMIT 1', (entry['id'],)).fetchone()
        # This transaction also coalesces retries and independent browser tabs.
        if latest and captured < _timestamp(latest['captured_at']) + timedelta(minutes=30):
            return {'recorded': False, 'reason': 'A recent location is already recorded.', 'captured_at': latest['captured_at']}
        return self._insert_location(db, entry, user, location)

    def _location_coverage(self, entry, points):
        """Expose real gaps; never infer movement or manufacture missed pings."""
        start = _timestamp(entry['start'])
        finish = _timestamp(entry['end']) if entry.get('end') else self.now()
        cursor, gaps = start, []
        for point in points:
            captured = min(finish, max(start, _timestamp(point['captured_at'])))
            if captured-cursor > timedelta(minutes=35):
                gaps.append({'start': _iso(cursor), 'end': _iso(captured), 'minutes': round((captured-cursor).total_seconds()/60)})
            cursor = max(cursor, captured)
        if finish-cursor > timedelta(minutes=35) or not points:
            gaps.append({'start': _iso(cursor), 'end': _iso(finish), 'minutes': max(0, round((finish-cursor).total_seconds()/60))})
        return {'interval_minutes': 30, 'gap_tolerance_minutes': 5, 'gaps': gaps,
                'first_at': points[0]['captured_at'] if points else None,
                'last_at': points[-1]['captured_at'] if points else None}


def _rounded(value, settings):
    seconds = settings['rounding_minutes'] * 60
    if not seconds:
        return value
    zone = ZoneInfo(settings['timezone'])
    offset = value.astimezone(zone).utcoffset().total_seconds()
    quotient = (value.timestamp() + offset) / seconds
    mode = settings['rounding_mode']
    rounded = math.floor(quotient + 0.5) if mode == 'nearest' else (math.ceil(quotient) if mode == 'up' else math.floor(quotient))
    return datetime.fromtimestamp(rounded * seconds - offset, UTC)


def break_applies(rule, member_id, start, zone):
    return (not rule['member_ids'] or member_id in rule['member_ids']) and start.astimezone(zone).weekday() in rule['days']


def _available_break_start(start, end, duration, desired, occupied):
    """Choose the nearest free interval, with an earlier start breaking ties."""
    cursor, choices = start, []
    for begin, finish in sorted(occupied) + [(end, end)]:
        if begin - cursor >= duration:
            candidate = min(max(desired, cursor), begin-duration)
            choices.append(candidate)
        cursor = max(cursor, finish)
    return min(choices, key=lambda candidate: (abs(candidate-desired), candidate)) if choices else None


def effective_breaks(entry, settings):
    """Retain manual evidence and derive any still-unmet automatic entitlements.

    Elapsed shift time determines entitlement. Repeated middle breaks are centred
    in equal portions of the completed shift. Each manual matching break satisfies
    one entitlement, and all placed breaks avoid existing intervals.
    """
    zone = ZoneInfo(settings['timezone'])
    result = [dict(item) for item in entry.get('breaks', [])]
    if not entry.get('end'):
        return result, []
    start, end = _timestamp(entry['start'], zone), _timestamp(entry['end'], zone)
    elapsed = int((end-start).total_seconds())
    occupied = [(_timestamp(item['start'], zone), _timestamp(item['end'], zone)) for item in result]
    used, warnings = set(), []
    for rule in settings['breaks']:
        if not rule['automatic'] or not break_applies(rule, entry['member_id'], start, zone):
            continue
        threshold = int(Decimal(rule['after_hours']) * 3600)
        if elapsed < threshold:
            continue
        repeat = int(Decimal(rule['repeat_hours']) * 3600) if rule['repeat_hours'] else None
        count = 1 + (elapsed-threshold)//repeat if repeat else 1
        if count > 50:
            warnings.append(f"{rule['name']}: more than 50 automatic breaks are due; review this long time entry.")
            count = 50
        duration = timedelta(minutes=rule['minutes'])
        satisfied = []
        for index, item in enumerate(entry.get('breaks', [])):
            same_rule = item.get('rule_id') == rule['id']
            legacy_match = not item.get('rule_id') and item['paid'] == rule['paid'] and _timestamp(item['end'], zone)-_timestamp(item['start'], zone) >= duration
            if index not in used and (same_rule or legacy_match):
                satisfied.append(index)
        for index in satisfied[:count]:
            used.add(index)
        for number in range(len(satisfied[:count]), count):
            centre = start + timedelta(seconds=int(elapsed*(number+0.5)/count))
            desired = centre-duration/2 if rule['placement'] == 'middle' else start+timedelta(seconds=threshold+number*(repeat or 0))-duration
            begin = _available_break_start(start, end, duration, desired, occupied)
            if begin is None:
                warnings.append(f"{rule['name']}: the full automatic break cannot fit without overlapping another break.")
                continue
            finish = begin+duration
            occupied.append((begin, finish))
            result.append({'start': _iso(begin), 'end': _iso(finish), 'paid': rule['paid'], 'rule_id': rule['id'],
                           'name': rule['name'], 'code': rule['code'], 'automatic': True})
    return sorted(result, key=lambda item: _timestamp(item['start'], zone)), warnings


def _paid_intervals(entry, settings):
    zone = ZoneInfo(settings['timezone'])
    start, end = _rounded(_timestamp(entry['start'], zone), settings), _rounded(_timestamp(entry['end'], zone), settings)
    cursor = start
    breaks, _ = effective_breaks(entry, settings)
    for item in breaks:
        if item['paid']:
            continue
        begin, finish = max(start, _timestamp(item['start'], zone)), min(end, _timestamp(item['end'], zone))
        if finish <= begin:
            continue
        if begin > cursor:
            yield cursor, begin
        cursor = max(cursor, finish)
    if cursor < end:
        yield cursor, end


def _time_rule_matches(rule, moment, zone):
    local = moment.astimezone(zone)
    minutes = local.hour*60+local.minute
    begin = int(rule['start_time'][:2])*60+int(rule['start_time'][3:])
    end = int(rule['end_time'][:2])*60+int(rule['end_time'][3:])
    if begin < end:
        return local.weekday() in rule['days'] and begin <= minutes < end
    day = (local.weekday()-1)%7 if minutes < end else local.weekday()
    return day in rule['days'] and (minutes >= begin or minutes < end)


def _time_boundaries(rule, cursor, zone):
    date = cursor.astimezone(zone).date()
    for day in (date, date+timedelta(days=1)):
        for text in (rule['start_time'], rule['end_time']):
            local = datetime.combine(day, datetime.min.time()).replace(hour=int(text[:2]), minute=int(text[3:]))
            for fold in (0, 1):
                point = local.replace(tzinfo=zone, fold=fold).astimezone(UTC)
                if point > cursor:
                    yield point


def _day_transition(date, zone):
    """Locate the local offset change so repeated clock minutes get their rate."""
    start = datetime.combine(date, datetime.min.time(), zone).astimezone(UTC)
    end = datetime.combine(date+timedelta(days=1), datetime.min.time(), zone).astimezone(UTC)
    offset = start.astimezone(zone).utcoffset()
    if offset == (end-timedelta(seconds=1)).astimezone(zone).utcoffset():
        return None
    low, high = int(start.timestamp()), int(end.timestamp())
    while high-low > 1:
        middle = (low+high)//2
        if datetime.fromtimestamp(middle, UTC).astimezone(zone).utcoffset() == offset:
            low = middle
        else:
            high = middle
    return datetime.fromtimestamp(high, UTC)


def calculate_payroll(entries, settings, visible_start=None, visible_end=None):
    """Calculate one highest rate per paid second using the current rule version."""
    settings = normalize_settings(settings)
    if not settings['pay_rules_confirmed']:
        return {'status': 'confirmation_required', 'rules_version': settings['version'], 'rows': [], 'message': 'Confirm pay rules before calculating pay.'}
    zone = ZoneInfo(settings['timezone'])
    rules = [rule for rule in settings['overtime_rules'] if rule['enabled']]
    ordinary = {'id': None, 'name': 'Ordinary', 'pay_item': ''}
    daily, weekly, rows, warnings, transitions = defaultdict(int), defaultdict(int), {}, [], {}
    for entry in sorted(entries, key=lambda item: (_timestamp(item['start'], zone), item['id'])):
        if not entry.get('end'):
            continue
        member_id = entry['member_id']
        _, break_warnings = effective_breaks(entry, settings)
        warnings.extend({'entry_id': entry['id'], 'message': warning} for warning in break_warnings)
        shift_start = _timestamp(entry['start'], zone)
        for begin, finish in _paid_intervals(entry, settings):
            cursor = begin
            while cursor < finish:
                local = cursor.astimezone(zone)
                day_key = member_id, local.date()
                week_key = member_id, local.date()-timedelta(days=local.weekday())
                midnight = datetime.combine(local.date()+timedelta(days=1), datetime.min.time(), zone).astimezone(UTC)
                boundary = min(finish, midnight)
                if local.date() not in transitions:
                    transitions[local.date()] = _day_transition(local.date(), zone)
                transition = transitions[local.date()]
                if transition and transition > cursor:
                    boundary = min(boundary, transition)
                matches = [(Decimal('1'), ordinary)]
                for rule in rules:
                    if rule['type'] == 'time':
                        applies = _time_rule_matches(rule, shift_start if rule['run_late'] else cursor, zone)
                        if not rule['run_late']:
                            boundary = min(boundary, *_time_boundaries(rule, cursor, zone))
                    else:
                        count = daily[day_key] if rule['type'] == 'daily' else weekly[week_key]
                        threshold = int(Decimal(rule['threshold_hours'])*3600)
                        if count < threshold:
                            boundary = min(boundary, cursor+timedelta(seconds=threshold-count))
                        applies = local.weekday() in rule['days'] and count >= threshold
                    if applies:
                        matches.append((Decimal(rule['multiplier']), rule))
                if visible_start and cursor < visible_start < boundary:
                    boundary = visible_start
                if visible_end and cursor < visible_end < boundary:
                    boundary = visible_end
                multiplier = max(rate for rate, _ in matches)
                seconds = int((boundary-cursor).total_seconds())
                daily[day_key] += seconds
                weekly[week_key] += seconds
                if (visible_start is None or cursor >= visible_start) and (visible_end is None or cursor < visible_end):
                    row = rows.setdefault(member_id, {'member_id': member_id, 'seconds': 0, 'gross': Decimal(0), 'segments': []})
                    amount = Decimal(seconds)/Decimal(3600)*Decimal(entry['base_rate'])*multiplier
                    # For reporting, attribute each paid second once to the first highest-rate
                    # match in configuration order. Keep all equally paid matches for audit.
                    winners = [rule for rate, rule in matches if rate == multiplier]
                    row['seconds'] += seconds
                    row['gross'] += amount
                    row['segments'].append({'entry_id': entry['id'], 'start': _iso(cursor), 'end': _iso(boundary),
                                            'seconds': seconds, 'multiplier': str(multiplier), 'base_rate': entry['base_rate'],
                                            'applied_rule_id': winners[0]['id'],
                                            'rules': [rule['name'] for rule in winners],
                                            'pay_items': list(dict.fromkeys(rule['pay_item'] for rule in winners if rule['pay_item'])),
                                            'amount': str(amount.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))})
                cursor = boundary
    for row in rows.values():
        row['hours'] = str((Decimal(row['seconds'])/Decimal(3600)).quantize(Decimal('0.0001')))
        row['gross'] = str(row['gross'].quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))
    return {'status': 'calculated', 'rules_version': settings['version'], 'rows': list(rows.values()), 'break_warnings': warnings,
            'message': f'{zone.key} calendar days; highest matching rate; all paid hours count toward weekly overtime. Current rule version applies to this calculation.'}
