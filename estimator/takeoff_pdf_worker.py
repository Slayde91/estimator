"""Bounded, disposable PDF metadata parser. Never run inside the HTTP process."""

import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile


MEMORY_LIMIT = 768 * 1024 * 1024
CPU_SECONDS = 30
MAX_PAGES = 2000
MAX_DOCUMENT_SIZE = 250 * 1024 * 1024
_JOB = None


def restrict_process():
    """Apply hard limits before opening untrusted PDF bytes; fail closed."""
    global _JOB
    if os.name != "nt":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
        return

    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                    ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise RuntimeError("PDF parser resource limits are unavailable.")
    limits = ExtendedLimits()
    # Per-process CPU, active processes, process memory, and kill-on-close.
    limits.BasicLimitInformation.LimitFlags = 0x2 | 0x8 | 0x100 | 0x2000
    limits.BasicLimitInformation.PerProcessUserTimeLimit = CPU_SECONDS * 10_000_000
    limits.BasicLimitInformation.ActiveProcessLimit = 1
    limits.ProcessMemoryLimit = MEMORY_LIMIT
    if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise RuntimeError("PDF parser resource limits are unavailable.")
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        raise RuntimeError("PDF parser resource limits are unavailable.")
    _JOB = handle  # Keep the limiting job alive until this disposable process exits.


def parse_pdf_stream(source):
    from pypdf import PdfReader
    if source.read(5) != b"%PDF-":
        raise ValueError("Choose a valid PDF document.")
    source.seek(0)
    reader = PdfReader(source, strict=True)
    if reader.is_encrypted:
        raise ValueError("Encrypted PDFs are not supported. Supply an unencrypted source PDF.")
    if not 1 <= len(reader.pages) <= MAX_PAGES:
        raise ValueError("Each project supports at most 2,000 PDF pages.")
    pages = []
    for number, page in enumerate(reader.pages, 1):
        media = [float(value) for value in page.mediabox]
        crop = [float(value) for value in page.cropbox]
        view = [max(media[0], crop[0]), max(media[1], crop[1]),
                min(media[2], crop[2]), min(media[3], crop[3])]
        user_unit = float(page.get("/UserUnit", 1))
        rotation_value = float(page.get("/Rotate", 0))
        values = media + crop + view + [user_unit, rotation_value]
        if (not all(math.isfinite(value) and abs(value) <= 1e9 for value in values)
                or not 0 < user_unit <= 75000 or view[2] <= view[0] or view[3] <= view[1]
                or rotation_value % 90):
            raise ValueError("The PDF has unsupported page geometry.")
        pages.append({"page": number, "width": view[2] - view[0], "height": view[3] - view[1],
                      "view": view, "media_box": media, "crop_box": crop,
                      "rotation": int(rotation_value) % 360, "user_unit": user_unit})
    return {"pages": pages}


def parse_pdf(path):
    # The caller's path can change while this process starts. Parse only the
    # private handle whose exact bytes were hashed; never reopen the source.
    # The parent compares this digest with its expected immutable original.
    checksum = hashlib.sha256()
    size = 0
    with tempfile.TemporaryFile(mode="w+b") as snapshot:
        with Path(path).open("rb") as source:
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_DOCUMENT_SIZE:
                    raise ValueError("Each PDF must be at most 250 MiB.")
                checksum.update(chunk)
                snapshot.write(chunk)
        snapshot.seek(0)
        return {"sha256": checksum.hexdigest(), **parse_pdf_stream(snapshot)}


def main():
    try:
        restrict_process()
        if len(sys.argv) != 2:
            raise ValueError("One PDF source is required.")
        result = parse_pdf(sys.argv[1])
    except Exception as error:
        # Never expose parser traces or local paths in browser-facing responses.
        message = str(error) if isinstance(error, (ValueError, RuntimeError)) else "The PDF could not be parsed safely."
        result = {"error": message[:300]}
    sys.stdout.write(json.dumps(result, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
