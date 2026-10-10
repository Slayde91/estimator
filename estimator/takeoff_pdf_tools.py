"""Read-only page operations on exact retained PDFs, in a bounded child process.

The session service owns locking, source ownership and audit verification. This
module never publishes a source, edits a draft or accepts a client filesystem path.
"""
from hashlib import sha256
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from threading import BoundedSemaphore

from .catalog import ValidationError
from .takeoff_documents import MAX_DOCUMENT_SIZE, MAX_DOCUMENTS, _metadata, _open_regular
from .takeoff_model import identity, object_fields

MAX_OUTPUT_PAGES = 2000  # Derived PDFs must be admissible as a new source.
MAX_INPUT_BYTES = MAX_DOCUMENT_SIZE
MAX_OUTPUT_BYTES = MAX_DOCUMENT_SIZE
MAX_SPEC_BYTES = 2 * 1024 * 1024
PDF_TOOLS_TIMEOUT = 65
_SLOTS = BoundedSemaphore(1)
OPERATIONS = ('merge', 'organise', 'extract')


def selection(snapshot, request):
    """Validate explicit order without changing any retained source identity."""
    required = {'expected_revision', 'operation', 'document_ids'}
    object_fields(request, required | {'page_order'}, 'PDF page tools', required)
    if type(request['expected_revision']) is not int or request['expected_revision'] != snapshot['revision']:
        raise ValidationError('The Takeoffs draft changed before preparing the PDF. Reopen Tools and try again.')
    operation = request['operation']
    if not isinstance(operation, str) or operation not in OPERATIONS:
        raise ValidationError('Choose Merge PDF Files, Organise Pages or Extract Pages.')
    identifiers = request['document_ids']
    if (not isinstance(identifiers, list) or not 1 <= len(identifiers) <= MAX_DOCUMENTS
            or any(not isinstance(value, str) for value in identifiers)):
        raise ValidationError('Choose retained Source Documents for the PDF operation.')
    for value in identifiers:
        identity(value, 'Source Document ID')
    if len(set(identifiers)) != len(identifiers):
        raise ValidationError('Choose each Source Document once.')
    by_id = {document['id']: document for document in snapshot['documents']}
    if set(identifiers) - by_id.keys():
        raise ValidationError('Every selected PDF must be retained in the current Takeoffs project.')
    documents = [by_id[value] for value in identifiers]
    for document in documents:
        _metadata(document)
    if sum(document['size'] for document in documents) > MAX_INPUT_BYTES:
        raise ValidationError('The selected source PDFs exceed the combined 250 MiB page-tools limit.')
    if operation == 'merge':
        if len(documents) < 2 or 'page_order' in request:
            raise ValidationError('Merge requires at least two distinct Source Documents in the requested order.')
        order = [{'source': index, 'page': number}
                 for index, document in enumerate(documents)
                 for number in range(1, len(document['pages']) + 1)]
    else:
        if len(documents) != 1:
            raise ValidationError('Organise Pages and Extract Pages use one Source Document.')
        pages = request.get('page_order')
        if (not isinstance(pages, list) or not 1 <= len(pages) <= MAX_OUTPUT_PAGES
                or any(type(value) is not int or not 1 <= value <= len(documents[0]['pages']) for value in pages)
                or len(set(pages)) != len(pages)):
            raise ValidationError('Choose distinct existing page numbers, in the required output order. Keep at least one page.')
        order = [{'source': 0, 'page': number} for number in pages]
    if len(order) > MAX_OUTPUT_PAGES:
        raise ValidationError('The derived PDF supports at most 2,000 pages. Select fewer documents or pages.')
    return documents, order


def build_pdf(snapshot, request, documents):
    """Return a validated derivative; optional source publication is a separate action."""
    selected, order = selection(snapshot, request)
    if not _SLOTS.acquire(blocking=False):
        raise ValidationError('Another PDF page operation is in progress. Try again after it finishes.')
    try:
        sources = [{'path': str(documents.document_path(document, verify=True)),
                    'sha256': document['sha256'], 'size': document['size'], 'pages': document['pages']}
                   for document in selected]
        payload = json.dumps({'sources': sources, 'page_order': order}, ensure_ascii=False,
                             allow_nan=False, separators=(',', ':')).encode('utf-8')
        if len(payload) > MAX_SPEC_BYTES:
            raise ValidationError('The PDF page selection exceeds its bounded request limit.')
        with tempfile.TemporaryDirectory(prefix='ceasefire-pdf-pages-') as directory:
            folder = Path(directory); specification = folder / 'request.json'; output = folder / 'pages.pdf'
            if shutil.disk_usage(folder).free < sum(value['size'] for value in selected) + MAX_OUTPUT_BYTES + 64*1024*1024:
                raise ValidationError('There is not enough temporary disk space to prepare this PDF safely.')
            specification.write_bytes(payload)
            try:
                completed = subprocess.run([sys.executable, '-I', str(Path(__file__).with_name('takeoff_pdf_tools_worker.py')),
                                            str(specification), str(output)], stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, timeout=PDF_TOOLS_TIMEOUT,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=False)
            except subprocess.TimeoutExpired as error:
                raise ValidationError('PDF page tools exceeded their time limit. The original PDFs are unchanged.') from error
            if completed.returncode or len(completed.stdout) > 1024*1024:
                raise ValidationError('The PDF page operation exceeded its resource limits or could not complete safely.')
            try:
                receipt = json.loads(completed.stdout)
            except (ValueError, UnicodeError) as error:
                raise ValidationError('PDF page tools returned an invalid completion receipt.') from error
            if not isinstance(receipt, dict) or set(receipt) != {'sha256', 'size', 'pages', 'metadata'}:
                message = receipt.get('error') if isinstance(receipt, dict) else None
                raise ValidationError(message if isinstance(message, str) and len(message) <= 300 else 'The PDF could not be prepared safely.')
            with _open_regular(output, MAX_OUTPUT_BYTES) as stream:
                result = stream.read(MAX_OUTPUT_BYTES+1)
            expected = [{**selected[value['source']]['pages'][value['page']-1], 'page': index}
                        for index, value in enumerate(order, 1)]
            if (type(receipt['size']) is not int or receipt['size'] != len(result)
                    or not 0 < len(result) <= MAX_OUTPUT_BYTES or not result.startswith(b'%PDF-')
                    or sha256(result).hexdigest() != receipt['sha256']
                    or type(receipt['pages']) is not int or receipt['pages'] != len(order)
                    or receipt['metadata'] != expected):
                raise ValidationError('The derived PDF bytes, page order or geometry did not match its validated result.')
            names = {'merge': 'CEASEFIRE-Merged-PDF.pdf', 'organise': 'CEASEFIRE-Organised-Pages.pdf',
                     'extract': 'CEASEFIRE-Extracted-Pages.pdf'}
            return result, 'application/pdf', names[request['operation']]
    finally:
        _SLOTS.release()
