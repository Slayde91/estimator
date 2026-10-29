"""Bounded, verified local evidence I/O shared by both application editions."""

from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re
import stat

from .catalog import ValidationError


HASH = re.compile(r"[0-9a-f]{64}\Z")


def _digest(value):
    if not isinstance(value, str) or not HASH.fullmatch(value):
        raise ValidationError("Invalid evidence digest.")
    return value



def _linked(info):
    if stat.S_ISLNK(info.st_mode):
        return True
    if not getattr(info, "st_file_attributes", 0) & 0x400:
        return False
    # Match the project's established OneDrive policy: documented cloud tags
    # do not redirect names. Junctions, symlinks and unknown providers do.
    return getattr(info, "st_reparse_tag", 0) & 0xFFFF0FFF != 0x9000001A


def _directory(path, create=False):
    path = Path(path).absolute()
    if ".." in path.parts:
        raise ValidationError("Evidence folders must be contained local folders.")
    for current in reversed((path, *path.parents)):
        try:
            info = current.lstat()
        except FileNotFoundError:
            if not create:
                raise ValidationError("The evidence folder is missing.") from None
            try:
                current.mkdir()
            except FileExistsError:
                pass
            info = current.lstat()
        if _linked(info) or not stat.S_ISDIR(info.st_mode):
            raise ValidationError("Evidence folders cannot be symbolic links or reparse points.")
    return path


def _identity(info):
    # Windows CRT fstat and path stat do not agree on ctime semantics.
    # Exact content hashing supplies integrity in addition to stable identity.
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


@contextmanager
def _open_regular(path, maximum, *, allow_empty=False):
    path = Path(path)
    _directory(path.parent)
    try:
        before = path.lstat()
        if _linked(before) or not stat.S_ISREG(before.st_mode) or not (0 if allow_empty else 1) <= before.st_size <= maximum:
            raise ValidationError("The evidence file is not a bounded regular file.")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            if _identity(before) != _identity(os.fstat(stream.fileno())):
                raise ValidationError("The evidence changed while being opened.")
            yield stream
            if _identity(before) != _identity(os.fstat(stream.fileno())) or _identity(before) != _identity(path.lstat()):
                raise ValidationError("The evidence changed while being read.")
    except OSError as error:
        raise ValidationError("The retained evidence is missing or cannot be read.") from error


def _hash_stream(stream):
    value = hashlib.sha256()
    stream.seek(0)
    while chunk := stream.read(1024 * 1024):
        value.update(chunk)
    stream.seek(0)
    return value.hexdigest()


def _verified(path, digest, maximum, *, allow_empty=False):
    with _open_regular(path, maximum, allow_empty=allow_empty) as stream:
        if _hash_stream(stream) != _digest(digest):
            raise ValidationError("The retained evidence hash has changed.")
