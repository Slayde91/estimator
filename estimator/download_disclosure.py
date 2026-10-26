"""Public download projections, separate from retained calculation evidence.

Exports keep entered details and calculated quantities. Internal lookup rules,
assessment notes, source coordinates and fingerprints remain in the application;
only the canonical report-reference projection is published from that evidence.
"""

from copy import deepcopy


_SUMMARY_COLUMNS = {
    'Product orders': 'ABCDEFGH',
    'Product order totals': 'ABCDEFGH',
    'Product totals': 'ABCDEFGHIJ',
    'Penetration angles by size and location': 'ABCD',
    'Maxilite 60 mm boards and cut strips': 'ABCDEFG',
    'Board stock totals by product and thickness': 'ABCDEFGHIJ',
}


def calculator_download_data(data):
    """Return an isolated public view; never change the calculation snapshot."""
    public = deepcopy(data)
    public['basis'] = ''
    public['source'] = {}
    for key in ('assessment_scope', 'assessment_receipt', 'assessment_notes',
                'assessment_evidence', 'assessment_evidences', 'application_notes',
                'application_summary_note', 'summary_notes'):
        public.pop(key, None)
    public['summaries'] = [summary for summary in public['summaries']
                           if summary['title'] in _SUMMARY_COLUMNS]
    public['quantity_notices'] = []
    if public['id'] == 'steel_intumescent':
        for summary in public['summaries']:
            for row in summary['rows']:
                if row['values'].get('I') == 'READY - component orders held':
                    public['quantity_notices'].append(
                        str(row['values']['A']) + ': Component quantities are unavailable. Review this item in the application.')
    for summary in public['summaries']:
        summary['columns'] = list(_SUMMARY_COLUMNS[summary['title']])
        summary['note'] = ''
        if public['id'] != 'steel_intumescent':
            summary.pop('qualifications', None)
    for row in public['rows']:
        for key in ('assessment_id', 'assessment_source', 'assessment_reference', 'source_reference'):
            row.pop(key, None)
    for row in public['extra_rows']:
        # N is the user's free-text allowance note; M is generated status.
        row['values'] = {key: value for key, value in row['values'].items() if key in 'ABCDEFGHIJKN'}
    if public.get('board_net_steel_areas'):
        public['board_net_steel_areas']['basis'] = ''
        public['board_net_steel_areas']['notes'] = []
    return public


def without_fingerprints(value):
    """Remove internal fingerprints from generated evidence, retaining geometry."""
    if isinstance(value, dict):
        return {key: without_fingerprints(item) for key, item in value.items()
                if not (isinstance(key, str) and key.endswith(('_sha256', '_sha256s')))
                and key not in {'digest', 'audit_head', 'sha256', 'source_sha256', 'document_sha256',
                               'dataset_sha256', 'source_report_sha256', 'source_report_sha256s',
                               'rendered_sha256', 'calculator_source_sha256', 'calculator_draft_sha256',
                               'image_sha256', 'graph_sha256', 'confirmation_digest', 'input_digest'}}
    if isinstance(value, list):
        return [without_fingerprints(item) for item in value]
    return value
