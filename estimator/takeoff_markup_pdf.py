"""Read-only marked PDF export through one bounded disposable PDF process."""
from hashlib import sha256
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from threading import BoundedSemaphore

from .catalog import ROOT, ValidationError
from .takeoff_documents import _open_regular
from .takeoff_model import markup_appearance

MAX_OUTPUT_BYTES = 256 * 1024 * 1024
MAX_SPEC_BYTES = 16 * 1024 * 1024
PDF_EXPORT_TIMEOUT = 65
_SLOTS = BoundedSemaphore(1)


def export_marked_pdf(document, items, results, confirmations, linked, documents, *, project_id, revision, mode):
    from .takeoff_exports import linked_result_text
    if not _SLOTS.acquire(blocking=False):
        raise ValidationError('Another marked drawing PDF is being prepared. Retry after it finishes.')
    try:
        source = documents.document_path(document, verify=True)
        rows = []
        vertices = 0
        for item in items:
            geometry = item['geometry']; fields = item['fields']; result = results[item['id']]
            vertices += len(geometry['points']) + sum(len(value['points']) for value in geometry.get('exclusions', []))
            rows.append({'id': item['id'], 'mode': item['mode'], 'geometry': geometry,
                         'cited_region': bool(item['measurement'] and item['measurement']['method'] == 'cited'),
                         'appearance': markup_appearance(item), 'mark': fields.get('mark') or item['id'][:8],
                         'section': fields.get('section'), 'shape': fields.get('shape'),
                         'width_mm': fields.get('width_mm'), 'height_mm': fields.get('height_mm'),
                         'diameter_mm': fields.get('diameter_mm'), 'quantity': item['quantity'],
                         'manual_length_m': item['measurement']['length_m'] if geometry.get('kind') == 'count' else None,
                         'additions_length_m': result.get('additions_length_m', 0),
                         'length_additions': item.get('length_additions', []),
                         'total_length_m': result.get('total_length_m'), 'net_area_m2': result.get('net_area_m2'),
                         'confirmed': confirmations[item['id']], 'linked_result': linked_result_text(linked[item['id']])})
        if vertices > 200000:
            raise ValidationError('The visible markup geometry exceeds the PDF export limit. Export a smaller visible selection.')
        spec = {'document': document, 'items': rows, 'project_id': project_id, 'revision': revision, 'mode': mode,
                'logo': str(ROOT / 'static' / 'ceasefire-logo.png')}
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
