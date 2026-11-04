"""Same-origin HTTP boundary for the local Scheduler workspace."""

from http.cookies import CookieError, SimpleCookie
from urllib.parse import parse_qs, urlsplit

from .scheduler import SchedulerError, SchedulerStore


class SchedulerHTTP:
    def __init__(self, path):
        self.store = SchedulerStore(path)

    def dispatch(self, handler, route):
        prefix = '/api/scheduler/'
        if not route.startswith(prefix):
            return False
        action = route.removeprefix(prefix)
        try:
            cookie = SimpleCookie()
            try:
                cookie.load(handler.headers.get('Cookie', ''))
            except CookieError:
                cookie = SimpleCookie()
            credential = cookie.get('classifire_scheduler')
            token = credential.value if credential else None
            query = parse_qs(urlsplit(handler.path).query, keep_blank_values=True)
            if any(len(values) != 1 for values in query.values()):
                handler.send_payload(400, {'error': 'Use one value per Scheduler filter.'})
                return True
            headers = {}
            if handler.command == 'GET':
                result = self.store.read(action, {key: values[0] for key, values in query.items()}, token)
            elif handler.command == 'POST':
                if query:
                    handler.send_payload(400, {'error': 'Scheduler updates do not accept query parameters.'})
                    return True
                if handler.headers.get('Sec-Fetch-Site') == 'cross-site':
                    handler.send_payload(403, {'error': 'Open Scheduler in the CLASSIFIRE web app.'})
                    return True
                result = self.store.write(action, handler.read_json(), token)
                if action in {'setup', 'login'}:
                    result = dict(result)
                    session = result.pop('token')
                    headers['Set-Cookie'] = f'classifire_scheduler={session}; HttpOnly; SameSite=Strict; Path=/api/scheduler; Max-Age=43200'
                elif action == 'logout':
                    headers['Set-Cookie'] = 'classifire_scheduler=; HttpOnly; SameSite=Strict; Path=/api/scheduler; Max-Age=0'
            else:
                handler.send_payload(405, {'error': 'Use GET or POST for Scheduler.'})
                return True
            handler.send_payload(200, result, headers=headers)
        except SchedulerError as error:
            handler.send_payload(error.status_code, {'error': str(error)})
        return True
