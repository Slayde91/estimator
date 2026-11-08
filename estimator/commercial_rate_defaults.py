"""Versioned application defaults for the seven commercial Schedule of Rates.

These are future-document defaults, not calculator prices or document snapshots.
Only explicit validated edits write this preference.
"""
from decimal import Decimal, InvalidOperation
import json

from .catalog import ValidationError
from .commercial_documents import CommercialConflict, RATE_DEFAULTS, validate_rate_schedule


PREFERENCE = 'commercial_rate_defaults'


def checked_rates(value, *, partial=False):
    if (not isinstance(value, dict) or not value or set(value) - set(RATE_DEFAULTS)
            or not partial and set(value) != set(RATE_DEFAULTS)):
        raise ValidationError('Include supported Schedule of Rates amounts only.')
    # Bound representation before the shared validator expands Decimal exponents.
    # No valid nonzero amount in the supported range needs a positive exponent >9.
    for amount in value.values():
        if isinstance(amount, bool) or not isinstance(amount, (str, int, float)) or len(str(amount)) > 64:
            raise ValidationError('Enter a supported Schedule of Rates amount.')
        try:
            number = Decimal(str(amount))
            if not number.is_finite() or not -6 <= number.as_tuple().exponent <= 9:
                raise ValueError
        except (InvalidOperation, ValueError) as error:
            raise ValidationError('Enter rates with at most six decimal places.') from error
    schedule = {'introduction': '', 'rates': {**RATE_DEFAULTS, **value},
                'acceptance': dict.fromkeys(('accepted_by', 'title', 'signature', 'date'), '')}
    normalized = validate_rate_schedule(schedule)['rates']
    return {key: normalized[key] for key in value}


class CommercialRateDefaults:
    def __init__(self, store):
        self.store = store

    @staticmethod
    def _read(db):
        row = db.execute('SELECT value FROM app_preferences WHERE key=?', (PREFERENCE,)).fetchone()
        if row is None:
            return {'version': 1, 'rates': dict(RATE_DEFAULTS)}
        try:
            value = json.loads(row[0])
            if (not isinstance(value, dict) or set(value) != {'version', 'rates'}
                    or type(value['version']) is not int or value['version'] < 1):
                raise ValueError
            return {'version': value['version'], 'rates': checked_rates(value['rates'])}
        except (ValueError, TypeError, KeyError, ValidationError) as error:
            raise ValidationError('Saved rate defaults could not be read. The stored values were retained.') from error

    def read(self):
        with self.store.connect() as db:
            return self._read(db)

    def save(self, request):
        if (not isinstance(request, dict) or set(request) != {'expected_version', 'rates'}
                or type(request['expected_version']) is not int or request['expected_version'] < 1):
            raise ValidationError('Include the rate changes and their current version only.')
        changes = checked_rates(request['rates'], partial=True)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current = self._read(db)
            # An identical lost-response retry never writes or clobbers another key.
            if all(current['rates'][key] == value for key, value in changes.items()):
                return current
            if request['expected_version'] != current['version']:
                raise CommercialConflict('Rate defaults changed in another window. Review your entries and retry.')
            saved = {'version': current['version'] + 1, 'rates': {**current['rates'], **changes}}
            db.execute('INSERT INTO app_preferences(key,value) VALUES(?,?) '
                       'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                       (PREFERENCE, json.dumps(saved, sort_keys=True, ensure_ascii=False)))
            return saved
