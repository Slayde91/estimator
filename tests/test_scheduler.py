"""Durability, authorization, clock concurrency and screenshot payroll boundaries."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest

from estimator.scheduler import SchedulerStore, SchedulerError, DEFAULT_SETTINGS, calculate_payroll, _timestamp


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = datetime(2026, 11, 1, 20, tzinfo=timezone.utc)
        self.path = Path(self.temp.name) / 'scheduler.sqlite3'
        self.store = SchedulerStore(self.path, now=lambda: self.now)
        self.auth = self.store.write('setup', {'name': 'Admin', 'email': 'admin@example.test', 'password': 'correct horse battery'})
        self.token = self.auth['token']

    def write(self, action, value=None, token=None):
        return self.store.write(action, value, token or self.token)

    def member(self, name='Worker'):
        return self.write('members/save', {'name': name, 'email': name.lower() + '@example.test',
                                          'password': 'worker password 123', 'base_rate': '40.00'})

    def state(self, token=None):
        return self.store.read('state', {'start': '2026-11-02', 'end': '2026-11-09'}, token or self.token)

    def assert_error(self, status, call):
        with self.assertRaises(SchedulerError) as caught:
            call()
        self.assertEqual(caught.exception.status_code, status)

    def test_setup_once_and_no_credentials_in_public_state(self):
        self.assert_error(409, lambda: self.store.write('setup', {'name': 'Other'}))
        self.assertFalse(self.store.read('bootstrap')['setup_required'])
        serialized = json.dumps(self.state())
        self.assertNotIn('password_hash', serialized)
        self.assertNotIn('correct horse', serialized)
        self.assert_error(401, lambda: self.store.read('state'))

    def test_password_login_expiry_and_logout(self):
        self.assert_error(401, lambda: self.store.write('login', {'email': 'admin@example.test', 'password': 'wrong password'}))
        token = self.store.write('login', {'email': 'ADMIN@example.test', 'password': 'correct horse battery'})['token']
        self.assertEqual(self.state(token)['user']['name'], 'Admin')
        self.write('logout', {}, token)
        self.assert_error(401, lambda: self.state(token))
        self.now += timedelta(hours=13)
        self.assert_error(401, lambda: self.state())

    def test_login_throttling_survives_rejected_transactions(self):
        for _ in range(5):
            self.assert_error(401, lambda: self.store.write('login', {'email': 'admin@example.test', 'password': 'wrong password'}))
        self.assert_error(429, lambda: self.store.write('login', {'email': 'admin@example.test', 'password': 'correct horse battery'}))
        self.now += timedelta(minutes=16)
        self.assertIn('token', self.store.write('login', {'email': 'admin@example.test', 'password': 'correct horse battery'}))

    def test_member_conflicts_rate_snapshots_and_last_admin(self):
        worker = self.member()
        updated = self.write('members/save', {**worker, 'base_rate': '45'})
        self.assertEqual(updated['version'], 2)
        self.assert_error(409, lambda: self.write('members/save', worker))
        self.assert_error(400, lambda: self.write('members/save', {**self.auth['user'], 'role': 'worker'}))
        self.assert_error(409, lambda: self.member())

    def test_shift_persistence_and_optimistic_update(self):
        worker = self.member()
        shift = self.write('shifts/save', {'title': 'Install batt', 'start': '2026-11-02T07:00', 'end': '2026-11-02T15:30',
                                           'member_ids': [worker['id']], 'published': True})
        reopened = SchedulerStore(self.path, now=lambda: self.now)
        self.assertEqual(reopened.read('state', {'start': '2026-11-02', 'end': '2026-11-09'}, self.token)['shifts'][0]['id'], shift['id'])
        changed = self.write('shifts/save', {**shift, 'title': 'New title'})
        self.assert_error(409, lambda: self.write('shifts/delete', {'id': shift['id'], 'version': shift['version']}))
        self.write('shifts/delete', {'id': changed['id'], 'version': changed['version']})
        self.assertEqual(self.state()['shifts'], [])

    def test_worker_cannot_admin_or_read_other_entries(self):
        worker = self.member()
        token = self.store.write('login', {'email': worker['email'], 'password': 'worker password 123'})['token']
        self.assert_error(403, lambda: self.write('members/save', {}, token))
        self.assert_error(403, lambda: self.write('entries/save', {}, token))
        self.write('clock/in')
        self.assertEqual(self.state(token)['entries'], [])
        admin = next(item for item in self.state(token)['members'] if item['role'] == 'admin')
        self.assertNotIn('base_rate', admin)

    def test_clock_uses_server_time_and_unique_active_entry(self):
        def clock():
            try:
                return self.write('clock/in')
            except SchedulerError as error:
                return error.status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: clock(), range(2)))
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertIn(409, results)
        entry = self.state()['active_entry']
        self.assertEqual(entry['start'], '2026-11-01T20:00:00Z')
        self.now += timedelta(hours=8)
        closed = self.write('clock/out')
        self.assertEqual(closed['end'], '2026-11-02T04:00:00Z')
        self.assertIsNone(self.state()['active_entry'])
        self.assert_error(409, lambda: self.write('clock/out'))

    def test_unknown_fields_and_stale_clock_commands_rejected(self):
        self.assert_error(400, lambda: self.write('clock/in', {'start': '2000-01-01T00:00:00Z'}))
        entry = self.write('clock/in')
        self.now += timedelta(seconds=20)
        self.assert_error(409, lambda: self.write('clock/out', {'entry_id': 'wrong-session'}))
        self.write('clock/break', {'action': 'start', 'entry_id': entry['id'], 'version': entry['version']})
        self.assert_error(409, lambda: self.write('clock/out', {'entry_id': entry['id'], 'version': entry['version']}))

    def test_breaks_and_raw_entry_are_retained(self):
        self.write('clock/in')
        self.now += timedelta(hours=3)
        self.write('clock/break', {'action': 'start', 'paid': False})
        self.now += timedelta(minutes=30)
        self.write('clock/break', {'action': 'end'})
        self.now += timedelta(hours=4, minutes=30)
        self.write('clock/out')
        state = self.state()
        self.assertEqual(state['payroll']['rows'][0]['seconds'], 7.5 * 3600)
        self.assertEqual(state['entries'][0]['breaks'][0]['start'], '2026-11-01T23:00:00Z')

    def test_location_requires_own_active_consent_and_current_timestamp(self):
        location = {'latitude': -33.86, 'longitude': 151.2, 'accuracy': 10}
        self.assert_error(403, lambda: self.write('locations', location))
        self.write('clock/in')
        self.assert_error(403, lambda: self.write('locations', location))
        self.now += timedelta(seconds=5)
        self.write('clock/out')
        self.now += timedelta(seconds=5)
        entry = self.write('clock/in', {'location_consent': True})
        self.assertTrue(self.write('locations', location)['recorded'])
        self.assertFalse(self.write('locations', location)['recorded'])
        self.assert_error(400, lambda: self.write('locations', {**location, 'captured_at': '2026-10-01T00:00:00Z'}))
        worker = self.member()
        token = self.store.write('login', {'email': worker['email'], 'password': 'worker password 123'})['token']
        self.assert_error(403, lambda: self.store.read('locations', {'entry_id': entry['id']}, token))
        self.assertEqual(len(self.store.read('locations', {'entry_id': entry['id']}, self.token)['locations']), 1)
        self.now += timedelta(seconds=10)
        self.write('clock/out')
        self.assert_error(403, lambda: self.write('locations', location))

    def test_manual_entries_overlap_break_validation_and_audit(self):
        entry = self.write('entries/save', {'member_id': self.auth['user']['id'], 'start': '2026-11-02T08:00', 'end': '2026-11-02T16:00'})
        self.assert_error(409, lambda: self.write('entries/save', {'member_id': self.auth['user']['id'], 'start': '2026-11-02T15:00', 'end': '2026-11-02T17:00'}))
        self.assert_error(400, lambda: self.write('entries/save', {**entry, 'breaks': [{'start': '2026-11-02T07:00', 'end': '2026-11-02T09:00', 'paid': False}]}))
        self.write('entries/delete', {'id': entry['id'], 'version': entry['version']})
        with self.store.connect() as db:
            audit = db.execute("SELECT before_data FROM scheduler_audit WHERE action='entry.delete'").fetchone()
        self.assertEqual(json.loads(audit[0])['start'], entry['start'])

    def test_settings_conflict_invalid_durations_and_unsupported_policy(self):
        settings = self.state()['settings']
        self.assert_error(400, lambda: self.write('settings', {**settings, 'breaks': [{'name': 'Break', 'minutes': 2.5, 'paid': False}]}))
        self.assert_error(400, lambda: self.write('settings', {**settings, 'overlap_rule': 'additive'}))
        saved = self.write('settings', {**settings, 'rounding_minutes': 15})
        self.assertEqual(saved['version'], settings['version'] + 1)
        self.assert_error(409, lambda: self.write('settings', settings))


class PayrollTests(unittest.TestCase):
    def entry(self, start, end, **extra):
        return {'id': start, 'member_id': 'worker', 'start': start, 'end': end, 'breaks': [], 'base_rate': '40', **extra}

    def pay(self, entries, **settings):
        return calculate_payroll(entries, {**deepcopy(DEFAULT_SETTINGS), **settings})['rows'][0]

    def test_daily_eight_and_ten_hour_boundaries(self):
        pay = self.pay([self.entry('2026-11-02T07:00', '2026-11-02T18:00')])
        self.assertEqual(pay['gross'], '520.00')
        self.assertEqual(pay['seconds'], 11 * 3600)
        self.assertEqual([item['multiplier'] for item in pay['segments']], ['1', '1', '1.5', '2'])

    def test_daily_accumulates_across_separate_entries(self):
        pay = self.pay([self.entry('2026-11-02T03:00', '2026-11-02T07:00'), self.entry('2026-11-02T08:00', '2026-11-02T14:00')])
        self.assertEqual(pay['gross'], '440.00')

    def test_saturday_first_two_hours_then_double(self):
        pay = self.pay([self.entry('2026-11-07T07:00', '2026-11-07T12:00')])
        self.assertEqual(pay['gross'], '360.00')

    def test_sunday_highest_only(self):
        pay = self.pay([self.entry('2026-11-08T15:00', '2026-11-08T23:00')])
        self.assertEqual(pay['gross'], '640.00')
        self.assertTrue(all(segment['multiplier'] == '2' for segment in pay['segments']))

    def test_shift_starts_in_window_applies_whole_shift(self):
        pay = self.pay([self.entry('2026-11-02T14:00', '2026-11-02T22:00')])
        self.assertEqual(pay['gross'], '480.00')
        day = self.pay([self.entry('2026-11-02T12:00', '2026-11-02T20:00')])
        self.assertEqual(day['gross'], '320.00')
        night = self.pay([self.entry('2026-11-02T22:00', '2026-11-03T06:00')])
        self.assertEqual(night['gross'], '480.00')

    def test_weekly_counts_all_hours_and_does_not_add_penalties(self):
        entries = [self.entry(f'2026-11-{day:02}T07:00', f'2026-11-{day:02}T17:00') for day in range(2, 7)]
        pay = self.pay(entries)
        self.assertEqual(pay['gross'], '2360.00')
        friday = [segment for segment in pay['segments'] if segment['start'].startswith('2026-11-05T20')]
        self.assertEqual(friday[0]['multiplier'], '1.5')

    def test_week_resets_monday(self):
        pay = self.pay([self.entry('2026-11-08T07:00', '2026-11-08T17:00'), self.entry('2026-11-09T07:00', '2026-11-09T15:00')])
        self.assertEqual(pay['gross'], '1120.00')

    def test_unpaid_break_removed_paid_break_retained_and_input_unchanged(self):
        entry = self.entry('2026-11-02T07:00', '2026-11-02T16:00', breaks=[
            {'start': '2026-11-02T10:00', 'end': '2026-11-02T10:15', 'paid': True},
            {'start': '2026-11-02T12:00', 'end': '2026-11-02T12:30', 'paid': False}])
        original = deepcopy(entry)
        pay = self.pay([entry])
        self.assertEqual(pay['gross'], '350.00')
        self.assertEqual(entry, original)

    def test_rounding_raw_preserved_and_visible_range_has_week_context(self):
        entries = [self.entry(f'2026-11-{day:02}T07:00', f'2026-11-{day:02}T17:00') for day in range(2, 7)]
        result = calculate_payroll(entries, DEFAULT_SETTINGS, _timestamp('2026-11-06'), _timestamp('2026-11-07'))['rows'][0]
        self.assertEqual(result['gross'], '600.00')
        entry = self.entry('2026-11-02T07:07', '2026-11-02T15:08')
        pay = self.pay([entry], rounding_minutes=15)
        self.assertEqual(pay['seconds'], 8.25*3600)
        self.assertEqual(entry['start'], '2026-11-02T07:07')

    def test_daylight_saving_uses_real_duration_and_rejects_ambiguous_local(self):
        for value in ('2026-10-04T02:30', '2026-04-05T02:30'):
            with self.assertRaises(SchedulerError):
                _timestamp(value)
        pay = self.pay([self.entry('2026-10-04T00:00:00+10:00', '2026-10-04T04:00:00+11:00')])
        self.assertEqual(pay['seconds'], 3*3600)
        self.assertEqual(pay['gross'], '240.00')
        pay = self.pay([self.entry('2026-04-05T00:00:00+11:00', '2026-04-05T04:00:00+10:00')])
        self.assertEqual(pay['seconds'], 5*3600)


if __name__ == '__main__':
    unittest.main()
