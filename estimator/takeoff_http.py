"""Explicit HTTP adapter for local takeoff capabilities and bounded PDF uploads."""
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit

from .catalog import ValidationError

CHUNK_LIMIT = 8 * 1_048_576
TOKEN = r'[A-Za-z0-9_-]{1,100}'
OCR_WORKER_POLICY = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'"


class TakeoffHTTP:
    def __init__(self, service, root, policy):
        self.service = service
        self.documents = service.documents
        self.vendor = Path(root) / 'static' / 'vendor' / 'pdfjs'
        self.policy = policy
        self.manifest = json.loads((self.vendor / 'manifest.json').read_text(encoding='utf-8'))['files']
        self.ocr_vendor = Path(root) / 'static' / 'vendor' / 'ocr'
        self.ocr_manifest = json.loads((self.ocr_vendor / 'manifest.json').read_text(encoding='utf-8'))['files']

    def dispatch(self, handler, route):
        if route.startswith('/vendor/ocr/'):
            if handler.command != 'GET':
                handler.send_payload(405, {'error': 'Method not allowed.'})
                return True
            name = route.removeprefix('/vendor/ocr/')
            entry = self.ocr_manifest.get(name)
            if entry is None:
                handler.send_payload(404, {'error': 'Unknown OCR asset.'})
                return True
            data = (self.ocr_vendor / name).read_bytes()
            if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise ValidationError('The installed local OCR asset failed its integrity check.')
            kind = 'text/javascript; charset=utf-8' if name.endswith('.js') else 'application/octet-stream'
            if name == 'worker.min.js':
                # Only this dedicated recognition worker may compile its pinned
                # WebAssembly core. Main-page and other asset policies stay strict.
                handler.send_payload(200, data, kind, content_security_policy_override=OCR_WORKER_POLICY)
            else:
                handler.send_payload(200, data, kind)
            return True
        if route.startswith('/vendor/pdfjs/'):
            if handler.command != 'GET':
                handler.send_payload(405, {'error': 'Method not allowed.'})
                return True
            name = route.removeprefix('/vendor/pdfjs/')
            entry = self.manifest.get(name)
            if entry is None:
                handler.send_payload(404, {'error': 'Unknown viewer asset.'})
                return True
            data = (self.vendor / name).read_bytes()
            if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise ValidationError('The installed PDF viewer asset failed its integrity check.')
            kind = {'.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm',
                    '.ttf': 'font/ttf', '.otf': 'font/otf', '.bcmap': 'application/octet-stream'}.get(Path(name).suffix, 'application/octet-stream')
            handler.send_payload(200, data, kind)
            return True
        if not route.startswith('/api/takeoffs/'):
            return False
        query = parse_qs(urlsplit(handler.path).query, keep_blank_values=True)
        if any(len(value) != 1 for value in query.values()):
            raise ValidationError('Use one value per takeoff option.')
        query = {key: value[0] for key, value in query.items()}
        if route == '/api/takeoffs/colour-legend' and handler.command == 'GET':
            if query:
                raise ValidationError('The colour legend does not accept extra options.')
            from .takeoff_presentation import PALETTE
            handler.send_payload(200, {'rounding': 'nearest_whole_mm', 'colours': [
                {'name': name, 'colour': colour, 'min_mm': index * 2 + 1,
                 'max_mm': None if index == 39 else index * 2 + 2}
                for index, (name, colour) in enumerate(PALETTE)]})
            return True
        if route == '/api/takeoffs/options' and handler.command == 'GET':
            if set(query) - {'calculator', 'product', 'member_type'}:
                raise ValidationError('Choose a calculator and optional product/member type.')
            fields = {key: query[key] for key in ('product', 'member_type') if key in query}
            handler.send_payload(200, self.service.options(query.get('calculator', ''), fields))
            return True
        if route == '/api/takeoffs/profiles' and handler.command == 'GET':
            if set(query) - {'calculator', 'search'}:
                raise ValidationError('Choose a calculator and optional profile search.')
            handler.send_payload(200, self.service.profile_options(query.get('calculator', ''), query.get('search', '')))
            return True
        if route == '/api/takeoffs/sessions' and handler.command == 'POST':
            body = handler.read_json()
            if set(body) - {'snapshot'}:
                raise ValidationError('Include an optional takeoff snapshot only.')
            handler.send_payload(200, self.service.open(body.get('snapshot')))
            return True
        match = re.fullmatch(rf'/api/takeoffs/sessions/({TOKEN})(?:/(.*))?', route)
        if not match:
            handler.send_payload(404, {'error': 'Unknown takeoff operation.'})
            return True
        session_id, action = match.groups()
        current = self.service.get(session_id, verify_evidence=not action and handler.command == 'GET')
        if not action and handler.command == 'GET':
            handler.send_payload(200, current)
            return True
        if action == 'images' and handler.command == 'GET':
            if set(query) - {'extraction_id', 'offset', 'limit'}:
                raise ValidationError('Image inventory accepts one extraction, offset and page size.')
            try:
                offset, limit = int(query.get('offset', '0')), int(query.get('limit', '100'))
            except ValueError as error:
                raise ValidationError('Image inventory offset and page size must be integers.') from error
            handler.send_payload(200, self.service.images(session_id, query.get('extraction_id'), offset, limit))
            return True
        image_match = re.fullmatch(rf'images/({TOKEN})/({TOKEN})/file', action or '')
        if image_match and handler.command == 'GET':
            if query:
                raise ValidationError('Image files do not accept extra options.')
            payload, kind = self.service.image_file(session_id, image_match[1], image_match[2])
            handler.send_payload(200, payload, kind)
            return True
        file_match = re.fullmatch(rf'documents/({TOKEN})/file', action or '')
        if file_match and handler.command == 'GET':
            document = next((doc for doc in current['snapshot']['documents'] if doc['id'] == file_match[1]), None)
            if document is None:
                raise ValidationError('The document is not part of this workspace.')
            with self.documents.iter_document(document, handler.headers.get('Range')) as (status, headers, chunks):
                handler.send_response(status)
                for key, value in headers.items():
                    handler.send_header(key, str(value))
                handler.send_header('Cache-Control', 'no-store')
                handler.send_header('X-Content-Type-Options', 'nosniff')
                handler.send_header('Referrer-Policy', 'no-referrer')
                handler.send_header('Content-Security-Policy', self.policy)
                handler.end_headers()
                for chunk in chunks:
                    handler.wfile.write(chunk)
            return True
        upload_match = re.fullmatch(rf'uploads/({TOKEN})(?:/(complete|cancel))?', action or '')
        if upload_match and handler.command == 'PUT' and upload_match[2] is None:
            if set(query) != {'offset'} or handler.headers.get_content_type() != 'application/octet-stream' or handler.headers.get('Transfer-Encoding'):
                raise ValidationError('Upload a binary chunk with one offset and Content-Length.')
            try:
                size = int(handler.headers.get('Content-Length', '0'))
                offset = int(query['offset'])
            except ValueError as error:
                raise ValidationError('Invalid chunk size or offset.') from error
            if not 0 < size <= CHUNK_LIMIT or offset < 0:
                raise ValidationError('Upload chunks must be at most 8 MiB with a nonnegative offset.')
            payload = handler.rfile.read(size)
            if len(payload) != size:
                raise ValidationError('The upload chunk is incomplete.')
            handler.send_payload(200, self.documents.write_chunk(session_id, upload_match[1], offset, payload))
            return True
        if handler.command != 'POST':
            handler.send_payload(405, {'error': 'Method not allowed.'})
            return True
        body = handler.read_json()
        if action == 'close':
            if body:
                raise ValidationError('Closing a workspace does not accept extra values.')
            self.service.close(session_id)
            result = {'closed': True}
        elif action == 'uploads':
            if set(body) - {'filename', 'size', 'sha256'} or not {'filename', 'size'} <= set(body):
                raise ValidationError('Include the PDF filename, size and optional checksum.')
            if len(current['snapshot']['documents']) >= 100:
                raise ValidationError('A takeoff project supports at most 100 PDFs.')
            result = self.documents.begin_upload(session_id, body['filename'], body['size'], body.get('sha256'))
        elif upload_match and upload_match[2] == 'complete':
            if set(body) != {'expected_revision'}:
                raise ValidationError('Include the current workspace revision.')
            if current['revision'] != body['expected_revision']:
                raise ValidationError('The workspace changed. Review it before completing the upload.')
            document = self.documents.finish_upload(session_id, upload_match[1])
            result = self.service.add_document(session_id, document, body['expected_revision'])
        elif upload_match and upload_match[2] == 'cancel':
            if body:
                raise ValidationError('Cancellation does not accept extra values.')
            self.documents.cancel_upload(session_id, upload_match[1])
            result = {'cancelled': True}
        elif action == 'commands':
            result = self.service.command(session_id, body)
        elif action == 'auto-calibrate':
            result = self.service.auto_calibrate(session_id, body)
        elif action == 'physical/preview':
            result = self.service.preview_physical(session_id, body)
        elif action == 'physical/apply':
            result = self.service.apply_physical(session_id, body)
        elif action == 'library/preview':
            result = self.service.preview_library_link(session_id, body)
        elif action == 'library/apply':
            result = self.service.apply_library_link(session_id, body)
        elif action == 'library/transfer-confirmed':
            if query:
                raise ValidationError('Confirmed register transfer accepts a structured request only.')
            result = self.service.transfer_confirmed_library(session_id, body)
        elif action == 'images/extract':
            result = self.service.extract_images(session_id, body)
        elif action in {'physical/export/csv', 'physical/export/xlsx', 'physical/export/pdf'}:
            format = action.rsplit('/', 1)[1]
            allowed = {'scope', 'expected_revision', 'confirmation'} if format == 'xlsx' else ({'scope', 'expected_revision'} if format == 'pdf' else {'scope'})
            if not isinstance(body, dict) or set(body) - allowed:
                raise ValidationError('Draft physical export accepts only its workspace scope and supported document selection.')
            payload, kind, filename = self.service.export_physical(session_id, format, body.get('scope', 'defect_reports'), body.get('expected_revision'), body.get('confirmation'))
            handler.send_download(payload, kind, filename)
            return True
        elif action == 'transfer-preview':
            result = self.service.preview_transfer(session_id, body)
        elif action == 'linked-results':
            if query:
                raise ValidationError('Linked register results accept a structured request only.')
            result = self.service.linked_register_results(session_id, body)
        elif action == 'transfer-apply':
            result = self.service.apply_transfer(session_id, body)
        elif action == 'linked-delete':
            result = self.service.delete_linked_items(session_id, body)
        elif action == 'linked-undo':
            result = self.service.undo_linked_delete(session_id, body)
        elif action == 'history':
            if set(body) - {'offset', 'limit'}:
                raise ValidationError('History accepts a page offset and limit only.')
            result = self.service.history(session_id, **body)
        elif action in {'export/csv', 'export/xlsx'}:
            if set(body) - {'selected_ids'}:
                raise ValidationError('Choose the confirmed items to export.')
            payload, kind, filename = self.service.export(session_id, action.rsplit('/', 1)[1], body.get('selected_ids'))
            handler.send_download(payload, kind, filename)
            return True
        elif action in {'export/schedule-xlsx', 'export/marked-pdf'}:
            if query:
                raise ValidationError('Current Takeoffs exports accept a structured request only.')
            payload, kind, filename = self.service.export_workspace(session_id, action.rsplit('/', 1)[1], body)
            handler.send_download(payload, kind, filename)
            return True
        else:
            handler.send_payload(404, {'error': 'Unknown takeoff operation.'})
            return True
        handler.send_payload(200, result)
        return True
