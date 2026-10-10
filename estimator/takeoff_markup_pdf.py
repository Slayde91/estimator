"""Read-only marked PDF export through one bounded disposable PDF process."""
from hashlib import sha256
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from threading import BoundedSemaphore

from .catalog import ROOT, ValidationError
from .takeoff_documents import _open_regular
from .takeoff_model import markup_appearance, polyline_length, validate_measurement_scope

MAX_OUTPUT_BYTES = 256 * 1024 * 1024
MAX_SPEC_BYTES = 16 * 1024 * 1024
PDF_EXPORT_TIMEOUT = 65
_SLOTS = BoundedSemaphore(1)


def measurement_value_labels(item, snapshot, result):
    """Presentation labels use explicit cited lengths or the exact page calibration."""
    if not markup_appearance(item)['display_values']:
        return []
    geometry, measurement = item.get('geometry'), item.get('measurement')
    if not geometry or not measurement:
        return []
    if geometry.get('kind') == 'count' and item['mode'] == 'steel':
        return [{'point': point, 'value': measurement['length_m'] * 1000, 'unit': 'mm', 'kind': 'cited-count'}
                for point in geometry['points']]
    if measurement['method'] != 'calibrated' or snapshot is None:
        return []
    try:
        validate_measurement_scope(item, snapshot)
        calibration = next(value for value in snapshot['calibrations'] if value['id'] == measurement['calibration_id'])
        scale = calibration['distance_m'] / polyline_length(calibration['points'])
    except (ValidationError, StopIteration):
        return []
    polygon = geometry.get('kind') == 'polygon'
    rings = [geometry['points']] + ([value['points'] for value in geometry.get('exclusions', [])] if polygon else [])
    labels = []
    for ring in rings:
        points = ring + [ring[0]] if polygon else ring
        for a, b in zip(points, points[1:]):
            labels.append({'point': [(a[0]+b[0])/2, (a[1]+b[1])/2],
                           'value': math.hypot(b[0]-a[0], b[1]-a[1]) * scale * 1000, 'unit': 'mm', 'kind': 'segment'})
    if polygon and result.get('net_area_m2') is not None:
        point = surface_label_point(geometry)
        if point is not None:
            labels.append({'point': point, 'value': result['net_area_m2'], 'unit': 'm²', 'kind': 'area'})
    return labels


def surface_label_point(geometry):
    """Choose an interior drawing span without placing the area value in an opening."""
    from .takeoff_area import _inside
    rings = [geometry['points']] + [value['points'] for value in geometry.get('exclusions', [])]
    levels = sorted({point[1] for ring in rings for point in ring})
    centre = (levels[0]+levels[-1])/2
    scans = sorted(((a+b)/2 for a, b in zip(levels, levels[1:])), key=lambda y: abs(y-centre))
    for y in scans[:16]:
        crossings = sorted(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1])
                           for ring in rings for a, b in zip(ring, ring[1:]+ring[:1]) if (a[1] > y) != (b[1] > y))
        spans = sorted(zip(crossings[::2], crossings[1::2]), key=lambda span: span[1]-span[0], reverse=True)
        for left, right in spans[:8]:
            point = [(left+right)/2, y]
            if _inside(point, rings[0]) and not any(_inside(point, ring) for ring in rings[1:]):
                return point
    return None


def export_marked_pdf(document, items, results, confirmations, linked, documents, *, project_id, revision, mode, physical_rows=None, snapshot=None, physical_rendering=None, annotations=()):
    from .takeoff_exports import linked_result_text
    from .takeoff_presentation import effective_appearance, legend_rows
    if not _SLOTS.acquire(blocking=False):
        raise ValidationError('Another marked drawing PDF is being prepared. Retry after it finishes.')
    try:
        source = documents.document_path(document, verify=True)
        rows = list(physical_rows or [])
        vertices = len(rows)
        for item in items:
            geometry = item['geometry']; fields = item['fields']; result = results[item['id']]
            vertices += len(geometry['points']) + sum(len(value['points']) for value in geometry.get('exclusions', []))
            rows.append({'id': item['id'], 'mode': item['mode'], 'purpose': item.get('purpose'), 'geometry': geometry,
                         'cited_region': bool(item['measurement'] and item['measurement']['method'] == 'cited'),
                         'appearance': effective_appearance(snapshot, item, linked) if snapshot else markup_appearance(item), 'mark': fields.get('mark') or item['id'][:8],
                         'section': fields.get('section'), 'shape': fields.get('shape'),
                         'width_mm': fields.get('width_mm'), 'height_mm': fields.get('height_mm'),
                         'diameter_mm': fields.get('diameter_mm'), 'quantity': item['quantity'],
                         'manual_length_m': item['measurement']['length_m'] if geometry.get('kind') == 'count' else None,
                         'additions_length_m': result.get('additions_length_m', 0),
                         'length_additions': item.get('length_additions', []),
                          'total_length_m': result.get('total_length_m'), 'net_area_m2': result.get('net_area_m2'),
                          **({'layers': result['layers'], 'total_area_m2': result['total_area_m2']} if 'layers' in fields else {}),
                         'value_labels': measurement_value_labels(item, snapshot, result),
                         'confirmed': confirmations[item['id']], 'linked_result': linked_result_text(linked[item['id']])})
        if vertices > 200000:
            raise ValidationError('The visible markup geometry exceeds the PDF export limit. Export a smaller visible selection.')
        spec = {'document': document, 'items': rows, 'project_id': project_id, 'revision': revision, 'mode': mode,
                'logo': str(ROOT / 'static' / 'ceasefire-logo.png')}
        from .takeoff_annotations import annotation_appearance, validate_annotation
        spec['annotations'] = []
        for annotation in annotations:
            validate_annotation(annotation, snapshot)
            if annotation['mode'] not in (('wall', 'slab') if mode == 'walls_floors' else (mode,)) or annotation['document_id'] != document['id']:
                raise ValidationError('Every free call-out must belong to the selected mode and exact source drawing.')
            spec['annotations'].append({**annotation, 'appearance': annotation_appearance(annotation['appearance'])})
        if physical_rows is not None:
            spec.update(physical_drawing=True, physical_rendering=physical_rendering or {'zoom':1,'rotations':{}})
        if snapshot:
            spec['drawing_legends'] = [{**legend, 'rows': legend_rows(snapshot, legend, results, linked)}
                for legend in snapshot.get('drawing_presentation', {}).get('legends', [])
                if legend['visible'] and legend['document_id'] == document['id'] and legend['mode'] == mode]
        payload = json.dumps(spec, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        if len(payload) > MAX_SPEC_BYTES:
            raise ValidationError('The marked drawing legend exceeds the bounded export limit. Reduce the visible selection.')
        with tempfile.TemporaryDirectory(prefix='ceasefire-marked-pdf-') as directory:
            folder = Path(directory); specification = folder / 'request.json'; output = folder / 'marked.pdf'
            if shutil.disk_usage(folder).free < document['size'] + MAX_OUTPUT_BYTES + 64*1024*1024:
                raise ValidationError('There is not enough temporary disk space to export this marked drawing safely.')
            specification.write_bytes(payload)
            try:
                completed = subprocess.run([sys.executable, '-I', str(Path(__file__).with_name('takeoff_markup_pdf_worker.py')),
                                            str(source), str(specification), str(output)],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=PDF_EXPORT_TIMEOUT,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=False)
            except subprocess.TimeoutExpired as error:
                raise ValidationError('Marked drawing export exceeded its time limit. No source PDF was changed.') from error
            if completed.returncode or len(completed.stdout) > 2048:
                raise ValidationError('Marked drawing export exceeded its resource limits or could not render the source safely.')
            try:
                receipt = json.loads(completed.stdout)
            except (ValueError, UnicodeError) as error:
                raise ValidationError('Marked drawing export did not return a valid completion receipt.') from error
            if not isinstance(receipt, dict) or set(receipt) != {'sha256', 'size', 'pages'}:
                raise ValidationError(receipt.get('error', 'The marked PDF could not be exported safely.') if isinstance(receipt, dict) else 'Invalid marked PDF result.')
            with _open_regular(output, MAX_OUTPUT_BYTES) as stream:
                exported = stream.read(MAX_OUTPUT_BYTES+1)
            if (type(receipt['size']) is not int or receipt['size'] != len(exported)
                    or sha256(exported).hexdigest() != receipt['sha256'] or not exported.startswith(b'%PDF-')
                    or type(receipt['pages']) is not int or not len(document['pages']) <= receipt['pages'] <= 4000):
                raise ValidationError('The marked PDF completion receipt did not match its output.')
            return exported, 'application/pdf', 'CEASEFIRE-Marked-Drawing.pdf'
    finally:
        _SLOTS.release()
