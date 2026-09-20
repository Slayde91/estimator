"""Loopback-only HTTP application. No hosted accounts or Excel runtime required."""

import argparse
import base64
import binascii
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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

MAX_BODY = 24 * 1_048_576
MAX_PRICING_FILE = 5 * 1_048_576
LOGGER = logging.getLogger(__name__)


def create_server(port=8765, database=None, project_dialogs=None, library_directory=None):
    store = Store(database or ROOT / ".runtime" / "estimator.sqlite3")
    from .project_library import ProjectLibrary
    projects = ProjectLibrary(store, project_dialogs)
    from .reference_library import ReferenceNotFound
    from .firestopping_library import FirestoppingLibrary, LibraryConflict
    libraries = FirestoppingLibrary(library_directory, store)

    class Handler(BaseHTTPRequestHandler):
        server_version = "CeasefireEstimator"

        def send_payload(self, status, payload, content_type="application/json; charset=utf-8", headers=None):
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8") if content_type.startswith("application/json") else payload
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def send_download(self, payload, content_type, filename, destination=None):
            if destination is not None:
                self.send_payload(200, projects.write_download(destination, filename, payload))
            else:
                self.send_payload(200, payload, content_type, {'Content-Disposition': f'attachment; filename="{filename}"'})

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
            report = render_quote_pdf({**quote, "report_kind": report_kind})
            self.send_download(report, "application/pdf", "CEASEFIRE-Estimate.pdf", destination)

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
            route = urlsplit(self.path).path
            if self.command == "GET":
                if route == '/api/libraries':
                    self.send_payload(200, libraries.overview())
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
                elif re.fullmatch(r'/api/libraries/(penetration|technical)/[a-z0-9][a-z0-9_-]{0,119}', route):
                    _, _, _, kind, key = route.split('/')
                    self.send_payload(200, libraries.detail(kind, key))
                elif re.fullmatch(r'/api/libraries/documents/[a-z0-9][a-z0-9_-]{0,119}\.pdf', route):
                    self.send_reference_asset(route.rsplit('/', 1)[1][:-4])
                elif re.fullmatch(r'/api/libraries/images/[a-z0-9][a-z0-9_-]{0,119}', route):
                    self.send_reference_asset(route.rsplit('/', 1)[1], False)
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
                    config = store.configuration()
                    catalog = effective_catalog(config)
                    self.send_payload(200, {"fields": fields(catalog), "baseline": baseline(), "configuration": config,
                                            "catalog": configuration_catalog(config), "workflows": WORKFLOWS})
                elif route == "/api/configuration":
                    self.send_payload(200, store.configuration())
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
                elif route in {"/", "/index.html", "/app.js", "/downloads.js", "/styles.css", "/calculators.js", "/calculators.css", "/penetration-breakdown.js", "/penetration.js", "/penetration.css", "/libraries.js", "/libraries.css", "/library-editor.js", "/library-editor.css", "/ceasefire-logo.png"}:
                    name = "index.html" if route == "/" else route[1:]
                    path = ROOT / "static" / name
                    kind = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".png": "image/png"}[path.suffix]
                    self.send_payload(200, path.read_bytes(), kind)
                else:
                    self.send_payload(404, {"error": "Not found."})
            elif self.command in {"POST", "PUT"}:
                body = self.read_json()
                calculator_route = re.fullmatch(r'/api/calculators/([a-z_]+)/(calculate|worksheet|report\.pdf|summary\.pdf|register\.xlsx|state|template|import)', route)
                if route == '/api/libraries/penetration':
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    self.send_payload(200, libraries.create(body))
                elif re.fullmatch(r'/api/libraries/penetration/[a-z0-9][a-z0-9_-]{0,119}/links', route):
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    self.send_payload(200, libraries.add_link(route.split('/')[-2], body))
                elif re.fullmatch(r'/api/libraries/penetration/[a-z0-9][a-z0-9_-]{0,119}/(calculate|refresh-pricing|save|delete)', route):
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    self.send_payload(200, libraries.action(route.split('/')[-2], route.split('/')[-1], body))
                elif route in {'/api/penetration/definition', '/api/penetration/calculate', '/api/penetration/report.pdf', '/api/penetration/register.xlsx'}:
                    if self.command != 'POST':
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    from .penetration_calculator import calculate as calculate_penetration, definition
                    action = route.rsplit('/', 1)[1]
                    allowed = {'configuration'} if action == 'definition' else {'draft', 'configuration'}
                    if action in {'report.pdf', 'register.xlsx'}:
                        allowed |= {'project_details', 'download'}
                    if set(body) - allowed or (action != 'definition' and 'draft' not in body):
                        raise ValidationError('Include the Firestopping Estimator draft and pricing configuration only.')
                    config = validate_configuration(body.get('configuration', store.configuration()))
                    if action == 'definition':
                        self.send_payload(200, definition(config, service_types=libraries.service_types()))
                    elif action == 'calculate':
                        result = calculate_penetration(body['draft'], config)
                        result['definition'] = definition(config, service_types=libraries.service_types())
                        self.send_payload(200, result)
                    else:
                        from .penetration_report import render_penetration_pdf, build_penetration_register
                        from .project_file import project_details
                        destination = projects.capture_download(body['download']) if 'download' in body else None
                        details = project_details(body.get('project_details'))
                        result = calculate_penetration(body['draft'], config)
                        if action == 'report.pdf':
                            report = render_penetration_pdf(result, definition(config), details)
                            self.send_download(report, 'application/pdf', 'CEASEFIRE-Firestopping-Estimate.pdf', destination)
                        else:
                            report = build_penetration_register(result, definition(config), details)
                            self.send_download(report, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'CEASEFIRE-Firestopping-Schedule.xlsx', destination)
                elif route == '/api/project/export' and self.command == 'POST':
                    from .project_file import export_project, project_filename, project_download_header
                    project = export_project(store, body)
                    filename = project_filename(json.loads(project)['estimate']['title'])
                    self.send_payload(200, project, 'application/octet-stream',
                                      {'Content-Disposition': project_download_header(filename)})
                elif route == '/api/project/save-as' and self.command == 'POST':
                    self.send_payload(200, projects.save_as(body))
                elif route == '/api/project/save' and self.command == 'POST':
                    self.send_payload(200, projects.save(body))
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
                elif route == '/api/configuration/preview' and self.command == 'POST':
                    if set(body) != {'configuration'}:
                        raise ValidationError('Include the draft pricing configuration only.')
                    config = validate_configuration(body['configuration'])
                    self.send_payload(200, {'configuration': config, 'fields': fields(effective_catalog(config))})
                elif route == '/api/project/import' and self.command == 'POST':
                    from .project_file import import_project
                    if set(body) != {'filename', 'content_base64'}:
                        raise ValidationError('Include the project filename and file content only.')
                    self.send_payload(200, import_project(store, body['filename'], body['content_base64']))
                elif route.startswith('/api/quotes/') and route.endswith('/report.pdf') and self.command == 'POST':
                    if set(body) - {'download'}:
                        raise ValidationError('Saved quote report requests accept download options only.')
                    destination = projects.capture_download(body['download']) if 'download' in body else None
                    self.send_report(store.quote(route[len('/api/quotes/'):-len('/report.pdf')]), 'Saved quote', destination)
                elif calculator_route:
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
                    destination = projects.capture_download(body['download']) if 'download' in body else None
                    if action in {'calculate', 'worksheet', 'report.pdf', 'summary.pdf', 'register.xlsx', 'import'}:
                        saved_inputs = store.calculator_state(calculator_id)['inputs']
                        inputs = validate_calculator_edits(calculator_id, body.get('inputs', saved_inputs), saved_inputs)
                    if action == 'calculate':
                        self.send_payload(200, calculate_page(calculator_id, inputs, body.get('sheet'), body.get('start_row', 1), body.get('row_count', 25)))
                    elif action == 'worksheet':
                        self.send_payload(200, calculate_worksheet(calculator_id, inputs, body.get('sheet'), body.get('include_advanced', False), body.get('schedule_view')))
                    elif action in {'report.pdf', 'summary.pdf'}:
                        from .calculator_report import build_calculator_report, build_calculator_summary_report
                        from .project_file import project_details
                        builder = build_calculator_report if action == 'report.pdf' else build_calculator_summary_report
                        report = builder(calculator_id, inputs, project_details=project_details(body.get('project_details')))
                        filename = 'APPENDIX A.pdf' if action == 'report.pdf' else f'ceasefire-{calculator_id}-materials-summary.pdf'
                        self.send_download(report, 'application/pdf', filename, destination)
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
                    destination = projects.capture_download(body['download']) if 'download' in body else None
                    workbook = export_pricing_workbook(body.get("configuration", store.configuration()))
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
                    proposed = import_pricing_workbook(payload, filename, body.get("configuration", store.configuration()))
                    config = proposed["configuration"]
                    self.send_payload(200, {**proposed, "catalog": configuration_catalog(config),
                                            "fields": fields(effective_catalog(config))})
                elif route == "/api/quote-report" and self.command == "POST":
                    destination = projects.capture_download(body.pop('download')) if 'download' in body else None
                    source_quote_id = body.pop("source_quote_id", None)
                    if source_quote_id is not None and (not isinstance(source_quote_id, str) or not 0 < len(source_quote_id) <= 200):
                        raise ValidationError("Source quote reference must contain 1 to 200 characters.")
                    quote = store.prepare_quote(body, source_quote_id)
                    quote["id"] = None
                    self.send_report(quote, "Current estimate", destination)
                elif route == "/api/calculate" and self.command == "POST":
                    if set(body) - {"inputs", "configuration", "workflow", "penetration"}:
                        raise ValidationError("Unknown calculation request fields.")
                    workflow = body.get("workflow", WORKFLOWS[0])
                    if not isinstance(workflow, str) or len(workflow) > 200:
                        raise ValidationError("Workflow must be text of at most 200 characters.")
                    if 'penetration' in body and body['penetration'] is None:
                        raise ValidationError('Include the Firestopping schedule draft only in the estimate.')
                    result = calculate(body.get("inputs", {}), body.get("configuration", store.configuration()), body.get('penetration'))
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
            self.connection.settimeout(15)
            try:
                self.dispatch()
            except LibraryConflict as exc:
                self.send_payload(409, {"error": str(exc)})
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

        def log_message(self, format_string, *args):
            LOGGER.info("%s", format_string % args)

    class Server(ThreadingHTTPServer):
        def server_close(self):
            try:
                super().server_close()
            finally:
                projects.close()

    return Server(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--library-directory", type=Path, help="Local reference library folder (defaults to .runtime/reference-library).")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    server = create_server(args.port, args.database, library_directory=args.library_directory)
    print(f"Ceasefire ESTIMATOR: http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
