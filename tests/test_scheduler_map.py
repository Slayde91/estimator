"""Map imagery policy, bounded cache and fixed-host requests, without external traffic."""
from email.message import Message
from io import BytesIO
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

from estimator.scheduler import SchedulerError
from estimator.scheduler_map import SchedulerMapTiles, _NoRedirects, MAX_TILE_BYTES, USER_AGENT


PNG = b'\x89PNG\r\n\x1a\n' + b'\0\0\0\rIHDR' + struct.pack('>II', 256, 256) + b'synthetic-test-tile'


class Response(BytesIO):
    status = 200

    def __init__(self, body=PNG, mime='image/png'):
        super().__init__(body)
        self.headers = Message(); self.headers['Content-Type'] = mime


class Opener:
    def __init__(self):
        self.calls = []; self.body = PNG; self.mime = 'image/png'; self.error = None

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if self.error:
            raise self.error
        return Response(self.body, self.mime)


class SchedulerMapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.now = 1000000; self.opener = Opener()
        self.cache = SchedulerMapTiles(Path(self.temp.name)/'tiles.sqlite3', opener=self.opener, now=lambda: self.now)

    def get(self, **query):
        return self.cache.get(query or {'z': '10', 'x': '942', 'y': '614'}, member_id='private-member', referer='http://127.0.0.1:1234/')

    def test_fixed_host_identification_referer_timeout_and_seven_day_cache(self):
        self.assertEqual(self.get(), PNG)
        request, timeout = self.opener.calls[0]
        self.assertEqual(request.full_url, 'https://tile.openstreetmap.org/10/942/614.png')
        self.assertEqual(timeout, 5)
        self.assertEqual(request.get_header('User-agent'), USER_AGENT)
        self.assertEqual(request.get_header('Referer'), 'http://127.0.0.1:1234/')
        self.assertNotIn('private-member', repr(request.header_items()))
        self.assertIsNone(request.get_header('Cookie'))
        self.assertIsNone(request.get_header('Authorization'))
        self.now += 7*86400-1
        self.assertEqual(self.get(), PNG); self.assertEqual(len(self.opener.calls), 1)
        self.now += 2
        self.assertEqual(self.get(), PNG); self.assertEqual(len(self.opener.calls), 2)

    def test_rejects_noncanonical_tiles_and_redirects(self):
        for query in ({'z': '20', 'x': '0', 'y': '0'}, {'z': '0', 'x': '1', 'y': '0'},
                      {'z': '1', 'x': '../secret', 'y': '0'}, {'z': '01', 'x': '0', 'y': '0'},
                      {'z': '1', 'x': '0', 'y': '-1'}, {'url': 'https://other.test'}):
            with self.subTest(query=query), self.assertRaises(SchedulerError): self.get(**query)
        self.assertEqual(self.opener.calls, [])
        self.assertIsNone(_NoRedirects().redirect_request(None, None, 302, '', {}, 'https://other.test'))

    def test_invalid_mime_size_dimensions_and_network_failure(self):
        for body, mime in ((PNG, 'text/html'), (b'bad', 'image/png'), (PNG+b'x'*MAX_TILE_BYTES, 'image/png'),
                           (PNG[:16]+struct.pack('>II', 100000, 100000), 'image/png')):
            self.opener.body, self.opener.mime = body, mime
            with self.subTest(mime=mime, size=len(body)), self.assertRaises(SchedulerError) as caught: self.get()
            self.assertEqual(caught.exception.status_code, 502)
        self.opener.error = URLError('offline')
        with self.assertRaises(SchedulerError) as caught: self.get()
        self.assertEqual(caught.exception.status_code, 502)

    def test_rate_and_cache_bounds_preserve_fresh_tiles(self):
        for column in range(60): self.get(z='10', x=str(column), y='1')
        with self.assertRaises(SchedulerError) as caught: self.get(z='10', x='61', y='1')
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(self.get(z='10', x='0', y='1'), PNG)
        self.now += 61
        with patch('estimator.scheduler_map.MAX_CACHE_TILES', 60), self.assertRaises(SchedulerError) as caught:
            self.get(z='10', x='61', y='1')
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(self.get(z='10', x='0', y='1'), PNG)
        self.now += 7*86400
        with patch('estimator.scheduler_map.MAX_CACHE_TILES', 60): self.assertEqual(self.get(z='10', x='61', y='1'), PNG)
