"""Conservative presentation of report identifiers from Trafalgar report fields.

Only report-labelled source values belong here, never arbitrary diagram/OCR text.
Source values stay in ingestion provenance. Unknown identifiers fail explicitly
so a new supplier format cannot disappear from a consolidated Report Number.
"""

import re
from typing import Iterable


_REPORT_LABEL = re.compile(
    r'^(?:(?:source|test|assessment)\s+|based\s+on\s+)?report'
    r'(?:\s+(?:numbers?|references?|no\.?)|\s*#)?'
    r'(?=$|\s*[:(\[\-—–])', re.IGNORECASE)
_LOCATOR_ITEM = r'(?:[A-Z]?\d+(?:\.\d+)*[A-Z]?|[A-Z])(?![A-Z0-9])'
_LOCATOR = re.compile(
    r'\b(?:tables?|pages?|clauses?|sections?|specimens?|appendix|appendices|figures?|fig\.?)'
    r'\s*[:#]?\s*' + _LOCATOR_ITEM
    + r'(?:\s*(?:[-–—,/&]|\band\b|\bor\b)\s*' + _LOCATOR_ITEM + r')*',
    re.IGNORECASE)
_DATE = re.compile(
    r'(?<![\w.-])(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}'
    r'|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)'
    r'\s+\d{4})(?![\w.-])', re.IGNORECASE)
_DOTTED_LOCATOR = re.compile(r'(?<![\w.])\d+(?:\.\d+){2,}(?![\w.])')
_LABEL_WORDS = re.compile(
    r'\b(?:based\s+on\s+)?(?:source\s+|test\s+|assessment\s+)?'
    r'report(?:\s+(?:number|reference|no\.?))?\s*[:#]?', re.IGNORECASE)
_DATE_LABEL = re.compile(r'\b(?:report\s+)?date\s*:', re.IGNORECASE)
_REPORT = re.compile(
    r'(?<![A-Z0-9])(?:'
    r'(?P<composite>\d{5,8}\s+FTR\s*\d+(?:\.\d+)+[A-Z]?)'
    r'|(?P<rtl>RTL\s*(?:FA|FT)\s*\d{3,8}(?:\.\d+)*[A-Z]?)'
    r'|(?P<tr_number>TR\s*\d{3,5}(?:\.\d+)+\s+\d{4})'
    r'|(?P<tr>TR\s*[-]\s*F\s*\d{1,5}(?:\.\d+)*[A-Z]?)'
    r'|(?P<igne>IGNE\s*[-]\s*\d{5}\s*[-]\s*\d{2}[A-Z]?)'
    r'|(?P<year>\d{2}\s*(?:SFR|FSR)\s*\d{5,8})'
    r'|(?P<pf>PF\s*\d{4,9})'
    r'|(?P<standard>(?:FCO|FAS|FAR|FRT|FTR|FSP|FSV|FC|RT)\s*[-]?\s*\d{3,9}(?:\.\d+)*[A-Z]?)'
    r'|(?P<numeric>\d{5,8})'
    r')(?![A-Z0-9])', re.IGNORECASE)
_EMPTY_VALUES = {'', '-', '—', 'n/a', 'na', 'none', 'not recorded', 'not stated',
                 'not specified', 'not available', 'contact trafalgar'}


def is_report_field(label: str) -> bool:
    """Recognize report numbers/references, including source/page label suffixes."""
    return isinstance(label, str) and bool(_REPORT_LABEL.match(label.strip()))


def _canonical(match: re.Match) -> str:
    text = re.sub(r'\s+', '', match.group()).upper()
    kind = match.lastgroup
    if kind == 'standard':
        parts = re.fullmatch(r'([A-Z]+)-?(.*)', text)
        return parts[1] + ' ' + parts[2]
    if kind == 'rtl':
        return 'RTL ' + text[3:5] + ' ' + text[5:]
    if kind == 'tr_number':
        return re.sub(r'\s+', ' ', match.group().strip()).upper().replace('TR ', 'TR')
    if kind == 'composite':
        return text.replace('FTR', ' FTR', 1)
    return text


def report_number_values(values: Iterable[str] | str) -> list[str]:
    """Return first-seen, unique actual report IDs; reject unparsed source data.

    Table, page, clause and specimen locators are not report identifiers. Numeric
    suffixes within recognized identifiers, including assessment revisions, stay
    intact. FSR and SFR remain different source prefixes; neither is corrected.
    """
    if isinstance(values, str):
        values = [values]
    result = []
    seen = set()
    for original in values:
        if not isinstance(original, str):
            raise TypeError('Report values must be source strings.')
        text = re.sub(r'\s+', ' ', original).strip()
        if text.casefold() in _EMPTY_VALUES:
            continue
        text = _LOCATOR.sub(' ', text)
        text = _DATE.sub(' ', text)
        text = _DATE_LABEL.sub(' ', text)
        text = _LABEL_WORDS.sub(' ', text)
        matches = list(_REPORT.finditer(text))
        remainder = _REPORT.sub(' ', text)
        if matches:
            remainder = _DOTTED_LOCATOR.sub(' ', remainder)
        remainder = re.sub(r'\b(?:and|or)\b', ' ', remainder, flags=re.IGNORECASE)
        remainder = re.sub(r'[\s:;,#&/()\[\]{}.—–-]+', '', remainder)
        if remainder:
            raise ValueError(f'Unrecognized report identifier or annotation: {original!r}')
        for match in matches:
            value = _canonical(match)
            if value not in seen:
                result.append(value)
                seen.add(value)
    return result


def normalize_report_numbers(values: Iterable[str] | str) -> str:
    """Consolidate the supplied report fields into one presentation value."""
    return '; '.join(report_number_values(values))
