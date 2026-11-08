"""Bounded progress/claim percentages over an immutable issued Quote snapshot."""
from copy import deepcopy
from decimal import Decimal
from hashlib import sha256
import json
import re

from .catalog import ValidationError

LINE_KEYS = ('estimate_id', 'description', 'quantity', 'unit_price', 'size', 'comments')
PERCENT_KEYS = ('completed_percent', 'claimed_percent')


def _encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def template(project_id, quote_id, reference, lines):
    source = {'project_id':project_id, 'quote_id':quote_id, 'quote_reference':reference,
              'rows':[{key:line.get(key, '') for key in LINE_KEYS} for line in lines]}
    source_hash = sha256(_encoded(source)).hexdigest()
    return {**{key:source[key] for key in ('project_id','quote_id','quote_reference')}, 'source_hash':source_hash,
            'rows':[{**row, 'line_id':sha256((source_hash+':'+str(index)).encode()).hexdigest(),
                     'completed_percent':'', 'claimed_percent':'', 'notes':''} for index,row in enumerate(source['rows'])]}


def percentage(value):
    from .commercial_documents import _number
    if value == '':
        return ''
    try:
        number = _number(value, 'Percentage', 1)
        if Decimal(number) > 100:
            raise ValueError
    except (ValidationError, ValueError) as error:
        raise ValidationError('Enter a percentage from 1 to 100, or leave it blank.') from error
    return number


def validate(value):
    from .commercial_documents import _identity, _number, _text
    from .document_numbers import valid_reference
    if not isinstance(value, dict) or set(value) != {'project_id','quote_id','quote_reference','source_hash','rows'}:
        raise ValidationError('Work tracking uses an unsupported format.')
    project, quote = _identity(value['project_id']), _identity(value['quote_id'])
    reference = _text(value['quote_reference'], 'Quote reference', 100)
    if not valid_reference(reference) or not isinstance(value['rows'], list) or len(value['rows']) > 500:
        raise ValidationError('Choose the issued Quote rows for this Work Order.')
    lines, percentages, notes, ids = [], [], [], []
    for row in value['rows']:
        if not isinstance(row, dict) or set(row) - {'notes'} != {*LINE_KEYS, *PERCENT_KEYS, 'line_id'}:
            raise ValidationError('Work tracking rows contain unsupported fields.')
        if not isinstance(row['line_id'], str) or not re.fullmatch('[0-9a-f]{64}', row['line_id']):
            raise ValidationError('Work tracking row identities are invalid.')
        lines.append({'estimate_id':_text(row['estimate_id'],'Estimate identity',100),
                      'description':_text(row['description'],'Description',6000),
                      'quantity':_number(row['quantity'],'Quantity'),
                      'unit_price':_number(row['unit_price'],'Unit price',-1000000000),
                      'size':_text(row['size'],'Size',1000), 'comments':_text(row['comments'],'Comments',2000)})
        percentages.append({key:percentage(row[key]) for key in PERCENT_KEYS})
        notes.append(_text(row.get('notes', ''), 'Notes', 2000))
        ids.append(row['line_id'])
    result = template(project, quote, reference, lines)
    if value['source_hash'] != result['source_hash'] or ids != [row['line_id'] for row in result['rows']]:
        raise ValidationError('The issued Quote row snapshot changed. Reopen this Work Order.')
    for row, amounts, note in zip(result['rows'], percentages, notes):
        row.update(amounts, notes=note)
    return result


def baseline(value):
    result = deepcopy(value)
    for row in result['rows']:
        row.update(dict.fromkeys(PERCENT_KEYS, ''))
        row['notes'] = ''
    return result


def has_completion(value):
    return bool(value and any(row['completed_percent'] and Decimal(row['completed_percent']) > 0 for row in value['rows']))
