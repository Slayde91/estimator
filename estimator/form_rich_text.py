"""Plain-text projection for versioned rich form values and legacy text."""
from html import unescape
import re


_TAGS = re.compile(r'(</?(?:p|div|br|b|strong|i|em|u|ul|ol|li)>)')
_BLOCKS = {'<p>','</p>','<div>','</div>','<li>','</li>'}


def plain_form_text(value):
    if not isinstance(value, dict) or not isinstance(value.get('html'), str):
        return value
    chunks = []
    for index, part in enumerate(_TAGS.split(value['html'])):
        if index % 2 == 0 and part:
            chunks.append(unescape(part))
        elif part == '<br>' or (part in _BLOCKS and chunks and not chunks[-1].endswith('\n')):
            chunks.append('\n')
    return ''.join(chunks).rstrip('\n')
