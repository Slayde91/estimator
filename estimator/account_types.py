"""Business account types shared by staff management and local authorization."""

import re

from .documentation_catalog import CALCULATOR_INSPECTION_ROUTES, CALCULATOR_REGISTER_ROUTES, INSPECTION_REGISTER_XLSX_ROUTES

ADMINISTRATOR = 'admin'
ESTIMATOR = 'estimator'
COORDINATOR = 'coordinator'
TECHNICIAN = 'technician'
TECHNICIAN_PLUS = 'technician_plus'
ACCOUNT_TYPES = (ADMINISTRATOR, ESTIMATOR, COORDINATOR, TECHNICIAN, TECHNICIAN_PLUS)
TECHNICIAN_TYPES = frozenset((TECHNICIAN, TECHNICIAN_PLUS))
SCHEDULE_EDITORS = frozenset((ADMINISTRATOR, COORDINATOR))
OFFICE_TYPES = frozenset((ESTIMATOR, COORDINATOR))
PROFILE_ROUTES = frozenset(('/api/certifications/defaults', '/api/document-numbering',
                            '/api/numbering-settings', '/api/project-details'))
OFFICE_PROJECT_ROUTES = frozenset(('/api/projects', '/api/projects/details', '/api/projects/details/save',
                                   '/api/projects/follow-up', '/api/projects/status', '/api/projects/files',
                                   '/api/project-clients'))
INSPECTION_DOCUMENT_ROUTES = frozenset((*CALCULATOR_INSPECTION_ROUTES, *CALCULATOR_REGISTER_ROUTES,
                                       *INSPECTION_REGISTER_XLSX_ROUTES, '/api/project/inspection-calculator-rows',
                                       '/api/project/passive-fire-register.pdf', '/api/project/passive-fire-registers.pdf'))
TECHNICIAN_FORM_ROUTES = frozenset(('/api/forms/templates', '/api/forms/entries', '/api/forms/entry',
                                    '/api/forms/entry/pdf', '/api/forms/entry/save', '/api/forms/entry/approve',
                                    '/api/forms/staff', '/api/forms/signer', '/api/forms/calculate'))


def account_type(member):
    return ADMINISTRATOR if member['role'] == 'admin' else member['account_type']


def _under(route, prefix):
    return route == prefix or route.startswith(prefix + '/')


def allows_local_request(role, route, *, read, admin_only):
    """Deny unclassified shared routes for explicitly assigned roles."""
    if admin_only:
        return False
    if route in PROFILE_ROUTES:
        return True
    if _under(route, '/api/libraries/technical'):
        return read and not route.endswith('/edit')
    if any(_under(route, '/api/libraries/' + name) for name in ('documents', 'images', 'replicas')):
        return read
    if role in TECHNICIAN_TYPES:
        return route in TECHNICIAN_FORM_ROUTES or route == '/api/libraries' and read
    if role not in OFFICE_TYPES:
        return False
    if route in OFFICE_PROJECT_ROUTES or route in INSPECTION_DOCUMENT_ROUTES or any(_under(route, prefix) for prefix in (
            '/api/contacts', '/api/project-participants', '/api/record-resources', '/api/pricing', '/api/documentation',
            '/api/swms', '/api/pdf-covers')):
        return True
    if _under(route, '/api/forms'):
        return True
    if _under(route, '/api/commercial'):
        # The commercial adapter authorizes writes against the actual document kind.
        return (read or route.rsplit('/', 1)[-1] in COMMERCIAL_ACTIONS
                or role == COORDINATOR and route == '/api/commercial/complete-billing')
    if _under(route, '/api/certifications'):
        return True
    if route in ('/api/configuration', '/api/configuration/preview'):
        return True
    if route == '/api/download-progress':
        return True
    if route in ('/api/bootstrap', '/api/libraries', '/api/travel/status') or re.fullmatch(
            r'/api/download-progress/[A-Za-z0-9_-]{32}', route):
        return read
    if _under(route, '/api/quotes') or route == '/api/quote-report':
        return read or role == ESTIMATOR
    if route in ('/api/download-files', '/api/travel/route') or _under(route, '/api/download-files'):
        return read
    if role == ESTIMATOR:
        return any(_under(route, prefix) for prefix in (
            '/api/calculate', '/api/calculators', '/api/takeoffs', '/api/project', '/api/projects/load',
            '/api/penetration', '/api/libraries/penetration')) or route in (
                '/api/penetration/item.pdf', '/api/penetration/item.xlsx')
    return False


_DOCUMENT_ACTIONS = ('save', 'status', 'delete', 'issue', 'activity', 'follow-up', 'notes', 'defaults')
COMMERCIAL_ACTIONS = frozenset((*_DOCUMENT_ACTIONS, 'derive', 'purchase-order-defaults', 'saved-open',
                                'saved-read-attachment', *('saved-' + action for action in _DOCUMENT_ACTIONS)))
COMMERCIAL_EDIT_TYPES = {ESTIMATOR: frozenset(('quote',)), COORDINATOR: frozenset(('work_order', 'purchase_order'))}
