"""Bundled typography for CLASSIFIRE-authored PDF text.

Only our private font family is registered. Source PDF resources and ReportLab's
built-in fonts/defaults are never replaced, so imported pages remain unchanged.
"""
from pathlib import Path
from threading import Lock

from reportlab.lib.styles import ParagraphStyle as ReportLabParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


FONT_REGULAR = 'ClassifireMontserrat'
FONT_BOLD = 'ClassifireMontserratBold'
FONT_ITALIC = 'ClassifireMontserratItalic'
FONT_BOLD_ITALIC = 'ClassifireMontserratBoldItalic'
_FACES = {
    'regular': (FONT_REGULAR, 'Regular'),
    'bold': (FONT_BOLD, 'Bold'),
    'italic': (FONT_ITALIC, 'Italic'),
    'boldItalic': (FONT_BOLD_ITALIC, 'BoldItalic'),
}
_FONT_ROOT = Path(__file__).resolve().parent.parent / 'static' / 'fonts'
_FONT_LOCK = Lock()
_registered = False


def font_path(style='regular'):
    """Return a bundled static TTF path for ReportLab or PDF annotation engines."""
    return _FONT_ROOT / ('Montserrat-' + _FACES[style][1] + '.ttf')


def register_pdf_fonts():
    """Register all four faces atomically for concurrent report generation."""
    global _registered
    with _FONT_LOCK:
        if _registered:
            return
        registered = set(pdfmetrics.getRegisteredFontNames())
        for style, (name, _) in _FACES.items():
            if name not in registered:
                pdfmetrics.registerFont(TTFont(name, str(font_path(style))))
        pdfmetrics.registerFontFamily(FONT_REGULAR, normal=FONT_REGULAR, bold=FONT_BOLD,
                                      italic=FONT_ITALIC, boldItalic=FONT_BOLD_ITALIC)
        _registered = True


class PdfParagraphStyle(ReportLabParagraphStyle):
    """Local paragraph defaults include bullets without changing ReportLab."""
    defaults = dict(ReportLabParagraphStyle.defaults, fontName=FONT_REGULAR,
                    bulletFontName=FONT_REGULAR)
