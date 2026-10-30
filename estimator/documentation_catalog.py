"""Finite authored document types and server-owned export identities."""
import re

from .catalog import ValidationError
from .edition import validate_edition

PDF = 'application/pdf'
XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
CALCULATORS = {'steel_vermiculite':'Steel (spray)', 'steel_intumescent':'Steel (intumescent)',
               'steel_board':'Steel (board)', 'ductwork':'Ductwork'}
SCOPES = {'steel':'Steel', 'duct':'Duct', 'walls_floors':'Walls and floors',
          'defect_reports':'Defect reports', 'service_plans':'Service plans'}


def document_catalog(edition='full'):
    validate_edition(edition)
    rows = []
    def add(kind, label, file_format, adapter, **spec):
        rows.append({'id':kind, 'label':label, 'format':file_format, 'adapter':adapter, 'spec':spec})
    add('estimate.summary.pdf','Estimate Summary','pdf','estimate',action='summary')
    add('project.full_schedule.pdf','Full Schedule','pdf','estimate',action='full_schedule')
    add('project.full_product_summary.pdf','Full Product Summary','pdf','estimate',action='full_product_summary')
    for calculator_id, title in CALCULATORS.items():
        for action, suffix, format in [('schedule','schedule','pdf'), ('product_summary','product summary','pdf'),
                                        ('register','schedule','xlsx'), ('template','schedule template','xlsx')]:
            add(f'calculator.{calculator_id}.{action}.{format}',f'{title} {suffix}',format,'calculator',
                calculatorId=calculator_id,action=action)
    for scope, title in [('schedule','Firestopping Schedule'),('current_item','Firestopping Item Details')]:
        for format in ['pdf','xlsx']:
            add(f'firestopping.{scope}.{format}',title,format,'firestopping',scope=scope,format=format)
    add('pricing.library.xlsx','Pricing Library','xlsx','pricing')
    add('certification','Installation Certificate','pdf','certification')
    for format in ['pdf','xlsx']:
        add(f'library.technical.item.{format}','Technical Library item',format,'library',source='technical',format=format)
    if edition == 'full':
        for mode, title in SCOPES.items():
            add(f'takeoff.{mode}.register.xlsx',f'{title} Takeoff register','xlsx','takeoff',action='register',mode=mode)
        for scope, title in [('defect_reports','Passive fire matrix'),('service_plans','Service plans matrix')]:
            add(f'takeoff.{scope}.matrix.pdf',title,'pdf','takeoff',action='matrix',scope=scope)
        add('takeoff.markups.pdf','Takeoff markups','pdf','takeoff',action='markups')
        add('takeoff.pdf_tools.pdf','PDF tools','pdf','takeoff',action='pdf_tools')
    return rows


def export_identity(route, body):
    """Classify a successful source route, never a caller's kind or filename.

    The source exporter still validates every input and source identity before
    its output may be recorded. Logical keys distinguish item/drawing variants.
    """
    if not isinstance(body, dict):
        raise ValidationError('Include the document request as an object.')
    fixed = {'/api/quote-report':'estimate.summary.pdf', '/api/pricing/export':'pricing.library.xlsx',
             '/api/project/full-schedule.pdf':'project.full_schedule.pdf',
             '/api/project/full-product-summary.pdf':'project.full_product_summary.pdf',
             '/api/penetration/report.pdf':'firestopping.schedule.pdf',
             '/api/penetration/register.xlsx':'firestopping.schedule.xlsx'}
    if route in fixed:
        return fixed[route], ''
    if re.fullmatch(r'/api/quotes/[^/]+/report\.pdf',route):
        return 'estimate.summary.pdf',''
    match = re.fullmatch(r'/api/calculators/(steel_vermiculite|steel_intumescent|steel_board|ductwork)/(report\.pdf|summary\.pdf|register\.xlsx|template)',route)
    if match:
        calculator_id, action = match.groups()
        key, format = {'report.pdf':('schedule','pdf'),'summary.pdf':('product_summary','pdf'),
                       'register.xlsx':('register','xlsx'),'template':('template','xlsx')}[action]
        return f'calculator.{calculator_id}.{key}.{format}', ''
    match = re.fullmatch(r'/api/(technical|penetration)/item\.(pdf|xlsx)',route)
    if match:
        source, format = match.groups()
        if source == 'technical':
            return f'library.technical.item.{format}', str(body.get('id',''))
        # The existing item exporter accepts a saved Library ID or one current
        # composer. A browser label cannot change this source classification.
        item = body.get('item')
        key = item.get('library_item_id') or item.get('id','') if isinstance(item, dict) else ''
        return f'firestopping.current_item.{format}', str(key)
    match = re.fullmatch(r'/api/takeoffs/sessions/[a-z0-9-]+/(.+)',route)
    if match:
        action = match[1]
        if action in {'physical/export/register-xlsx','physical/export/xlsx','physical/export/pdf'}:
            scope = body.get('scope','defect_reports')
            if scope not in {'defect_reports','service_plans'}:
                return None
            suffix = 'matrix.pdf' if action.endswith('/pdf') else 'register.xlsx'
            return f'takeoff.{scope}.{suffix}', str(body.get('confirmation','all')) if suffix.endswith('xlsx') else ''
        if action in {'export/register-xlsx','export/schedule-xlsx','export/xlsx'}:
            mode = body.get('mode','steel')
            if mode not in SCOPES:
                return None
            return f'takeoff.{mode}.register.xlsx', str(body.get('confirmation','all'))
        if action in {'export/markup-pdf','export/marked-pdf'}:
            return 'takeoff.markups.pdf', '|'.join(str(body.get(key,'')) for key in ('mode','physical_scope','kind','document_id'))
        if action == 'pdf-tools':
            return 'takeoff.pdf_tools.pdf', str(body.get('operation',''))
    return None
