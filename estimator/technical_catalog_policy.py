"""Explicit public catalog decisions, separate from immutable source evidence.

Apply only after source-bound configuration/duplicate reviews. Product identity
comes from normalized supplier/product fields, never a title or incidental
installation text. This layer assigns report navigation, not installation approval.
"""
from copy import deepcopy
import re

FYRESHIELD_REPORT = 'FAS200221 R3.0'
FYRESHIELD_REPORT_URL = 'https://tfire.com.au/documents/FyreSHIELD-Range-Test-Report'
_FYRESHIELD = {'fyreshield', 'fyreshield plus', 'fyreshield screw fixed', 'fyreshield plus screw fixed'}
_RETIRED = {'frss', 'frss screw fixed'}


def _name(value):
    return ' '.join(re.sub(r'[-‐‑‒–—−]', ' ', value).casefold().split())


def product_family(record):
    """Recognize an explicit, unambiguous Trafalgar product family only."""
    manufacturers = {_name(value) for value in record.get('filter_values', {}).get('manufacturer', [])}
    if manufacturers != {'trafalgar'}:
        return None
    products = {_name(value) for field in record.get('fields', []) if field.get('label') == 'System Products'
                for value in str(field.get('value', '')).splitlines() if value.strip()}
    return next(iter(products)) if len(products) == 1 else None


def retired(record):
    return product_family(record) in _RETIRED


def assigned_report_url(label):
    """A verified report URL is independent of each item's source diagram PDF."""
    return FYRESHIELD_REPORT_URL if label.strip().casefold() == FYRESHIELD_REPORT.casefold() else None


def public_records(records, aliases, report_keys):
    """Copy only changed records; never mutate reviewed records or raw sources."""
    excluded = {key for key, item in records.items() if retired(item)}
    excluded.update(key for key in records if aliases.get(key, key) in excluded)
    result = {}
    for key, item in records.items():
        if key in excluded:
            continue
        if product_family(item) not in _FYRESHIELD:
            result[key] = item
            continue
        item = deepcopy(item)
        fields = item.setdefault('fields', [])
        report = next((field for field in fields if field.get('label') == 'Report Number'), None)
        if report is None:
            report = {'label': 'Report Number', 'value': ''}
            fields.append(report)
        captions = [value.strip() for value in report.get('value', '').splitlines() if value.strip()]
        captions = [FYRESHIELD_REPORT if value.casefold() == FYRESHIELD_REPORT.casefold() else value for value in captions]
        if FYRESHIELD_REPORT not in captions:
            captions.append(FYRESHIELD_REPORT)
        report['value'] = '\n'.join(dict.fromkeys(captions))
        old_links = {link['label']: link for link in report.get('report_links', [])
                     if link['label'].casefold() != FYRESHIELD_REPORT.casefold()}
        old_links[FYRESHIELD_REPORT] = {'label': FYRESHIELD_REPORT, 'url': FYRESHIELD_REPORT_URL}
        report['report_links'] = [deepcopy(old_links[label]) for label in dict.fromkeys(captions) if label in old_links]
        for name in report_keys:
            values = item.setdefault('filter_values', {}).setdefault(name, [])
            if FYRESHIELD_REPORT not in values:
                values.append(FYRESHIELD_REPORT)
        result[key] = item
    return result
