"""Exclusive staging files for project and companion writes."""

import errno
import os
import secrets


def open_project_temp(folder):
    """Return a writable descriptor and its path in the destination folder."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    # On Windows a directory can pass os.access(W_OK) while its ACL denies
    # file creation. Retry genuine name collisions only, never access failures.
    for _ in range(8):
        path = folder / ('.cf-' + secrets.token_hex(8) + '.tmp')
        try:
            descriptor = os.open(path, flags, 0o600)
        except FileExistsError:
            continue
        except PermissionError:
            # Windows may report an occupied directory name as access denied.
            if os.path.lexists(path):
                continue
            raise
        return descriptor, path
    raise FileExistsError(errno.EEXIST, 'Could not reserve a unique temporary project file', str(folder))
