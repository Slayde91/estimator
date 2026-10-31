"""Row-specific assessment captions, separate from calculation and source bytes.

Only reviewed assessment URLs are eligible. Product manuals are never promoted
to report authority. A missing report stays explicit instead of being guessed.
"""

from functools import lru_cache
import json
import re

from .catalog import ROOT
from .library_report_links import report_href


_PUBLIC = {
    'FC18580-01-01': ('steel_intumescent', 'Nullifire SC902 — FC18580-01-01, 20 March 2024'),
    'FAR4853 Issue 3': ('steel_vermiculite', 'MONOKOTE solid steel assessment FAR4853'),
    'FAR4856 Issue 2': ('steel_vermiculite', 'MONOKOTE hollow steel assessment FAR4856'),
    'FAS230196 RIR3.2': ('ductwork', 'CAFCO 300 horizontal and vertical duct assessment FAS230196 RIR3.2'),
    'FC17299-01-1': ('ductwork', 'FyreWrap external-fire duct assessment FC17299'),
    'FCO3226 Rev F': ('ductwork', 'FyreWrap internal-fire duct assessment FCO3226'),
    'FAS200445 R2.0': ('steel_board', 'COREX structural steel assessment FAS200445 R2.0'),
    'FC15555-01-03': ('steel_board', 'PROMATECT 100 and 250 — FC15555-01-03, 13 August 2025'),
    'FAS230021 RIR1.4': ('steel_board', 'PROMATECT-XS — FAS230021 RIR1.4, 20 February 2025'),
    'FC13107-01-05': ('steel_vermiculite', 'CAFCO 300 steel assessment FC13107-01-05, 8 July 2025'),
    'FC21286-01-01': ('steel_vermiculite', 'MANDOLITE CP2 steel assessment FC21286-01-01, 22 December 2025'),
    'FAR3541 Issue 7': ('steel_vermiculite', 'FENDOLITE MII steel assessment FAR3541 Issue 7, 7 October 2025'),
    'FC15909-01-03': ('ductwork', 'MONOKOTE duct assessment FC15909-01-03, 24 February 2026'),
}
_KINDS = {'Fire assessment', 'Assessment report', 'Fire assessment — thickness authority'}


@lru_cache(maxsize=1)
def _links():
    sections = json.loads((ROOT / 'data' / 'calculator_documents.json').read_text(encoding='utf-8-sig'))['sections']
    return {label: next((document.get('url') for document in sections[section]
                       if document.get('title') == title and document.get('kind') in _KINDS), None)
            for label, (section, title) in _PUBLIC.items()}


def _references(labels):
    # Exact editions stay distinct: only a source evaluated under the reviewed
    # current report gets its URL. Historic captions are never silently relabelled.
    return [{'label': label, 'url': report_href(label, _links().get(label), user_authored=True)}
            for label in dict.fromkeys(labels)]


def schedule_report_references(calculator_id, engine, row):
    """Read the evaluated row under its caller's existing evaluation lock."""
    sheet = 'SCHEDULE' if calculator_id in {'steel_vermiculite', 'steel_intumescent'} else 'CALCULATOR'
    value = lambda column: engine.value(sheet, f'{column}{row}')
    product = str(value('B' if sheet == 'SCHEDULE' else 'C') or '')
    if calculator_id == 'steel_intumescent':
        product = product or str(engine.value('SETTINGS', 'D6') or '')
    source = str(value('X' if sheet == 'SCHEDULE' else 'AQ' if calculator_id == 'ductwork' else 'AT') or '')
    if not product or not source:
        return []
    if calculator_id == 'ductwork' and product.casefold() == 'fyrewrap':
        direction = str(value('H') or '').casefold()
        if direction == 'internal':
            return _references(['FCO3226 Rev F'])
        if direction in {'external', 'stair pressurisation', 'other pressurisation'}:
            return _references(['FC17299-01-1'])
        if direction == 'both':
            return _references(['FC17299-01-1', 'FCO3226 Rev F'])
        return []
    # The MONOKOTE workbook's open-section tables were reviewed against FAR4853;
    # its closed-section route is replaced by the reviewed FAR4856 dataset.
    if calculator_id == 'steel_vermiculite' and product.casefold() in {'monokote mk-6 hy', 'monokote z106'}:
        return _references(['FAR4856 Issue 2' if str(value('C') or '').casefold() == 'hollow - 4 sides' else 'FAR4853 Issue 3'])
    if calculator_id == 'steel_board' and product.casefold() == 'trafalgar corex':
        # COREX section/general tables and stock rules share the explicitly
        # recorded assessment in SETTINGS D23:D31. AT retains the page locator.
        return _references(['FAS200445 R2.0'])
    if (calculator_id == 'steel_board' and product.casefold() == 'promatect-xs'
            and source.casefold().startswith('xs p')
            and str(engine.value('PRODUCTS', 'G9') or '').strip() == 'FAS230021'):
        # The public RIR identifies its underlying FAS230021 R1.4 assessment.
        # Keep the source-family guard; this link does not expand lookup scope.
        return _references(['FAS230021 RIR1.4'])
    compact = re.sub(r'[^a-z0-9]', '', source.casefold())
    candidates = [
        ('fc185800101', 'FC18580-01-01'), ('fc2057101c1', 'FC20571/01/C1'),
        ('fc21221011c1', 'FC21221-01-1-C1'), ('fc21278011', 'FC21278-01-1'),
        ('far3541i6', 'FAR3541 Issue 6'), ('far3541issue6', 'FAR3541 Issue 6'),
        ('far3541issue7', 'FAR3541 Issue 7'),
        ('fc131070105', 'FC13107-01-05'), ('fc212860101', 'FC21286-01-01'),
        ('fc159090103', 'FC15909-01-03'),
        ('fc15909012', 'FC15909-01-2'), ('fas230196rir32', 'FAS230196 RIR3.2'),
        ('fc155550103', 'FC15555-01-03'), ('fas200445r20', 'FAS200445 R2.0'),
    ]
    labels = [label for token, label in candidates if token in compact]
    return _references(labels or ['Assessment not identified in source'])


def report_reference_text(references, *, urls=False):
    return ' | '.join(reference['label'] + (f" ({reference['url']})" if urls and reference.get('url') else '')
                      for reference in references)
