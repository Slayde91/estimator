"""Public download names, independent of immutable source/revision metadata."""
from email.message import Message
from email.utils import collapse_rfc2231_value
import re

DOCUMENT_FILENAMES = {
    'estimate.summary.pdf': 'BREAKDOWN.pdf',
    'project.full_schedule.pdf': 'FULL_SCHEDULE.pdf',
    'project.full_product_summary.pdf': 'FULL_PRODUCT_SUMMARY.pdf',
    'firestopping.schedule.pdf': 'FIRESTOPPING_SCHEDULE.pdf',
    'certification': 'INSTALLATION_CERTIFICATE.pdf',
}
for _identity, _prefix in [('steel_vermiculite','SPRAY'),('steel_intumescent','PAINT'),
                           ('steel_board','BOARD'),('ductwork','DUCT')]:
    DOCUMENT_FILENAMES[f'calculator.{_identity}.schedule.pdf'] = _prefix + '_SCHEDULE.pdf'
    DOCUMENT_FILENAMES[f'calculator.{_identity}.product_summary.pdf'] = _prefix + '_PRODUCT_SUMMARY.pdf'


def document_filename(kind, filename, revision=None):
    """Public name from authored kind and the owner's recorded revision."""
    name = DOCUMENT_FILENAMES.get(kind, download_filename(filename))
    if revision is None:
        return name
    if type(revision) is not int or revision < 1:
        raise ValueError('A download revision must be a positive integer.')
    stem, dot, suffix = name.rpartition('.')
    if not dot:
        stem, suffix = name, ''
    stem = re.sub(r'-R[1-9][0-9]*$', '', stem)
    tag=f'-R{revision}'; extension=dot+suffix if dot else ''
    stem=stem[:200-len(tag)-len(extension)].rstrip(' .')
    return stem + tag + extension


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
