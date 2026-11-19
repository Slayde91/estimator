"""Print accents for authored documents, isolated to the generating request."""
from contextlib import contextmanager
from contextvars import ContextVar

from reportlab.lib import colors

from .catalog import ValidationError


THEMES = {'ceasefire': '#bd0018', 'midnight': '#244a75', 'ocean': '#155e75',
          'forest': '#166534', 'slate': '#334155'}
CLASSIFIRE_RED = colors.HexColor(THEMES['ceasefire'])
_theme = ContextVar('document_theme', default='ceasefire')


@contextmanager
def document_theme(name):
    if name not in THEMES:
        raise ValidationError('Choose a supported document colour theme.')
    token = _theme.set(name)
    try:
        yield
    finally:
        _theme.reset(token)


def accent_hex(default='BD0018'):
    name = _theme.get()
    return default if name == 'ceasefire' else THEMES[name][1:].upper()


def pdf_accent(default='BD0018'):
    return colors.HexColor('#' + accent_hex(default))
