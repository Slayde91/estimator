"""Read-only Quote choices from the saved, effective Pricing Library."""
import math

from .catalog import ValidationError, effective_catalog, product_service_name


MAX_RESULTS = 30
QUOTE_PRICE_LIMIT = 1_000_000_000


def _choice(identity, name, price):
    # Never invent a zero for unavailable pricing or clamp a price that the
    # existing Quote validator cannot represent. Canonical zero is valid.
    if (not isinstance(name, str) or not name.strip() or name.strip().casefold() in {'n/a', 'n / a'}
            or isinstance(price, bool) or not isinstance(price, (int, float))
            or not math.isfinite(price) or abs(price) > QUOTE_PRICE_LIMIT):
        return None
    return {'id': identity, 'name': name, 'description': name, 'unit_price': price}


def search_pricing(configuration, search=''):
    if not isinstance(search, str) or len(search) > 500:
        raise ValidationError('Search Pricing Library using up to 500 characters.')
    catalog = effective_catalog(configuration)
    inventory = {item['id']: item for item in catalog['inventory']}
    rates = [(group, rate) for group, rows in catalog['rate_groups'].items() for rate in rows]
    linked = {}
    for _, rate in rates:
        linked.setdefault(rate.get('inventory_id'), []).append(rate)
    choices, product_choices = [], {}

    def add(choice, record, uses=()):
        if choice is not None:
            searchable = [choice['name'], record.get('name', ''), record.get('sales_description', ''),
                          str(record.get('item_code', '')), record.get('manufacturer', '')]
            searchable.extend(value for rate in uses for value in (rate.get('name', ''), rate.get('display_name', '')))
            choices.append((choice, ' '.join(str(value) for value in searchable)))

    for identity, item in inventory.items():
        uses = linked.get(identity, [])
        choice = _choice('inventory:' + identity, product_service_name(item, uses), item.get('sales_price'))
        product_choices[identity] = choice
        add(choice, item, uses)
    for _, rate in rates:
        product = inventory.get(rate.get('inventory_id'))
        choice = _choice('rate:' + rate['id'], product_service_name(product, [rate]), rate.get('price'))
        source = product_choices.get(rate.get('inventory_id'))
        # Keep a linked service/rate when its label or effective selling price
        # differs. Identical uses of the same canonical product are one choice.
        if choice is not None and source is not None and all(choice[key] == source[key] for key in ('name', 'unit_price')):
            continue
        add(choice, {**(product or {}), **rate}, [rate])
    needle = ' '.join(search.split()).casefold()
    matching = [choice for choice, text in choices if needle in ' '.join(text.split()).casefold()]
    matching.sort(key=lambda item: (not item['name'].casefold().startswith(needle), item['name'].casefold(), item['id']))
    return {'items': matching[:MAX_RESULTS]}
