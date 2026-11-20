"""Separate documented Firefly installation steps from the wrap specification."""
import re

from .technical_brand_presentation import manufacturer_names


_REPORT_SHA256 = 'a61e53af7ad9d54fbec0302ddc90ee261248ac8e73d54504cef5319295722819'
_ALTERNATIVES = re.compile(
    r'1\. Install 1 layer of FIREFLY\s*Penowrap '
    r'• for 600 mm, on the topside only of the FIREFLYBatt seal, butting up to the face of the FIREFLYBatt, or, '
    r'• for 300 mm, on each side of the FIREFLYBatt seal, butting up to the face of the FIREFLYBatt 2\. ')
_EDGE_LENGTH = re.compile(
    r'close to edge of the aperture provided that a 50 mm fillet of FIREFLYMastic is provided .*?'
    r'length of the FIREFLYPenowrap is increased to 600 mm on the topside of the FIREFLYBatt seal')
_SINGLE_LENGTH = re.compile(
    r'1\. Install 1 layer of FIREFLY\s*Penowrap for (\d+(?:\.\d+)?) mm,? on '
    r'(each side|the top\s*side only) of the FIREFLYBatt seal, butting up to the face of the FIREFLYBatt\. '
    r'2\. Secure the FIREFLY\s*Penowrap using stainless steel cable ties, nom\. 50 mm from each end and '
    r'at nom\. 100 mm centres(?:\.|, and/or, 3\. Seal the FIREFLY\s*Penowrap to the FIREFLYBatt using FIREFLYMastic\.)')
_INSTALLATION = 'Installation Details'
_WRAP = 'Service Wrap'


def _summary(instructions):
    text = ' '.join(instructions.split())
    if _ALTERNATIVES.match(text):
        result = '300 mm both sides or 600 mm topside only'
        if _EDGE_LENGTH.search(text):
            return result + '. For installations close to the edge, use 600 mm topside only.'
        return result
    match = _SINGLE_LENGTH.fullmatch(text)
    if match:
        length, side = match.groups()
        placement = 'both sides' if side == 'each side' else 'topside only'
        return f'{length} mm {placement}'
    return ''


def firefly_wrap_fields(record, fields):
    """Keep full source procedures and shorten only proven wrap specifications."""
    if 'firefly' not in manufacturer_names(record) or not any(
            source.get('document_id') == 'fas190235' and source.get('sha256') == _REPORT_SHA256
            for source in record.get('sources', [])):
        return fields
    wraps = [field for field in fields if field['label'] == _WRAP]
    installations = [field for field in fields if field['label'] == _INSTALLATION]
    if len(wraps) != 1 or len(installations) > 1:
        return fields
    wrap = wraps[0]
    if any(wrap.get(key) for key in ('table', 'tables', 'table_links', 'images')):
        return fields
    instructions = wrap.get('value', '')
    summary = _summary(instructions)
    if not summary:
        return fields
    installation = installations[0] if installations else None
    result = []
    for field in fields:
        if field is wrap:
            result.append({**wrap, 'value': summary})
        elif field is installation:
            current = field.get('value', '')
            value = current if instructions in current else '\n\n'.join(filter(None, (current, instructions)))
            result.append({**field, 'value': value})
        else:
            result.append(field)
    if installation is None:
        after = next((index for index, field in enumerate(result)
                      if field['label'] in ('Source Options', 'Source Issues', 'Diagrams & Figures', 'Report Number')),
                     len(result))
        result.insert(after, {'label': _INSTALLATION, 'value': instructions})
    return result
