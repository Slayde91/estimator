"""Exercise the PowerShell launcher probe against real loopback HTTP endpoints."""
import json
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest

from estimator.crm_access import CRMAccess
from estimator.scheduler import SchedulerStore
from estimator.server import create_server, DEFAULT_CONTENT_SECURITY_POLICY


HELPER = Path(__file__).resolve().parents[1] / 'scripts' / 'local_estimator_health.ps1'
POLICY = DEFAULT_CONTENT_SECURITY_POLICY
SESSION = {'enabled': False, 'version': 1, 'user': None}
BOOTSTRAP = {'fields': [], 'catalog': {}, 'configuration': {}, 'workflows': []}


@unittest.skipUnless(shutil.which('pwsh'), 'The launcher readiness tests require PowerShell.')
class LocalEstimatorHealthTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        self.runner = self.folder / 'probe.ps1'
        self.runner.write_text(
            "param([string]$Helper, [int]$Port, [string]$Policy)\n"
            "$ErrorActionPreference = 'Stop'\n. $Helper\nGet-LocalEstimatorEndpoint $Port $Policy\n",
            encoding='utf-8')

    def serve(self, service):
        thread = threading.Thread(target=service.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(service.server_close)
        self.addCleanup(service.shutdown)
        return service.server_port

    def probe(self, port, policy=POLICY):
        result = subprocess.run(
            ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(self.runner),
             str(HELPER), str(port), policy], cwd=self.folder, capture_output=True,
            text=True, encoding='utf-8', timeout=20, check=True)
        self.assertEqual(result.stderr, '')
        return result.stdout.strip()

    def mock_service(self, status, session=SESSION, name='CeasefireEstimator', policy=POLICY, bootstrap=BOOTSTRAP):
        requests = []
        supplied_credentials = []
        class Handler(BaseHTTPRequestHandler):
            server_version = name

            def do_GET(self):
                requests.append(self.path)
                supplied_credentials.extend(key for key in ('Cookie', 'Authorization') if key in self.headers)
                is_session = self.path == '/api/access/session'
                self.send_response(status if is_session else 200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Security-Policy', policy)
                if is_session and status == 302:
                    self.send_header('Location', '/api/bootstrap')
                self.end_headers()
                self.wfile.write(json.dumps(session if is_session else bootstrap).encode())

            def log_message(self, *args):
                pass
        service = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.addCleanup(self.assertEqual, supplied_credentials, [])
        return self.serve(service), requests

    def test_real_bootstrap_remains_protected_and_both_modes_are_ready(self):
        port = self.serve(create_server(0, self.folder / 'runtime.sqlite3',
                          library_directory=self.folder / 'libraries', allow_annotation_styles=True))
        policy = POLICY + "; style-src-elem 'self' 'unsafe-inline'"
        self.assertEqual(self.probe(port, policy), 'estimator')
        scheduler = SchedulerStore(self.folder / 'runtime-scheduler.sqlite3')
        scheduler.write('setup', {'name': 'Local test administrator', 'email': 'test@example.test',
                                  'password': 'Temporary-fixture-password'})
        CRMAccess(self.folder / 'runtime-access.sqlite3', scheduler).activate_named_access()
        connection = HTTPConnection('127.0.0.1', port, timeout=5)
        try:
            connection.request('GET', '/api/bootstrap')
            response = connection.getresponse()
            self.assertEqual(response.status, 401)
            response.read()
        finally:
            connection.close()
        self.assertEqual(self.probe(port, policy), 'estimator')
        self.assertEqual(self.probe(port, POLICY), 'policy-mismatch')

    def test_legacy_fallback_checks_identity_policy_and_bootstrap(self):
        for status, name, policy, payload, expected in [
                (404, 'CeasefireEstimator', POLICY, BOOTSTRAP, 'estimator'),
                (405, 'CeasefireEstimator', POLICY, BOOTSTRAP, 'estimator'),
                (404, 'DifferentService', POLICY, BOOTSTRAP, 'other'),
                (404, 'CeasefireEstimator', POLICY + '; something', BOOTSTRAP, 'policy-mismatch'),
                (404, 'CeasefireEstimator', POLICY, {'fields': []}, 'other')]:
            with self.subTest(status=status, name=name, policy=policy, expected=expected):
                port, seen = self.mock_service(status, name=name, policy=policy, bootstrap=payload)
                self.assertEqual(self.probe(port), expected)
                self.assertEqual(seen, ['/api/access/session', '/api/bootstrap'])

    def test_no_private_probe_on_foreign_malformed_or_denied_session_endpoint(self):
        cases = [(200, SESSION, 'DifferentService'), (401, SESSION, 'CeasefireEstimator'),
                 (302, SESSION, 'CeasefireEstimator'), (500, SESSION, 'CeasefireEstimator')]
        cases += [(200, bad, 'CeasefireEstimator') for bad in (
            [SESSION], {'enabled': True, 'version': 1}, {**SESSION, 'secret': 'unexpected'},
            {**SESSION, 'user': {'id': 'already-signed-in'}}, {**SESSION, 'enabled': 'false'},
            {**SESSION, 'version': True}, {**SESSION, 'version': 0}, {**SESSION, 'version': '1'},
            {**SESSION, 'version': 1.5})]
        for status, payload, name in cases:
            with self.subTest(status=status, payload=payload, name=name):
                port, seen = self.mock_service(status, session=payload, name=name)
                self.assertEqual(self.probe(port), 'other')
                self.assertEqual(seen, ['/api/access/session'])

    def test_closed_port(self):
        with socket.socket() as bound:
            bound.bind(('127.0.0.1', 0))
            self.assertEqual(self.probe(bound.getsockname()[1]), 'unavailable')
