"""Scoped reports over completed, recorded time in the organisation's local calendar."""
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
import json
from zoneinfo import ZoneInfo

from .scheduler import (SchedulerError, _iso, _paid_intervals,
                        _timestamp, calculate_payroll, effective_breaks)


def _assignment(entry):
    order = entry.get('work_order') or {}
    if order:
        project = ':'.join((order.get('source_id',''), order.get('project_id','')))
        label = ' · '.join(filter(None, (order.get('project_no'), order.get('client'), order.get('site_address'))))
        return ('order:'+order['id'], order.get('reference',''), 'project:'+project, label)
    project = entry.get('project_id') or entry.get('project_name')
    if project:
        label = entry.get('project_name') or project
        return ('legacy:'+project, label, 'legacy:'+project, label)
    return ('unassigned', '', 'unassigned', '')


def _by_day(start, end, zone, first, until):
    cursor, end = max(first, start), min(until, end)
    while cursor < end:
        day = cursor.astimezone(zone).date()
        boundary = min(end, _midnight(day + timedelta(days=1), zone))
        yield str(day), int((boundary-cursor).total_seconds())
        cursor = boundary


def _midnight(day, zone):
    return datetime.combine(day,time.min,zone).astimezone(timezone.utc)


def report(db, viewer, settings, query):
    """The inclusive date range filters output. Earlier paid work still establishes weekly rates."""
    try:
        first, last = (date.fromisoformat(query[key]) for key in ('start','end'))
        if not (2000 <= first.year <= last.year <= 2100 and 0 <= (last-first).days < 366
                and all(str(d) == query[k] for k,d in [('start',first),('end',last)])):
            raise ValueError
    except (ValueError, TypeError, KeyError):
        raise SchedulerError('Select a reporting period of 1 to 366 days.') from None
    zone = ZoneInfo(settings['timezone'])
    start = _midnight(first,zone)
    until = _midnight(last+timedelta(days=1),zone)
    week = _midnight(first - timedelta(days=first.weekday()),zone)
    # Rounded payroll can start before or finish after an entry's recorded clock instant.
    margin = timedelta(minutes=settings['rounding_minutes'])
    sql = "SELECT data FROM scheduler_records WHERE kind='entry' AND end IS NOT NULL AND start<? AND end>?"
    args = [_iso(until+margin), _iso(week-margin)]
    if viewer['role'] != 'admin':
        sql += ' AND member_id=?'
        args.append(viewer['id'])
    entries = [json.loads(row[0]) for row in db.execute(sql+' ORDER BY start,id',args)]
    members = {row['id']:row['name'] for row in db.execute(
        "SELECT id,name FROM scheduler_members WHERE ?='admin' OR id=?", (viewer['role'],viewer['id']))}
    pay = calculate_payroll(entries, settings, start, until)
    rates = defaultdict(list)
    for member in pay['rows']:
        for segment in member['segments']:
            rates[segment['entry_id']].append(segment)
    rows, warnings = [], []
    for entry in entries:
        days = defaultdict(lambda: dict.fromkeys(('elapsed','paid','regular','overtime','paid_break','unpaid_break'),0))
        def add(period_start, period_end, key):
            for day,seconds in _by_day(period_start,period_end,zone,start,until):
                days[day][key] += seconds
        begin, finish = (_timestamp(entry[key],zone) for key in ('start','end'))
        if finish + margin <= start or begin - margin >= until:
            continue
        add(begin,finish,'elapsed')
        breaks, problems = effective_breaks(entry,settings)
        warnings.extend(problems)
        for item in breaks:
            add(_timestamp(item['start'],zone),_timestamp(item['end'],zone),'paid_break' if item['paid'] else 'unpaid_break')
        if pay['status'] == 'calculated':
            for segment in rates[entry['id']]:
                left, right = _timestamp(segment['start'],zone), _timestamp(segment['end'],zone)
                add(left,right,'paid')
                add(left,right,'overtime' if float(segment['multiplier']) > 1 else 'regular')
        else:
            for left,right in _paid_intervals(entry,settings):
                add(left,right,'paid')
        job, job_label, project, project_label = _assignment(entry)
        for day, values in days.items():
            rows.append({'day':day, 'member':entry['member_id'], 'job':job, 'job_label':job_label,
                         'project':project, 'project_label':project_label,
                         'clock_in':begin.astimezone(zone).isoformat(timespec='seconds'),
                         'clock_out':finish.astimezone(zone).isoformat(timespec='seconds'), **values})
    return {'timezone':zone.key, 'members':members, 'rows':rows, 'pay_status':pay['status'],
            'rules_version':pay['rules_version'], 'warnings':list(dict.fromkeys(warnings))}
