"""Local PDF/Excel/CSV destinations and exclusive, non-overwriting file writes."""

import ctypes
from dataclasses import dataclass
import os
from pathlib import Path
import re
import shlex
import sys
import uuid
import secrets
import stat
import subprocess
from hashlib import sha256
from threading import Lock
from time import monotonic

from .catalog import ValidationError


class SavedDownloadFiles:
    """Session-only capabilities for files actually written by this application."""

    def __init__(self, *, clock=monotonic, limit=256, ttl=8 * 60 * 60):
        self._clock, self._limit, self._ttl = clock, limit, ttl
        self._entries, self._lock = {}, Lock()

    def register(self, receipt, payload):
        path = Path(receipt['path'])
        if path.suffix.lower() not in {'.pdf', '.xlsx'}:
            return receipt
        try:
            info = path.lstat()
        except OSError as error:
            raise ValidationError('The saved-file link could not be registered. Download the file again.') from error
        with self._lock:
            self._prune()
            while len(self._entries) >= self._limit:
                del self._entries[next(iter(self._entries))]
            token = secrets.token_urlsafe(24)
            self._entries[token] = (path, self._identity(info), sha256(payload).digest(), self._clock())
        url = f'/api/download-files/{token}'
        return {**receipt, 'download_url': url, 'open_url': url + '/open' if path.suffix.lower() == '.xlsx' else None}

    def _prune(self):
        now = self._clock()
        self._entries = {key: entry for key, entry in self._entries.items() if now - entry[3] < self._ttl}

    @staticmethod
    def _identity(info):
        return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns

    def read(self, token):
        from .project_library import _directory, _linked
        with self._lock:
            self._prune()
            entry = self._entries.get(token) if isinstance(token, str) else None
        if entry is None:
            raise ValidationError('This saved-file link has expired. Download the file again.')
        path, identity, digest, _ = entry
        try:
            _directory(path.parent)
            before = path.lstat()
            if _linked(before) or not stat.S_ISREG(before.st_mode) or self._identity(before) != identity:
                raise OSError('File was replaced.')
            flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
            with os.fdopen(os.open(path, flags), 'rb') as stream:
                if self._identity(os.fstat(stream.fileno())) != identity:
                    raise OSError('File was replaced while opening.')
                payload = stream.read()
                if self._identity(os.fstat(stream.fileno())) != identity:
                    raise OSError('File changed while reading.')
            if self._identity(path.lstat()) != identity or sha256(payload).digest() != digest:
                raise OSError('File changed.')
            return path, payload
        except (OSError, ValidationError) as error:
            raise ValidationError('The saved file changed, moved or was removed. Download it again.') from error

    def open_workbook(self, token):
        path, _ = self.read(token)
        if path.suffix.lower() != '.xlsx':
            raise ValidationError('Only saved Excel workbooks can be opened in the default application.')
        try:
            if sys.platform == 'win32':
                os.startfile(str(path))
            else:
                subprocess.Popen(['open' if sys.platform == 'darwin' else 'xdg-open', str(path)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as error:
            raise ValidationError('The workbook could not be opened. Check its default application.') from error
        return {'opened': True}


@dataclass(frozen=True)
class DownloadDestination:
    folder: Path
    destination: str


def _windows_downloads():
    """Read FOLDERID_Downloads, including Windows/OneDrive redirection."""
    folder_id = (ctypes.c_byte * 16).from_buffer_copy(uuid.UUID('374de290-123f-4565-9164-39c4925e467b').bytes_le)
    shell = ctypes.WinDLL('shell32', use_last_error=True)
    memory = ctypes.WinDLL('ole32', use_last_error=True)
    lookup = shell.SHGetKnownFolderPath
    lookup.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    lookup.restype = ctypes.c_long
    memory.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    memory.CoTaskMemFree.restype = None
    result = ctypes.c_void_p()
    try:
        # DONT_VERIFY resolves the configured path even before its first use.
        status = lookup(ctypes.byref(folder_id), 0x4000, None, ctypes.byref(result))
        if status != 0 or not result.value:
            raise OSError('Windows could not resolve the Downloads folder.')
        return Path(ctypes.wstring_at(result.value))
    finally:
        if result.value:
            memory.CoTaskMemFree(result)


def standard_downloads_directory():
    """Use the operating system's configured Downloads location, without a dialog."""
    try:
        if sys.platform == 'win32':
            path = _windows_downloads()
        else:
            home = Path.home()
            path = home / 'Downloads'
            if sys.platform.startswith('linux'):
                config = Path(os.environ.get('XDG_CONFIG_HOME', str(home / '.config'))) / 'user-dirs.dirs'
                if config.is_file():
                    for line in config.read_text(encoding='utf-8').splitlines():
                        if re.match(r'^\s*XDG_DOWNLOAD_DIR\s*=', line):
                            values = shlex.split(line.split('=', 1)[1], comments=True)
                            if len(values) == 1:
                                value = values[0]
                                if value == '$HOME' or value.startswith('$HOME/'):
                                    value = str(home) + value[5:]
                                path = Path(value)
                            break
        if not path.is_absolute() or '..' in path.parts:
            raise OSError('The configured Downloads folder is not an absolute path.')
        return path
    except (OSError, ValueError) as error:
        raise ValidationError('The standard Downloads folder could not be located. Check its operating-system setting and try again.') from error


def _download_directory(folder, create=False):
    from .project_library import _directory
    try:
        if create and not folder.exists():
            ancestor = next((parent for parent in folder.parents if parent.exists()), None)
            if ancestor is None:
                raise OSError('No accessible parent folder.')
            _directory(ancestor)
            folder.mkdir(parents=True, exist_ok=True)
        return _directory(folder)
    except (OSError, ValidationError) as error:
        raise ValidationError('The download folder is unavailable. Check that it exists and is an accessible regular folder.') from error


def write_download_file(destination, filename, payload):
    """Save complete bytes using exclusive creation; existing names get a suffix."""
    if (not isinstance(filename, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 ._-]*\.(?:pdf|xlsx|csv)', filename)
            or len(filename) > 180 or '..' in filename or not isinstance(payload, bytes) or not payload):
        raise ValidationError('The download has an invalid filename or file content.')
    folder = _download_directory(destination.folder, create=destination.destination == 'downloads')
    stem, suffix = Path(filename).stem, Path(filename).suffix
    path, identity = None, None
    try:
        for number in range(10000):
            candidate = folder / (filename if number == 0 else f'{stem} ({number}){suffix}')
            try:
                descriptor = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            except FileExistsError:
                continue
            path = candidate
            with os.fdopen(descriptor, 'wb') as stream:
                info = os.fstat(stream.fileno())
                identity = (info.st_dev, info.st_ino)
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            _download_directory(folder)
            return {'saved': True, 'path': str(path), 'filename': path.name, 'destination': destination.destination}
        raise ValidationError('Too many files share this download name. Rename or move older downloads and try again.')
    except (OSError, ValidationError) as error:
        # Remove only the failed file created by this request. Never remove an
        # existing or externally replaced destination, even when cleanup fails.
        if path is not None and identity is not None:
            try:
                info = path.lstat()
                if (info.st_dev, info.st_ino) == identity:
                    path.unlink()
            except OSError:
                pass
        if isinstance(error, ValidationError):
            raise
        raise ValidationError('The download could not be saved. Check the destination folder permissions and available disk space, then try again.') from error
