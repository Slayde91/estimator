"""Reviewed application inputs, kept separate from immutable Excel sources.

Only unsaved calculator states and explicit UI reset/apply actions use these
defaults. Existing saves and callers supplying explicit inputs are unchanged.
"""

from copy import deepcopy
from functools import lru_cache
import json

from .catalog import ROOT


@lru_cache(maxsize=1)
def _review():
    return json.loads((ROOT / 'data' / 'vermiculite_yield_defaults.json').read_text(encoding='utf-8'))


def yield_review(calculator_id):
    return deepcopy(_review()) if calculator_id == 'steel_vermiculite' else None


def default_calculator_inputs(calculator_id):
    if calculator_id != 'steel_vermiculite':
        return {}
    settings = {}
    for product in _review()['products']:
        for field, address in product['cells'].items():
            settings[address] = product[field]
    return {'SETTINGS': settings}
