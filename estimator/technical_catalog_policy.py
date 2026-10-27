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
_REPORT_PLACEHOLDERS = {'n/a', 'na', 'n.a', 'none', 'nil', 'null', 'unknown', 'unavailable',
                        'not applicable', 'not available', 'not recorded', 'not supplied',
                        'not provided', 'not identified', 'not specified', 'pending',
                        'to be confirmed', 'to be determined', 'tbc', 'tbd', 'no report'}


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


def _report_caption(value):
    """Keep literal explicit captions; missing-value labels are not reports."""
    caption = value.strip()
    if len(caption) > 1000:
        return None
    key = ' '.join(caption.casefold().split()).rstrip('.')
    key = re.sub(r'^report(?: number| reference)?\s*:?\s+', '', key)
    if not any(character.isalnum() for character in caption) or key in _REPORT_PLACEHOLDERS:
        return None
    return caption


def _promat_report_facets(item, report_keys):
    """Repair missing discovery assignments from explicit report fields only."""
    manufacturers = {_name(value) for value in item.get('filter_values', {}).get('manufacturer', [])}
    if manufacturers != {'promat'}:
        return item
    captions = list(dict.fromkeys(caption for field in item.get('fields', [])
                                  if field.get('label') == 'Report Number'
                                  for value in field.get('value', '').splitlines()
                                  if (caption := _report_caption(value)) is not None))
    missing = [key for key in report_keys if not any(
        _report_caption(value) for value in item.get('filter_values', {}).get(key, []))]
    if not captions or not missing:
        return item
    result = deepcopy(item)
    for key in missing:
        values = result.setdefault('filter_values', {}).setdefault(key, [])
        values.extend(value for value in captions if value not in values)
    return result


def public_records(records, aliases, report_keys):
    """Copy only changed records; never mutate reviewed records or raw sources."""
    excluded = {key for key, item in records.items() if retired(item)}
    excluded.update(key for key in records if aliases.get(key, key) in excluded)
    result = {}
    for key, item in records.items():
        if key in excluded:
            continue
        item = _promat_report_facets(item, report_keys)
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
