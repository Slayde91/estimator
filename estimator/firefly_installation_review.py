"""Installation procedures from the installed, identified FIREFLY assessment editions."""
import re

from .technical_brand_presentation import manufacturer_names


_BATT_SHA = 'a61e53af7ad9d54fbec0302ddc90ee261248ac8e73d54504cef5319295722819'
_CORE_SHA = '8591513cd147a765901a9676e2b115e8ab9f52508c94096f886c4f0d4fcc4f08'
_INSTALLATION = 'Installation Details'
_WRAP = 'Service Wrap'
_LOCAL = 'Local Protection'
_ASSETS = ('table', 'tables', 'table_links', 'images')
_NO_WRAP = re.compile(r'\Anone\.?\s+(?=Pipe to be wrapped locally with grease proof paper)', re.I)
_WALL_EDGE = re.compile(
    r'\s*This service can be installed in wall constructions against Floors or ceilings\s*'
    r'\(see Table 21, Item 9 for 3 sided Penowrap installation and cable sizes/cable bundle dimensions\)\.?',
    re.I)
_WALL_EDGE_SCOPE = (
    'Wall installations against a floor or ceiling require a separately assessed three-sided wrap detail '
    'for PVC-insulated and sheathed copper power or communication cables.')
_PRODUCT_LOCATOR = re.compile(r'\s*\((?:FRF\s+\d+\s+)?Item\s+\d+\)', re.I)
_REFERENCE = re.compile(r'\b(?:tables?|figures?|figs?\.?|pages?)\s+\d', re.I)
_NUMBER = re.compile(r'(?<!\S)(\d{1,2}\.)(?=\s+[A-Z•])')
_NO_PROCEDURE = {'', 'none', 'none.', 'fireflymastic hp'}
_KNOWN_ISSUES = {
    'H115': 'The report calls for a 25 × 25 mm topside fillet. It names FIREFLYMastic HP but gives the '
            'product reference for FIREFLYMastic. Confirm the fillet sealant before using this detail.',
    'V115': 'The report calls for a 25 × 25 mm fillet on both sides. It names FIREFLYMastic HP but gives the '
            'product reference for FIREFLYMastic. Confirm the fillet sealant before using this detail.',
    'H127': 'The report specifies a nominal 10 mm annular gap and a full-depth seal. It names FIREFLYMastic HP '
            'but gives the product reference for FIREFLYMastic. Confirm the sealant before using this detail.',
    'H128(b)': 'The report specifies an underside FRF-100 collar and also describes using threaded rod to join '
              'two collars. Confirm the collar arrangement before using this detail.',
    'H151': 'The report has an unfinished note about the gap. Confirm any additional gap requirement '
            'for this configuration.',
}

# Shared source cells that split over a page boundary. Keep the two page
# positions in the provenance while displaying the procedure as plain text.
_CORE_FRF_100_MASONRY = (
    'Use a nominal 100 mm diameter opening for the maximum service size. Install a FIREFLY FRF-100 '
    'fire collar on each side and secure with four 75 mm masonry screws. Fill gaps around the services '
    'to the full depth of each collar with FIREFLYMastic HP.')
_CORE_CONTINUATIONS = {
    'V499A': (175, 176,
              'Use an 80 mm wide strip of FIREFLY Penowrap up to 2200 mm long. Staple two stacked '
              'layers of FIREFLYStrap to the reflective face. Coat the white face with FIREFLYMastic BG '
              'and insert the assembly in the annular gap around the service.\n\n'
              'Fit a FIREFLYBatt collar on each side, made from a strip 50 mm wide and up to 1100 mm long. '
              'Secure each collar with masonry screws and oversized penny washers. Fill the annular gap '
              'between the Penowrap and the collar through the wall with FIREFLY HP. Coat the cut collar '
              'edges and faces and the space between the service and collar with FIREFLYMastic BG.\n\n'
              'Wrap the service with FIREFLY Penowrap for 500 mm on each side. Overlap the wrap lengths '
              'by 100 mm. Fit stainless steel cable ties 50 mm from each end and at least four intermediate '
              'ties nominally 100 mm apart.'),
    'V506C': (179, 178,
              'Fit a FIREFLY FRF-150 fire collar on each side of the wall. Secure the collars using '
              'masonry fixings. Fill the gaps between the wall and the services and between the collars '
              'and the services with FIREFLY HP.'),
    'V539C': (192, 191,
              'Fill the blank hole, up to 40 mm in diameter, to the full depth with FIREFLY HP. '
              'For thicker substrates, apply FIREFLY HP 65 mm deep from each side. Finish flush on both sides.'),
    'V553B': (197, 196,
              'Use a nominal 75 mm diameter opening for the maximum service size. Fill the annular gap '
              'around the service with FIREFLY HP to full depth. For thicker substrates, apply FIREFLY HP '
              '65 mm deep from each side. Finish flush on both sides.'),
    'V558C': (200, 199,
              'Use a nominal 100 mm diameter opening for the maximum service size. Fit a FIREFLY FRF-100 '
              'fire collar on each side and secure with four 38 mm plasterboard screws. Fill gaps around '
              'the services to the full depth of each collar with FIREFLYMastic HP.'),
    'V559B': (201, 200, _CORE_FRF_100_MASONRY),
    'V559C': (201, 200, _CORE_FRF_100_MASONRY),
}
_CORE_SERVICE_SCOPE = {
    'V499A': ('Up to 10 DN32 Type B copper pipes with 32 mm nitrile lagging and up to 10 TPS cables, each '
              '2.5 mm² 2C+E. The assessed nitrile lagging range is 13–32 mm on DN20 copper pipe and 25–38 mm on '
              'copper pipe above DN20 up to DN32.'),
    'V506C': ('Up to 4 DN20 Type B copper pipes with 25 mm nitrile lagging, one Cat 6 cable, one 2.5 mm² '
              '2C+E TPS cable, one 0.22 mm² two-pair data cable and one 18 mm condensate pipe.'),
    'V553B': ('PEX-a pipe only. The nominal pipe sizes and maximum wall thicknesses are 16 mm × 2.2 mm, '
              '20 mm × 2.8 mm, 25 mm × 3.5 mm, 32 mm × 4.4 mm and 40 mm × 5.5 mm.'),
}
_CORE_MULTIPLE_SERVICE_SCOPE = (
    'Use only the listed service combinations. The services may occupy up to 80% of the cross-sectional '
    'area of the FIREFLY FRF-100 fire collar.')


def _source(record, document, sha, system, page=None):
    # The system ID may contain spaces and parentheses. Compare the literal
    # source identifier rather than matching a family prefix.
    return next((source for source in record.get('sources', [])
                 if source.get('document_id') == document and source.get('sha256') == sha
                 and (page is None or source.get('page') == page)
                 and f", {system}, PDF page {source.get('page')}" in source.get('label', '')), None)


def _plain(text):
    """Reflow the imported clauses while retaining every material and measurement."""
    text = _PRODUCT_LOCATOR.sub('', text)
    blocks = re.split(r'\n\s*\n', text.strip())
    result = []
    for block in blocks:
        # PDF soft line breaks carry no instruction boundaries. Explicitly
        # retain source bullets and step markers, including nested alternatives.
        line = ' '.join(block.split())
        line = _NUMBER.sub(r'\n\1', line)
        line = re.sub(r'\s*•\s*', '\n• ', line)
        line = re.sub(r'[ \t]+([.,)])', r'\1', line)
        result.append('\n'.join(part.strip() for part in line.strip().splitlines()).replace('with a using a', 'with a'))
    return '\n\n'.join(filter(None, result))


def _append_field(fields, label, value, **metadata):
    """Keep existing annotations and place additional ones near the report fields."""
    for index, field in enumerate(fields):
        if field['label'] == label:
            old = field.get('value', '')
            parts = old.split('\n\n') if old else []
            if value not in parts:
                parts.append(value)
            fields[index] = {**field, 'value': '\n\n'.join(parts), **metadata}
            return
    after = next((index for index, field in enumerate(fields)
                  if field['label'] in ('Source Options', 'Source Issues', 'Diagrams & Figures', 'Report Number')),
                 len(fields))
    fields.insert(after, {'label': label, 'value': value, **metadata})


def _batt_review(record, fields, by_label, system):
    if not _source(record, 'fas190235', _BATT_SHA, system):
        return fields
    protection = by_label.get(_LOCAL, {})
    service_wrap = by_label.get(_WRAP, {})
    local, wrap = (field.get('value', '') for field in (protection, service_wrap))
    if any(field.get(asset) for field in (protection, service_wrap) for asset in _ASSETS):
        return fields

    local_step = local.strip().casefold() not in _NO_PROCEDURE
    wrap_step = wrap.strip().casefold() not in _NO_PROCEDURE
    if system in _KNOWN_ISSUES:
        # The complete method remains unresolved. Keep the conflicting clause
        # in the retained source and make the qualification visible in exports.
        warning = 'Installation details are pending source clarification. ' + _KNOWN_ISSUES[system]
        if warning in by_label.get('Assessment Scope', {}).get('value', ''):
            return fields
        result = [field for field in fields if field is not protection]
        _append_field(result, 'Assessment Scope', warning)
        return result
    if not local_step and not wrap_step:
        return fields
    move_local, move_wrap = (local if local_step else ''), (wrap if wrap_step else '')
    if system == 'V110(b)':
        move_local = re.sub(r'(within\s+the\s+FIREFLYBatt),', r'\1),', move_local)
    flat_wrap = ' '.join(move_wrap.split())
    move_wrap_without_edge, edge = _WALL_EDGE.subn('', flat_wrap)
    if edge:
        move_wrap = move_wrap_without_edge
    before_seal = bool(_NO_WRAP.match(flat_wrap))
    if before_seal:
        move_wrap = _NO_WRAP.sub('', flat_wrap)
    procedure_parts = (move_wrap, move_local) if before_seal else (move_local, move_wrap)
    procedure = '\n\n'.join(filter(None, (_plain(part) for part in procedure_parts)))
    if not procedure or _REFERENCE.search(procedure):
        return fields

    result = [field for field in fields if not ((local_step and field is protection)
                                                 or (wrap_step and field is service_wrap and not before_seal))]
    if before_seal:
        index = result.index(service_wrap)
        result[index] = {**service_wrap, 'value': 'None'}
    source_labels = list(dict.fromkeys(label for field, move in ((protection, local_step), (service_wrap, wrap_step))
                                      if move for label in field.get('source_labels', [])))
    metadata = {'source_labels': source_labels} if source_labels else {}
    _append_field(result, _INSTALLATION, procedure, **metadata)
    if edge:
        _append_field(result, 'Assessment Scope', _WALL_EDGE_SCOPE)
    return result


def firefly_reviewed_installation_fields(record, fields):
    """Fill missing FIREFLY instructions using exact source-bound procedure text."""
    if 'firefly' not in manufacturer_names(record):
        return fields
    by_label = {field['label']: field for field in fields}
    installation = by_label.get(_INSTALLATION, {})
    if len(by_label) != len(fields) or installation.get('value', '').strip() or any(
            installation.get(asset) for asset in _ASSETS):
        return fields
    system = by_label.get('ID', {}).get('value', '').strip()
    if system in _CORE_CONTINUATIONS:
        selected, evidence, instructions = _CORE_CONTINUATIONS[system]
        if _source(record, 'fas190236', _CORE_SHA, system, selected):
            result = list(fields)
            _append_field(result, _INSTALLATION, instructions, source_labels=[
                f'FAS190236 RIR1.25A · {system} · installation continuation on PDF page {evidence}'])
            scope = _CORE_SERVICE_SCOPE.get(system)
            if system in ('V558C', 'V559B', 'V559C'):
                scope = _CORE_MULTIPLE_SERVICE_SCOPE
            if scope:
                _append_field(result, 'Assessment Scope', scope)
            return result
    return _batt_review(record, fields, by_label, system)
