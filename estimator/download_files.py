"""Local PDF/Excel destinations and exclusive, non-overwriting file writes."""

import ctypes
from dataclasses import dataclass
import os
from pathlib import Path
import re
import shlex
import sys
import uuid

from .catalog import ValidationError


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
    if (not isinstance(filename, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 ._-]*\.(?:pdf|xlsx)', filename)
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
