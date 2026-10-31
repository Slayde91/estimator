"""Public download names, independent of immutable source/revision metadata."""
from email.message import Message
from email.utils import collapse_rfc2231_value
import re


def download_filename(filename):
    if not isinstance(filename, str) or 'ceasefire' not in filename.casefold():
        return filename
    stem, dot, suffix = filename.rpartition('.')
    if not dot:
        stem, suffix = filename, ''
    stem = re.sub('ceasefire', '', stem, flags=re.I)
    stem = re.sub(r'([ _-])[ _-]+', r'\1', stem).strip(' ._-') or 'Download'
    return stem + (dot + suffix if dot else '')


def download_header(value):
    if 'ceasefire' not in value.casefold():
        return value
    message = Message(); message['Content-Disposition'] = value
    filename = next((collapse_rfc2231_value(part) for key, part in message.get_params(header='Content-Disposition') or []
                     if key == 'filename' and isinstance(part, tuple)), message.get_filename())
    if not filename:
        return value
    from .project_file import project_download_header
    header = project_download_header(download_filename(filename))
    return header.replace('attachment;', 'inline;', 1) if message.get_content_disposition() == 'inline' else header
