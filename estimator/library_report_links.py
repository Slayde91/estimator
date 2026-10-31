"""Validated outbound report references; never HTML or guessed download URLs."""

import re
from urllib.parse import urlsplit

REPORT_HOSTS = {'media.promat.com', 'etex.azureedge.net'}
TRAFALGAR_REPORT_PATH = re.compile(r'/documents/[A-Za-z0-9][A-Za-z0-9_.()=-]*')
FIREFLY_REPORTS_URL = 'https://systems.tbafirefly.com.au/reports'


def pdf_report_href(value, origin=None):
    """Publish validated public links or exact local report-asset routes only."""
    if valid_report_url(value):
        return value
    if isinstance(value, str) and re.fullmatch(r'/api/libraries/documents/[a-z0-9][a-z0-9_-]{0,119}\.pdf', value):
        return origin.rstrip('/') + value if origin else value
    return None


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
            and TRAFALGAR_REPORT_PATH.fullmatch(url.path) is not None
            or url.netloc == 'bossfire.com' and not url.query and not url.fragment
            and re.fullmatch(r'https://bossfire\.com/documents/test-reports/[A-Za-z0-9][A-Za-z0-9_.()-]*\.pdf', value, re.I) is not None))
    except ValueError:
        return False


def valid_manual_report_url(value):
    """An explicit user-authored hyperlink; never fetched by the server."""
    if not isinstance(value, str) or not 1 <= len(value) <= 4000 or re.search(r'[\s<>"\\\x00-\x1f\x7f]', value):
        return False
    try:
        url = urlsplit(value)
        return url.scheme in ('https', 'http') and bool(url.hostname) and not url.username and not url.password
    except ValueError:
        return False


def validate_report_links(field, *, user_authored=False):
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
                or link['label'] not in labels or not (valid_report_url(link['url']) or user_authored and valid_manual_report_url(link['url']))):
            raise ValueError('Invalid report link or report number')
        positions.append(labels.index(link['label']))
    if positions != sorted(set(positions)):
        raise ValueError('Report links must be unique and in displayed order')
