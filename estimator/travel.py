"""Explicit, transient Google driving-route lookups; never quote inputs or prices."""
import json
import math
import os
import re
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPRedirectHandler

from .catalog import ValidationError

ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes'
KEY_ENV = 'CEASEFIRE_GOOGLE_MAPS_API_KEY'


class TravelError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def address(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 400 or any(ord(c) < 32 for c in value):
        raise ValidationError('Enter a valid address, up to 400 characters.')
    return value.strip()


def waypoint(value):
    if not isinstance(value, dict):
        raise ValidationError('Choose your current location or enter its address.')
    if set(value) == {'address'}:
        return {'address': address(value['address'])}
    if set(value) != {'latitude', 'longitude'}:
        raise ValidationError('Include an address or latitude and longitude only.')
    for field, limit in [('latitude', 90), ('longitude', 180)]:
        number = value[field]
        if isinstance(number, bool) or not isinstance(number, (float, int)) or not math.isfinite(number) or abs(number) > limit:
            raise ValidationError('The current location has invalid coordinates.')
    return {'location': {'latLng': dict(value)}}


class TravelService:
    def __init__(self, *, key=None, opener=None, clock=time.monotonic):
        candidate = os.environ.get(KEY_ENV, '') if key is None else key
        self._key = candidate.strip() if isinstance(candidate, str) else ''
        if not re.fullmatch(r'[A-Za-z0-9_-]{20,256}', self._key):
            self._key = ''
        self._opener = opener or build_opener(NoRedirect()).open
        self._clock = clock
        self._lock = threading.Lock()
        self._last = float('-inf')

    def status(self):
        return {'configured': bool(self._key), 'provider': 'Google Maps'}

    def route(self, body):
        if not isinstance(body, dict) or set(body) != {'origin', 'destination'}:
            raise ValidationError('Include the current location and project address only.')
        origin = waypoint(body['origin'])
        destination = address(body['destination'])
        if not self._key:
            raise TravelError('Google Maps is not configured. Open the setup guide in Settings.', 503)
        if not self._lock.acquire(blocking=False):
            raise TravelError('A route lookup is already running. Please wait.', 429)
        try:
            if self._clock() - self._last < 1:
                raise TravelError('Please wait a moment before checking another route.', 429)
            self._last = self._clock()
            request = Request(ENDPOINT, data=json.dumps({
                'origin': origin, 'destination': {'address': destination},
                'travelMode': 'DRIVE', 'routingPreference': 'TRAFFIC_UNAWARE',
                'computeAlternativeRoutes': False, 'languageCode': 'en-AU', 'units': 'METRIC',
            }).encode('utf-8'), method='POST', headers={
                'Content-Type': 'application/json', 'X-Goog-Api-Key': self._key,
                'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.description',
            })
            try:
                with self._opener(request, timeout=10) as response:
                    raw = response.read(65537)
                if len(raw) > 65536:
                    raise ValueError('oversized response')
                payload = json.loads(raw)
                routes = payload.get('routes') if isinstance(payload, dict) else None
                if routes == []:
                    raise TravelError('Google Maps could not find a driving route between these locations.', 422)
                route = routes[0]
                distance = route['distanceMeters']
                duration = route['duration']
                if isinstance(distance, bool) or not isinstance(distance, int) or not 0 <= distance <= 50_000_000:
                    raise ValueError('invalid distance')
                if not isinstance(duration, str) or not re.fullmatch(r'\d+(?:\.\d+)?s', duration):
                    raise ValueError('invalid duration')
                seconds = float(duration[:-1])
                if not math.isfinite(seconds) or seconds > 31_536_000:
                    raise ValueError('invalid duration')
                summary = route.get('description', '')
                if not isinstance(summary, str) or len(summary) > 1000:
                    raise ValueError('invalid summary')
            except TravelError:
                raise
            except (HTTPError, URLError, TimeoutError, OSError, ValueError, KeyError, TypeError, IndexError):
                # Never return provider exception strings, API keys or location data.
                raise TravelError('Google Maps could not calculate the route. Check the addresses, connection and Google Maps setup.') from None
            return {'provider': 'Google Maps', 'distance_meters': distance, 'duration_seconds': seconds, 'summary': summary}
        finally:
            self._lock.release()
