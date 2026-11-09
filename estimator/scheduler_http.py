"""Same-origin HTTP boundary for the local Scheduler workspace."""

from http.cookies import CookieError, SimpleCookie
from urllib.parse import parse_qs, urlsplit

from .scheduler import SchedulerError, SchedulerStore
from .scheduler_map import SchedulerMapTiles


class SchedulerHTTP:
    def __init__(self, path, projects=None):
        self.store = SchedulerStore(path, work_orders=projects.scheduler_work_orders if projects else None,
                                    work_order_lookup=projects.scheduler_work_order if projects else None)
        self.map_tiles = SchedulerMapTiles(self.store.path.parent / 'scheduler-map-tiles.sqlite3')

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
            global_cookie, scheduler_cookie = cookie.get('classifire_access'), cookie.get('classifire_scheduler')
            credential = global_cookie or scheduler_cookie
            if global_cookie and scheduler_cookie and not self.store.read('bootstrap', {}, global_cookie.value)['user']:
                credential = scheduler_cookie
            token = credential.value if credential else None
            query = parse_qs(urlsplit(handler.path).query, keep_blank_values=True)
            if any(len(values) != 1 for values in query.values()):
                handler.send_payload(400, {'error': 'Use one value per Scheduler filter.'})
                return True
            headers = {}
            expected_member = handler.headers.get('X-Scheduler-Member')
            if expected_member:
                current = self.store.read('bootstrap', {}, token)['user']
                if current is None or current['id'] != expected_member:
                    handler.send_payload(409, {'error': 'The signed-in account changed. Reload Scheduler before continuing.'})
                    return True
            if handler.command == 'GET' and action == 'map-tile':
                user = self.store.read('bootstrap', {}, token)['user']
                if user is None:
                    raise SchedulerError('Sign in to view Scheduler maps.', 401)
                referer = handler.headers.get('Referer', '')
                source = urlsplit(referer)
                if source.scheme != 'http' or source.netloc != handler.headers.get('Host') or source.path != '/' or source.query or source.fragment:
                    raise SchedulerError('Open the map from the CLASSIFIRE application.', 403)
                tile = self.map_tiles.get({key: values[0] for key, values in query.items()}, member_id=user['id'], referer=referer)
                handler.send_payload(200, tile, 'image/png')
                return True
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
                    # Server sessions still expire after twelve hours without an
                    # active-shift heartbeat. Heartbeats must never rewrite this
                    # cookie: a delayed response could overwrite a newer login.
                    headers['Set-Cookie'] = f'classifire_scheduler={session}; HttpOnly; SameSite=Strict; Path=/api/scheduler; Max-Age=2592000'
                elif action == 'logout':
                    native_expiry = 'classifire_scheduler=; HttpOnly; SameSite=Strict; Path=/api/scheduler; Max-Age=0'
                    global_expiry = 'classifire_access=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
                    if global_cookie and credential is global_cookie:
                        headers['Set-Cookie'] = [global_expiry,native_expiry] if scheduler_cookie else global_expiry
                        result = {**result, 'global_session':True}
                    else:
                        headers['Set-Cookie'] = native_expiry
            else:
                handler.send_payload(405, {'error': 'Use GET or POST for Scheduler.'})
                return True
            handler.send_payload(200, result, headers=headers)
        except SchedulerError as error:
            handler.send_payload(error.status_code, {'error': str(error)})
        return True
