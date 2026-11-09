"""Configurable pay/break rules preserve recorded evidence and project authority."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest

from estimator.scheduler import (DEFAULT_SETTINGS, SchedulerError, SchedulerStore,
                                 calculate_payroll, effective_breaks, normalize_settings,
                                 validate_rules, _timestamp)


def settings(**changes):
    return normalize_settings({**deepcopy(DEFAULT_SETTINGS), **changes})


def entry(start='2026-11-02T07:00', end='2026-11-02T15:00', **changes):
    return {'id': start, 'member_id': 'worker', 'start': start, 'end': end,
            'breaks': [], 'base_rate': '40', **changes}


def overtime(**changes):
    return {'id': 'custom', 'name': 'Custom overtime', 'type': 'daily', 'days': list(range(7)),
            'threshold_hours': '6', 'multiplier': '2.25', 'pay_item': 'Custom pay item',
            'start_time': '22:00', 'end_time': '06:00', 'run_late': False, 'enabled': True, **changes}


def break_rule(**changes):
    return {'id': 'meal', 'name': 'Meal break', 'code': 'MEAL', 'minutes': 15, 'paid': False,
            'member_ids': [], 'automatic': True, 'after_hours': '4', 'repeat_hours': '4',
            'days': [0, 1, 2, 3, 4], 'placement': 'middle', 'manual': True,
            'auto_end': False, 'minimum': False, 'notify_minutes': 0, **changes}


class SchedulerRuleCalculations(unittest.TestCase):
    def test_legacy_settings_keep_manual_breaks_and_original_overtime(self):
        legacy = {key: value for key, value in DEFAULT_SETTINGS.items() if key not in ('overtime_rules', 'rules_schema_version')}
        normalized = normalize_settings(legacy)
        self.assertEqual(len(normalized['overtime_rules']), 8)
        self.assertTrue(all(not rule['automatic'] for rule in normalized['breaks']))
        pay = calculate_payroll([entry(end='2026-11-02T17:00')], legacy)['rows'][0]
        self.assertEqual(pay['gross'], '440.00')

    def test_custom_daily_and_weekly_rules_and_pay_item_labels(self):
        policy = settings(overtime_rules=[overtime()])
        pay = calculate_payroll([entry()], policy)
        self.assertEqual(pay['rows'][0]['gross'], '420.00')
        self.assertEqual(pay['rows'][0]['segments'][-1]['pay_items'], ['Custom pay item'])
        policy = settings(overtime_rules=[overtime(type='weekly', threshold_hours='12', multiplier='1.5')])
        pay = calculate_payroll([entry(), entry('2026-11-03T07:00', '2026-11-03T15:00')], policy)
        self.assertEqual(pay['rows'][0]['gross'], '720.00')

    def test_time_windows_and_run_late_across_midnight(self):
        policy = settings(overtime_rules=[overtime(type='time', days=[0], multiplier='1.5')])
        pay = calculate_payroll([entry('2026-11-02T21:00', '2026-11-03T07:00')], policy)
        self.assertEqual(pay['rows'][0]['gross'], '560.00')
        policy['overtime_rules'][0]['run_late'] = True
        pay = calculate_payroll([entry('2026-11-02T23:00', '2026-11-03T09:00')], policy)
        self.assertEqual(pay['rows'][0]['gross'], '600.00')

    def test_time_window_respects_both_daylight_saving_folds(self):
        policy = settings(overtime_rules=[overtime(type='time', days=[6], start_time='02:00', end_time='03:00', multiplier='2')])
        spring = calculate_payroll([entry('2026-10-04T00:00+10:00', '2026-10-04T04:00+11:00')], policy)
        self.assertEqual(spring['rows'][0]['gross'], '120.00')
        autumn = calculate_payroll([entry('2026-04-05T00:00+11:00', '2026-04-05T04:00+10:00')], policy)
        self.assertEqual(autumn['rows'][0]['gross'], '280.00')
        policy['overtime_rules'][0].update(start_time='01:30', end_time='02:30')
        repeated = calculate_payroll([entry('2026-04-05T00:00+11:00', '2026-04-05T04:00+10:00')], policy)
        self.assertEqual(repeated['rows'][0]['gross'], '260.00')

    def test_automatic_repeat_is_derived_once_without_changing_raw_evidence(self):
        policy = settings(breaks=[break_rule()])
        raw = entry()
        original = deepcopy(raw)
        breaks, warnings = effective_breaks(raw, policy)
        self.assertEqual(warnings, [])
        self.assertEqual(len(breaks), 2)
        self.assertEqual([item['start'] for item in breaks], ['2026-11-01T21:52:30Z', '2026-11-02T01:52:30Z'])
        pay = calculate_payroll([raw], policy)['rows'][0]
        self.assertEqual(pay['gross'], '300.00')
        self.assertEqual(raw, original)
        self.assertEqual(calculate_payroll([raw], policy)['rows'][0], pay)

    def test_manual_break_satisfies_one_auto_entitlement_and_never_overlaps(self):
        policy = settings(breaks=[break_rule()])
        raw = entry(breaks=[{'start': '2026-11-02T11:00', 'end': '2026-11-02T11:15', 'paid': False, 'rule_id': 'meal'}])
        breaks, _ = effective_breaks(raw, policy)
        self.assertEqual(sum(bool(item.get('automatic')) for item in breaks), 1)
        self.assertEqual(calculate_payroll([raw], policy)['rows'][0]['gross'], '300.00')
        intervals = sorted((_timestamp(item['start']), _timestamp(item['end'])) for item in breaks)
        self.assertLessEqual(intervals[0][1], intervals[1][0])

    def test_automatic_days_members_paid_breaks_and_fit_warnings(self):
        policy = settings(breaks=[break_rule(member_ids=['someone-else'])])
        self.assertEqual(effective_breaks(entry(), policy)[0], [])
        policy = settings(breaks=[break_rule(paid=True)])
        self.assertEqual(calculate_payroll([entry()], policy)['rows'][0]['gross'], '320.00')
        self.assertEqual(effective_breaks(entry('2026-11-07T07:00', '2026-11-07T15:00'), policy)[0], [])
        policy = settings(breaks=[break_rule(minutes=180, after_hours='3', repeat_hours='3'), break_rule(id='other', minutes=180, after_hours='3', repeat_hours=None)])
        self.assertTrue(effective_breaks(entry(end='2026-11-02T11:00'), policy)[1])

    def test_invalid_rules_rejected_before_saving(self):
        invalid = [settings(breaks=[break_rule(minutes=None)]), settings(breaks=[break_rule(minutes=15, repeat_hours='0.1')]),
                   settings(breaks=[break_rule(notify_minutes=15)]), settings(overtime_rules=[overtime(multiplier='NaN')]),
                   settings(overtime_rules=[overtime(days=[])]), settings(overtime_rules=[overtime(), overtime()])]
        for policy in invalid:
            with self.subTest(policy=policy), self.assertRaises(SchedulerError):
                validate_rules(policy, {'worker'})


class SchedulerRulePersistence(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = datetime(2026, 11, 1, 20, tzinfo=timezone.utc)
        self.order = {'id':'wo-a', 'revision':'revision-a', 'reference':'WO-02', 'client':'Fixture client',
                      'site_address':'12 Site Street', 'status':'Draft', 'version':1}
        def lookup(identity, revision):
            if (identity, revision) != (self.order['id'], self.order['revision']):
                raise ValueError('Stale')
            return dict(self.order)
        self.store = SchedulerStore(Path(self.temp.name)/'scheduler.sqlite3', now=lambda: self.now, work_order_lookup=lookup)
        auth = self.store.write('setup', {'name': 'Admin', 'email': 'admin@example.test', 'password': 'correct password 123'})
        self.token, self.user = auth['token'], auth['user']

    def write(self, action, payload):
        if action == 'clock/in':
            payload = {'location_consent': True, 'location': {'latitude': -33.8688, 'longitude': 151.2093, 'accuracy': 10, 'captured_at': self.now.isoformat()}, **payload}
        return self.store.write(action, payload, self.token)

    def state(self):
        return self.store.read('state', {'start': '2026-11-02', 'end': '2026-11-09'}, self.token)

    def test_work_order_assignment_and_legacy_snapshot_survive_unrelated_edits(self):
        selection = {key:self.order[key] for key in ('id','revision')}
        payload = {'title':'Install', 'start':'2026-11-02T07:00', 'end':'2026-11-02T15:00', 'work_order':selection}
        saved = self.write('shifts/save', payload)
        self.assertEqual(saved['location'], '12 Site Street')
        self.assertEqual(saved['work_order'], self.order)
        self.order.update(status='Completed', revision='revision-b', version=2)
        with self.assertRaises(SchedulerError):
            self.write('shifts/save', payload)
        edit = {key:value for key,value in saved.items() if key != 'work_order'}
        retained = self.write('shifts/save', {**edit,'location':'Custom gate'})
        self.assertEqual(retained['work_order'],saved['work_order'])
        self.assertEqual(retained['location'],'Custom gate')
        legacy = self.write('shifts/save', {k:v for k,v in payload.items() if k!='work_order'})
        with self.store.connect() as db:
            legacy.update(project_id='old-project', project_name='Historic project')
            import json
            db.execute('UPDATE scheduler_records SET data=? WHERE id=?',(json.dumps(legacy),legacy['id']))
        edited = self.write('shifts/save', {**legacy, 'notes':'New note'})
        self.assertEqual((edited['project_id'],edited['project_name']),('old-project','Historic project'))
        self.assertNotIn('work_order', edited)
        with self.assertRaises(SchedulerError):
            self.write('shifts/save', {**payload,'project_id':'new-project'})
        with self.assertRaises(SchedulerError):
            self.write('clock/in', {'project_id':'new-project'})
        current = {key:self.order[key] for key in ('id','revision')}
        clock = self.write('clock/in', {'work_order':current})
        self.assertEqual(clock['work_order'],self.order)
        with self.assertRaises(SchedulerError):
            self.write('entries/save', {'member_id':self.user['id'],'start':'2026-11-01T07:00','end':'2026-11-01T08:00','project_id':'new-project'})

    def test_manual_rule_minimum_auto_end_and_snapshot_survive_settings_change(self):
        policy = self.state()['settings']
        policy['breaks'] = [break_rule(automatic=False, repeat_hours=None, minimum=True, auto_end=True, notify_minutes=5)]
        saved = self.write('settings', policy)
        self.write('clock/in', {})
        self.now += timedelta(hours=3)
        active = self.write('clock/break', {'action': 'start', 'rule_id': 'meal'})
        self.assertEqual(active['breaks'][0]['notify_at'], '2026-11-01T23:10:00Z')
        saved['breaks'][0]['minutes'] = 10
        self.write('settings', saved)
        self.now += timedelta(minutes=12)
        with self.assertRaises(SchedulerError):
            self.write('clock/break', {'action': 'end'})
        with self.assertRaises(SchedulerError):
            self.write('clock/out', {})
        self.now += timedelta(minutes=5)
        settled = self.state()['active_entry']
        self.assertEqual(settled['breaks'][0]['end'], '2026-11-01T23:15:00Z')
        self.assertEqual(self.state()['active_entry']['version'], settled['version'])
        self.write('clock/out', {})

    def test_member_applicability_and_legacy_settings_save_preserve_rule_options(self):
        member = self.write('members/save', {'name': 'Worker', 'email': 'worker@example.test', 'password': 'worker password 123'})
        policy = self.state()['settings']
        policy['breaks'] = [break_rule(member_ids=[member['id']], automatic=False, auto_end=True)]
        saved = self.write('settings', policy)
        self.write('clock/in', {})
        with self.assertRaises(SchedulerError):
            self.write('clock/break', {'action': 'start', 'rule_id': 'meal'})
        older = {**saved, 'breaks': [{'name': 'Meal break', 'minutes': 15, 'paid': False}]}
        updated = self.write('settings', older)
        self.assertTrue(updated['breaks'][0]['auto_end'])
        self.assertEqual(updated['breaks'][0]['member_ids'], [member['id']])


if __name__ == '__main__':
    unittest.main()
