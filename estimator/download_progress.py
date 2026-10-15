"""Bounded, opaque progress receipts for a single local document download.

Percentages describe completed preparation/save stages, never estimated time.
Optional page counts advance the preparation stage from measured worker output.
"""
import secrets
from threading import Lock
from time import monotonic

from .catalog import ValidationError


class DownloadProgress:
    def __init__(self, *, clock=monotonic, limit=16, ttl=1800):
        self._clock, self._limit, self._ttl = clock, limit, ttl
        self._entries, self._lock = {}, Lock()

    def _prune(self):
        now = self._clock()
        self._entries = {key: value for key, value in self._entries.items()
                         if now - value['updated'] < self._ttl}

    def begin(self):
        with self._lock:
            self._prune()
            # Finished receipts may be retired to make room; active jobs cannot.
            for key in list(self._entries):
                if len(self._entries) < self._limit:
                    break
                if self._entries[key]['state'] in ('saved', 'failed'):
                    del self._entries[key]
            if len(self._entries) >= self._limit:
                raise ValidationError('Too many document downloads are active. Wait for one to finish.')
            token = secrets.token_urlsafe(24)
            self._entries[token] = {'percent': 0, 'state': 'waiting', 'updated': self._clock()}
            return {'token': token, 'percent': 0, 'state': 'waiting'}

    def _entry(self, token):
        if not isinstance(token, str) or token not in self._entries:
            raise ValidationError('The document progress receipt is unavailable.')
        return self._entries[token]

    def claim(self, token):
        with self._lock:
            self._prune()
            entry = self._entry(token)
            if entry['state'] != 'waiting':
                raise ValidationError('A document progress receipt can be used only once.')
            entry.update(percent=10, state='preparing', updated=self._clock())

    def update(self, token, percent, state):
        if token is None:
            return
        with self._lock:
            entry = self._entry(token)
            if entry['state'] in ('saved', 'failed'):
                return
            entry.update(percent=max(entry['percent'], min(100, percent)), state=state, updated=self._clock())

    def pages(self, token, completed, total):
        if not isinstance(completed, int) or not isinstance(total, int) or not 0 <= completed <= total or total < 1:
            raise ValidationError('Document page progress is invalid.')
        self.update(token, 10 + int(75 * completed / total), 'preparing')

    def read(self, token):
        with self._lock:
            self._prune()
            entry = self._entry(token)
            return {key: entry[key] for key in ('percent', 'state')}
