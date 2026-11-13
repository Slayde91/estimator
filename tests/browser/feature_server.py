"""Disposable, signed-in HTTP fixtures for feature tests. Identity tests use the stock server."""

from pathlib import Path
import tempfile

from estimator.catalog import ROOT
from estimator.scheduler import SchedulerStore
from estimator.server import create_server as application_server


def create_server(port, database, *args, **kwargs):
    """Run feature requests as one synthetic staff member in an isolated test database."""
    database = Path(database).resolve()
    fixture_roots = (Path(tempfile.gettempdir()).resolve(), (ROOT / '.runtime/browser-qa').resolve())
    if port or not any(database.is_relative_to(root) for root in fixture_roots):
        raise ValueError('Feature fixtures require a disposable database and an ephemeral port.')
    server = application_server(port, database, *args, **kwargs)
    try:
        staff = SchedulerStore(database.with_name(database.stem + '-scheduler.sqlite3'))
        account = {'email': 'feature-fixture@example.test', 'password': 'Disposable-feature-fixture-password'}
        if staff.read('bootstrap')['setup_required']:
            session = staff.write('setup', {**account, 'name': 'Feature fixture'})
        else:
            session = staff.write('login', account)
        cookie = 'classifire_access=' + session['token']
        member_id = session['user']['id']

        class SignedInFixtureRequest(server.RequestHandlerClass):
            def parse_request(self):
                if not super().parse_request():
                    return False
                # Supply the feature client's real disposable identity. Explicit
                # cookies and actor headers still exercise standard authorization.
                if not self.headers.get('Cookie'):
                    self.headers['Cookie'] = cookie
                    if not self.headers.get('X-CRM-Member'):
                        self.headers['X-CRM-Member'] = member_id
                return True

        server.RequestHandlerClass = SignedInFixtureRequest
        return server
    except Exception:
        server.server_close()
        raise
