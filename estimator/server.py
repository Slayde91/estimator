"""Loopback-only HTTP application. No hosted accounts or Excel runtime required."""

import argparse
import base64
import binascii
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from .calculation_work import CalculationBusy
import json
import logging
import re
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .calculator import fields, labour_breakdown
from .estimate_composition import calculate
from .catalog import ROOT, baseline, configuration_catalog, effective_catalog, validate_configuration, ValidationError
from .presentation import calculation_error_details
from .quote_details import compile_work_summary
from .storage import Store, WORKFLOWS
from .edition import excluded_route, features, render_index, require_project_edition, validate_edition
from .travel import TravelService, TravelError

MAX_BODY = 24 * 1_048_576
MAX_PRICING_FILE = 5 * 1_048_576
LOGGER = logging.getLogger(__name__)
DEFAULT_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"


def create_server(port=8765, database=None, project_dialogs=None, library_directory=None, *, allow_annotation_styles=False, edition='full'):
    edition = validate_edition(edition)
    capabilities = features(edition)
    content_security_policy = DEFAULT_CONTENT_SECURITY_POLICY
    if allow_annotation_styles:
        # Browser annotation tools inject stylesheet elements into their overlay.
        # Keep style attributes and scripts under the normal strict policy.
        content_security_policy += "; style-src-elem 'self' 'unsafe-inline'"
    store = Store(database or ROOT / ".runtime" / "estimator.sqlite3")
    travel = TravelService()
    takeoffs = takeoff_http = None
    if capabilities['takeoffs']:
        from .takeoff_documents import TakeoffDocuments
        from .takeoff_workspace import TakeoffService
        from .takeoff_http import TakeoffHTTP
        takeoffs = TakeoffService(store, TakeoffDocuments(store.path.parent / 'takeoffs'))
        takeoff_http = TakeoffHTTP(takeoffs, ROOT, content_security_policy)
    from .project_library import ProjectLibrary
    projects = ProjectLibrary(store, project_dialogs, takeoffs=takeoffs, edition=edition)
    from .download_progress import DownloadProgress
    download_progress = DownloadProgress()
    from .reference_library import ReferenceNotFound
    from .firestopping_library import LibraryConflict
    from .technical_library_edits import ManualTechnicalLibrary
    libraries = ManualTechnicalLibrary(library_directory, store)
    from .certification import CertificationService, CertificationConflict, CertificationNotFound
    certifications = CertificationService(store)
    from .certification_projects import CertificationProjects
    certification_projects = CertificationProjects(certifications)
    projects.certifications = certification_projects
    from .documentation_catalog import document_catalog, export_identity, PDF, XLSX
    from .project_documentation import ProjectDocumentation, DocumentationConflict, DocumentationNotFound
    document_types = document_catalog(edition)
    documentation = ProjectDocumentation(certification_projects, kinds={row['id']:row['label'] for row in document_catalog('full')})
    projects.documentation = documentation
    from .pdf_download_covers import PdfCoverConflict
    pdf_covers = certifications.covers
    if takeoffs is not None:
        takeoffs.libraries = libraries

    def certificate_context(path):
        query = parse_qs(urlsplit(path).query, keep_blank_values=True)
        if set(query) - {'workspace'} or any(len(values) != 1 for values in query.values()):
            raise ValidationError('Choose exactly one current certificate workspace.')
        token = query.get('workspace', [None])[0]
        # The unscoped legacy store is retained for explicit recovery and old
        # clients. The current Certification page always sends its capability.
        return (certification_projects.service(token), token) if token is not None else (certifications, None)

    def certificate_response(token, value):
        return certification_projects.response(token, value) if token is not None else value

    def documentation_workspace(path):
        query = parse_qs(urlsplit(path).query, keep_blank_values=True)
        if set(query) != {'workspace'} or len(query['workspace']) != 1 or not query['workspace'][0]:
            raise ValidationError('Choose exactly one current project document workspace.')
        return query['workspace'][0]

    class DocumentationReplay(Exception):
        def __init__(self, receipt, destination):
            self.receipt, self.destination = receipt, destination

    def reference_download_body(body, key):
        """Capture legacy Takeoffs links into this download, without saving edits."""
        if not isinstance(body, dict) or 'takeoff_session_id' not in body:
            return body
        from copy import deepcopy
        from .penetration_calculator import normalize_draft
        from .takeoff_model import identity
        session_id = body['takeoff_session_id']
        if takeoffs is None or not isinstance(session_id, str):
            raise ValidationError('Open the current Takeoffs session before downloading its references.')
        identity(session_id, 'Takeoff session ID')
        draft = {'globals': body.get('globals', {}), 'rows': [body.get('item')]} if key == 'item' else body.get(key)
        result = deepcopy(body)
        result.pop('takeoff_session_id')
        if draft is None:
            return result
        draft = normalize_draft(draft)
        references = takeoffs.firestopping_references(session_id, draft)['row_references']
        for row in draft['rows']:
            if row.get('takeoff_source') and not any(field in row for field in ('technical_reference_ids', 'takeoff_reference_ids')):
                row['takeoff_reference_ids'] = [item['id'] for item in references[row['id']]['systems']]
        result[key] = draft['rows'][0] if key == 'item' else draft
        return result

    class Handler(BaseHTTPRequestHandler):
        server_version = "CeasefireEstimator"

        def company_details(self):
            # A long-running export must use the same company and cover even
            # when Settings is saved concurrently in a second window.
            from copy import deepcopy
            if self._company_settings_snapshot is None:
                self._company_settings_snapshot = store.company_settings()
            return deepcopy(self._company_settings_snapshot)

        def pdf_company_details(self, kind):
            # Freeze just this export's cover before a long renderer starts.
            # The Settings table is metadata-only; bulk blobs are never loaded.
            company = self.company_details()
            if kind not in self._pdf_cover_settings_snapshot:
                self._pdf_cover_settings_snapshot[kind] = pdf_covers.get(kind)
            return company

        def send_payload(self, status, payload, content_type="application/json; charset=utf-8", headers=None, *, content_security_policy_override=None):
            if status >= 400:
                download_progress.update(getattr(self, '_download_progress_token', None), 0, 'failed')
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8") if content_type.startswith("application/json") else payload
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", content_security_policy_override or content_security_policy)
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def send_download(self, payload, content_type, filename, destination=None, *, frozen_pdf=False, pdf_kind=None):
            if content_type.split(';', 1)[0].strip() == 'application/pdf' and not frozen_pdf:
                from .pdf_cover import prepend_cover_pdf
                company = self.pdf_company_details(pdf_kind)
                payload = prepend_cover_pdf(payload, company, self._pdf_cover_settings_snapshot[pdf_kind])
            retained = self._documentation_receipt
            if self._documentation_context is not None and retained is None:
                workspace, request_id = self._documentation_context
                kind, logical_key = self._documentation_identity
                if content_type not in {PDF, XLSX}:
                    raise ValidationError('Only authored PDF and XLSX files belong in Documentation.')
                retained = documentation.record(workspace, kind, logical_key, filename, content_type,
                                                payload, request_id, self._documentation_fingerprint)
                self._documentation_receipt = retained
                if retained['replayed']:
                    existing = documentation.read(workspace, retained['item']['id'])
                    payload, content_type, filename = existing['payload'], existing['item']['media_type'], existing['item']['filename']
            token = getattr(self, '_download_progress_token', None)
            download_progress.update(token, 90, 'saving')
            if destination is not None:
                receipt = projects.write_download(destination, filename, payload)
                if retained is not None:
                    receipt['documentation'] = retained
                download_progress.update(token, 100, 'saved')
                self.send_payload(200, receipt)
            else:
                self.send_payload(200, payload, content_type, {'Content-Disposition': f'attachment; filename="{filename}"'})
                download_progress.update(token, 100, 'saved')

        def capture_download(self, request):
            return projects.capture_download(request)

        def download_progress(self, completed, total):
            download_progress.pages(getattr(self, '_download_progress_token', None), completed, total)

        def send_reference_asset(self, asset_id, pdf=True):
            payload, content_type, filename = libraries.asset(asset_id, pdf)
            size = len(payload)
            headers = {'Content-Disposition': f'inline; filename="{filename}"', 'Accept-Ranges': 'bytes'}
            requested = self.headers.get('Range')
            status = 200
            if requested:
                match = re.fullmatch(r'bytes=(\d{0,18})-(\d{0,18})', requested)
                if not match or not any(match.groups()):
                    self.send_payload(416, b'', content_type, {'Content-Range': f'bytes */{size}'})
                    return
                left, right = match.groups()
                start = int(left) if left else max(0, size - int(right))
                end = min(size - 1, int(right)) if left and right else size - 1
                if start > end or start >= size:
                    self.send_payload(416, b'', content_type, {'Content-Range': f'bytes */{size}'})
                    return
                headers['Content-Range'] = f'bytes {start}-{end}/{size}'
                status, payload = 206, payload[start:end + 1]
            self.send_payload(status, payload, content_type, headers)

        def send_report(self, quote, report_kind, destination=None):
            from .report import render_quote_pdf
            report = render_quote_pdf({**quote, "report_kind": report_kind}, company=self.pdf_company_details('estimate'))
            self.send_download(report, "application/pdf", "CEASEFIRE-Estimate.pdf", destination, pdf_kind='estimate')

        def send_quote(self, status, quote):
            # Dropdown metadata belongs to the quote's own pricing snapshot.
            result = quote["result"]
            if "labour" not in result:
                result = {**result, "labour": labour_breakdown(result)}
            self.send_payload(status, {**quote,
                                       "result": result,
                                       "work_summary": quote.get("work_summary", compile_work_summary(quote.get("workflow", WORKFLOWS[0]), quote["result"])),
                                       "fields": fields(effective_catalog(quote["configuration"]))})

        def read_json(self):
            if self.headers.get_content_type() != "application/json":
                raise ValidationError("Use Content-Type: application/json.")
            if self.headers.get("Transfer-Encoding"):
                raise ValidationError("Transfer-Encoding is not supported.")
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError as exc:
                raise ValidationError("Invalid request size.") from exc
            if not 0 < size <= MAX_BODY:
                raise ValidationError("Request must contain JSON of at most 24 MB.")
            def reject_constant(value):
                raise ValidationError(f"Invalid JSON number: {value}.")
            try:
                value = json.loads(self.rfile.read(size), parse_constant=reject_constant)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValidationError("Request body must contain valid JSON.") from exc
            if not isinstance(value, dict):
                raise ValidationError("Request body must be a JSON object.")
            if self._documentation_context is not None:
                route = urlsplit(self.path).path
                identity = export_identity(route, value)
                if identity is None or identity[0] not in {row['id'] for row in document_types}:
                    raise ValidationError('This action does not generate a supported project document.')
                self._documentation_identity = identity
                semantic_body = {key:item for key,item in value.items() if key != 'download'}
                self._documentation_fingerprint = sha256(json.dumps({'route':route,'body':semantic_body}, ensure_ascii=True,
                    sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()
                workspace, request_id = self._documentation_context
                retained = documentation.replay(workspace, request_id, self._documentation_fingerprint)
                if retained is not None:
                    destination = self.capture_download(value['download']) if 'download' in value else None
                    raise DocumentationReplay(retained, destination)
            return value

        def dispatch(self):
            actual_port = self.server.server_port
            hosts = {f"127.0.0.1:{actual_port}", f"localhost:{actual_port}"}
            if self.headers.get("Host") not in hosts:
                self.send_payload(403, {"error": "Only the local application host is allowed."})
                return
            origin = self.headers.get("Origin")
            if origin and origin not in {f"http://{h}" for h in hosts}:
                self.send_payload(403, {"error": "Cross-origin requests are not allowed."})
                return
            progress_token = self.headers.get('X-Estimator-Download-Progress')
            if progress_token is not None:
                if self.command != 'POST':
                    raise ValidationError('Document progress requires one download request.')
                download_progress.claim(progress_token)
                self._download_progress_token = progress_token
            route = urlsplit(self.path).path
            workspace = self.headers.get('X-Estimator-Documentation-Workspace')
            request_id = self.headers.get('X-Estimator-Documentation-Request')
            if workspace is not None or request_id is not None:
                import uuid
                if self.command != 'POST' or not workspace or not request_id:
                    raise ValidationError('Document history requires its current workspace and generation request.')
                try:
                    if str(uuid.UUID(request_id)) != request_id:
                        raise ValueError()
                except (ValueError, AttributeError):
                    raise ValidationError('The document generation request identity is invalid.')
                certification_projects.project_id(workspace)
                self._documentation_context = workspace, request_id
            if excluded_route(route, edition):
                self.send_payload(404, {'error': 'Not found.'})
                return
            if takeoff_http is not None and takeoff_http.dispatch(self, route):
                return
            if self.command == "GET":
                if re.fullmatch(r'/api/download-progress/[A-Za-z0-9_-]{32}', route):
                    self.send_payload(200, download_progress.read(route.rsplit('/', 1)[1]))
                elif route == '/api/travel/status':
                    self.send_payload(200, travel.status())
                elif route == '/api/company-settings':
                    self.send_payload(200, self.company_details())
                elif route == '/api/pdf-covers':
                    self.send_payload(200, pdf_covers.list())
                elif route == '/api/documentation/catalog':
                    self.send_payload(200, {'documents':document_types})
                elif route == '/api/documentation':
                    self.send_payload(200, documentation.view(documentation_workspace(self.path)))
                elif re.fullmatch(r'/api/documentation/[a-z0-9-]{36}', route):
                    result = documentation.read(documentation_workspace(self.path), route.rsplit('/',1)[1])
                    from .project_file import project_download_header
                    disposition = project_download_header(result['item']['filename'])
                    if result['item']['media_type'] == PDF:
                        disposition = disposition.replace('attachment;', 'inline;', 1)
                    self.send_payload(200, result['payload'], result['item']['media_type'], {'Content-Disposition':disposition})
                elif route == '/api/certifications':
                    service, token = certificate_context(self.path)
                    self.send_payload(200, certificate_response(token, service.list_documents()))
                elif route == '/api/certifications/defaults':
                    self.send_payload(200, certifications.get_defaults())
                elif route == '/api/certifications/legacy':
                    self.send_payload(200, certifications.list_documents())
                elif re.fullmatch(r'/api/certifications/workspaces/[a-z0-9-]{1,64}', route):
                    self.send_payload(200, certification_projects.view(route.rsplit('/', 1)[1]))
                elif re.fullmatch(r'/api/certifications/[a-z0-9-]{1,64}/revisions/[1-9][0-9]{0,9}\.pdf', route):
                    certificate_id, revision = route.split('/')[3], int(route.rsplit('/', 1)[1][:-4])
                    service, _ = certificate_context(self.path)
                    payload = service.revision_pdf(certificate_id, revision)
                    # Immutable revisions already contain their original cover.
                    self.send_payload(200, payload, 'application/pdf',
                                      {'Content-Disposition': f'inline; filename="Installation-Certificate-Revision-{revision}.pdf"'})
                elif re.fullmatch(r'/api/certifications/[a-z0-9-]{1,64}', route):
                    service, token = certificate_context(self.path)
                    self.send_payload(200, certificate_response(token, service.get(route.rsplit('/', 1)[1])))
                elif route == '/api/libraries':
                    self.send_payload(200, libraries.overview())
                elif route == '/api/libraries/technical/new':
                    self.send_payload(200, libraries.technical_edit())
                elif re.fullmatch(r'/api/libraries/technical/[a-z0-9][a-z0-9_-]{0,119}/edit', route):
                    self.send_payload(200, libraries.technical_edit(route.split('/')[-2]))
                elif route in {'/api/libraries/penetration', '/api/libraries/technical'}:
                    query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                    if any(len(values) != 1 for values in query.values()):
                        raise ValidationError('Use one value per library search option.')
                    self.send_payload(200, libraries.listing(route.rsplit('/', 1)[1], **{key: values[0] for key, values in query.items()}))
                elif re.fullmatch(r'/api/libraries/penetration/[a-z0-9][a-z0-9_-]{0,119}/(image|thumbnail)', route):
                    key, variant = route.split('/')[-2:]
                    payload, content_type, filename = libraries.diagram_asset(key, variant == 'thumbnail')
                    self.send_payload(200, payload, content_type,
                                      {'Content-Disposition': f'inline; filename="{filename}"'})
                elif re.fullmatch(r'/api/libraries/penetration/[a-z0-9][a-z0-9_-]{0,119}/edit', route):
                    self.send_payload(200, libraries.edit(route.split('/')[-2]))
                elif re.fullmatch(r'/api/libraries/penetration/[a-z0-9][a-z0-9_-]{0,119}/takeoff', route):
                    self.send_payload(200, libraries.takeoff_record(route.split('/')[-2]))
                elif re.fullmatch(r'/api/libraries/(penetration|technical)/[a-z0-9][a-z0-9_-]{0,119}', route):
                    _, _, _, kind, key = route.split('/')
                    detail = libraries.detail(kind, key)
                    # Presentation only: never included in technical identities,
                    # calculator inputs, saved records or source evidence hashes.
                    replicas = libraries.image_replicas()
                    if replicas:
                        images = [*detail.get('images', []), *(image for field in detail.get('fields', []) for image in field.get('images', []))]
                        detail['image_replicas'] = {image['id']: f"/api/libraries/replicas/{image['id']}" for image in images if image['id'] in replicas}
                    self.send_payload(200, detail)
                elif re.fullmatch(r'/api/libraries/documents/[a-z0-9][a-z0-9_-]{0,119}\.pdf', route):
                    self.send_reference_asset(route.rsplit('/', 1)[1][:-4])
                elif re.fullmatch(r'/api/libraries/images/[a-z0-9][a-z0-9_-]{0,119}', route):
                    self.send_reference_asset(route.rsplit('/', 1)[1], False)
                elif re.fullmatch(r'/api/libraries/replicas/[a-z0-9][a-z0-9_-]{0,119}', route):
                    payload, content_type, filename = libraries.replica_asset(route.rsplit('/', 1)[1])
                    self.send_payload(200, payload, content_type,
                                      {'Content-Disposition': f'inline; filename="{filename}"'})
                elif route == '/api/penetration':
                    from .penetration_calculator import definition
                    self.send_payload(200, definition(store.configuration(), service_types=libraries.service_types()))
                elif route == '/api/calculators':
                    from .workbook_calculators import calculator_list
                    self.send_payload(200, calculator_list())
                elif re.fullmatch(r'/api/calculators/[a-z_]+', route):
                    from .workbook_calculators import calculator_definition
                    calculator_id = route.rsplit('/', 1)[1]
                    state = store.calculator_state(calculator_id)
                    self.send_payload(200, calculator_definition(calculator_id, state['inputs'], state['schedule_rows']))
                elif route == "/api/bootstrap":
                    from .penetration_calculator import pricing_usage_metadata
                    config = store.shared_configuration()
                    catalog = effective_catalog(config)
                    self.send_payload(200, {"fields": fields(catalog), "baseline": baseline(), "configuration": config,
                                            "catalog": configuration_catalog(config), "workflows": WORKFLOWS,
                                            "pricing_usage": pricing_usage_metadata(),
                                            "edition": edition, "features": capabilities})
                elif route == "/api/configuration":
                    self.send_payload(200, store.shared_configuration())
                elif route == "/api/projects":
                    query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                    if set(query) - {'search', 'sort', 'offset', 'limit', 'refresh'} or any(len(values) != 1 for values in query.values()):
                        raise ValidationError('Use one supported value per project search or page option.')
                    self.send_payload(200, projects.listing(**{key: values[0] for key, values in query.items()}))
                elif route == "/api/quotes":
                    self.send_payload(200, {"quotes": store.list_quotes()})
                elif route.startswith("/api/quotes/") and route.endswith("/report.pdf"):
                    self.send_report(store.quote(route[len("/api/quotes/"):-len("/report.pdf")]), "Saved quote")
                elif route.startswith("/api/quotes/"):
                    self.send_quote(200, store.quote(route.removeprefix("/api/quotes/")))
                elif route in {'/certification.js', '/certification.css', '/cover-sheets.js', '/documentation.js', '/documentation.css'}:
                    kind = 'text/javascript; charset=utf-8' if route.endswith('.js') else 'text/css; charset=utf-8'
                    self.send_payload(200, (ROOT / 'static' / route[1:]).read_bytes(), kind)
                elif route in {'/games/play.js', '/games/play.css', '/games/fireline-art.js', '/games/fireline.js', '/penetration-references.js', '/sounds/type.mp3', '/sounds/gameover.mp3', '/sounds/flame-whoosh.wav', '/takeoff-visual-search-icon.png', '/takeoff-ocr-icon.png', '/header-steel-intumescent.png', '/sounds/checkpoint.ogg', '/sounds/loading.mp3', '/sounds/new-explosion.mp3', '/sounds/hover.mp3', '/sounds/select.mp3', '/sounds/select-2.mp3', '/sounds/mixkit-vintage-dot-printing-1371.wav', '/takeoff-visual-search.js', '/takeoff-visual-search.css', '/takeoff-ocr-layer.js', '/takeoff-ocr-layer.css', '/header-menu-sounds.js', '/sounds/mgs1-menu-move.mp3', '/sounds/mgs-confirm2.mp3', '/brand-boot.js', '/brand-boot.css', '/classifire-app.ico', '/register-references.js', '/travel.js', '/travel.css', '/maps-setup.html', '/pdf-cursors.css', '/cursors/pointer.png', '/cursors/precision.png', '/cursors/move.png', '/cursors/text.png', '/cursors/handwriting.png', '/cursors/link.png', '/cursors/resize-nwse.png', '/cursors/resize-nesw.png', '/cursors/resize-horizontal.png', '/cursors/resize-vertical.png', '/cursors/unavailable.png', '/cursors/busy.png', "/", "/index.html", "/company-settings.js", "/classifire-logo.png", "/main-layout.js", "/downloads.css", "/activity.js", "/calculation-queue.js", "/searchable-choice.js", "/penetration-presentation.js", "/icons/navigation-takeoffs.svg", "/icons/navigation-takeoffs.jpg", "/icons/navigation-help.jpg", "/theme.js", "/language.js", "/language-catalog.js", "/language.css", "/theme.css", "/laser.css", "/laser-steel.svg", "/home-steel-frame.png", "/header-layout.css", "/workspace-art.css", "/pointer-effects.css", "/pointer-effects.js", "/laser-reticle.svg", "/takeoff-header-steel.png", "/takeoff-header-ductwork.png", "/takeoff-header-physical.png", "/takeoff-header-service-plans.png", "/header-steel-spray.png", "/header-steel-board.png", "/header-ductwork.png", "/header-firestopping.png", "/header-estimate.png", "/header-projects.png", "/projects-evidence-banner.png", "/header-firestopping-library.png", "/header-technical-library.png", "/app.js", "/downloads.js", "/styles.css", "/calculators.js", "/calculators.css", "/penetration-breakdown.js", "/penetration.js", "/penetration.css", "/libraries.js", "/library-detail-text.js", "/libraries.css", "/library-editor.js", "/library-editor.css", "/icons/navigation-home.png", "/icons/document.png", "/icons/schedule-add.png", "/icons/navigation-help.png", "/icons/navigation-takeoffs.png", "/icons/takeoff-visibility.jpg", "/icons/takeoff-colour-wheel.png", "/icons/takeoff-legend.png", "/ceasefire-logo.png", "/ceasefire-app.ico", "/fonts/Montserrat-Variable.ttf", "/fonts/Vera.ttf", "/fonts/VeraBd.ttf", "/fonts/Montserrat-Italic-Variable.ttf", "/takeoffs.js", "/takeoffs.css", "/takeoff-geometry.js", "/takeoff-physical.js", "/takeoff-annotations.js", "/takeoff-signatures.js", "/takeoff-graphics.js", "/takeoff-graphics-ui.js", "/takeoff-pane-resize.js", "/takeoff-initial-pages.js", "/takeoff-pdf-tools.js", "/takeoff-pdf-tools.css", "/icons/default-memory.svg", "/icons/takeoff-set-default.png", "/icons/signature.svg", "/help-glossary.js", "/help-glossary.css", "/takeoff-search.js", "/takeoff-shortcuts.js", "/icons/takeoff-callout.png", "/takeoff-pdf-worker.mjs", "/takeoff-library-links.js", "/icons/takeoff-visibility.png", "/icons/takeoff-bullet-list.png", "/icons/takeoff-numbered-list.png", "/icons/takeoff-add-service.png", "/icons/takeoff-add-barrier.png", "/icons/takeoff-transfer.png", "/icons/takeoff-measure.png", "/header-tagline-media.js", "/header-tagline-character.gif", "/header-tagline-character-still.png"}:
                    name = "index.html" if route == "/" else route[1:]
                    path = ROOT / "static" / name
                    kind = {".ogg": "audio/ogg", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".gif": "image/gif", ".avif": "image/avif", ".ico": "image/x-icon", ".ttf": "font/ttf"}[path.suffix]
                    payload = path.read_bytes()
                    if name == 'index.html':
                        payload = render_index(payload, edition)
                    self.send_payload(200, payload, kind)
                else:
                    self.send_payload(404, {"error": "Not found."})
            elif self.command in {"POST", "PUT"}:
                body = self.read_json()
                calculator_route = re.fullmatch(r'/api/calculators/([a-z_]+)/(calculate|worksheet|report\.pdf|summary\.pdf|register\.xlsx|state|template|import)', route)
                if route == '/api/download-progress' and self.command == 'POST':
                    if body:
                        raise ValidationError('Document progress does not accept extra options.')
                    self.send_payload(200, download_progress.begin())
                elif route in {'/api/project/full-schedule.pdf', '/api/project/full-product-summary.pdf'} and self.command == 'POST':
                    from .project_file import CALCULATOR_IDS, project_details
                    from .project_reports import build_project_report
                    body = reference_download_body(body, 'penetration')
                    if set(body) - {'calculators', 'penetration', 'configuration', 'project_details', 'download'}:
                        raise ValidationError('Include the project schedule snapshots only.')
                    destination = self.capture_download(body['download']) if 'download' in body else None
                    materials = route.endswith('full-product-summary.pdf')
                    report = build_project_report(body.get('calculators', {}), body.get('penetration'),
                        validate_configuration(body.get('configuration', store.configuration())), project_details(body.get('project_details')),
                        materials=materials, library=libraries, company=self.pdf_company_details('full_product_summary' if materials else 'full_schedule'),
                        saved_calculators={key: store.calculator_state(key)['inputs'] for key in CALCULATOR_IDS})
                    self.send_download(report, 'application/pdf', 'CEASEFIRE-Full-Product-Summary.pdf' if materials else 'CEASEFIRE-Full-Schedule.pdf', destination,
                                       pdf_kind='full_product_summary' if materials else 'full_schedule')
                elif route == '/api/travel/route':
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    try:
                        self.send_payload(200, travel.route(body))
                    except TravelError as error:
                        self.send_payload(error.status, {'error': str(error)})
                elif route == '/api/company-settings':
                    self.send_payload(200, store.save_company_settings(body))
                elif re.fullmatch(r'/api/pdf-covers/[a-z_]+', route):
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    if set(body) != {'cover_pdf', 'cover_pdf_name', 'expected_version'}:
                        raise ValidationError('Include the PDF cover, filename and current version only.')
                    self.send_payload(200, pdf_covers.metadata(pdf_covers.save(route.rsplit('/', 1)[1], body['cover_pdf'], body['cover_pdf_name'], body['expected_version'])))
                elif route == '/api/certifications':
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    if set(body) - {'fields', 'request_id', 'options'}:
                        raise ValidationError('Unknown certification fields.')
                    options = {'options': body['options']} if 'options' in body else {}
                    service, token = certificate_context(self.path)
                    self.send_payload(201, certificate_response(token, service.create(body.get('fields', {}), body.get('request_id'), **options)))
                elif route == '/api/certifications/workspaces':
                    if self.command != 'POST' or body:
                        raise ValidationError('Create a fresh certificate workspace without other fields.')
                    self.send_payload(201, certification_projects.new())
                elif re.fullmatch(r'/api/certifications/workspaces/[a-z0-9-]{1,64}/discard', route):
                    if self.command != 'POST' or body:
                        raise ValidationError('Discard the prepared certificate workspace without other fields.')
                    self.send_payload(200, certification_projects.discard(route.split('/')[-2]))
                elif re.fullmatch(r'/api/certifications/workspaces/[a-z0-9-]{1,64}/import', route):
                    if self.command != 'POST' or set(body) != {'document_id'}:
                        raise ValidationError('Choose one older certificate explicitly to add to this project.')
                    self.send_payload(200, certification_projects.import_legacy(route.split('/')[-2], body['document_id']))
                elif route == '/api/certifications/defaults':
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    if set(body) not in ({'fields', 'expected_version'}, {'fields', 'expected_version', 'signature_image', 'signature_name'}):
                        raise ValidationError('Include the signer details and current defaults version.')
                    signature = {key: body[key] for key in ('signature_image', 'signature_name') if key in body}
                    self.send_payload(200, certifications.save_defaults(body['fields'], body['expected_version'], **signature))
                elif re.fullmatch(r'/api/certifications/[a-z0-9-]{1,64}/revisions', route):
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    if not {'fields', 'expected_version', 'request_id'} <= set(body) <= {'fields', 'expected_version', 'request_id', 'options'}:
                        raise ValidationError('Include the certificate details, current version and generation request.')
                    options = {'options': body['options']} if 'options' in body else {}
                    service, token = certificate_context(self.path)
                    result = service.generate(route.split('/')[3], body['fields'], body['expected_version'],
                                                     body['request_id'], self.company_details(), **options)
                    self.send_payload(201, certificate_response(token, result))
                elif re.fullmatch(r'/api/certifications/[a-z0-9-]{1,64}', route):
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    if not {'fields', 'expected_version'} <= set(body) <= {'fields', 'expected_version', 'options'}:
                        raise ValidationError('Include the certificate details and current version.')
                    options = {'options': body['options']} if 'options' in body else {}
                    service, token = certificate_context(self.path)
                    self.send_payload(200, certificate_response(token, service.save(route.rsplit('/', 1)[1], body['fields'], body['expected_version'], **options)))
                elif route == '/api/libraries/penetration':
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    self.send_payload(200, libraries.create(body))
                elif route == '/api/libraries/technical':
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    self.send_payload(200, libraries.technical_save(None, body))
                elif re.fullmatch(r'/api/libraries/technical/[a-z0-9][a-z0-9_-]{0,119}/(save|delete|links)', route):
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    key, action = route.split('/')[-2:]
                    method = {'save': libraries.technical_save, 'delete': libraries.technical_delete, 'links': libraries.technical_link}[action]
                    self.send_payload(200, method(key, body))
                elif re.fullmatch(r'/api/libraries/penetration/[a-z0-9][a-z0-9_-]{0,119}/links/remove', route):
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    self.send_payload(200, libraries.remove_link(route.split('/')[-3], body))
                elif re.fullmatch(r'/api/libraries/penetration/[a-z0-9][a-z0-9_-]{0,119}/links', route):
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    self.send_payload(200, libraries.add_link(route.split('/')[-2], body))
                elif re.fullmatch(r'/api/libraries/penetration/[a-z0-9][a-z0-9_-]{0,119}/project-draft', route):
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    self.send_payload(200, libraries.project_draft(route.split('/')[-2], body))
                elif route == '/api/project/library-drafts/prepare':
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    if not isinstance(body, dict) or set(body) != {'library_drafts'}:
                        raise ValidationError('Include only the project library drafts to prepare.')
                    from .project_library_drafts import prepare_library_drafts
                    self.send_payload(200, prepare_library_drafts(body['library_drafts'], service_types=libraries.service_types()))
                elif re.fullmatch(r'/api/libraries/penetration/[a-z0-9][a-z0-9_-]{0,119}/(calculate|refresh-pricing|save|delete)', route):
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    self.send_payload(200, libraries.action(route.split('/')[-2], route.split('/')[-1], body))
                elif route in {'/api/technical/item.pdf', '/api/technical/item.xlsx'}:
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    if urlsplit(self.path).query:
                        raise ValidationError('Technical item downloads do not accept query parameters.')
                    from .technical_item_exports import prepare_technical_item, render_technical_item_pdf, build_technical_item_xlsx
                    snapshot = prepare_technical_item(body, library=libraries)
                    destination = self.capture_download(body['download']) if 'download' in body else None
                    if route.endswith('.pdf'):
                        self.send_download(render_technical_item_pdf(snapshot, company=self.pdf_company_details('technical_library_item')), 'application/pdf', 'CEASEFIRE-Technical-Item.pdf', destination, pdf_kind='technical_library_item')
                    else:
                        self.send_download(build_technical_item_xlsx(snapshot), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'CEASEFIRE-Technical-Item.xlsx', destination)
                elif route in {'/api/penetration/item.pdf', '/api/penetration/item.xlsx'}:
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    from .penetration_item_exports import prepare_item_snapshot, render_item_pdf, build_item_xlsx
                    body = reference_download_body(body, 'item')
                    snapshot = prepare_item_snapshot(body, library=libraries, default_configuration=store.configuration(), require_diagram=route.endswith('.pdf'))
                    destination = self.capture_download(body['download']) if 'download' in body else None
                    if route.endswith('.pdf'):
                        self.send_download(render_item_pdf(snapshot, company=self.pdf_company_details('firestopping_library_item')), 'application/pdf', 'CEASEFIRE-Firestopping-Item.pdf', destination, pdf_kind='firestopping_library_item')
                    else:
                        self.send_download(build_item_xlsx(snapshot), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'CEASEFIRE-Firestopping-Item.xlsx', destination)
                elif route == '/api/penetration/references' and self.command == 'POST':
                    from .penetration_references import resolve_schedule_references
                    if not isinstance(body, dict) or set(body) - {'draft', 'takeoff_session_id'} or 'draft' not in body:
                        raise ValidationError('Include the Firestopping draft and optional Takeoffs session only.')
                    session_id = body.get('takeoff_session_id')
                    if session_id is not None:
                        if takeoffs is None or not isinstance(session_id, str):
                            raise ValidationError('Open the current Takeoffs session before reading its references.')
                        result = takeoffs.firestopping_references(session_id, body['draft'])
                    else:
                        result = resolve_schedule_references(body['draft'], libraries)
                    self.send_payload(200, result)
                elif route in {'/api/penetration/definition', '/api/penetration/validate-item', '/api/penetration/calculate', '/api/penetration/report.pdf', '/api/penetration/register.xlsx'}:
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    from .penetration_calculator import calculate as calculate_penetration, definition
                    action = route.rsplit('/', 1)[1]
                    if action in {'report.pdf', 'register.xlsx'}:
                        body = reference_download_body(body, 'draft')
                    allowed = {'configuration'} if action == 'definition' else {'draft', 'configuration'}
                    if action in {'report.pdf', 'register.xlsx'}:
                        allowed |= {'project_details', 'download'}
                    if set(body) - allowed or (action != 'definition' and 'draft' not in body):
                        raise ValidationError('Include the Firestopping Estimator draft and pricing configuration only.')
                    config = validate_configuration(body.get('configuration', store.configuration()))
                    if action == 'definition':
                        self.send_payload(200, definition(config, service_types=libraries.service_types()))
                    elif action == 'validate-item':
                        from .penetration_entry import validate_item_for_add
                        validate_item_for_add(body['draft'])
                        self.send_payload(200, {'valid': True})
                    elif action == 'calculate':
                        result = calculate_penetration(body['draft'], config, service_types=libraries.service_types())
                        self.send_payload(200, result)
                    else:
                        from .penetration_report import render_penetration_pdf, build_penetration_register
                        from .project_file import project_details
                        destination = self.capture_download(body['download']) if 'download' in body else None
                        details = project_details(body.get('project_details'))
                        result = calculate_penetration(body['draft'], config)
                        if action == 'report.pdf':
                            report = render_penetration_pdf(result, result['definition'], details, library=libraries, company=self.pdf_company_details('firestopping_schedule'))
                            self.send_download(report, 'application/pdf', 'CEASEFIRE-Firestopping-Estimate.pdf', destination, pdf_kind='firestopping_schedule')
                        else:
                            report = build_penetration_register(result, result['definition'], details, library=libraries)
                            self.send_download(report, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'CEASEFIRE-Firestopping-Schedule.xlsx', destination)
                elif route == '/api/project/export' and self.command == 'POST':
                    from .project_file import export_project, project_filename, project_download_header
                    require_project_edition(body, edition)
                    if 'takeoffs' in body or 'certifications' in body or 'documentation' in body:
                        raise ValidationError('Use Save As to save the project together with its evidence and certificate companion folders.')
                    project = export_project(store, body, edition=edition)
                    filename = project_filename(json.loads(project)['estimate']['title'])
                    self.send_payload(200, project, 'application/octet-stream',
                                      {'Content-Disposition': project_download_header(filename)})
                elif route == '/api/project/save-as' and self.command == 'POST':
                    self.send_payload(200, projects.save_as(body))
                elif route == '/api/project/save' and self.command == 'POST':
                    self.send_payload(200, projects.save(body))
                elif route == '/api/project/attachment' and self.command == 'POST':
                    self.send_payload(200, projects.save_attachment(body))
                elif route == '/api/project/open' and self.command == 'POST':
                    if body:
                        raise ValidationError('Load Project does not accept a file path or other fields.')
                    self.send_payload(200, projects.open_file())
                elif route == '/api/projects/link-folder' and self.command == 'POST':
                    if body:
                        raise ValidationError('Link folder does not accept a folder path or other fields.')
                    self.send_payload(200, projects.link_folder())
                elif route == '/api/projects/load' and self.command == 'POST':
                    if set(body) != {'id'}:
                        raise ValidationError('Choose a project file from the linked folder.')
                    self.send_payload(200, projects.load(body['id']))
                elif route == '/api/projects/files' and self.command == 'POST':
                    self.send_payload(200, projects.browse_files(body))
                elif route == '/api/projects/open-file' and self.command == 'POST':
                    self.send_payload(200, projects.open_project_file(body))
                elif route == '/api/configuration/preview' and self.command == 'POST':
                    if set(body) != {'configuration'}:
                        raise ValidationError('Include the draft pricing configuration only.')
                    config = validate_configuration(body['configuration'])
                    self.send_payload(200, {'configuration': config, 'fields': fields(effective_catalog(config))})
                elif route == '/api/project/import' and self.command == 'POST':
                    from .project_file import import_project
                    if set(body) != {'filename', 'content_base64'}:
                        raise ValidationError('Include the project filename and file content only.')
                    project = import_project(store, body['filename'], body['content_base64'], edition=edition)
                    workspace = certification_projects.restore(project.get('certifications'))
                    project['certification_workspace_id'] = workspace['workspace_id']
                    try:
                        documentation.restore(project.get('documentation'), workspace['workspace_id'])
                        if 'takeoffs' in project:
                            session = takeoffs.open(project['takeoffs'])
                            project.update(takeoffs=session['snapshot'], takeoffs_session_id=session['session_id'], takeoffs_issues=session.get('issues', []))
                    except Exception:
                        certification_projects.discard(workspace['workspace_id'])
                        raise
                    self.send_payload(200, project)
                elif route.startswith('/api/quotes/') and route.endswith('/report.pdf') and self.command == 'POST':
                    if set(body) - {'download'}:
                        raise ValidationError('Saved quote report requests accept download options only.')
                    destination = self.capture_download(body['download']) if 'download' in body else None
                    self.send_report(store.quote(route[len('/api/quotes/'):-len('/report.pdf')]), 'Saved quote', destination)
                elif calculator_route:
                    from .schedule_rows import blank_schedule_defaults
                    from .workbook_calculators import calculate_page, calculate_worksheet, normalize_calculator_inputs, validate_calculator_edits
                    calculator_id, action = calculator_route.groups()
                    expected_method = 'PUT' if action == 'state' else 'POST'
                    if self.command != expected_method:
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    allowed = {'calculate': {'inputs', 'sheet', 'start_row', 'row_count'}, 'state': {'inputs', 'schedule_rows'},
                               'worksheet': {'inputs', 'sheet', 'include_advanced', 'schedule_view'}, 'report.pdf': {'inputs', 'project_details', 'download'}, 'summary.pdf': {'inputs', 'project_details', 'download'}, 'register.xlsx': {'inputs', 'download'},
                               'template': {'download'}, 'import': {'filename', 'content_base64', 'inputs'}}[action]
                    if set(body) - allowed:
                        raise ValidationError('Unknown calculator request fields.')
                    destination = self.capture_download(body['download']) if 'download' in body else None
                    if action in {'calculate', 'worksheet', 'report.pdf', 'summary.pdf', 'register.xlsx', 'import'}:
                        saved_inputs = store.calculator_state(calculator_id)['inputs']
                        inputs = validate_calculator_edits(calculator_id, blank_schedule_defaults(
                            calculator_id, body.get('inputs', saved_inputs)), saved_inputs)
                    if action == 'calculate':
                        self.send_payload(200, calculate_page(calculator_id, inputs, body.get('sheet'), body.get('start_row', 1), body.get('row_count', 25)))
                    elif action == 'worksheet':
                        self.send_payload(200, calculate_worksheet(calculator_id, inputs, body.get('sheet'), body.get('include_advanced', False), body.get('schedule_view')))
                    elif action in {'report.pdf', 'summary.pdf'}:
                        from .calculator_report import build_calculator_report, build_calculator_summary_report
                        from .project_file import project_details
                        builder = build_calculator_report if action == 'report.pdf' else build_calculator_summary_report
                        report = builder(calculator_id, inputs, project_details=project_details(body.get('project_details')),
                                         company=self.pdf_company_details(calculator_id + ('_schedule' if action == 'report.pdf' else '_product_summary')))
                        filename = 'APPENDIX A.pdf' if action == 'report.pdf' else f'ceasefire-{calculator_id}-materials-summary.pdf'
                        self.send_download(report, 'application/pdf', filename, destination,
                                           pdf_kind=calculator_id + ('_schedule' if action == 'report.pdf' else '_product_summary'))
                    elif action == 'register.xlsx':
                        from .calculator_register import build_calculator_register
                        workbook = build_calculator_register(calculator_id, inputs)
                        self.send_download(workbook, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'APPENDIX A.xlsx', destination)
                    elif action == 'state':
                        if 'inputs' not in body:
                            raise ValidationError('Include the calculator inputs to save.')
                        self.send_payload(200, store.save_calculator_state(calculator_id, body['inputs'], body.get('schedule_rows')))
                    elif action == 'template':
                        from .schedule_workbook import export_schedule_template
                        workbook = export_schedule_template(calculator_id)
                        self.send_download(workbook, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', f'ceasefire-{calculator_id}-schedule.xlsx', destination)
                    elif action == 'import':
                        from .schedule_workbook import import_schedule_workbook
                        filename, content = body.get('filename'), body.get('content_base64')
                        if not isinstance(filename, str) or not filename.lower().endswith('.xlsx') or len(filename) > 255:
                            raise ValidationError('Choose an Excel .xlsx schedule using the exported template.')
                        if not isinstance(content, str) or len(content) > ((MAX_PRICING_FILE + 2) // 3) * 4:
                            raise ValidationError('The schedule file must be at most 5 MB.')
                        try:
                            payload = base64.b64decode(content, validate=True)
                        except (ValueError, binascii.Error) as error:
                            raise ValidationError('The Excel schedule upload is invalid.') from error
                        if not payload or len(payload) > MAX_PRICING_FILE:
                            raise ValidationError('Choose a nonempty schedule file of at most 5 MB.')
                        proposed = import_schedule_workbook(calculator_id, payload, filename, inputs)
                        proposed['inputs'] = normalize_calculator_inputs(calculator_id, proposed['inputs'])
                        self.send_payload(200, proposed)
                elif route == "/api/pricing/export" and self.command == "POST":
                    from .pricing_workbook import export_pricing_workbook
                    if set(body) - {"configuration", "download"}:
                        raise ValidationError("Unknown pricing export fields.")
                    destination = self.capture_download(body['download']) if 'download' in body else None
                    workbook = export_pricing_workbook(body['configuration'] if 'configuration' in body else store.shared_configuration())
                    self.send_download(workbook, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 'ceasefire-pricing.xlsx', destination)
                elif route == "/api/pricing/import" and self.command == "POST":
                    from .pricing_workbook import import_pricing_workbook
                    if set(body) - {"filename", "content_base64", "configuration"}:
                        raise ValidationError("Unknown pricing import fields.")
                    filename, content = body.get("filename"), body.get("content_base64")
                    if not isinstance(filename, str) or not filename.lower().endswith(".xlsx") or len(filename) > 255:
                        raise ValidationError("Choose an Excel .xlsx pricing workbook.")
                    if not isinstance(content, str) or len(content) > ((MAX_PRICING_FILE + 2) // 3) * 4:
                        raise ValidationError("The Excel file must be at most 5 MB.")
                    try:
                        payload = base64.b64decode(content, validate=True)
                    except (ValueError, binascii.Error) as exc:
                        raise ValidationError("The Excel file upload is invalid.") from exc
                    if not payload or len(payload) > MAX_PRICING_FILE:
                        raise ValidationError("Choose a nonempty Excel file of at most 5 MB.")
                    proposed = import_pricing_workbook(payload, filename, body['configuration'] if 'configuration' in body else store.shared_configuration())
                    config = proposed["configuration"]
                    self.send_payload(200, {**proposed, "catalog": configuration_catalog(config),
                                            "fields": fields(effective_catalog(config))})
                elif route == "/api/quote-report" and self.command == "POST":
                    destination = self.capture_download(body.pop('download')) if 'download' in body else None
                    source_quote_id = body.pop("source_quote_id", None)
                    if source_quote_id is not None and (not isinstance(source_quote_id, str) or not 0 < len(source_quote_id) <= 200):
                        raise ValidationError("Source quote reference must contain 1 to 200 characters.")
                    quote = store.prepare_quote(body, source_quote_id)
                    quote["id"] = None
                    self.send_report(quote, "Current estimate", destination)
                elif route == "/api/calculate" and self.command == "POST":
                    if set(body) - {"inputs", "configuration", "workflow", "penetration", "work_items"}:
                        raise ValidationError("Unknown calculation request fields.")
                    workflow = body.get("workflow", WORKFLOWS[0])
                    if not isinstance(workflow, str) or len(workflow) > 200:
                        raise ValidationError("Workflow must be text of at most 200 characters.")
                    if 'penetration' in body and body['penetration'] is None:
                        raise ValidationError('Include the Firestopping schedule draft only in the estimate.')
                    result = calculate(body.get("inputs", {}), body.get("configuration", store.configuration()), body.get('penetration'), body.get('work_items'))
                    self.send_payload(200, {**result, "error_details": calculation_error_details(result),
                                            "work_summary": compile_work_summary(workflow, result)})
                elif route == "/api/configuration" and self.command == "PUT":
                    self.send_payload(200, store.save_configuration(body))
                elif route == "/api/quotes" and self.command == "POST":
                    self.send_quote(201, store.save_quote(body))
                elif route.startswith("/api/quotes/") and self.command == "PUT":
                    self.send_quote(200, store.save_quote(body, route.removeprefix("/api/quotes/")))
                else:
                    self.send_payload(404, {"error": "Not found."})
            else:
                self.send_payload(405, {"error": "Method not allowed."})

        def handle_request(self):
            self._download_progress_token = None
            self._company_settings_snapshot = None
            self._pdf_cover_settings_snapshot = {}
            self._documentation_context = None
            self._documentation_identity = None
            self._documentation_fingerprint = None
            self._documentation_receipt = None
            self.connection.settimeout(15)
            try:
                self.dispatch()
            except DocumentationReplay as replay:
                try:
                    self._documentation_receipt = replay.receipt
                    workspace, _ = self._documentation_context
                    existing = documentation.read(workspace, replay.receipt['item']['id'])
                    self.send_download(existing['payload'], existing['item']['media_type'], existing['item']['filename'], replay.destination, frozen_pdf=True)
                except (DocumentationNotFound, CertificationNotFound) as exc:
                    self.send_payload(404, {'error':str(exc)})
                except ValidationError as exc:
                    self.send_payload(400, {'error':str(exc)})
            except DocumentationConflict as exc:
                self.send_payload(409, {'error':str(exc)})
            except DocumentationNotFound as exc:
                self.send_payload(404, {'error':str(exc)})
            except LibraryConflict as exc:
                self.send_payload(409, {"error": str(exc)})
            except CertificationConflict as exc:
                self.send_payload(409, {"error": str(exc)})
            except PdfCoverConflict as exc:
                self.send_payload(409, {"error": str(exc)})
            except CertificationNotFound as exc:
                self.send_payload(404, {"error": str(exc)})
            except CalculationBusy as exc:
                self.send_payload(503, {"error": str(exc)}, headers={"Retry-After": "2"})
            except ValidationError as exc:
                self.send_payload(400, {"error": str(exc)})
            except ReferenceNotFound:
                self.send_payload(404, {"error": "Library reference not found."})
            except KeyError:
                self.send_payload(404, {"error": "Quote not found."})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
                pass
            except Exception:
                LOGGER.exception("Request failed")
                self.send_payload(500, {"error": "The request failed. Check the application terminal."})

        do_GET = handle_request
        do_POST = handle_request
        do_PUT = handle_request
        do_OPTIONS = handle_request
        if edition == 'standard':
            # Disabled assets remain absent for metadata probes as well.
            do_HEAD = handle_request

        def log_message(self, format_string, *args):
            LOGGER.info("%s", format_string % args)

    class Server(ThreadingHTTPServer):
        # ThreadingHTTPServer enables SO_REUSEADDR by default. On Windows that
        # permits two Estimator processes to bind the same port, after which
        # requests can be split between different code and in-memory state.
        # A local desktop application must have one authoritative process.
        allow_reuse_address = False

        def server_close(self):
            try:
                super().server_close()
            finally:
                projects.close()
                if takeoffs is not None:
                    takeoffs.documents.close()

    return Server(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--library-directory", type=Path, help="Local reference library folder (defaults to .runtime/reference-library).")
    parser.add_argument("--allow-annotation-styles", action="store_true", help="Opt in to local browser annotation compatibility by allowing inline stylesheet elements; scripts and style attributes keep the normal policy.")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    server = create_server(args.port, args.database, library_directory=args.library_directory, allow_annotation_styles=args.allow_annotation_styles)
    if args.allow_annotation_styles:
        LOGGER.warning("Local browser annotation compatibility enabled: inline stylesheet elements are allowed. Inline scripts and style attributes remain blocked.")
    print(f"Ceasefire ESTIMATOR: http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
