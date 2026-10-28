"""Shared classification choices, independent of optional installed records.

These are existing descriptive vocabularies, never pricing routes or evidence
that a system is suitable. Installed observed options retain their exact values
and group labels; an empty catalogue still offers the approved vocabulary.
"""
from copy import deepcopy

from .library_facets import CATEGORIES, FRLS
from .library_filter_groups import grouped_filter_options
from .library_opening_types import OPENING_TYPES
from .library_substrates import classification_substrate_options
from .penetration_calculator import MANUFACTURERS
from .technical_service_options import TECHNICAL_SERVICES

FACETS = (('report', 'Report'), ('substrate', 'Substrate'), ('orientation', 'Orientation'),
          ('manufacturer', 'Manufacturer'), ('type', 'Type'), ('category', 'Category'),
          ('services', 'Services'), ('frl', 'FRL'))


def classification_filters(observed=()):
    """One metadata contract for Libraries, editors and physical draft forms."""
    definitions = {entry['key']: entry for entry in observed}
    values = {'report': (), 'orientation': ('Horizontal', 'Vertical'),
              'manufacturer': MANUFACTURERS, 'type': OPENING_TYPES,
              'category': CATEGORIES, 'services': TECHNICAL_SERVICES, 'frl': FRLS}
    result = []
    for key, label in FACETS:
        entry = definitions.get(key) or (definitions.get('document') if key == 'report' else None)
        options = deepcopy(entry.get('options', [])) if entry else []
        if not options:
            options = (classification_substrate_options() if key == 'substrate' else
                       [{'value': value, 'label': value} for value in values[key]])
            options = grouped_filter_options(key, options)
        result.append({'key': key, 'label': label, 'options': options})
    return result
