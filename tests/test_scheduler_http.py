"""Exercise Scheduler authentication and isolation through the application server."""

from http.client import HTTPConnection
import json
from pathlib import Path
import tempfile
import threading
import unittest

from estimator.server import create_server


class SchedulerHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.server = create_server(0, root / 'state.sqlite3', library_directory=root / 'library')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.cookie = ''

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, action, body=None, *, cookie=None, headers=None):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        request_headers = {'Cookie': self.cookie if cookie is None else cookie}
        if body is not None:
            request_headers['Content-Type'] = 'application/json'
        request_headers.update(headers or {})
        connection.request('GET' if body is None else 'POST', '/api/scheduler/' + action,
                           json.dumps(body) if body is not None else None, request_headers)
        response = connection.getresponse()
        status, response_headers = response.status, dict(response.getheaders())
        result = json.loads(response.read())
        connection.close()
        return status, response_headers, result

    def setup_account(self):
        status, headers, result = self.request('setup', {
            'name': 'Test manager', 'email': 'manager@example.test', 'password': 'Example-password-2026'})
        self.assertEqual(status, 200, result)
        self.assertNotIn('token', result)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', headers['Set-Cookie'])
        self.cookie = headers['Set-Cookie'].split(';')[0]
        return result['user']

    def test_cookie_authentication_logout_and_cross_origin_protection(self):
        self.assertTrue(self.request('bootstrap')[2]['setup_required'])
        self.assertEqual(self.request('state')[0], 401)
        self.setup_account()
        self.assertEqual(self.request('state')[0], 200)
        self.assertEqual(self.request('state', cookie='')[0], 401)
        self.assertEqual(self.request('logout', {}, headers={'Origin': 'https://other.example'})[0], 403)
        self.assertEqual(self.request('logout', {}, headers={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.request('state')[0], 200)
        status, headers, result = self.request('logout', {})
        self.assertEqual(status, 200)
        self.assertIn('Max-Age=0', headers['Set-Cookie'])
        self.assertEqual(self.request('state')[0], 401)

    def test_member_permissions_and_stale_updates_are_enforced(self):
        self.setup_account()
        member = {'name': 'Worker', 'email': 'worker@example.test',
                  'password': 'Worker-password-2026', 'role': 'worker', 'active': True, 'base_rate': '40'}
        status, _, worker = self.request('members/save', member)
        self.assertEqual(status, 200, worker)
        shift = {'title': 'Installation', 'start': '2026-11-05T07:00:00+11:00',
                 'end': '2026-11-05T15:30:00+11:00', 'member_ids': [worker['id']],
                 'published': True, 'color': '#2196f3'}
        status, _, saved = self.request('shifts/save', shift)
        self.assertEqual(status, 200, saved)
        update = {**shift, 'id': saved['id'], 'version': saved['version'], 'title': 'Updated job'}
        self.assertEqual(self.request('shifts/save', update)[0], 200)
        self.assertEqual(self.request('shifts/save', update)[0], 409)
        _, login_headers, login = self.request('login', {
            'email': member['email'], 'password': member['password']}, cookie='')
        self.assertNotIn('token', login)
        worker_cookie = login_headers['Set-Cookie'].split(';')[0]
        self.assertEqual(self.request('clock/in', {}, cookie=worker_cookie,
                         headers={'X-Scheduler-Member': 'previous-browser-account'})[0], 409)
        self.assertEqual(self.request('members/save', member, cookie=worker_cookie)[0], 403)
        self.assertEqual(self.request('shifts/save', shift, cookie=worker_cookie)[0], 403)
        status, _, state = self.request('state?start=2026-11-02&end=2026-11-09', cookie=worker_cookie)
        self.assertEqual(status, 200)
        self.assertEqual(state['shifts'][0]['title'], 'Updated job')
        self.assertEqual(self.request('state?start=2026-11-02&start=2026-11-03')[0], 400)


if __name__ == '__main__':
    unittest.main()
