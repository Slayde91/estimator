"""Loopback-only HTTP application. No hosted accounts or Excel runtime required."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
from pathlib import Path
from urllib.parse import urlsplit

from .calculator import calculate, fields, specification
from .catalog import ROOT, baseline, effective_catalog, ValidationError
from .storage import Store, WORKFLOWS

MAX_BODY = 1_048_576
LOGGER = logging.getLogger(__name__)


def create_server(port=8765, database=None):
    store = Store(database or ROOT / ".runtime" / "estimator.sqlite3")

    class Handler(BaseHTTPRequestHandler):
        server_version = "CeasefireEstimator"

        def send_payload(self, status, payload, content_type="application/json; charset=utf-8"):
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8") if content_type.startswith("application/json") else payload
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

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
                raise ValidationError("Request must contain JSON of at most 1 MB.")
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
                if route == "/api/bootstrap":
                    config = store.configuration()
                    catalog = effective_catalog(config)
                    self.send_payload(200, {"fields": fields(catalog), "baseline": baseline(), "configuration": config,
                                            "catalog": catalog, "workflows": WORKFLOWS, "formulas": specification()["formulas"]})
                elif route == "/api/configuration":
                    self.send_payload(200, store.configuration())
                elif route == "/api/quotes":
                    self.send_payload(200, {"quotes": store.list_quotes()})
                elif route.startswith("/api/quotes/"):
                    self.send_payload(200, store.quote(route.removeprefix("/api/quotes/")))
                elif route in {"/", "/index.html", "/app.js", "/styles.css"}:
                    name = "index.html" if route == "/" else route[1:]
                    path = ROOT / "static" / name
                    kind = {".js": "text/javascript", ".css": "text/css", ".html": "text/html"}[path.suffix]
                    self.send_payload(200, path.read_bytes(), kind + "; charset=utf-8")
                else:
                    self.send_payload(404, {"error": "Not found."})
            elif self.command in {"POST", "PUT"}:
                body = self.read_json()
                if route == "/api/calculate" and self.command == "POST":
                    if set(body) - {"inputs", "configuration"}:
                        raise ValidationError("Unknown calculation request fields.")
                    self.send_payload(200, calculate(body.get("inputs", {}), body.get("configuration", store.configuration())))
                elif route == "/api/configuration" and self.command == "PUT":
                    self.send_payload(200, store.save_configuration(body))
                elif route == "/api/quotes" and self.command == "POST":
                    self.send_payload(201, store.save_quote(body))
                elif route.startswith("/api/quotes/") and self.command == "PUT":
                    self.send_payload(200, store.save_quote(body, route.removeprefix("/api/quotes/")))
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
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
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
