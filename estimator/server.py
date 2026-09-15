"""Loopback-only HTTP application. No hosted accounts or Excel runtime required."""

import argparse
import base64
import binascii
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import re
from pathlib import Path
from urllib.parse import urlsplit

from .calculator import calculate, fields, labour_breakdown
from .catalog import ROOT, baseline, configuration_catalog, effective_catalog, ValidationError
from .presentation import calculation_error_details
from .quote_details import compile_work_summary
from .storage import Store, WORKFLOWS

MAX_BODY = 24 * 1_048_576
MAX_PRICING_FILE = 5 * 1_048_576
LOGGER = logging.getLogger(__name__)


def create_server(port=8765, database=None):
    store = Store(database or ROOT / ".runtime" / "estimator.sqlite3")

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

        def send_report(self, quote, report_kind):
            from .report import render_quote_pdf
            # Restrict the filename to safe ASCII; the full title is inside the PDF.
            name = re.sub(r"[^a-zA-Z0-9]+", "-", quote["title"]).strip("-")[:80] or "ceasefire-quote"
            report = render_quote_pdf({**quote, "report_kind": report_kind})
            self.send_payload(200, report, "application/pdf", {"Content-Disposition": f'attachment; filename="{name}.pdf"'})

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
                if route == '/api/calculators':
                    from .workbook_calculators import calculator_list
                    self.send_payload(200, calculator_list())
                elif re.fullmatch(r'/api/calculators/[a-z_]+', route):
                    from .workbook_calculators import calculator_definition
                    calculator_id = route.rsplit('/', 1)[1]
                    self.send_payload(200, calculator_definition(calculator_id, store.calculator_state(calculator_id)['inputs']))
                elif route == "/api/bootstrap":
                    config = store.configuration()
                    catalog = effective_catalog(config)
                    self.send_payload(200, {"fields": fields(catalog), "baseline": baseline(), "configuration": config,
                                            "catalog": configuration_catalog(config), "workflows": WORKFLOWS})
                elif route == "/api/configuration":
                    self.send_payload(200, store.configuration())
                elif route == "/api/quotes":
                    self.send_payload(200, {"quotes": store.list_quotes()})
                elif route.startswith("/api/quotes/") and route.endswith("/report.pdf"):
                    self.send_report(store.quote(route[len("/api/quotes/"):-len("/report.pdf")]), "Saved quote")
                elif route.startswith("/api/quotes/"):
                    self.send_quote(200, store.quote(route.removeprefix("/api/quotes/")))
                elif route in {"/", "/index.html", "/app.js", "/styles.css", "/calculators.js", "/calculators.css", "/ceasefire-logo.png"}:
                    name = "index.html" if route == "/" else route[1:]
                    path = ROOT / "static" / name
                    kind = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".png": "image/png"}[path.suffix]
                    self.send_payload(200, path.read_bytes(), kind)
                else:
                    self.send_payload(404, {"error": "Not found."})
            elif self.command in {"POST", "PUT"}:
                body = self.read_json()
                calculator_route = re.fullmatch(r'/api/calculators/([a-z_]+)/(calculate|worksheet|report\.pdf|register\.xlsx|state|template|import)', route)
                if calculator_route:
                    from .workbook_calculators import calculate_page, calculate_worksheet, normalize_calculator_inputs, validate_calculator_edits
                    calculator_id, action = calculator_route.groups()
                    expected_method = 'PUT' if action == 'state' else 'POST'
                    if self.command != expected_method:
                        self.send_payload(405, {'error': 'Method not allowed.'})
                        return
                    allowed = {'calculate': {'inputs', 'sheet', 'start_row', 'row_count'}, 'state': {'inputs'},
                               'worksheet': {'inputs', 'sheet', 'include_advanced'}, 'report.pdf': {'inputs'}, 'register.xlsx': {'inputs'},
                               'template': set(), 'import': {'filename', 'content_base64', 'inputs'}}[action]
                    if set(body) - allowed:
                        raise ValidationError('Unknown calculator request fields.')
                    if action in {'calculate', 'worksheet', 'report.pdf', 'register.xlsx', 'import'}:
                        saved_inputs = store.calculator_state(calculator_id)['inputs']
                        inputs = validate_calculator_edits(calculator_id, body.get('inputs', saved_inputs), saved_inputs)
                    if action == 'calculate':
                        self.send_payload(200, calculate_page(calculator_id, inputs, body.get('sheet'), body.get('start_row', 1), body.get('row_count', 25)))
                    elif action == 'worksheet':
                        self.send_payload(200, calculate_worksheet(calculator_id, inputs, body.get('sheet'), body.get('include_advanced', False)))
                    elif action == 'report.pdf':
                        from .calculator_report import build_calculator_report
                        report = build_calculator_report(calculator_id, inputs)
                        self.send_payload(200, report, 'application/pdf',
                                          {'Content-Disposition': f'attachment; filename="ceasefire-{calculator_id}-schedule.pdf"'})
                    elif action == 'register.xlsx':
                        from .calculator_register import build_calculator_register
                        workbook = build_calculator_register(calculator_id, inputs)
                        self.send_payload(200, workbook, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                          {'Content-Disposition': f'attachment; filename="ceasefire-{calculator_id}-register.xlsx"'})
                    elif action == 'state':
                        if 'inputs' not in body:
                            raise ValidationError('Include the calculator inputs to save.')
                        self.send_payload(200, store.save_calculator_state(calculator_id, body['inputs']))
                    elif action == 'template':
                        from .schedule_workbook import export_schedule_template
                        workbook = export_schedule_template(calculator_id)
                        self.send_payload(200, workbook, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                          {'Content-Disposition': f'attachment; filename="ceasefire-{calculator_id}-schedule.xlsx"'})
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
                    if set(body) - {"configuration"}:
                        raise ValidationError("Unknown pricing export fields.")
                    workbook = export_pricing_workbook(body.get("configuration", store.configuration()))
                    self.send_payload(200, workbook, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                      {"Content-Disposition": 'attachment; filename="ceasefire-pricing.xlsx"'})
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
                    source_quote_id = body.pop("source_quote_id", None)
                    if source_quote_id is not None and (not isinstance(source_quote_id, str) or not 0 < len(source_quote_id) <= 200):
                        raise ValidationError("Source quote reference must contain 1 to 200 characters.")
                    quote = store.prepare_quote(body, source_quote_id)
                    quote["id"] = None
                    self.send_report(quote, "Current estimate")
                elif route == "/api/calculate" and self.command == "POST":
                    if set(body) - {"inputs", "configuration", "workflow"}:
                        raise ValidationError("Unknown calculation request fields.")
                    workflow = body.get("workflow", WORKFLOWS[0])
                    if not isinstance(workflow, str) or len(workflow) > 200:
                        raise ValidationError("Workflow must be text of at most 200 characters.")
                    result = calculate(body.get("inputs", {}), body.get("configuration", store.configuration()))
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
            except ValidationError as exc:
                self.send_payload(400, {"error": str(exc)})
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

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--database", type=Path)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    server = create_server(args.port, args.database)
    print(f"Ceasefire ESTIMATOR: http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
