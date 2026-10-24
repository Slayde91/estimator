"""Discovery/display vocabulary; never rewrite calculator or physical inputs."""
from .library_facets import CATEGORIES, SERVICES
from .library_opening_types import OPENING_TYPES


CATEGORY_ONLY_SERVICES = frozenset(('Access Panel', 'Blank Seal', 'Linear Joints',
                                  'Movement Joints', 'Structural Steel', 'Structural Timber'))


def _text(value):
    return '' if value is None else str(value).strip()


def canonical_opening_type(value):
    text = _text(value)
    return {'core hole': OPENING_TYPES[0], 'oversized': OPENING_TYPES[1],
            'oversized core hole': OPENING_TYPES[1]}.get(text.casefold(), text)


def category_service(category, service):
    """Project explicit historical category tokens without inferring a system."""
    category, service = _text(category), _text(service)
    moved = {value.casefold(): value for value in CATEGORY_ONLY_SERVICES}
    if service.casefold() in moved:
        return moved[service.casefold()], 'N/A'
    category = {value.casefold(): value for value in CATEGORIES}.get(category.casefold(), category)
    if not service and category in CATEGORY_ONLY_SERVICES:
        service = 'N/A'
    service = {'junction box': 'Conduits', 'conduit': 'Conduits', 'conduits': 'Conduits',
               'n/a': 'N/A'}.get(service.casefold(), service)
    return category, service


def display_details(inputs):
    result = dict(inputs)
    result['J'], result['K'] = category_service(inputs.get('J'), inputs.get('K'))
    result['L'] = canonical_opening_type(inputs.get('L'))
    return result


def is_blank_seal(inputs):
    """Keep old seal quantity semantics and support explicit new N/A Services."""
    service = _text(inputs.get('K'))
    return service == 'Blank Seal' or (service == 'N/A' and _text(inputs.get('J')) == 'Blank Seal')
