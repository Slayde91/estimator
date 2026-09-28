"""Literal-value takeoff registers retaining IDs, sources and transfer lineage."""

import csv
from io import StringIO
import json

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

from .catalog import ValidationError
from .takeoff_area import AREA_MODES, measured_area
from .takeoff_model import item_digest, measured_length
from .pricing_workbook import _serialize_exact


HEADERS = ('Item ID', 'Item version', 'Mode', 'Mark / run', 'Level', 'Zone', 'Group',
           'Member type', 'Section', 'Shape', 'Width mm', 'Height mm', 'Diameter mm',
           'Quantity', 'Length per item m', 'Total length m', 'FRL', 'Fire period min',
           'Exposure', 'Orientation', 'System', 'Product', 'Source document ID',
           'Source document', 'Source SHA-256', 'Source page', 'Geometry PDF points',
           'Measurement basis', 'Evidence references', 'Confirmation ID',
           'Confirmation digest', 'Confirmed at', 'Transfer references', 'Notes', 'Physical member IDs',
           'Confirmation checks', 'Confirmed by', 'Gross area m2', 'Excluded area m2', 'Net area m2',
           'Treatment', 'Substrate', 'Surface basis', 'Surface citation', 'Area exclusions')


def register_rows(snapshot, items):
    documents = {d['id']: d for d in snapshot['documents']}
    rows = []
    for item in items:
        if item['state'] != 'confirmed' or not item['confirmation'] or item['confirmation']['digest'] != item_digest(item, snapshot):
            raise ValidationError('Only unchanged confirmed takeoff records can be exported.')
        fields, geometry, receipt = item['fields'], item['geometry'], item['confirmation']
        if not geometry or type(item['quantity']) is not int or item['quantity'] <= 0:
            raise ValidationError('Export requires source geometry and explicit physical quantities.')
        doc = documents[geometry['document_id']]
        area = measured_area(item, snapshot) if item['mode'] in AREA_MODES else None
        length = None if area is not None else measured_length(item, snapshot)
        basis = dict(item['measurement'])
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
                ('Scope', 'Confirmed measured takeoffs. Technical suitability requires separate assessment.'),
                ('Coordinates', 'Unrotated source PDF coordinates; measurements use the retained calibration or cited dimension.'),
                ('Quantity', 'Explicit physical quantity; never photo count. Linear total length is quantity times per-item length. A wall/slab polygon is one distinct treatment surface; net area is gross area less its explicit exclusions, with no inferred face multiplier.'),
                ('Surface basis', 'Wall polygons represent true wall faces, not plan footprints. Slab polygons identify top or soffit surfaces. Calibration scale is squared for area; rendering rotation and UserUnit do not change quantities.'),
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
