"""Quote prices and scope copied from validated estimate workspaces.

The existing estimator and Full Schedule report remain the calculation and
technical-document authorities. Client-supplied totals are never used.
"""

from hashlib import sha256
from html import escape
from decimal import Decimal, ROUND_HALF_UP
import json
import math
import re

from .calculator_report import project_calculator_report, calculator_schedule_table
from .catalog import ValidationError
from .commercial_documents import linked_estimate_ids
from .commercial_documents import validate_rich_text
from .edition import require_project_edition
from .penetration_calculator import calculate as calculate_penetration, definition
from .penetration_report import penetration_schedule_table
from .project_file import CALCULATOR_IDS, export_project, load_project_bytes
from .project_reports import TITLES, build_project_report
from .schedule_rows import empty_schedule_inputs, populated_schedule_rows


def _scope_preamble(source, names):
    """Keep custom scope prose while removing obsolete generated name blocks.

    A saved Quote can contain the old names from an earlier selection. Testing
    the whole block against today's selected sequence misses that case and
    prints the hidden preamble again above the actual estimate heading.
    """
    names = [re.escape(validate_rich_text('<p><b>' + escape(name) + '</b></p>', 'Scope'))
             for name in names]
    # Default estimate names may have since been renamed in the project.
    names.append(r'<p><b>Estimate [1-9]\d*</b></p>')
    generated = '(?:' + '|'.join(names) + r')(?:<p>No calculator schedule rows have been entered for this estimate\.</p>)?'
    return re.sub(generated, '', source)


def _scope_tables(project, name, library=None, *, pending=False, estimate_id=None):
    tables = []
    for calculator_id in CALCULATOR_IDS:
        inputs = project['calculators'][calculator_id]['inputs']
        if not populated_schedule_rows(calculator_id, inputs):
            continue
        if pending:
            # Selecting a Quote's estimates needs trusted totals immediately;
            # the original schedule projection is evaluated on explicit expand.
            # These descriptors are editor previews, never persisted schedules.
            tables.append({'title': name + ' — ' + TITLES[calculator_id], 'headers': [], 'rows': [],
                           'pending': True, 'estimate_id': estimate_id})
            continue
        table = calculator_schedule_table(project_calculator_report(calculator_id, inputs))
        if not table['rows']:
            continue
        tables.append({'title': name + ' — ' + TITLES[calculator_id], **table})
    if project.get('penetration'):
        result = calculate_penetration(project['penetration']['draft'], project['estimate']['configuration'])
        table = penetration_schedule_table(result, definition(project['estimate']['configuration']), library=library)
        if table['rows']:
            tables.append({'title': name + ' — Firestopping', **table})
    return tables


def derive_estimates(store, body, *, edition='full', company=None, library=None, include_pdfs=False):
    """Return trusted linked prices, visible scope and optional original PDFs."""
    if not isinstance(body, dict):
        raise ValidationError('Include the captured project estimates.')
    include_scope_tables = body.get('include_scope_tables', True)
    if type(include_scope_tables) is not bool or include_pdfs and not include_scope_tables:
        raise ValidationError('Choose a valid linked estimate preview.')
    estimates = body.get('estimates')
    if not isinstance(estimates, list) or len(estimates) > 100:
        raise ValidationError('Include up to 100 captured estimates for this project.')
    available = {}
    for item in estimates:
        if not isinstance(item, dict) or set(item) != {'id', 'name', 'workspace'}:
            raise ValidationError('Each linked estimate requires its identity, name and workspace.')
        identity, name = item['id'], item['name']
        if (not isinstance(identity, str) or not 1 <= len(identity) <= 100 or identity in available
                or not isinstance(name, str) or not name.strip() or len(name) > 200):
            raise ValidationError('Linked estimate identities must be unique and names must be entered.')
        available[identity] = item
    selected = body.get('selected_ids')
    if selected is None:
        fields = body.get('fields', {})
        if not isinstance(fields, dict):
            raise ValidationError('Include the Quote Summary fields.')
        lines = fields.get('lines', [])
        if not isinstance(lines, list) or any(not isinstance(line, dict) for line in lines):
            raise ValidationError('Choose the estimates included in the Quote Summary.')
        selected = linked_estimate_ids(lines)
    if (not isinstance(selected, list) or any(not isinstance(identity, str) for identity in selected)
            or len(set(selected)) != len(selected) or any(identity not in available for identity in selected)):
        raise ValidationError('Choose each linked estimate once from the current project.')
    scope_source = ''
    preamble = ''
    if include_pdfs:
        fields = body.get('fields', {})
        if not isinstance(fields, dict):
            raise ValidationError('Include the Quote Summary fields.')
        scope_source = validate_rich_text(fields.get('scope', ''), 'Scope')
        preamble = _scope_preamble(scope_source, (item['name'] for item in available.values()))
    output = {'lines': [], 'scope': '', 'scope_tables': [], 'scope_groups': [], 'sources': [], 'scope_documents': []}
    paragraphs = []
    for identity in selected:
        item = available[identity]
        workspace = item['workspace']
        if not isinstance(workspace, dict):
            raise ValidationError('Include the complete workspace of each linked estimate.')
        require_project_edition(workspace, edition)
        # Takeoff capability tokens and project-owned document histories do not
        # enter pricing. The canonical export validates all estimate inputs.
        request = {key: workspace[key] for key in ('estimate', 'calculators', 'penetration', 'library_drafts')
                   if key in workspace}
        calculators = request.get('calculators', {})
        if not isinstance(calculators, dict) or set(calculators) - set(CALCULATOR_IDS):
            raise ValidationError('Use the available calculators in each linked estimate.')
        request['calculators'] = {key: calculators.get(key, {'inputs': empty_schedule_inputs(key)})
                                  for key in CALCULATOR_IDS}
        payload = export_project(store, request, edition=edition)
        project = load_project_bytes(store, payload, edition=edition)
        total = project['estimate']['result']['summary']['total']
        if isinstance(total, bool) or not isinstance(total, (int, float)) or not math.isfinite(total):
            raise ValidationError(f"Resolve the calculation errors in {item['name']} before quoting it.")
        output['lines'].append({'estimate_id': identity, 'description': item['name'],
                                'quantity': '1', 'unit_price': str(Decimal(str(total)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP))})
        source = json.dumps({'name': item['name'], 'workspace': json.loads(payload)},
                            sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        output['sources'].append({'estimate_id': identity, 'sha256': sha256(source).hexdigest()})
        tables = _scope_tables(project, item['name'], library, pending=not include_scope_tables, estimate_id=identity)
        start = len(output['scope_tables'])
        output['scope_tables'].extend(tables)
        scope = '<p><b>' + escape(item['name']) + '</b></p>'
        if not tables:
            scope += '<p>No calculator schedule rows have been entered for this estimate.</p>'
        paragraphs.append(scope)
        output['scope_groups'].append({'estimate_id': identity, 'scope': scope,
                                       'table_start': start, 'table_count': len(tables)})
        if include_pdfs and tables:
            calculators = {key: {'inputs': value['inputs']} for key, value in project['calculators'].items()}
            document = build_project_report(calculators,
                project.get('penetration', {}).get('draft'), project['estimate']['configuration'],
                project['project_details'], company=company, library=library, portrait=True, quote_scope=True,
                scope_intro={'name': item['name'], 'heading': not output['scope_documents'],
                             'preamble': preamble if not output['scope_documents'] else '',
                             'source_scope': scope_source if not output['scope_documents'] else ''})
            output['scope_documents'].append({'estimate_id': identity, 'name': item['name'], 'pdf': document})
    output['scope'] = ''.join(paragraphs)
    return output
