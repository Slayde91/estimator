"""Bounded, authenticated-adapter map imagery cache for visible Scheduler maps.

Only canonical OSM raster tile addresses are supported. OSM receives viewport
tile coordinates and the application Referer, never worker names, timestamps,
credentials or the recorded location list. The caller authenticates the account.
"""
from contextlib import closing
import re
import sqlite3
import struct
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .scheduler import SchedulerError

MAX_TILE_BYTES = 512 * 1024
CACHE_DAYS = 7
MAX_CACHE_BYTES = 128 * 1024 * 1024
MAX_CACHE_TILES = 8192
USER_AGENT = 'CLASSIFIRE/1.0 (+https://github.com/Slayde91/estimator)'


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class SchedulerMapTiles:
    def __init__(self, path, *, opener=None, now=time.time):
        self.path, self.now = path, now
        self.opener = opener or build_opener(_NoRedirects())
        self.lock = threading.RLock()
        self.slots = threading.BoundedSemaphore(4)
        self.requests = {}
        with closing(sqlite3.connect(path)) as db:
            db.execute('CREATE TABLE IF NOT EXISTS map_tiles (key TEXT PRIMARY KEY, body BLOB NOT NULL, saved REAL NOT NULL)')
            db.commit()

    @staticmethod
    def key(query):
        if set(query) != {'z', 'x', 'y'} or any(not re.fullmatch(r'0|[1-9][0-9]{0,6}', str(query[key])) for key in query):
            raise SchedulerError('Use one valid zoom, tile column and tile row.')
        z, x, y = (int(query[key]) for key in ('z', 'x', 'y'))
        if not 0 <= z <= 19 or not 0 <= x < 2**z or not 0 <= y < 2**z:
            raise SchedulerError('Map tile is outside the supported range.')
        return f'{z}/{x}/{y}'

    def get(self, query, *, member_id, referer):
        key = self.key(query)
        with self.lock, closing(sqlite3.connect(self.path)) as db:
            cached = db.execute('SELECT body,saved FROM map_tiles WHERE key=?', (key,)).fetchone()
            if cached and self.now()-cached[1] < CACHE_DAYS*86400:
                return bytes(cached[0])
            # This endpoint serves an interactive viewport only, not bulk scans.
            recent = [stamp for stamp in self.requests.get(member_id, []) if stamp > self.now()-60]
            if len(recent) >= 60:
                raise SchedulerError('Map requests are temporarily limited. Wait a moment before moving the map again.', 429)
            recent.append(self.now()); self.requests[member_id] = recent
            self.requests = {actor: stamps for actor, stamps in self.requests.items() if stamps and stamps[-1] > self.now()-60}
            db.execute('DELETE FROM map_tiles WHERE saved<=?', (self.now()-CACHE_DAYS*86400,))
            count, size = db.execute('SELECT count(*),coalesce(sum(length(body)),0) FROM map_tiles').fetchone()
            db.commit()
            if count >= MAX_CACHE_TILES or size > MAX_CACHE_BYTES-MAX_TILE_BYTES:
                raise SchedulerError('The map cache is full. Recorded location pins remain available.', 503)
        if not self.slots.acquire(timeout=3):
            raise SchedulerError('Map imagery is busy. Recorded location pins remain available.', 503)
        try:
            request = Request('https://tile.openstreetmap.org/' + key + '.png',
                              headers={'User-Agent': USER_AGENT, 'Referer': referer, 'Accept': 'image/png'})
            with self.opener.open(request, timeout=5) as response:
                if response.status != 200 or response.headers.get_content_type() != 'image/png':
                    raise SchedulerError('Map imagery is unavailable. Recorded location pins remain available.', 502)
                body = response.read(MAX_TILE_BYTES+1)
            if len(body) > MAX_TILE_BYTES or len(body) < 24 or body[:8] != b'\x89PNG\r\n\x1a\n' or struct.unpack('>II', body[16:24]) != (256, 256):
                raise SchedulerError('Map imagery returned an invalid tile.', 502)
            with self.lock, closing(sqlite3.connect(self.path)) as db:
                # Recheck under the write lock because other visible maps can finish concurrently.
                count, size = db.execute('SELECT count(*),coalesce(sum(length(body)),0) FROM map_tiles WHERE key<>?', (key,)).fetchone()
                if count >= MAX_CACHE_TILES or size+len(body) > MAX_CACHE_BYTES:
                    raise SchedulerError('The map cache is full. Recorded location pins remain available.', 503)
                db.execute('INSERT OR REPLACE INTO map_tiles VALUES(?,?,?)', (key, body, self.now()))
                db.commit()
            return body
        except (HTTPError, URLError, OSError, ValueError) as error:
            raise SchedulerError('Map imagery could not be loaded. Recorded location pins remain available.', 502) from error
        finally:
            self.slots.release()
