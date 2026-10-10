"""Read-only exports of exactly one captured, possibly unsaved composer item.

Calculations use the existing Firestopping engine and supplied pricing snapshot.
Diagram bytes come only from a bounded upload or the managed library renderer;
no paths, URLs, PDFs, attachments or schedule collections are accepted.
"""

from copy import deepcopy
import base64
from hashlib import sha256
from io import BytesIO
import json
import re

from openpyxl import Workbook
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Image, SimpleDocTemplate, Spacer

from .catalog import ValidationError, validate_configuration
from .calculator_register import _sheet, _table
from .firestopping_library import MAX_DIAGRAM_BYTES, _render_diagram, diagram_upload
from .penetration_calculator import calculate, definition, normalize_composer
from .penetration_report import _display, _excel_format, _input_basis, _input_value, _visible_outputs
from .pricing_workbook import _serialize_exact
from .reference_library import ReferenceNotFound
from .report import ROOT, _Report, _company_header, _register_fonts, _LINE, _MUTED


def prepare_item_snapshot(body, *, library, default_configuration, require_diagram=True):
    """Validate one item's immutable download capture, without storing anything."""
    if not isinstance(body, dict) or set(body) - {'item', 'globals', 'configuration', 'diagram', 'download'} or 'item' not in body:
        raise ValidationError('Include exactly one current Firestopping item, its settings, pricing and optional source diagram only.')
    if not isinstance(body['item'], dict):
        raise ValidationError('Current item downloads accept one item, not a schedule or item list.')
    draft = normalize_composer({'globals': body.get('globals', {}), 'rows': [deepcopy(body['item'])]})
    configuration = validate_configuration(body.get('configuration', default_configuration))
    result = calculate(draft, configuration)
    metadata = definition(configuration)
    diagram = None
    identity = {'kind': 'none', 'library_item_id': draft['rows'][0].get('library_item_id')}
    if 'diagram' in body:
        upload = body['diagram']
        if not isinstance(upload, dict) or not isinstance(upload.get('filename'), str) or re.search(r'[\\/:]', upload['filename']):
            raise ValidationError('The source diagram must contain image bytes and a plain image filename, never a path or URL.')
        diagram = diagram_upload(upload)
        identity = {'kind': 'current unsaved image', 'filename': upload['filename'],
                    'source_sha256': sha256(base64.b64decode(upload['content_base64'], validate=True)).hexdigest(),
                    'rendered_sha256': diagram['sha256']}
    elif draft['rows'][0].get('library_item_id'):
        key = draft['rows'][0]['library_item_id']
        try:
            payload, mime, filename = library.diagram_asset(key, False)
        except ReferenceNotFound as exc:
            if require_diagram:
                raise ValidationError('The linked current item source diagram is unavailable. Choose a retained diagram before downloading this item PDF.') from exc
            identity = {'kind': 'managed library image', 'library_item_id': key, 'status': 'unavailable'}
            return {'result': result, 'definition': metadata, 'diagram': None, 'diagram_identity': identity}
        if not 0 < len(payload) <= MAX_DIAGRAM_BYTES or mime not in {'image/png', 'image/jpeg', 'image/webp'}:
            raise ValidationError('The linked source diagram must be a PNG, JPEG or WebP image no larger than 15 MB.')
        diagram = _render_diagram(payload)
        identity = {'kind': 'managed library image', 'library_item_id': key, 'filename': filename,
                    'source_sha256': sha256(payload).hexdigest(), 'rendered_sha256': diagram['sha256']}
    return {'result': result, 'definition': metadata, 'diagram': diagram, 'diagram_identity': identity}


def _inputs(snapshot):
    row = snapshot['result']['rows'][0]
    for field in snapshot['definition']['row_fields']:
        yield field, row['inputs'].get(field['column']), _input_value(row, field['column']), _input_basis(row, field['column'])


def build_item_xlsx(snapshot):
    """All item inputs, calculated values and settings; exact values, no formulas."""
    result, metadata = snapshot['result'], snapshot['definition']
    row = result['rows'][0]
    workbook = Workbook()
    workbook.remove(workbook.active)
    workbook.properties.creator = 'Ceasefire'
    workbook.properties.title = 'Current Firestopping item'
    summary = _sheet(workbook, 'Item', 'CURRENT FIRESTOPPING ITEM', [32, 72])
    _table(summary, 4, ['Field', 'Value'], [['Item ID', row['id']]] +
           [[label, result['summary'].get(name)] for label, name in
            (('Labour', 'labour'), ('Materials', 'materials'), ('Item total', 'grand_total'), ('Total days', 'total_days'))], [32, 72])
    widths = [22, 34, 18, 22, 22, 14, 24]
    inputs = _sheet(workbook, 'Inputs', 'CAPTURED CURRENT ITEM INPUTS', widths)
    records = list(_inputs(snapshot))
    _table(inputs, 4, ['Section', 'Field', 'Source column', 'Raw input', 'Effective value', 'Units', 'Basis'],
           [[field['group'], field['label'], field['column'], raw, effective, field.get('units', ''), basis]
            for field, raw, effective, basis in records], widths, filtered=True)
    for offset, (field, _, _, _) in enumerate(records, 5):
        for column in (4, 5):
            inputs.cell(offset, column).number_format = _excel_format(field)
    output = _sheet(workbook, 'Calculated detail', 'CURRENT ITEM CALCULATED VALUES', [40, 26, 18, 18])
    _table(output, 4, ['Field', 'Value', 'Units', 'Source cell'],
           [[field['label'], row['outputs'].get(field['column']), field.get('units', ''), field['address']]
            for field in _visible_outputs(metadata)], [40, 26, 18, 18], filtered=True)
    settings = _sheet(workbook, 'Settings', 'CAPTURED SETTINGS FOR THIS ITEM', [40, 90])
    _table(settings, 4, ['Setting', 'Captured value'],
           [[name, json.dumps(value, ensure_ascii=False, sort_keys=True) if isinstance(value, (dict, list)) else value]
            for name, value in result['draft']['globals'].items()], [40, 90])
    source = _sheet(workbook, 'Source', 'CURRENT ITEM SOURCE IDENTITY', [34, 100])
    _table(source, 4, ['Identity', 'Value'],
           [['Calculator source SHA256', result['source_sha256']], ['Calculation policy', metadata['calculation_policy']]] +
           list(map(list, snapshot['diagram_identity'].items())), [34, 100])
    if result.get('errors'):
        errors = _sheet(workbook, 'Calculation errors', 'CURRENT ITEM CALCULATION ERRORS', [20, 90])
        _table(errors, 4, ['Cell', 'Error'], [[error['cell'], error['message']] for error in result['errors']], [20, 90])
    for sheet in workbook:
        sheet.print_area = sheet.dimensions
    return _serialize_exact(workbook)


def render_item_pdf(snapshot):
    """Current item details and its explicit source image, never a schedule."""
    if snapshot['diagram_identity'].get('status') == 'unavailable':
        raise ValidationError('The linked current item source diagram is unavailable. Choose a retained diagram before downloading this item PDF.')
    _register_fonts()
    report = _Report({})
    width, height = A4
    margin = 32
    content = width - margin * 2
    result, metadata = snapshot['result'], snapshot['definition']
    row = result['rows'][0]
    report.story.append(report.p('Current Firestopping item', 'title'))
    report.story.append(report.p(f"Item ID: {row['id']}", 'body'))
    report.story.append(report.table(['Calculated item', 'Value'],
        [[report.p(label, 'cell'), report.p(_display(result['summary'].get(name), {'format': 'currency' if name != 'total_days' else 'number'}), 'cell')]
         for label, name in (('Labour', 'labour'), ('Materials', 'materials'), ('Item total', 'grand_total'), ('Total days', 'total_days'))],
        [content * .6, content * .4]))
    report.story.append(report.p('Source diagram', 'subheading'))
    diagram = snapshot['diagram']
    if diagram is None:
        report.story.append(report.p('No source diagram is attached to this current item.', 'body'))
    else:
        scale = min(content / diagram['width'], 230 / diagram['height'])
        report.story.append(Image(BytesIO(diagram['image_data']), width=diagram['width'] * scale, height=diagram['height'] * scale))
        identity = snapshot['diagram_identity']
        report.story.append(report.p(identity.get('filename', '') + (' | ' + identity['library_item_id'] if identity.get('library_item_id') else ''), 'small'))
        report.story.append(report.p('Source SHA256: ' + identity['source_sha256'], 'small'))
    report.story.append(Spacer(1, 10))
    grouped = {}
    for field, raw, effective, basis in _inputs(snapshot):
        if effective not in (None, '') or field['column'] in {'J', 'K', 'L', 'M', 'N', 'O', 'P', 'T', 'U'}:
            grouped.setdefault(field['group'], []).append([
                report.p(field['label'], 'cell'), report.p(_display(effective, field), 'cell'),
                report.p(field.get('units', '') + ('; ' + basis if basis else ''), 'cell')])
    for group, rows in grouped.items():
        report.story.append(report.p(group, 'subheading'))
        report.story.append(report.table(['Item field', 'Captured / effective value', 'Units / basis'], rows,
                                         [content * .38, content * .4, content * .22]))
    if result.get('errors'):
        report.story.append(report.p('Review calculation', 'subheading'))
        for error in result['errors']:
            report.story.append(report.p(f"{error['cell']}: {error['message']}", 'alert'))
    logo = ImageReader(str(ROOT / 'static' / 'ceasefire-logo.png'))
    output = BytesIO()
    document = SimpleDocTemplate(
        output, pagesize=A4, leftMargin=margin, rightMargin=margin, topMargin=91, bottomMargin=43,
        pageCompression=1, title='Ceasefire - Current Firestopping item', author='Ceasefire')

    def decorate(canvas, doc):
        canvas.saveState()
        _company_header(canvas, logo, width, height, margin, 'FIRESTOPPING ITEM', label_below_logo=True)
        canvas.setStrokeColor(_LINE)
        canvas.line(margin, 32, width - margin, 32)
        canvas.setFont('CeasefireVera', 7)
        canvas.setFillColor(_MUTED)
        canvas.drawString(margin, 20, 'Ceasefire ESTIMATOR | Current captured item')
        canvas.drawRightString(width - margin, 20, f'Page {doc.page}')
        canvas.restoreState()

    document.build(report.story, onFirstPage=decorate, onLaterPages=decorate)
    return output.getvalue()
