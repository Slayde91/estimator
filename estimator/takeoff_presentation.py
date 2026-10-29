"""Audited drawing presentation, independent of quantities and confirmations."""
from copy import deepcopy
from decimal import Decimal, ROUND_CEILING
import math

from .catalog import ValidationError
from .takeoff_model import (object_fields, identity, number, page_metadata, points,
                           validate_appearance, markup_appearance, item_digest)

# Exact RGB values from Construction_Plan_40_Colour_Legend (1).pdf,
# SHA-256 f74da6c069b462386983cf6594989e3c32403b41047712b8c5389389188ca126.
PALETTE = [
    ('Rose brown', '#6C4848'), ('Mustard yellow', '#C0B400'), ('Royal blue', '#0000E4'),
    ('Brick red', '#C06060'), ('Silver grey', '#A0A0A0'), ('Electric violet', '#A123FB'),
    ('Lime green', '#78CC0C'), ('Orange', '#D86000'), ('Sky blue', '#23B6FE'),
    ('Emerald green', '#00B46C'), ('Raspberry', '#A80048'), ('Lilac', '#D0A5F4'),
    ('Navy blue', '#0A4383'), ('Turquoise', '#00CCC0'), ('Sand', '#C7AD85'),
    ('Burnt sienna', '#732D05'), ('Hot pink', '#FC609C'), ('Red', '#CC0000'),
    ('Mauve', '#91798B'), ('Azure blue', '#0078CC'), ('Grass green', '#4B8B07'),
    ('Coral', '#FC9078'), ('Plum', '#6C246C'), ('Amber', '#FC9C18'),
    ('Ochre', '#A87800'), ('Jade green', '#1D7E5C'), ('Olive brown', '#634F1A'),
    ('Dusty pink', '#D8A8B4'), ('Cerise', '#CC249C'), ('Dusty teal', '#4D98A4'),
    ('Olive green', '#7D8060'), ('Charcoal', '#404040'), ('Forest green', '#245400'),
    ('Periwinkle', '#849CFC'), ('Magenta', '#FC48FC'), ('Slate violet', '#766DB9'),
    ('Sage green', '#A7BB91'), ('Taupe', '#9A7A65'), ('Petrol blue', '#236778'),
    ('Pine green', '#184B3E')]
COLOURS = ('stroke_color', 'fill_color', 'font_color')
CURRENT_PALETTE_VERSION = 2


def thickness_colour(value, calculator=None, *, palette_version=1):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        return None
    if palette_version >= 2 and calculator == 'steel_intumescent':
        if value > 10:
            return None
        # The native millimetre value is retained. Decimal comparisons keep a
        # value just above a quarter-mm boundary in the following 250 µm bin.
        index = int((Decimal(str(value)) / Decimal('.25')).to_integral_value(rounding=ROUND_CEILING)) - 1
        return PALETTE[index][1]
    # Positive halves round up, matching Math.round; exact values remain native.
    rounded = max(1, math.floor(value + .5))
    return PALETTE[min(39, (rounded - 1) // 2)][1]


def thickness_value(records, calculator):
    key = {'steel_vermiculite': 'estimating_thickness_mm', 'steel_intumescent': 'intumescent_thickness_mm', 'steel_board': 'total_thickness_mm',
           'ductwork': 'duct_thickness_mm'}.get(calculator)
    result = next((row for row in records if row['calculator_id'] == calculator and row['status'] == 'Current'), {})
    value = result.get(key)
    return value if type(value) in (int, float) and math.isfinite(value) and value > 0 else None


def dft_micron_text(value, native_microns=None):
    """Convert display units only; prefer the calculator's exact native DFT."""
    microns = (Decimal(str(native_microns)) if type(native_microns) in (int, float)
               and math.isfinite(native_microns) and native_microns > 0 else Decimal(str(value)) * 1000)
    text = format(microns, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def thickness_label(value, calculator, *, native_microns=None, palette_version=2):
    if value is None:
        return 'Thickness missing/unavailable'
    if calculator == 'steel_intumescent':
        text = dft_micron_text(value, native_microns) + ' µm'
        if palette_version >= 2 and value > 10:
            text += ' (outside 0–10,000 µm colour scale)'
        return text
    return f'{value:g} mm'


def validate_presentation(snapshot):
    state = snapshot.get('drawing_presentation')
    if state is None:
        return
    object_fields(state, {'version', 'colour_modes', 'legends'}, 'Drawing presentation', {'version', 'colour_modes', 'legends'})
    if type(state['version']) is not int or state['version'] != 1:
        raise ValidationError('Unsupported drawing presentation version.')
    if not isinstance(state['colour_modes'], list) or len(state['colour_modes']) > 100:
        raise ValidationError('Too many document colour modes.')
    seen = set(); retained_count = 0
    for mode in state['colour_modes']:
        object_fields(mode, {'document_id', 'calculator_id', 'originals', 'palette_version'}, 'Thickness colour mode', {'document_id', 'calculator_id', 'originals'})
        if type(mode.get('palette_version', 1)) is not int or mode.get('palette_version', 1) not in (1, 2):
            raise ValidationError('Unsupported thickness colour palette version.')
        page_metadata(snapshot, mode['document_id'], 1)
        if mode['document_id'] in seen or mode['calculator_id'] not in ('steel_vermiculite', 'steel_intumescent', 'steel_board'):
            raise ValidationError('Use one Steel colour mode per source document.')
        seen.add(mode['document_id'])
        if not isinstance(mode['originals'], list) or len(mode['originals']) > 10000:
            raise ValidationError('Too many retained markup colours.')
        retained_count += len(mode['originals'])
        if retained_count > 10000:
            raise ValidationError('Too many retained markup colours across documents.')
        ids = set()
        for row in mode['originals']:
            keys = {'item_id', 'item_version', 'colours', 'thickness_mm', 'colour', 'item_digest', 'calculator_id'}
            object_fields(row, keys, 'Original markup colours', keys)
            number(row['item_version'], 'Markup version', positive=True, integer=True)
            if row['calculator_id'] not in ('steel_vermiculite', 'steel_intumescent', 'steel_board'):
                raise ValidationError('Retain the native Steel thickness source.')
            identity(row['item_id']); validate_appearance(row['colours'])
            if set(row['colours']) != set(COLOURS) or row['item_id'] in ids:
                raise ValidationError('Retain one complete original colour set per markup.')
            ids.add(row['item_id'])
            if row['thickness_mm'] is not None:
                number(row['thickness_mm'], 'Thickness', positive=True)
            if row['colour'] != thickness_colour(row['thickness_mm'], row['calculator_id'], palette_version=mode.get('palette_version', 1)):
                raise ValidationError('The thickness colour does not match the reference palette.')
            if not isinstance(row['item_digest'], str) or len(row['item_digest']) != 64 or any(value not in '0123456789abcdef' for value in row['item_digest']):
                raise ValidationError('Retain the original markup fingerprint.')
    if not isinstance(state['legends'], list) or len(state['legends']) > 2000:
        raise ValidationError('Too many drawing legends.')
    seen = set(); ids = set()
    for legend in state['legends']:
        validate_legend(snapshot, legend)
        key = (legend['document_id'], legend['page'], legend['mode'])
        if key in seen or legend['id'] in ids:
            raise ValidationError('Use one legend per drawing page and mode.')
        seen.add(key); ids.add(legend['id'])


def validate_legend(snapshot, legend):
    keys = {'id', 'mode', 'document_id', 'page', 'point', 'width', 'height', 'visible', 'appearance'}
    object_fields(legend, keys, 'Drawing legend', keys)
    identity(legend['id']); _, page = page_metadata(snapshot, legend['document_id'], legend['page'])
    if legend['mode'] not in ('steel', 'duct') or type(legend['visible']) is not bool:
        raise ValidationError('Choose a Steel or Duct legend and explicit visibility.')
    points([legend['point']], 'Legend anchor', page, 1, 1)
    for key in ('width', 'height'):
        number(legend[key], 'Legend ' + key, positive=True)
        if not 20 <= legend[key] <= max(page['width'], page['height']) * 2:
            raise ValidationError('Keep the legend size within drawing limits.')
    validate_appearance(legend['appearance'])


def apply_presentation(snapshot, request, linked=None):
    state = snapshot.setdefault('drawing_presentation', {'version': 1, 'colour_modes': [], 'legends': []})
    if request['op'] == 'set_legend':
        legend = deepcopy(request['legend']); validate_legend(snapshot, legend)
        old = next((value for value in state['legends'] if value['id'] == legend['id']), None)
        if old:
            if any(old[key] != legend[key] for key in ('mode', 'document_id', 'page')):
                raise ValidationError('A legend retains its original document and mode.')
            state['legends'].remove(old)
        state['legends'].append(legend)
        return
    document_id = request['document_id']; page_metadata(snapshot, document_id, 1)
    active = next((mode for mode in state['colour_modes'] if mode['document_id'] == document_id), None)
    if active:
        originals = {row['item_id']: row for row in active['originals']}
        for item in snapshot['items']:
            if item['id'] in originals:
                item.setdefault('appearance', {}).update(originals[item['id']]['colours'])
        state['colour_modes'].remove(active)
        return
    calculator = request['calculator_id']
    if calculator not in ('steel_vermiculite', 'steel_intumescent', 'steel_board'):
        raise ValidationError('Thickness colours require a Steel calculator.')
    rows = []
    for item in snapshot['items']:
        if item['mode'] != 'steel' or not item['geometry'] or item['geometry']['document_id'] != document_id:
            continue
        if item['geometry'].get('kind', 'polyline') not in ('polyline', 'count', 'count-only'):
            continue
        appearance = markup_appearance(item)
        records = (linked or {}).get(item['id'], [])
        native = next((key for key in (calculator, *('steel_board', 'steel_vermiculite', 'steel_intumescent')) if thickness_value(records, key) is not None), calculator)
        value = thickness_value(records, native)
        rows.append({'item_id': item['id'], 'item_version': item['version'], 'colours': {key: appearance.get(key, appearance['stroke_color']) for key in COLOURS},
                     'thickness_mm': value, 'colour': thickness_colour(value, native, palette_version=CURRENT_PALETTE_VERSION), 'item_digest': item_digest(item, snapshot), 'calculator_id': native})
    if not rows:
        raise ValidationError('The selected document has no Steel Length or Count markups.')
    state['colour_modes'].append({'document_id': document_id, 'calculator_id': calculator,
                                 'palette_version': CURRENT_PALETTE_VERSION, 'originals': rows})


def effective_appearance(snapshot, item, linked=None):
    appearance = markup_appearance(item)
    mode = next((value for value in snapshot.get('drawing_presentation', {}).get('colour_modes', [])
                 if item.get('geometry') and value['document_id'] == item['geometry']['document_id'] and item['mode'] == 'steel'), None)
    if mode:
        original = next((value for value in mode['originals'] if value['item_id'] == item['id']), None)
        if original and original['colour'] and original['item_digest'] == item_digest(item, snapshot):
            current = thickness_value((linked or {}).get(item['id'], []), original['calculator_id'])
            if current == original['thickness_mm']:
                appearance.update({key: original['colour'] for key in COLOURS})
    return appearance


def legend_rows(snapshot, legend, results, linked, *, viewer=False, calculator_id=None):
    rows = []
    for item in snapshot['items']:
        geometry = item.get('geometry')
        if item['mode'] != legend['mode'] or not geometry or geometry['document_id'] != legend['document_id'] or geometry['page'] != legend['page']:
            continue
        field = item['fields']; records = linked.get(item['id'], [])
        mode = next((mode for mode in snapshot.get('drawing_presentation', {}).get('colour_modes', []) if mode['document_id'] == legend['document_id']), None)
        original = next((row for row in mode['originals'] if row['item_id'] == item['id']), None) if mode else None
        calculator = 'ductwork' if item['mode'] == 'duct' else next((value['calculator_id'] for value in snapshot.get('drawing_presentation', {}).get('colour_modes', []) if value['document_id'] == legend['document_id']), None)
        if viewer and calculator_id:
            calculator = calculator_id
        if not calculator:
            calculator = next((value['calculator_id'] for value in records if value['status'] == 'Current'), 'steel_vermiculite')
        calculator = original['calculator_id'] if original else calculator
        thickness = thickness_value(records, calculator)
        if item['mode'] == 'steel' and thickness is None and original is None:
            for key in ('steel_vermiculite', 'steel_board', 'steel_intumescent'):
                thickness = thickness_value(records, key)
                if thickness is not None:
                    calculator = key
                    break
        record = next((row for row in records if row['calculator_id'] == calculator and row['status'] == 'Current'), {})
        label = thickness_label(thickness, calculator, native_microns=record.get('intumescent_dft_um'),
                                palette_version=mode.get('palette_version', 1) if mode else CURRENT_PALETTE_VERSION)
        colour = effective_appearance(snapshot, item, linked)['stroke_color']
        description = field.get('mark') or item['id'][:8]
        if item['mode'] == 'steel':
            description += ' | ' + (field.get('section') or 'Section missing')
            if item['quantity'] > 1:
                description += f" | {item['quantity']:g} members"
        else:
            description += f" | {field.get('width_mm', '?')} x {field.get('height_mm', '?')} mm"
            total = results.get(item['id'], {}).get('total_length_m')
            description += f" | {total:g} m" if total is not None else ' | Length missing'
        description += ' | ' + label
        if viewer:
            from .takeoff_physical_markers import _number
            separator = ' · '
            description = field.get('mark') or item['id'][:8]
            if item['mode'] == 'steel':
                description += separator + (field.get('section') or 'Section missing')
                if item['quantity'] > 1: description += separator + _number(item['quantity']) + ' members'
            else:
                width, height = field.get('width_mm'), field.get('height_mm')
                size = 'WxH missing' if width is None and height is None else _number(width) + ' x ' + _number(height)
                total = results.get(item['id'], {}).get('total_length_m')
                from decimal import Decimal, localcontext, ROUND_HALF_UP
                if total is None: length = '—'
                else:
                    number = Decimal(str(total))
                    with localcontext() as context:
                        context.prec = max(28, number.adjusted()+8)
                        length = format(number.quantize(Decimal('.01'), rounding=ROUND_HALF_UP), ',f')
                description += separator + size + ' mm' + separator + length + ' m'
            description += separator + (label if calculator == 'steel_intumescent' or thickness is None else _number(thickness) + ' mm')
        rows.append({'colour': colour, 'text': description})
    return rows
