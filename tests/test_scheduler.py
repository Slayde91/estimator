"""Durability, authorization, clock concurrency and screenshot payroll boundaries."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

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
        if action == 'clock/in':
            value = {'location_consent': True, 'location': self.location(), **(value or {})}
        return self.store.write(action, value, token or self.token)

    def location(self):
        return {'latitude': -33.8688, 'longitude': 151.2093, 'accuracy': 10, 'captured_at': self.now.isoformat()}

    def member(self, name='Worker'):
        return self.write('members/save', {'name': name, 'email': name.lower() + '@example.test',
                                          'password': 'worker password 123', 'base_rate': '40.00'})

    def state(self, token=None):
        return self.store.read('state', {'start': '2026-11-02', 'end': '2026-11-09'}, token or self.token)

    def assert_error(self, status, call):
        with self.assertRaises(SchedulerError) as caught:
            call()
        self.assertEqual(caught.exception.status_code, status)

    def test_organization_zone_reassigns_members_and_recalculates_recorded_work(self):
        worker = self.member()
        original = self.store.read('organization',token=self.token)
        self.assertEqual(original['timezone'], 'Australia/Sydney')
        self.assertIn('Asia/Kathmandu', original['zones'])
        entry = self.write('entries/save', {'member_id': worker['id'], 'start': '2026-11-06T14:00:00Z',
                                             'end': '2026-11-06T15:00:00Z'})
        self.assertEqual(self.state()['payroll']['rows'][0]['gross'], '60.00')
        with self.assertRaises(SchedulerError):
            self.write('organization', {'timezone': 'Mars/City', 'version': original['version']})
        self.write('organization', {'timezone': 'America/New_York', 'version': original['version']})
        revised = self.state()
        self.assertEqual(revised['entries'][0]['start'], entry['start'])
        self.assertEqual(revised['payroll']['rows'][0]['gross'], '40.00')
        self.assertTrue(all(person['timezone']=='America/New_York' for person in revised['members']))
        self.assertEqual(self.member('Additional')['timezone'], 'America/New_York')
        self.assert_error(409, lambda: self.write('organization', {'timezone':'UTC','version':original['version']}))
        self.assert_error(409, lambda: self.write('entries/save', {'member_id':worker['id'], 'input_timezone':'Australia/Sydney',
                                                                    'start':'2026-11-08T08:00','end':'2026-11-08T09:00'}))
        for missing_or_repeated in ('2026-03-08T02:15', '2026-11-01T01:15'):
            self.assert_error(400, lambda: self.write('entries/save', {'member_id':worker['id'],
                'start': missing_or_repeated, 'end':missing_or_repeated[:10]+'T04:00'}))
        fallback = self.write('entries/save', {'member_id':worker['id'], 'start':'2026-11-01T00:00','end':'2026-11-01T04:00'})
        self.assertEqual((fallback['start'], fallback['end']), ('2026-11-01T04:00:00Z','2026-11-01T09:00:00Z'))
        token = self.store.write('login', {'email':worker['email'], 'password':'worker password 123'})['token']
        self.assert_error(403, lambda: self.store.write('organization', {'timezone':'UTC','version':revised['settings']['version']}, token))

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

    def test_shift_create_retry_replays_durable_response_without_duplicate(self):
        payload = {'request_id': str(uuid.uuid4()), 'title': 'Lost response',
                   'start': '2026-11-02T07:00', 'end': '2026-11-02T15:30',
                   'member_ids': [], 'published': True}
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(lambda _: self.write('shifts/save', payload), range(2)))
        self.assertEqual(responses[0], responses[1])
        reopened = SchedulerStore(self.path, now=lambda: self.now)
        replay = reopened.write('shifts/save', dict(reversed(list(payload.items()))), self.token)
        self.assertEqual(replay, responses[0])
        self.assertEqual(len(self.state()['shifts']), 1)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM scheduler_audit WHERE action='shift.create'").fetchone()[0], 1)
        self.assert_error(409, lambda: self.write('shifts/save', {**payload, 'title': 'Changed after retry'}))
        self.assertEqual(self.state()['shifts'][0]['title'], 'Lost response')
        self.assert_error(400, lambda: self.write('shifts/save', {**responses[0], 'request_id': payload['request_id']}))

    def test_failed_shift_create_does_not_reserve_retry_receipt(self):
        payload = {'request_id': str(uuid.uuid4()), 'title': '', 'start': '2026-11-02T07:00', 'end': '2026-11-02T15:30'}
        self.assert_error(400, lambda: self.write('shifts/save', payload))
        saved = self.write('shifts/save', {**payload, 'title': 'Corrected invalid request'})
        self.assertEqual(saved['title'], 'Corrected invalid request')
        self.assert_error(400, lambda: self.write('shifts/save', {**payload, 'request_id': 'not-a-uuid'}))

    def test_worker_cannot_admin_or_read_other_entries(self):
        worker = self.member()
        token = self.store.write('login', {'email': worker['email'], 'password': 'worker password 123'})['token']
        self.assert_error(403, lambda: self.write('members/save', {}, token))
        self.assert_error(403, lambda: self.write('entries/save', {}, token))
        self.write('clock/in')
        self.assertEqual(self.state(token)['entries'], [])
        self.assertEqual([member['id'] for member in self.state(token)['members']], [worker['id']])

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
        location = self.location()
        self.assert_error(403, lambda: self.write('locations', location))
        entry = self.write('clock/in', {'location_consent': True})
        self.assert_error(400, lambda: self.write('locations', location))
        self.now += timedelta(minutes=30)
        location = self.location()
        location['entry_id'] = entry['id']
        self.assertTrue(self.write('locations', location)['recorded'])
        self.assertFalse(self.write('locations', location)['recorded'])
        self.assert_error(400, lambda: self.write('locations', {**location, 'captured_at': (self.now + timedelta(seconds=20)).isoformat()}))
        self.assert_error(400, lambda: self.write('locations', {**location, 'captured_at': '2026-10-01T00:00:00Z'}))
        worker = self.member()
        token = self.store.write('login', {'email': worker['email'], 'password': 'worker password 123'})['token']
        self.assert_error(403, lambda: self.store.read('locations', {'entry_id': entry['id']}, token))
        self.assertEqual(len(self.store.read('locations', {'entry_id': entry['id']}, self.token)['locations']), 2)
        self.now += timedelta(seconds=10)
        closed = self.write('clock/out')
        self.assert_error(403, lambda: self.write('locations', location))
        self.assert_error(400, lambda: self.write('entries/save', {**closed, 'start': (self.now - timedelta(seconds=1)).isoformat()}))

    def test_stale_location_watcher_cannot_follow_another_user_or_clock_session(self):
        first = self.write('clock/in', {'location_consent': True})
        location = {'entry_id': first['id'], **self.location()}
        worker = self.member()
        worker_token = self.store.write('login', {'email': worker['email'], 'password': 'worker password 123'})['token']
        second = self.write('clock/in', {'location_consent': True}, worker_token)
        self.assert_error(409, lambda: self.write('locations', location, worker_token))
        self.assertEqual(len(self.store.read('locations', {'entry_id': second['id']}, worker_token)['locations']), 1)
        self.now += timedelta(minutes=30)
        second_location = {**self.location(), 'entry_id': second['id']}
        self.assertTrue(self.write('locations', second_location, worker_token)['recorded'])
        self.now += timedelta(seconds=20)
        self.write('clock/out', {}, worker_token)
        self.now += timedelta(seconds=20)
        third = self.write('clock/in', {'location_consent': True}, worker_token)
        self.assert_error(409, lambda: self.write('locations', second_location, worker_token))
        self.assertEqual(len(self.store.read('locations', {'entry_id': third['id']}, worker_token)['locations']), 1)

    def test_periodic_locations_are_half_hourly_across_tabs_retries_and_restarts(self):
        entry = self.write('clock/in')
        first = self.location()['captured_at']
        self.now += timedelta(minutes=29, seconds=59)
        early = self.write('locations', {'entry_id': entry['id'], **self.location()})
        self.assertFalse(early['recorded'])
        self.assertEqual(_timestamp(early['captured_at']), _timestamp(first))
        self.now += timedelta(seconds=1)
        payload = {'entry_id': entry['id'], **self.location()}
        reopened = SchedulerStore(self.path, now=lambda: self.now)
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(lambda store: store.write('locations', payload, self.token), [self.store, reopened]))
        self.assertEqual(sorted(result['recorded'] for result in responses), [False, True])
        self.assertFalse(reopened.write('locations', payload, self.token)['recorded'])
        self.now += timedelta(minutes=29, seconds=59)
        self.assertFalse(self.write('locations/enable', {'entry_id': entry['id'], **self.location()})['recorded'])
        self.now += timedelta(seconds=1)
        self.assertTrue(self.write('locations', {'entry_id': entry['id'], **self.location()})['recorded'])
        history = self.store.read('locations', {'entry_id': entry['id']}, self.token)
        self.assertEqual(len(history['locations']), 3)
        self.assertEqual(history['coverage']['gaps'], [])

    def test_clock_out_final_fix_bypasses_periodic_cadence_and_is_atomic(self):
        entry = self.write('clock/in')
        self.now += timedelta(minutes=1)
        payload = {'entry_id': entry['id'], 'location': self.location()}
        for location in ({}, {**self.location(), 'accuracy': -1},
                         {**self.location(), 'captured_at': (self.now-timedelta(minutes=3)).isoformat()}):
            self.assert_error(400, lambda: self.write('clock/out', {**payload, 'location': location}))
            self.assertEqual(self.state()['active_entry']['id'], entry['id'])
        self.assert_error(409, lambda: self.write('clock/out', {**payload, 'entry_id': 'different-session'}))
        with patch.object(self.store, '_insert_location', side_effect=RuntimeError('Synthetic storage failure')):
            with self.assertRaises(RuntimeError):
                self.write('clock/out', payload)
        self.assertEqual(self.state()['active_entry']['id'], entry['id'])
        self.assertEqual(self.state()['active_entry']['location_summary']['count'], 1)
        closed = self.write('clock/out', payload)
        self.assertIsNone(self.state()['active_entry'])
        history = self.store.read('locations', {'entry_id': entry['id']}, self.token)
        self.assertEqual(len(history['locations']), 2)
        self.assertEqual(history['locations'][-1]['captured_at'], closed['end'])
        self.assert_error(409, lambda: self.write('clock/out', payload))
        self.assertEqual(len(self.store.read('locations', {'entry_id': entry['id']}, self.token)['locations']), 2)

    def test_clock_out_reuses_same_second_fix_and_still_accepts_no_location(self):
        entry = self.write('clock/in')
        self.now += timedelta(minutes=30)
        self.write('locations', {'entry_id': entry['id'], **self.location()})
        self.write('clock/out', {'entry_id': entry['id'], 'location': self.location()})
        self.assertEqual(len(self.store.read('locations', {'entry_id': entry['id']}, self.token)['locations']), 2)
        self.now += timedelta(seconds=1)
        next_entry = self.write('clock/in')
        self.now += timedelta(minutes=1)
        self.write('clock/out', {'entry_id': next_entry['id']})
        self.assertEqual(len(self.store.read('locations', {'entry_id': next_entry['id']}, self.token)['locations']), 1)

    def test_clock_in_requires_a_fresh_valid_location_and_saves_it_atomically(self):
        for payload in ({}, {'location_consent': False, 'location': self.location()},
                        {'location_consent': True}, {'location_consent': True, 'location': {**self.location(), 'accuracy': -1}},
                        {'location_consent': True, 'location': {**self.location(), 'captured_at': (self.now-timedelta(minutes=3)).isoformat()}},
                        {'location_consent': True, 'location': {**self.location(), 'captured_at': (self.now+timedelta(seconds=1)).isoformat()}}):
            with self.subTest(payload=payload):
                self.assert_error(400, lambda: self.store.write('clock/in', payload, self.token))
                self.assertIsNone(self.state()['active_entry'])
        fix = {**self.location(), 'captured_at': (self.now-timedelta(seconds=2)).isoformat()}
        entry = self.write('clock/in', {'location': fix})
        history = self.store.read('locations', {'entry_id': entry['id']}, self.token)
        self.assertEqual(history['locations'][0]['captured_at'], '2026-11-01T19:59:58Z')
        self.assertEqual(history['coverage']['gaps'], [])
        self.assertEqual(self.state()['active_entry']['location_summary']['count'], 1)
        self.now += timedelta(hours=1)
        closed = self.write('clock/out')
        edited = self.write('entries/save', {**closed, 'notes': 'Keep original verified clock-in'})
        self.assertEqual(edited['start'], entry['start'])

    def test_administrator_history_gaps_and_heartbeat_session_renewal(self):
        worker = self.member()
        token = self.store.write('login', {'email': worker['email'], 'password': 'worker password 123'})['token']
        entry = self.write('clock/in', token=token)
        self.now += timedelta(minutes=30)
        self.write('locations', {'entry_id': entry['id'], **self.location()}, token)
        self.now += timedelta(minutes=70)
        self.write('locations', {'entry_id': entry['id'], **self.location()}, token)
        history = self.store.read('locations', {'entry_id': entry['id']}, self.token)
        self.assertEqual(len(history['locations']), 3)
        self.assertEqual([gap['minutes'] for gap in history['coverage']['gaps']], [70])
        # Successful fresh heartbeats keep this existing local session alive for long shifts.
        self.now += timedelta(hours=10)
        self.write('locations', {'entry_id': entry['id'], **self.location()}, token)
        self.now += timedelta(hours=10)
        self.assertEqual(self.store.read('bootstrap', {}, token)['user']['id'], worker['id'])
        self.write('clock/out', token=token)
        self.assert_error(403, lambda: self.write('locations', {'entry_id': entry['id'], **self.location()}, token))
        self.now += timedelta(hours=3)
        self.assertIsNone(self.store.read('bootstrap', {}, token)['user'])

    def test_legacy_active_shift_can_resume_mandatory_tracking_without_new_entry(self):
        entry = self.write('clock/in')
        with self.store.connect() as db:
            row = db.execute('SELECT data FROM scheduler_records WHERE id=?', (entry['id'],)).fetchone()
            legacy = json.loads(row[0]); legacy['location_consent'] = False
            db.execute('UPDATE scheduler_records SET data=? WHERE id=?', (json.dumps(legacy), entry['id']))
            db.execute('DELETE FROM scheduler_locations WHERE entry_id=?', (entry['id'],))
        self.now += timedelta(hours=1)
        self.assert_error(403, lambda: self.write('locations', {'entry_id': entry['id'], **self.location()}))
        self.assertTrue(self.write('locations/enable', {'entry_id': entry['id'], **self.location()})['recorded'])
        self.assertEqual(self.state()['active_entry']['id'], entry['id'])
        self.assertTrue(self.state()['active_entry']['location_consent'])
        self.assertEqual(self.store.read('locations', {'entry_id': entry['id']}, self.token)['coverage']['gaps'][0]['minutes'], 60)
        self.now += timedelta(minutes=1)
        self.assertFalse(self.write('locations/enable', {'entry_id': entry['id'], **self.location()})['recorded'])
        self.assertEqual(self.state()['active_entry']['location_summary']['count'], 1)

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

    def test_manual_reassignment_captures_new_members_rate(self):
        worker = self.member()
        entry = self.write('entries/save', {'member_id': self.auth['user']['id'], 'start': '2026-11-02T08:00', 'end': '2026-11-02T16:00'})
        moved = self.write('entries/save', {**entry, 'member_id': worker['id']})
        self.assertEqual(moved['base_rate'], '40.00')
        self.write('members/save', {**worker, 'base_rate': '45.00'})
        retained = self.write('entries/save', {**moved, 'notes': 'Corrected note'})
        self.assertEqual(retained['base_rate'], '40.00')
        self.assert_error(400, lambda: self.write('entries/delete', {'id': {}, 'version': 1}))

    def test_read_filters_boolean_fields_and_dates_validate_strictly(self):
        self.assert_error(400, lambda: self.store.read('state', {'star': '2026-11-02'}, self.token))
        self.assert_error(400, lambda: self.store.read('bootstrap', []))
        self.assert_error(400, lambda: self.write('logout', []))
        self.assert_error(400, lambda: self.write('clock/in', {'location_consent': 1}))
        self.assert_error(400, lambda: self.write('members/save', {'name': 'Invalid', 'email': 'invalid@example.test', 'password': 'long-password-123', 'active': 'false'}))
        for stamp in ('2026-02-30T07:00', '2099-garbage', '9999-12-31T00:00Z', None, [], True):
            self.assert_error(400, lambda: self.write('entries/save', {'member_id': self.auth['user']['id'], 'start': stamp, 'end': '2026-11-02T17:00'}))

    def test_manual_entry_cannot_overlap_active_clock_or_future_record(self):
        self.write('clock/in')
        self.assert_error(409, lambda: self.write('entries/save', {'member_id': self.auth['user']['id'], 'start': '2026-11-02T08:00', 'end': '2026-11-02T16:00'}))
        self.now += timedelta(minutes=1)
        self.write('clock/out')
        self.write('entries/save', {'member_id': self.auth['user']['id'], 'start': '2026-11-03T08:00', 'end': '2026-11-03T16:00'})
        self.assert_error(409, lambda: self.write('clock/in'))

    def test_overdue_clock_can_be_closed_after_seven_days(self):
        self.write('clock/in')
        self.now += timedelta(days=8)
        self.token = self.store.write('login', {'email': 'admin@example.test', 'password': 'correct horse battery'})['token']
        closed = self.write('clock/out')
        self.assertEqual((_timestamp(closed['end']) - _timestamp(closed['start'])).days, 8)
        self.assertIsNone(self.state()['active_entry'])


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
