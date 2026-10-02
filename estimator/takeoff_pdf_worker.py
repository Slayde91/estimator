"""Bounded, disposable PDF metadata parser. Never run inside the HTTP process."""

import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile


MEMORY_LIMIT = 768 * 1024 * 1024
CPU_SECONDS = 30
MAX_PAGES = 2000
MAX_DOCUMENT_SIZE = 250 * 1024 * 1024
_JOB = None
PRINTED_SCALES = (2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 125, 150, 200, 250, 300)


def printed_page_scale(page):
    """Read one explicit footer scale; decline ambiguous or unlocated text.

    This is text evidence, not OCR and not a measurement of drawing geometry.
    Keep extraction in the resource-limited worker and bound the retained text.
    """
    view = [max(float(page.mediabox[0]), float(page.cropbox[0])),
            max(float(page.mediabox[1]), float(page.cropbox[1])),
            min(float(page.mediabox[2]), float(page.cropbox[2])),
            min(float(page.mediabox[3]), float(page.cropbox[3]))]
    x0, y0, x1, y1 = view
    rotation = int(page.get('/Rotate', 0)) % 360
    display_width, display_height = ((y1-y0, x1-x0) if rotation in (90, 270) else (x1-x0, y1-y0))
    spans, chars = [], 0

    def visit(value, cm, tm, font, size):
        nonlocal chars
        value = ' '.join(value.split())
        if not value:
            return
        chars += len(value)
        if chars > 200000 or len(spans) >= 10000 or len(value) > 2000:
            raise ValueError('The PDF page has too much text for automatic scale detection.')
        x, y = tm[4]*cm[0]+tm[5]*cm[2]+cm[4], tm[4]*cm[1]+tm[5]*cm[3]+cm[5]
        if not all(math.isfinite(v) for v in (x, y, size)) or not x0 <= x <= x1 or not y0 <= y <= y1:
            return
        dx, dy = {0: (x-x0, y-y0), 90: (y-y0, x1-x),
                  180: (x1-x, y1-y), 270: (y1-y, x-x0)}[rotation]
        # Footer/title block only. Detail captions elsewhere cannot choose a
        # whole-page scale. All competing scale cells in this band still count.
        if dy <= display_height * .2:
            spans.append({'text': value, 'x': dx, 'y': dy, 'size': max(1, abs(size)), 'point': [x, y]})

    try:
        page.extract_text(visitor_text=visit)
    except Exception:
        # Failure to read scale text must not make a valid PDF unopenable.
        return None
    if not spans:
        return None
    spans.sort(key=lambda value: (-value['y'], value['x']))
    lines = []
    for span in spans:
        line = next((line for line in lines if abs(line['y']-span['y']) <= min(line['size'], span['size'])*.35), None)
        if line is None:
            line = {'y': span['y'], 'size': span['size'], 'spans': []}
            lines.append(line)
        line['spans'].append(span)
    candidates = []
    ambiguous = re.compile(r'\b(?:AS\s+SHOWN|AS\s+INDICATED|VARIES|VARIOUS|N\s*\.?\s*T\s*\.?\s*S\b|NOT\s+TO\s+SCALE)')
    ratio = re.compile(r'(?<![\d.])1\s*:\s*(\d+)(?![\d.])')
    local_caption = re.compile(r'\b(?:DETAIL|SECTION|ELEVATION|INSET)\b', re.I)
    paper_label = re.compile(r'\b(?:SHEET\s+SIZE|PAPER(?:\s+SIZE)?)\b', re.I)
    paper_sizes = {0: (841, 1189), 1: (594, 841), 2: (420, 594), 3: (297, 420), 4: (210, 297), 5: (148, 210)}
    physical = sorted((float(page.mediabox.width), float(page.mediabox.height)))
    physical = [value*float(page.get('/UserUnit', 1))*25.4/72 for value in physical]
    sheet_text, sheet_spans, declared_sizes = [], [], []
    for label in spans:
        if not paper_label.search(label['text']):
            continue
        nearby = [span for span in spans if abs(span['y']-label['y']) <= label['size']*.35
                  and 0 <= span['x']-label['x'] <= display_width*.18]
        value = ' '.join(span['text'] for span in sorted(nearby, key=lambda span: span['x'])).upper()
        if not re.search(r'\bA\d+\b', value):
            below = [span for span in spans if 0 < label['y']-span['y'] <= label['size']*2.5
                     and abs(span['x']-label['x']) <= label['size']*2]
            nearby.extend(below)
            value = ' '.join(span['text'] for span in nearby).upper()
        sizes = re.findall(r'\bA(\d+)\b', value)
        # An explicit but unreadable/unsupported paper-size cell is ambiguous.
        if len(set(sizes)) != 1 or int(sizes[0]) not in paper_sizes:
            return None
        declared_sizes.extend(sizes); sheet_text.append(value); sheet_spans.extend(nearby)
    for line in lines:
        ordered = sorted(line['spans'], key=lambda value: value['x'])
        for index, label in enumerate(ordered):
            if not re.match(r'^(?:(?:MAIN|DRAWING)\s+)?SCALE\b', label['text'], re.I):
                continue
            if local_caption.search(label['text']) or (not re.match(r'^(?:MAIN|DRAWING)\s+SCALE\b', label['text'], re.I)
                    and any(local_caption.search(span['text']) and abs(span['x']-label['x']) <= display_width*.2
                            and abs(span['y']-label['y']) <= max(label['size']*6, display_height*.05) for span in spans)):
                continue
            # Keep a title-block cell local: do not borrow another cell's ratio.
            nearby = [span for span in ordered[index:] if span['x']-label['x'] <= display_width*.18]
            value = ' '.join(span['text'] for span in nearby).upper()
            relevant = nearby
            if not ratio.search(value) and not ambiguous.search(value):
                below = [span for span in spans if 0 < label['y']-span['y'] <= label['size']*2.5
                         and abs(span['x']-label['x']) <= label['size']*2]
                if below:
                    relevant = [label, *below]
                    value = ' '.join(span['text'] for span in relevant).upper()
            if ambiguous.search(value):
                return None
            ratios = ratio.findall(value)
            if len(ratios) != 1 or int(ratios[0]) not in PRINTED_SCALES:
                return None
            # An explicit printed paper size must match the actual physical PDF
            # sheet. Rescaled exports cannot inherit the original paper ratio.
            sizes = declared_sizes + re.findall(r'\bA(\d+)\b', value)
            if (len(set(sizes)) > 1 or any(int(size) not in paper_sizes for size in sizes)
                    or sizes and any(abs(actual-expected) > expected*.02 for actual, expected in zip(physical, paper_sizes[int(sizes[0])]))):
                return None
            if sheet_text:
                value += ' | ' + ' | '.join(dict.fromkeys(sheet_text))
                relevant = [*relevant, *sheet_spans]
            if len(value) > 200:
                return None
            source_points = [span['point'] for span in relevant]
            candidates.append({'scale_denominator': int(ratios[0]), 'text': value,
                               'points': [[min(point[0] for point in source_points), min(point[1] for point in source_points)],
                                          [max(point[0] for point in source_points), max(point[1] for point in source_points)]]})
    if not candidates or len({value['scale_denominator'] for value in candidates}) != 1:
        return None
    return candidates[0]


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


def parse_pdf_stream(source, scale_page=None):
    from pypdf import PdfReader
    if source.read(5) != b"%PDF-":
        raise ValueError("Choose a valid PDF document.")
    source.seek(0)
    reader = PdfReader(source, strict=True)
    if reader.is_encrypted:
        raise ValueError("Encrypted PDFs are not supported. Supply an unencrypted source PDF.")
    if not 1 <= len(reader.pages) <= MAX_PAGES:
        raise ValueError("Each project supports at most 2,000 PDF pages.")
    if scale_page is not None:
        if type(scale_page) is not int or not 1 <= scale_page <= len(reader.pages):
            raise ValueError('Choose an existing source page for automatic calibration.')
        return {'printed_scale': printed_page_scale(reader.pages[scale_page-1])}
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


def parse_pdf(path, scale_page=None):
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
        parsed = parse_pdf_stream(snapshot) if scale_page is None else parse_pdf_stream(snapshot, scale_page)
        return {"sha256": checksum.hexdigest(), **parsed}


def main():
    try:
        restrict_process()
        if len(sys.argv) not in (2, 3):
            raise ValueError("One PDF source is required.")
        result = parse_pdf(sys.argv[1], int(sys.argv[2]) if len(sys.argv) == 3 else None)
    except Exception as error:
        # Never expose parser traces or local paths in browser-facing responses.
        message = str(error) if isinstance(error, (ValueError, RuntimeError)) else "The PDF could not be parsed safely."
        result = {"error": message[:300]}
    sys.stdout.write(json.dumps(result, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
