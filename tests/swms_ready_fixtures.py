"""Explicitly prepare synthetic SWMS content only at successful PDF boundaries."""
from copy import deepcopy


def complete_swms(fields):
    result = deepcopy(fields)
    defaults = {'job_reference': 'PN-SWMS-QA', 'contact_person': 'Synthetic Contact', 'position': 'Supervisor',
                'phone': '0400 000 001', 'principal_contractor': 'Synthetic Builder',
                'date': '2026-11-09', 'project_address': '1 Synthetic SWMS Street'}
    for key, value in defaults.items():
        if not result['details'][key].strip():
            result['details'][key] = value
    ink = {'version': 1, 'ratio': 3, 'strokes': [[[.1, .4], [.5, .2], [.8, .7]]]}
    for key in ('reviewers', 'consultation'):
        if not result[key]:
            result[key] = [{'name': 'Synthetic Reviewer', 'position': 'Supervisor', 'signature': deepcopy(ink)}]
    if not result['work_types'] and not result['additional_steps']:
        result['work_types'] = ['Passive Firestopping']
    return result
