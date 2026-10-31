"""Known material subtotals for PDF display; retained calculation orders stay intact."""
from math import ceil
from .report import _numeric

QUANTITY_COLUMNS = {
    'steel_vermiculite': set('CDEGH'),
    'steel_intumescent': set('BCDEGH'),
    'steel_board': set('EFGHIJ') | {'NET_STEEL'},
    'ductwork': set('CDEFGHIJ'),
}


def _product(value):
    return ' '.join(str(value or '').casefold().split())


def mark_incomplete_quantities(data):
    """Annotate only the isolated public PDF projection, never an engine/draft."""
    column = 'B' if data['id'] in {'steel_vermiculite', 'steel_intumescent'} else 'C'
    pending, complete, unassigned = set(), set(), False
    for row in data['rows']:
        product = _product(row['values'].get(column))
        if row['complete']:
            complete.add(product)
        elif product:
            pending.add(product)
        else:
            unassigned = True
    for summary in data['summaries']:
        for item in summary['rows']:
            values = item['values']; product = _product(values.get('A'))
            matches = lambda name: product == name or product.startswith(name + ' ')
            incomplete = (unassigned or any(matches(name) for name in pending)
                          or 'INCOMPLETE' in str(values.get('I', '')).upper())
            item['quantity_incomplete'] = incomplete
            item['available_quantities'] = {}
            # Use the existing pooled net demand, waste and whole-unit rule.
            # Never estimate missing thickness, yields, stock or pack settings.
            if (incomplete and data['id'] in {'steel_vermiculite', 'steel_intumescent'}
                    and any(matches(name) for name in complete) and not _numeric(values.get('G'))
                    and _numeric(values.get('E')) and values['E'] >= 0
                    and _numeric(values.get('F')) and 0 <= values['F'] <= 1):
                if data['id'] == 'steel_intumescent' and not (
                        _numeric(item.get('quantity_pack_litres')) and item['quantity_pack_litres'] > 0):
                    continue
                whole = ceil(values['E'] * (1 + values['F']))
                item['available_quantities']['G'] = whole
                if data['id'] == 'steel_intumescent':
                    item['available_quantities']['H'] = whole * item['quantity_pack_litres']
