"""HTTP client for feature tests that run with signed-in staff access."""

from http.client import HTTPConnection
from threading import Lock
import json

_setup_lock = Lock()


def _staff_headers(server):
    with _setup_lock:
        if hasattr(server, 'fixture_staff_headers'):
            return server.fixture_staff_headers
        account = {'email': 'http-fixture@example.test', 'password': 'Disposable-http-fixture-password'}
        connection = HTTPConnection(*server.server_address, timeout=30)
        try:
            connection.request('POST', '/api/access/setup', json.dumps({**account, 'name': 'HTTP fixture'}),
                               {'Content-Type': 'application/json'})
            response = connection.getresponse()
            data = json.loads(response.read())
            if response.status == 409:
                connection.request('POST', '/api/access/login', json.dumps(account), {'Content-Type': 'application/json'})
                response = connection.getresponse()
                data = json.loads(response.read())
            if response.status != 200:
                raise AssertionError(f'Could not sign in to the disposable fixture: {response.status}')
            server.fixture_staff_headers = {'Cookie': response.getheader('Set-Cookie').split(';', 1)[0],
                                            'X-CRM-Member': data['user']['id']}
            return server.fixture_staff_headers
        finally:
            connection.close()


class StaffConnection(HTTPConnection):
    def __init__(self, server, **kwargs):
        super().__init__(*server.server_address, **kwargs)
        self.staff_headers = _staff_headers(server)

    def request(self, method, url, body=None, headers=None, **kwargs):
        super().request(method, url, body, {**self.staff_headers, **(headers or {})}, **kwargs)
