"""Validated outbound report references; never HTML or guessed download URLs."""

import re
from urllib.parse import urlsplit

REPORT_HOSTS = {'media.promat.com', 'etex.azureedge.net'}
TRAFALGAR_REPORT_PATH = re.compile(r'/documents/[A-Za-z0-9][A-Za-z0-9_.()=-]*')
FIREFLY_REPORTS_URL = 'https://systems.tbafirefly.com.au/'
_LEGACY_FIREFLY_URL = 'https://systems.tbafirefly.com.au/reports'


def report_href(label, value=None, *, user_authored=False):
    """Display policy only: never promote an internal source copy to a report."""
    if re.match(r'^FAS\s*19023[456](?=\b|[_/])', str(label).strip(), re.I):
        return FIREFLY_REPORTS_URL
    if value == _LEGACY_FIREFLY_URL:
        return FIREFLY_REPORTS_URL
    if isinstance(value, str):
        try:
            if urlsplit(value).path.startswith('/api/libraries/documents/'):
                return None
        except ValueError:
            return None
    if valid_report_url(value):
        return value
    if user_authored and valid_manual_report_url(value):
        from ipaddress import ip_address
        host = urlsplit(value).hostname
        if host.lower() == 'localhost':
            return None
        try:
            if not ip_address(host).is_global:
                return None
        except ValueError:
            if '.' not in host or host.lower().endswith(('.localhost', '.local', '.internal')):
                return None
        return value
    return None


def pdf_report_href(value, origin=None):
    """Only approved public report links, regardless of the local app origin."""
    # Its callers pass links resolved by the catalog or explicitly by the user.
    return report_href('', value, user_authored=True)


def valid_report_url(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 4000:
        return False
    if re.search(r'[\s<>"\\\x00-\x1f\x7f]', value):
        return False
    if value in (FIREFLY_REPORTS_URL, _LEGACY_FIREFLY_URL):
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
