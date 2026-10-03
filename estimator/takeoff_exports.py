"""Literal-value takeoff registers retaining IDs, sources and transfer lineage."""

import csv
from copy import deepcopy
from io import StringIO
import json
import math

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

from .catalog import ValidationError
from .takeoff_area import measured_area
from .takeoff_model import (base_length, item_digest, length_additions, measured_length, is_area_item, is_standalone_count,
                           validate_measurement_scope, digest, item_result, object_fields)
from .pricing_workbook import _serialize_exact


HEADERS = ('Item ID', 'Item version', 'Mode', 'Mark / run', 'Level', 'Zone', 'Group',
           'Member type', 'Section', 'Shape', 'Width mm', 'Height mm', 'Diameter mm',
           'Quantity', 'Length per item m', 'Total length m', 'FRL', 'Fire period min',
           'Exposure', 'Orientation', 'System', 'Product', 'Source document ID',
           'Source document', 'Source SHA-256', 'Source page', 'Geometry PDF points',
           'Measurement basis', 'Evidence references', 'Confirmation ID',
           'Confirmation digest', 'Confirmed at', 'Transfer references', 'Notes', 'Physical member IDs',
           'Confirmation checks', 'Confirmed by', 'Gross area m2', 'Excluded area m2', 'Net area m2',
           'Treatment', 'Substrate', 'Surface basis', 'Surface citation', 'Area exclusions',
           'Base length per item m', 'Riser/drop additions per item m', 'Riser/drop source dimensions', 'Count ID', 'Purpose')


def register_rows(snapshot, items):
    documents = {d['id']: d for d in snapshot['documents']}
    rows = []
    for item in sorted(items, key=is_standalone_count):
        if item['state'] != 'confirmed' or not item['confirmation'] or item['confirmation']['digest'] != item_digest(item, snapshot):
            raise ValidationError('Only unchanged confirmed takeoff records can be exported.')
        fields, geometry, receipt = item['fields'], item['geometry'], item['confirmation']
        if not geometry or type(item['quantity']) is not int or item['quantity'] <= 0:
            raise ValidationError('Export requires source geometry and explicit physical quantities.')
        doc = documents[geometry['document_id']]
        validate_measurement_scope(item, snapshot)
        area = measured_area(item, snapshot) if is_area_item(item) else None
        length = None if area is not None or is_standalone_count(item) else measured_length(item, snapshot)
        basis = dict(item['measurement']) if item['measurement'] else {'method': 'count', 'quantity': item['quantity']}
        if basis['method'] == 'calibrated':
            basis['calibration'] = next(c for c in snapshot['calibrations'] if c['id'] == basis['calibration_id'])
        refs = [{**ref, 'document_sha256': documents[ref['document_id']]['sha256'],
                 'document_name': documents[ref['document_id']]['name']} for ref in item['evidence']]
        bindings = [{**{key: binding[key] for key in ('id', 'calculator_id', 'sheet', 'row', 'item_version', 'status')},
                     'destination_verification': 'Last transfer receipt; calculator draft not rechecked by register export'}
                    for binding in snapshot['transfers'] if binding['item_id'] == item['id']]
        row = [item['id'], item['version'], item['mode']]
        row.extend(fields.get(k) for k in ('mark', 'level', 'zone', 'group', 'member_type', 'section', 'shape', 'width_mm', 'height_mm', 'diameter_mm'))
        row.extend([item['quantity'], length, length * item['quantity'] if length is not None else None])
        row.extend(fields.get(k) for k in ('frl', 'fire_period_min', 'exposure', 'orientation', 'system', 'product'))
        row.extend([doc['id'], doc['name'], doc['sha256'], geometry['page'],
                    json.dumps(geometry['points'], separators=(',', ':')),
                    json.dumps(basis, ensure_ascii=False, sort_keys=True),
                    json.dumps(refs, ensure_ascii=False, sort_keys=True), receipt['id'], receipt['digest'], receipt['at'],
                    json.dumps(bindings, ensure_ascii=False, sort_keys=True), fields.get('notes'), json.dumps(item['member_ids']),
                    json.dumps(receipt.get('checks'), ensure_ascii=False, sort_keys=True),
                    json.dumps(receipt.get('actor'), ensure_ascii=False, sort_keys=True)])
        row.extend([*(area[key] if area else None for key in ('gross_area_m2', 'excluded_area_m2', 'net_area_m2')),
                    *(fields.get(key) if area else None for key in ('treatment', 'substrate', 'surface_basis', 'surface_citation')),
                    json.dumps(geometry['exclusions'], ensure_ascii=False, sort_keys=True) if area else None])
        additions = [{**addition, 'document_sha256': documents[addition['document_id']]['sha256'],
                      'document_name': documents[addition['document_id']]['name']}
                     for addition in item.get('length_additions', [])]
        row.extend([base_length(item, snapshot) if area is None and not is_standalone_count(item) else None,
                    length_additions(item, snapshot) if area is None and not is_standalone_count(item) else None,
                    json.dumps(additions, ensure_ascii=False, sort_keys=True) if area is None else None,
                    item.get('count_id'), item.get('purpose')])
        rows.append(row)
    return rows


def export_register(snapshot, items, format):
    if format not in ('csv', 'xlsx'):
        raise ValidationError('Choose CSV or XLSX register export.')
    rows = register_rows(snapshot, items)
    if format == 'csv':
        output = StringIO(newline='')
        writer = csv.writer(output)
        writer.writerow(HEADERS)
        for row in rows:
            # Spreadsheet importers interpret leading formula characters even in
            # quoted CSV fields. A leading apostrophe intentionally marks text.
            writer.writerow(["'"+v if isinstance(v, str) and v.lstrip().startswith(('=', '+', '-', '@', '\t', '\r')) else v for v in row])
        return output.getvalue().encode('utf-8-sig'), 'text/csv; charset=utf-8', 'CEASEFIRE-Takeoffs.csv'
    workbook = Workbook()
    sheet = workbook.active; sheet.title = 'Confirmed Takeoffs'
    details = []
    for row_number, row in enumerate([HEADERS, *rows], 1):
        for column, value in enumerate(row, 1):
            if row_number > 1 and isinstance(value, str) and len(value.encode('utf-16-le')) > 60000:
                # Excel cells are limited to 32,767 characters. openpyxl would
                # silently truncate geometry/member/evidence JSON otherwise.
                parts = [value[start:start+15000] for start in range(0, len(value), 15000)]
                details.extend([[row[0], HEADERS[column-1], index+1, len(parts), part] for index, part in enumerate(parts)])
                value = f'See Provenance Detail: {row[0]} / {HEADERS[column-1]} ({len(parts)} ordered parts)'
            cell = sheet.cell(row_number, column, value)
            if isinstance(value, str):
                cell.data_type = 's'  # Exact literal content, including =, +, - and @.
            cell.alignment = Alignment(vertical='top', wrap_text=True)
            if row_number == 1:
                cell.font = Font(bold=True, color='FFFFFF')
                cell.fill = PatternFill('solid', fgColor='1F2937')
    sheet.freeze_panes = 'D2'
    sheet.auto_filter.ref = sheet.dimensions
    for column in sheet.columns:
        sheet.column_dimensions[column[0].column_letter].width = 22
    if details:
        detail_sheet = workbook.create_sheet('Provenance Detail')
        detail_sheet.append(['Item ID', 'Field', 'Part', 'Total Parts', 'Exact Text (concatenate in Part order)'])
        for row in details:
            detail_sheet.append(row)
            for cell in detail_sheet[detail_sheet.max_row]:
                if isinstance(cell.value, str):
                    cell.data_type = 's'
        detail_sheet.freeze_panes = 'C2'
        detail_sheet.auto_filter.ref = detail_sheet.dimensions
        for column, width in (('A', 40), ('B', 30), ('C', 10), ('D', 12), ('E', 100)):
            detail_sheet.column_dimensions[column].width = width
    info = workbook.create_sheet('Provenance')
    for row in [('Project ID', snapshot['project_id']), ('Takeoff revision', snapshot['revision']),
                ('Audit head SHA-256', snapshot['audit_head']),
                ('Scope', 'Confirmed takeoff records. Technical suitability requires separate assessment.'),
                ('Coordinates', 'Unrotated source PDF coordinates. Traces use the retained calibration or cited dimension; Steel counts retain independent member markers and an explicitly entered manual length, without requiring a scale.'),
                ('Quantity', 'Explicit physical quantity; never inferred from photographs. Steel count quantity is derived from its retained member markers, with ordered point/member-ID correspondence. Linear total length is quantity times the sum of base length and each explicitly entered riser/drop addition per member. A wall/slab polygon is one distinct treatment surface; net area is gross area less its explicit exclusions, with no inferred face multiplier.'),
                ('Surface basis', 'Wall polygons represent true wall faces, not plan footprints. Slab polygons identify top or soffit surfaces. Calibration scale is squared for area. Printed presets include PDF UserUnit once; manual known-distance calibration is direct. Rendering zoom and rotation do not change quantities.'),
                ('Calculator links', 'Transfer statuses describe retained receipts. This register export does not recheck the current calculator draft; stale/conflicting links do not become current by exporting.'),
                ('Source links', 'Document IDs, page numbers and hashes identify the retained source originals.')]:
        info.append(row)
    info.column_dimensions['A'].width = 28; info.column_dimensions['B'].width = 100
    for row in info:
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical='top')
            if isinstance(cell.value, str):
                cell.data_type = 's'
    payload = _serialize_exact(workbook); workbook.close()
    return payload, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'CEASEFIRE-Takeoffs.xlsx'


def _local_authority(snapshot, store):
    """Receipts copied into project JSON cannot grant export approval."""
    with store.connect() as db:
        approvals = {row[0]: json.loads(row[1]) for row in db.execute(
            'SELECT receipt_id,receipt FROM takeoff_approvals WHERE project_id=? AND kind=?',
            (snapshot['project_id'], 'confirmation'))}
        bindings = {(row[0], row[1]) for row in db.execute(
            'SELECT binding_id,digest FROM takeoff_transfer_receipts WHERE project_id=?',
            (snapshot['project_id'],))}
    return approvals, bindings


def _confirmed(item, snapshot, result, approvals):
    receipt = item.get('confirmation')
    return bool(item['state'] == 'confirmed' and not result['issues'] and receipt
                and receipt['digest'] == item_digest(item, snapshot)
                and approvals.get(receipt['id']) == receipt)


def _calculator_drafts(value):
    from .schedule_rows import blank_schedule_defaults, normalize_schedule_rows
    from .takeoff_transfer import DESTINATIONS
    from .workbook_calculators import normalize_calculator_inputs
    if not isinstance(value, dict) or set(value) - set(DESTINATIONS):
        raise ValidationError('Export accepts the current inputs of the three existing calculators only.')
    drafts = {}
    for calculator_id, supplied in value.items():
        object_fields(supplied, {'inputs', 'schedule_rows'}, 'Current calculator draft', {'inputs', 'schedule_rows'})
        if not isinstance(supplied['inputs'], dict) or any(not isinstance(cells, dict) for cells in supplied['inputs'].values()):
            raise ValidationError('Current calculator inputs must be a map of worksheet input maps.')
        if not isinstance(supplied['schedule_rows'], list):
            raise ValidationError('Current calculator schedule rows must be an explicit list.')
        # This is a read-only calculation of an existing draft, including saved
        # legacy overrides. The public calculator input validator still rejects
        # formula outputs, unknown cells, nonfinite numbers and excess fields.
        inputs = normalize_calculator_inputs(calculator_id, blank_schedule_defaults(calculator_id, supplied['inputs']))
        rows = normalize_schedule_rows(calculator_id, inputs, supplied['schedule_rows'])
        drafts[calculator_id] = {'inputs': inputs, 'schedule_rows': rows,
                                'declared_rows': supplied['schedule_rows'],
                                'fingerprint': digest({'inputs': supplied['inputs'], 'schedule_rows': supplied['schedule_rows']})}
    return drafts


def _linked_results(snapshot, selected, confirmations, registered_bindings, drafts):
    """Project original result cells only after verifying each current link."""
    from .takeoff_transfer import row_values
    from .excel_engine import FormulaError
    from .workbook_calculators import calculator_session, source_model
    output = {}; sessions = {}
    number = lambda value: not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
    for item in selected:
        results = []
        for binding in snapshot['transfers']:
            if binding['item_id'] != item['id']:
                continue
            calculator_id = binding['calculator_id']; draft = drafts.get(calculator_id)
            result = {'calculator_id': calculator_id, 'row': binding['row'], 'status': 'Unavailable',
                      'reason': 'Current confirmed source and matching calculator draft are required.',
                      'published_thickness_mm': None, 'estimating_thickness_mm': None,
                      'board_stack_mm': None, 'board_layers': None, 'total_thickness_mm': None}
            results.append(result)
            if (not confirmations[item['id']] or binding['status'] != 'current'
                    or binding['item_version'] != item['version'] or binding['item_digest'] != item_digest(item, snapshot)
                    or (binding['id'], digest({key: value for key, value in binding.items() if key != 'status'})) not in registered_bindings
                    or draft is None):
                continue
            model = source_model(calculator_id); schedule = model['schedule']
            if (binding['source_sha256'] != model['source']['sha256'] or binding['sheet'] != schedule['sheet']
                    or binding['row'] not in draft['declared_rows']
                    or binding['input_hash'] != digest(row_values(draft['inputs'], schedule, binding['row']))):
                result['reason'] = 'The linked row was edited, removed or uses a different calculator source.'
                continue
            try:
                if calculator_id not in sessions:
                    sessions[calculator_id] = calculator_session(calculator_id, draft['inputs'])
                _, engine, lock = sessions[calculator_id]
                with lock:
                    value = lambda column: engine.value(schedule['sheet'], f"{column}{binding['row']}")
                    if calculator_id == 'steel_vermiculite':
                        status, published, estimating = value('W'), value('O'), value('P')
                        if not isinstance(status, str) or not status.startswith('QUANTIFIED') or not number(estimating) or estimating <= 0:
                            result['reason'] = str(status or 'The calculator has no usable coating thickness.')
                            continue
                        result.update(published_thickness_mm=published if number(published) else None,
                                      estimating_thickness_mm=estimating)
                    elif calculator_id == 'steel_board':
                        status, stack, total, layers = value('AR'), value('Z'), value('AB'), value('AA')
                        if status != 'CLADDING ESTIMATE' or not number(total) or total <= 0:
                            result['reason'] = str(status or 'The calculator has no usable board selection.')
                            continue
                        result.update(board_stack_mm=stack, total_thickness_mm=total,
                                      board_layers=layers if number(layers) else None)
                    else:
                        # Duct dimensions and lengths are exported from Takeoffs.
                        # No new technical thickness mapping is inferred here.
                        result['reason'] = 'Duct protection remains in the linked Ductwork calculator.'
                        continue
                    result.update(status='Current', reason='', calculator_source_sha256=model['source']['sha256'],
                                  calculator_draft_sha256=draft['fingerprint'])
            except (ValueError, ArithmeticError, TypeError, KeyError, FormulaError):
                result['reason'] = 'The existing calculator could not return a usable result.'
        output[item['id']] = results
    return output


def linked_result_text(results):
    """Human-readable result values; unknowns never become zero thickness."""
    sections = []
    for result in results:
        label = {'steel_vermiculite': 'Spray', 'steel_board': 'Board', 'ductwork': 'Ductwork'}[result['calculator_id']]
        if result['status'] != 'Current':
            sections.append(f"{label}: Unavailable ({result['reason']})")
        elif result['calculator_id'] == 'steel_vermiculite':
            published = result['published_thickness_mm']
            sections.append(f"Spray: {result['estimating_thickness_mm']:.2f} mm estimating"
                            + (f"; {published:.2f} mm published" if published is not None else '; published thickness unavailable'))
        else:
            layers = result['board_layers']
            sections.append(f"Board: {result['board_stack_mm']} mm stack; "
                            + (f"{layers:g} layers; " if layers is not None else '')
                            + f"{result['total_thickness_mm']:.2f} mm total")
    return ' | '.join(sections) or 'Unavailable (no current linked calculator result)'


def _schedule_xlsx(snapshot, selected, results, confirmations, linked):
    """Current mode register, including unresolved drafts, with literal provenance."""
    documents = {doc['id']: doc for doc in snapshot['documents']}
    headers = ['Item ID', 'Item version', 'Mode', 'Confirmation', 'Mark / Run ID', 'Member type', 'Section',
               'Shape', 'Width mm', 'Height mm', 'Diameter mm', 'Quantity', 'Length per item m', 'Total length m',
               'Net area m2', 'Product', 'FRL', 'Fire period min', 'Exposed sides', 'Critical temperature C',
               'Exposure', 'Orientation', 'Level', 'Zone', 'Group', 'Notes', 'Source document', 'Source page',
               'Source SHA-256', 'Linked calculator result', 'Issues', 'Confirmation ID', 'Confirmation digest',
               'Geometry', 'Measurement basis', 'All item properties', 'Supporting evidence', 'Riser/drop additions',
               'Calculator result provenance', 'Appearance', 'Physical member IDs', 'Source page metadata', 'Confirmation receipt', 'Count ID', 'Purpose']
    workbook = Workbook(); sheet = workbook.active; sheet.title = 'Current Takeoffs'
    sheet.append(headers); details = []
    for item in selected:
        field, geometry = item['fields'], item['geometry']; result = results[item['id']]
        doc = documents[geometry['document_id']] if geometry else None
        confirmation = item['confirmation'] if confirmations[item['id']] else None
        def bound_reference(reference):
            source = documents[reference['document_id']]
            return {**reference, 'document_sha256': source['sha256'], 'document_name': source['name']}
        basis = deepcopy(item['measurement'])
        if basis and basis['method'] == 'calibrated':
            calibration = next(value for value in snapshot['calibrations'] if value['id'] == basis['calibration_id'])
            basis['calibration'] = bound_reference(calibration)
        evidence = [bound_reference(reference) for reference in item['evidence']]
        additions = [bound_reference(reference) for reference in item.get('length_additions', [])]
        row = [item['id'], item['version'], item['mode'], 'Confirmed' if confirmation else 'Unconfirmed',
               *(field.get(key) for key in ('mark', 'member_type', 'section', 'shape', 'width_mm', 'height_mm', 'diameter_mm')),
               item['quantity'], result.get('length_m'), result.get('total_length_m'), result.get('net_area_m2'),
               *(field.get(key) for key in ('product', 'frl', 'fire_period_min', 'sides', 'critical_temperature', 'exposure',
                                          'orientation', 'level', 'zone', 'group', 'notes')),
               doc['name'] if doc else None, geometry['page'] if geometry else None, doc['sha256'] if doc else None,
               linked_result_text(linked[item['id']]), '\n'.join(issue['message'] for issue in result['issues']),
               confirmation['id'] if confirmation else None, confirmation['digest'] if confirmation else None]
        row.extend(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) if value is not None else None
                   for value in (geometry, basis, field, evidence, additions,
                                 linked[item['id']], item.get('appearance'), item['member_ids'],
                                 doc['pages'][geometry['page']-1] if doc else None, confirmation))
        row.extend([item.get('count_id'), item.get('purpose')])
        for index, value in enumerate(row):
            if isinstance(value, str) and len(value.encode('utf-16-le')) > 60000:
                parts = [value[start:start+15000] for start in range(0, len(value), 15000)]
                details.extend([[item['id'], headers[index], i+1, len(parts), part] for i, part in enumerate(parts)])
                row[index] = f'See Provenance Detail: {item["id"]} / {headers[index]} ({len(parts)} ordered parts)'
        sheet.append(row)
    if details:
        detail = workbook.create_sheet('Provenance Detail')
        detail.append(['Item ID', 'Field', 'Part', 'Total parts', 'Exact text in part order'])
        for row in details: detail.append(row)
    info = workbook.create_sheet('Export scope')
    for row in [('Project ID', snapshot['project_id']), ('Takeoff revision', snapshot['revision']),
                ('Audit SHA-256', snapshot['audit_head']), ('Scope', 'All items in the active Takeoffs mode, including hidden and unconfirmed items.'),
                ('Approval', 'Unconfirmed items are drafts. Unknown quantities remain blank. Export does not confirm an item or authorize technical suitability.'),
                ('Linked results', 'Only locally registered current confirmations and exact current calculator row inputs permit a linked steel result. Missing or stale results are unavailable.'),
                ('Precision', 'Stored numeric values retain full precision. Cell display rounding does not change quantities.')]:
        info.append(row)
    for table in workbook:
        table.freeze_panes = 'A2'; table.auto_filter.ref = table.dimensions
        for row in table:
            for cell in row:
                if isinstance(cell.value, str): cell.data_type = 's'
                cell.alignment = Alignment(wrap_text=True, vertical='top')
                if cell.row == 1:
                    cell.font = Font(bold=True, color='FFFFFF'); cell.fill = PatternFill('solid', fgColor='1F2937')
                elif isinstance(cell.value, (float, int)):
                    measurement_headers = {'Width mm', 'Height mm', 'Diameter mm', 'Length per item m', 'Total length m', 'Net area m2'}
                    cell.number_format = '0.00' if table.title == 'Current Takeoffs' and headers[cell.column-1] in measurement_headers else '0'
        for column in table.columns: table.column_dimensions[column[0].column_letter].width = 24
    payload = _serialize_exact(workbook); workbook.close()
    return payload, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', f'CEASEFIRE-{selected[0]["mode"].title()}-Takeoffs.xlsx'


def export_workspace(snapshot, request, format, *, documents, store):
    """Read-only current-register/drawing exports after service evidence gates."""
    if format not in ('schedule-xlsx', 'marked-pdf'):
        raise ValidationError('Choose the current schedule XLSX or marked drawing PDF export.')
    if request.get('mode') == 'penetrations' and format == 'marked-pdf':
        if type(request.get('expected_revision')) is not int or request['expected_revision'] != snapshot['revision']:
            raise ValidationError('The Takeoffs draft changed before export. Retry from its current state.')
        from .takeoff_physical_markers import export_physical_pdf
        return export_physical_pdf(snapshot, request, documents)
    allowed = {'expected_revision', 'mode', 'item_ids', 'calculator_drafts'} | ({'document_id'} if format == 'marked-pdf' else set())
    required = {'expected_revision', 'mode'} | ({'document_id', 'item_ids'} if format == 'marked-pdf' else set())
    object_fields(request, allowed, 'Current Takeoffs export', required)
    if type(request['expected_revision']) is not int or request['expected_revision'] != snapshot['revision']:
        raise ValidationError('The Takeoffs draft changed before export. Retry from its current state.')
    if request['mode'] not in ('steel', 'duct', 'wall', 'slab'):
        raise ValidationError('Choose the active Steel, Duct, Walls or Slabs register.')
    active = sorted((item for item in snapshot['items'] if item['mode'] == request['mode']), key=is_standalone_count)
    ids = request.get('item_ids', [item['id'] for item in active])
    if (not isinstance(ids, list) or len(ids) > 10000 or any(not isinstance(value, str) for value in ids)
            or len(ids) != len(set(ids)) or set(ids) - {item['id'] for item in active}):
        raise ValidationError('Export item IDs must be distinct existing items in the selected Takeoffs mode.')
    if format == 'schedule-xlsx':
        if set(ids) != {item['id'] for item in active}:
            raise ValidationError('Download XLSX includes every item in the current mode, including hidden rows.')
        if not active:
            raise ValidationError('There are no items in this Takeoffs schedule to export.')
        selected = active
    else:
        document = next((doc for doc in snapshot['documents'] if doc['id'] == request['document_id']), None)
        if document is None:
            raise ValidationError('Choose a source document retained in this Takeoffs project.')
        by_id = {item['id']: item for item in active}; selected = [by_id[identifier] for identifier in ids]
        if any(not item['geometry'] or item['geometry']['document_id'] != document['id'] for item in selected):
            raise ValidationError('Every exported markup must belong to the selected original PDF.')
    approvals, binding_registry = _local_authority(snapshot, store)
    results = {item['id']: item_result(item, snapshot) for item in selected}
    confirmations = {item['id']: _confirmed(item, snapshot, results[item['id']], approvals) for item in selected}
    drafts = _calculator_drafts(request.get('calculator_drafts', {}))
    linked = _linked_results(snapshot, selected, confirmations, binding_registry, drafts)
    if format == 'schedule-xlsx':
        return _schedule_xlsx(snapshot, selected, results, confirmations, linked)
    from .takeoff_markup_pdf import export_marked_pdf
    return export_marked_pdf(document, selected, results, confirmations, linked, documents,
                             project_id=snapshot['project_id'], revision=snapshot['revision'], mode=request['mode'])
