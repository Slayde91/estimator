"""Bounded, read-only viewer markup derivatives across distinct workspaces."""
from hashlib import sha256
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

from .catalog import ValidationError
from .takeoff_documents import _open_regular
from .takeoff_model import object_fields
from .takeoff_markup_pdf import MAX_OUTPUT_BYTES, MAX_SPEC_BYTES, PDF_EXPORT_TIMEOUT, _SLOTS

KINDS = ('current-all', 'current-marked', 'all-all', 'all-marked')
SCOPES = ('steel', 'duct', 'walls_floors', 'defect_reports', 'service_plans')
MAX_COPIES = 128
MAX_PAGES = 4000


def _rendering(value, document):
    object_fields(value, {'zoom', 'rotations'}, 'Viewer PDF rendering', {'zoom', 'rotations'})
    zoom, rotations = value['zoom'], value['rotations']
    valid_pages = {str(index) for index in range(1, len(document['pages']) + 1)}
    if type(zoom) not in (int, float) or not math.isfinite(zoom) or not .05 <= zoom <= 20:
        raise ValidationError('Viewer PDF zoom must be finite and between 0.05 and 20.')
    if (not isinstance(rotations, dict) or len(rotations) > len(valid_pages)
            or any(page not in valid_pages or type(rotation) is not int
                   or rotation not in (0, 90, 180, 270) for page, rotation in rotations.items())):
        raise ValidationError('Viewer PDF rotations must identify retained pages and quarter turns.')
    return {'zoom': zoom, 'rotations': rotations}


def _selection(snapshot, scope, document_id):
    modes = ('wall', 'slab') if scope == 'walls_floors' else (scope,)
    physical = scope in ('defect_reports', 'service_plans')
    if physical:
        from .takeoff_physical_operations import current_graph
        from .takeoff_physical_markers import defect_annotation
        graph = current_graph(snapshot, scope)
        identifiers = [value['id'] for value in graph['barriers'] if not value['deleted']
                       and (value.get('marker') or {}).get('document_id') == document_id]
        if graph['version'] == 2:
            identifiers += [value['id'] for value in graph['defects'] if not value['deleted']
                            and defect_annotation(value, document_id)]
        elif graph['version'] == 3:
            identifiers += [value['id'] for value in graph['services'] if not value['deleted']
                            and (value.get('annotation') or {}).get('document_id') == document_id]
    else:
        identifiers = [value['id'] for value in snapshot['items'] if value['mode'] in modes
                       and (value.get('geometry') or {}).get('document_id') == document_id]
    return {'item_ids': identifiers,
            'annotation_ids': [] if physical else [value['id'] for value in snapshot.get('annotations', {}).get('callouts', [])
                if value['mode'] in modes and value['document_id'] == document_id],
            'signature_ids': [value['id'] for value in snapshot.get('signatures', {}).get('records', [])
                if value['mode'] in modes and value['document_id'] == document_id],
            'graphic_ids': [value['id'] for value in snapshot.get('graphics', {}).get('records', [])
                if value['mode'] in modes and value['document_id'] == document_id],
            'legend_ids': [value['id'] for value in snapshot.get('drawing_presentation', {}).get('legends', [])
                if value['visible'] and value['mode'] == scope and value['document_id'] == document_id]}


def _visible(selection, value):
    object_fields(value, set(selection), 'Visible viewer markups', set(selection))
    for name, active in selection.items():
        ids = value[name]
        if (not isinstance(ids, list) or len(ids) > len(active) or any(not isinstance(item, str) for item in ids)
                or len(ids) != len(set(ids)) or set(ids) - set(active)):
            raise ValidationError('Visible markup IDs must belong to the exact workspace and retained source PDF.')
    return value


def prepare_copies(snapshot, request, documents, store):
    """Validate all source-bound selections before starting a disposable worker."""
    from .takeoff_exports import export_workspace
    required = {'expected_revision', 'kind', 'mode'}
    allowed = required | {'document_id', 'physical_scope', 'visibility', 'rendering', 'calculator_drafts', 'targets'}
    object_fields(request, allowed, 'Viewer markup PDF export', required)
    if type(request['expected_revision']) is not int or request['expected_revision'] != snapshot['revision']:
        raise ValidationError('The takeoff draft changed. Download its current revision again.')
    if request['kind'] not in KINDS or request['mode'] not in ('steel', 'duct', 'walls_floors', 'penetrations'):
        raise ValidationError('Choose a supported markup download and Takeoff workspace.')
    scope = request.get('physical_scope') if request['mode'] == 'penetrations' else request['mode']
    if scope not in SCOPES or request['mode'] != 'penetrations' and 'physical_scope' in request:
        raise ValidationError('Choose the current physical workspace only for penetration drawings.')
    current = request['kind'].startswith('current-')
    docs = {document['id']: document for document in snapshot['documents']}
    if current and (not isinstance(request.get('document_id'), str) or request['document_id'] not in docs):
        raise ValidationError('Open a retained original PDF before downloading its current markups.')
    if not current and ('document_id' in request or 'visibility' in request):
        raise ValidationError('Combined downloads include every marked workspace; current visibility cannot filter them.')
    renderings = request.get('rendering', {})
    if not isinstance(renderings, dict) or set(renderings) - docs.keys():
        raise ValidationError('Viewer rendering must identify retained original PDFs only.')
    renderings = {key: _rendering(value, docs[key]) for key, value in renderings.items()}
    targets = request.get('targets', {})
    if (not isinstance(targets, dict) or set(targets) - {'steel', 'duct'}
            or 'steel' in targets and targets['steel'] not in ('steel_vermiculite', 'steel_intumescent', 'steel_board')
            or 'duct' in targets and targets['duct'] != 'ductwork'):
        raise ValidationError('Drawing legend targets must be supported Steel or Duct calculators.')
    copies, pages, size, geometry_cost = [], 0, 0, 0
    for active_scope in (scope,) if current else SCOPES:
        for document in snapshot['documents']:
            if current and document['id'] != request['document_id']:
                continue
            all_selected = _selection(snapshot, active_scope, document['id']); selected = all_selected
            if current and 'visibility' in request:
                selected = _visible(selected, request['visibility'])
            if not current and not any(selected.values()):
                continue
            rendering = renderings.get(document['id'], {'zoom': 1, 'rotations': {}})
            physical = active_scope in ('defect_reports', 'service_plans')
            export_request = {'expected_revision': snapshot['revision'], 'mode': 'penetrations' if physical else active_scope,
                'document_id': document['id'], **{key: all_selected[key] if key == 'item_ids' and not physical else selected[key] for key in ('item_ids', 'signature_ids', 'graphic_ids')}}
            if physical:
                export_request.update(physical_scope=active_scope, rendering=rendering)
            else:
                export_request.update(annotation_ids=selected['annotation_ids'], calculator_drafts=request.get('calculator_drafts', {}))
            spec, source = export_workspace(snapshot, export_request, 'marked-pdf', documents=documents, store=store,
                markup_options={'viewer_rendering': rendering, 'prepare_only': True, 'legend_target': targets.get(active_scope)})
            spec['items'] = [value for value in spec['items'] if value['id'] in selected['item_ids']]
            spec['drawing_legends'] = [value for value in spec.get('drawing_legends', []) if value['id'] in selected['legend_ids']]
            marked = {value['geometry']['page'] for value in spec['items']}
            for name in ('annotations', 'signatures', 'graphics', 'drawing_legends'):
                marked.update(value['page'] for value in spec.get(name, []))
            spec['selected_pages'] = sorted(marked) if request['kind'].endswith('-marked') else list(range(1, len(document['pages']) + 1))
            if not spec['selected_pages']:
                continue
            pages += len(spec['selected_pages']); size += document['size']
            geometry_cost += sum(len(value['geometry']['points']) + sum(len(ring['points']) for ring in value['geometry'].get('exclusions', [])) for value in spec['items'])
            geometry_cost += sum(sum(len(stroke) for stroke in value['strokes']) for value in spec.get('signatures', []))
            from .takeoff_graphics import graphic_geometry_cost
            geometry_cost += sum(graphic_geometry_cost(value) for value in spec.get('graphics', []))
            if len(copies) >= MAX_COPIES or pages > MAX_PAGES or size > MAX_OUTPUT_BYTES or geometry_cost > 200000:
                raise ValidationError('This combined markup PDF exceeds its bounded drawing, page, source or geometry limit. Download a smaller current PDF.')
            copies.append({'source': source, 'spec': spec})
    if not copies:
        raise ValidationError('There are no visible marked pages in the selected drawing or Takeoff workspaces.')
    return copies, pages, size


def export_markups(snapshot, request, documents, store, progress=None):
    copies, pages, source_size = prepare_copies(snapshot, request, documents, store)
    payload = json.dumps({'copies': copies}, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    if len(payload) > MAX_SPEC_BYTES:
        raise ValidationError('The combined markup request exceeds its bounded export limit.')
    if not _SLOTS.acquire(blocking=False):
        raise ValidationError('Another marked drawing PDF is being prepared. Retry after it finishes.')
    try:
        with tempfile.TemporaryDirectory(prefix='classifire-viewer-markups-') as directory:
            folder = Path(directory); specification = folder / 'request.json'; output = folder / 'markups.pdf'; progress_path = folder / 'progress.json'
            if shutil.disk_usage(folder).free < source_size + MAX_OUTPUT_BYTES + 64 * 1024 * 1024:
                raise ValidationError('There is not enough temporary disk space to export these marked drawings safely.')
            specification.write_bytes(payload)
            started = time.monotonic(); reported = 0
            with subprocess.Popen([sys.executable, '-I', str(Path(__file__).with_name('takeoff_markup_pdf_worker.py')),
                    '--batch', str(specification), str(output), str(progress_path)], stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)) as process:
                while True:
                    try:
                        stdout, _ = process.communicate(timeout=.2)
                        break
                    except subprocess.TimeoutExpired:
                        if time.monotonic() - started > PDF_EXPORT_TIMEOUT:
                            process.kill(); process.communicate()
                            raise ValidationError('Markup PDF export exceeded its time limit. No original PDF was changed.')
                        if progress is not None and progress_path.exists():
                            try:
                                value = json.loads(progress_path.read_bytes())
                                completed = value['completed']
                                if set(value) != {'completed', 'total'} or value['total'] != pages or type(completed) is not int or not reported <= completed <= pages:
                                    raise ValueError('Invalid page progress.')
                            except (KeyError, ValueError, OSError, UnicodeError):
                                continue
                            if completed > reported:
                                progress(completed, pages); reported = completed
                if process.returncode or len(stdout) > 2048:
                    raise ValidationError('Markup PDF export exceeded its resource limits or could not render the sources safely.')
            try:
                receipt = json.loads(stdout)
            except (ValueError, UnicodeError) as error:
                raise ValidationError('Markup PDF export did not return a valid completion receipt.') from error
            if not isinstance(receipt, dict) or set(receipt) != {'sha256', 'size', 'pages'}:
                raise ValidationError(receipt.get('error', 'The markup PDF could not be exported safely.') if isinstance(receipt, dict) else 'Invalid markup PDF result.')
            with _open_regular(output, MAX_OUTPUT_BYTES) as stream:
                data = stream.read(MAX_OUTPUT_BYTES + 1)
            if (type(receipt['size']) is not int or receipt['size'] != len(data) or not data.startswith(b'%PDF-')
                    or sha256(data).hexdigest() != receipt['sha256'] or type(receipt['pages']) is not int or receipt['pages'] != pages):
                raise ValidationError('The markup PDF completion receipt did not match its complete output.')
            if progress is not None:
                progress(pages, pages)
            names = dict(zip(KINDS, ('Full-Markup', 'Markups-Only', 'All-Markups', 'Full-Markups-Only')))
            return data, 'application/pdf', f'CLASSIFIRE-{names[request["kind"]]}.pdf'
    finally:
        _SLOTS.release()
