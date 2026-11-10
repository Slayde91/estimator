"""Explicit complete workflow data for tests crossing readiness boundaries.

Production defaults remain blank and Draft save tests keep exercising them.
Only use these helpers when the scenario issues a PDF or enters a later stage.
"""
from copy import deepcopy

INK = {'version':1,'ratio':3,'strokes':[[[0,0],[.5,1],[1,0]]]}
DETAILS = {'project_no':'PN-01','client':'Fixture client','site_address':'10 Fixture Road',
           'contact':'Fixture Contact','phone':'0400 000 000','email':'fixture@example.test','date':'2026-11-09'}


def complete_details(fields):
    result = deepcopy(fields)
    for key,value in DETAILS.items():
        if not result['details'].get(key,'').strip():
            result['details'][key] = value
    return result


def complete_quote(fields):
    result = complete_details(fields)
    for key in ('allowances','terms'):
        if not result.get(key,'').strip():
            result[key] = '<p>N / A</p>'
    return result


def complete_work_order(fields, stage='Draft'):
    result = complete_details(fields)
    order = result['order']
    # Keep a blank cost so the linked Quote's authoritative amount can seed it.
    for key,value in {'start_date':'2026-11-10','urgency':'Medium Priority','description':'Fixture installation work'}.items():
        if not order.get(key,'').strip():
            order[key] = value
    stages = ['Draft','Review','OHS Docs','Client Approval','In progress','Claim','Certify','Completed']
    index = stages.index(stage) if stage in stages else 0
    roles = [('details_by','details_date'),('reviewed_by','review_date'),('prepared_by','prepared_date'),('client_approved_by','client_approval_date'),
             ('progress_by','progress_date'),('claimed_by','claim_date'),('closed_by','closed_date')]
    if index >= 2:
        order['approval'] = order.get('approval') or 'Approved'
    for name,date in roles[:min(index,7)]:
        order[name] = order.get(name) or 'Fixture Signer'
        order[date] = order.get(date) or '2026-11-09'
        result.setdefault('signatures',{}).setdefault(name,deepcopy(INK))
    if index >= 5:
        for row in result.get('work_tracking',{}).get('rows',[]):
            row['completed_percent'] = row.get('completed_percent') or '1'
    if index >= 6:
        for row in result.get('work_tracking',{}).get('rows',[]):
            row['claimed_percent'] = row.get('claimed_percent') or '1'
    if index >= 7:
        order['certification'] = order.get('certification') or 'Certification issued'
        order['completion'] = order.get('completion') or 'Completed'
    return result
