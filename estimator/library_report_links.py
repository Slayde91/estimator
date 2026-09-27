"""Validated outbound report references; never HTML or guessed download URLs."""

import re
from urllib.parse import urlsplit

REPORT_HOSTS = {'media.promat.com', 'etex.azureedge.net'}
TRAFALGAR_REPORT_PATH = re.compile(r'/documents/[A-Za-z0-9][A-Za-z0-9_.()=-]*')
FIREFLY_REPORTS_URL = 'https://systems.tbafirefly.com.au/reports'


def valid_report_url(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 4000:
        return False
    if re.search(r'[\s<>"\\\x00-\x1f\x7f]', value):
        return False
    if value == FIREFLY_REPORTS_URL:
        return True
    try:
        url = urlsplit(value)
        return (url.scheme == 'https' and (
            url.netloc in REPORT_HOSTS and url.path.lower().endswith('.pdf')
            or url.netloc == 'tfire.com.au' and not url.query and not url.fragment
            and TRAFALGAR_REPORT_PATH.fullmatch(url.path) is not None))
    except ValueError:
        return False


def validate_report_links(field):
    if 'report_links' not in field:
        return
    links = field['report_links']
    if field['label'] != 'Report Number' or not isinstance(links, list) or not 1 <= len(links) <= 20:
        raise ValueError('Invalid report links')
    labels = [s.strip() for s in field['value'].splitlines() if s.strip()]
    if len(set(labels)) != len(labels):
        raise ValueError('Report links must match the displayed report numbers')
    positions = []
    for link in links:
        if (not isinstance(link, dict) or set(link) != {'label', 'url'}
                or link['label'] not in labels or not valid_report_url(link['url'])):
            raise ValueError('Invalid report link or report number')
        positions.append(labels.index(link['label']))
    if positions != sorted(set(positions)):
        raise ValueError('Report links must be unique and in displayed order')
