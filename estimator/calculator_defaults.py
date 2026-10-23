"""Reviewed application inputs, kept separate from immutable Excel sources.

Only unsaved calculator states and explicit UI reset/apply actions use these
defaults. Existing saves and callers supplying explicit inputs are unchanged.
"""

from copy import deepcopy
from functools import lru_cache
import json

from .catalog import ROOT


# Application-only settings; the imported workbook has no method selectors.
MONOKOTE_APPLICATION_BASIS_CELLS = {'MONOKOTE MK-6 HY': 'D569', 'MONOKOTE Z106': 'D570'}
MONOKOTE_APPLICATION_BASES = ('Injected', 'Uninjected')


@lru_cache(maxsize=1)
def _review():
    return json.loads((ROOT / 'data' / 'vermiculite_yield_defaults.json').read_text(encoding='utf-8'))


def yield_review(calculator_id):
    return deepcopy(_review()) if calculator_id == 'steel_vermiculite' else None


def default_calculator_inputs(calculator_id):
    if calculator_id == 'steel_intumescent':
        from .intumescent import SETTING_DEFAULTS
        return {'SETTINGS': dict(SETTING_DEFAULTS)}
    if calculator_id != 'steel_vermiculite':
        return {}
    settings = {}
    for product in _review()['products']:
        for field, address in product['cells'].items():
            settings[address] = product[field]
    settings.update({address: 'Uninjected' for address in MONOKOTE_APPLICATION_BASIS_CELLS.values()})
    return {'SETTINGS': settings}
