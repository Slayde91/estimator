"""Keep the default PDF typeface and substitute the user's CJK glyphs where needed."""
from functools import lru_cache
from itertools import groupby
import os
from pathlib import Path
from threading import Lock
from xml.sax.saxutils import escape

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont, TTFError


_lock = Lock()


@lru_cache(maxsize=12)
def system_cjk_font(name, filename, standard):
    # Embed subsets where a suitable system font is installed. Standard CJK PDF
    # fonts are available through the PDF reader on systems without those fonts.
    with _lock:
        if os.name == 'nt':
            path = Path(os.environ.get('SystemRoot',r'C:\Windows'))/'Fonts'/filename
            if path.is_file():
                try:
                    face = TTFont(name,str(path))
                    pdfmetrics.registerFont(face)
                    return name
                except (OSError,TTFError):
                    pass
        if standard not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(UnicodeCIDFont(standard))
        return standard


def font_text(text, font):
    primary = pdfmetrics.getFont(font).face.charToGlyph
    def face(char):
        code = ord(char)
        if primary.get(code) or char in '\r\n\t':
            return font
        if 0x3040 <= code <= 0x30ff:
            return system_cjk_font('FormJapanese','msgothic.ttc','HeiseiMin-W3')
        if 0xac00 <= code <= 0xd7af or 0x1100 <= code <= 0x11ff:
            return system_cjk_font('FormKorean','malgun.ttf','HYSMyeongJo-Medium')
        if 0x3000 <= code <= 0x303f or 0x3400 <= code <= 0x9fff or 0xff00 <= code <= 0xffef:
            return system_cjk_font('FormChinese','simsun.ttc','STSong-Light')
        return None
    runs = []
    needs_browser = False
    for name, group in groupby(text,key=face):
        value = escape(''.join(group)).replace('\n','<br/>')
        if name is None:
            needs_browser = True
        runs.append(value if name in (None,font) else f'<font name="{name}">{value}</font>')
    return ''.join(runs), needs_browser
