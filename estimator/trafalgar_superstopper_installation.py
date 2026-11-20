"""Source-verified SuperSTOPPER Circular procedures for exact AFS selector rows."""

from typing import NamedTuple

# Trafalgar's Dincel & AFS Style Concrete Walls technical manual (p. 4)
# allows the Circular system with permanent formwork retained using FC10266.
# The AFS Rediwall guide identifies RW156C as having a nominal 151 mm concrete
# core. FC10266-01-5, 24 October 2024, Table 16 and figures 24–26 and 34
# supply the service conditions, annular gap, wall installation and wrap.
# https://docadmin.tfire.com.au/exfiles/TFire_Technical_Manual_Dincel_%26_AFS_Style_concrete_walls_080724.pdf
# https://afsformwork.com.au/wp-content/uploads/2024/11/AFS-Rediwall-DCI-Guides-2024.pdf
_REPORT_URL = 'https://tfire.com.au/documents/Superstopper-orange-box-Range-Test-Report'
_CIRCULAR_MANUAL = 'Trafalgar SuperSTOPPER Circular Technical Manual'


class _Service(NamedTuple):
    name: str
    selector_size: str
    scope: str
    selector_wrap: str = '300mm'
    wrap_mm: int = 300
    loose_fill: bool = False

_SERVICES = {
    'trafalgar-selector-8582': _Service(
        'Pipes - Steel', 'Up to NB50', 'Uninsulated steel pipes up to NB50.'),
    'trafalgar-selector-8584': _Service(
        'Pipes - PEX', 'Up to NB32', 'Uninsulated PEX or PEX-AL-PEX pipes up to NB32.', '', 450),
    'trafalgar-selector-8585': _Service(
        'Cables - Data & Comms', 'Appendix D2 Comms',
        'Copper-core Group B communications cables in the assessed arrangement. Use discrete bundles when '
        'installed without a cable tray.', '400mm', 450, True),
    'trafalgar-selector-8586': _Service(
        'Cables - Power', 'Appendix D1 Power',
        'Copper-core Group A power cables in the assessed arrangement. Use discrete bundles when installed '
        'without a cable tray.', '600mm', 600, True),
    'trafalgar-selector-8587': _Service(
        'Pipes - Insulated', 'Copper pipes up to 50mm with FR Insulation or up to 20mm PE insulation',
        'Copper pipes up to 50 mm outside diameter with fire-rated insulation or up to 20 mm PE insulation. '
        'Heat trace cable under the insulation is optional.'),
    'trafalgar-selector-8588': _Service(
        'Paircoil Bundle', 'Up to 9.5 and 19mm Copper with up to 13mm PE insulation or 20mm FR insulation',
        'Copper paircoil pipes up to 9.5 mm and 19 mm with up to 13 mm PE or 20 mm fire-rated insulation.'),
    'trafalgar-selector-8590': _Service(
        'Cables - Fire', 'TPS Fire Cables', 'Up to twelve 2.5 mm² copper-core TPS cables per bundle.'),
    'trafalgar-selector-8592': _Service(
        'Cables - Fibre Optic', 'Fibre Optic Cables', 'NBN-grade fibre-optic cable.'),
    'trafalgar-selector-8593': _Service(
        'Cables - Aluminium', '120mm2, 240mm2 28mm OD, 70mm2 17mm OD',
        'Single-core aluminium cables. Per bundle, use up to three 240 mm² cables of 28 mm outside diameter, '
        'four 120 mm² cables and nine 70 mm² cables of 17 mm outside diameter, with up to 16 cables in total.'),
    'trafalgar-selector-8594': _Service(
        'Cables - Data & Comms', 'RG6', 'Up to three RG6 coaxial cables per bundle.'),
    'trafalgar-selector-8595': _Service(
        'Conduits - PVC', 'Rigid or Flexible Conduits up to 32mm',
        'Rigid or flexible uPVC conduits up to NB32, with or without cables.'),
}

_PEX_SUMMARY = {
    'columns': ['Configuration', 'Service size / condition', 'Wrap requirement'],
    'rows': [
        ['Wrap configuration 1', 'PEX up to NB20 and PEX-AL-PEX up to NB25', '300mm'],
        ['Wrap configuration 2', 'PEX and PEX-AL-PEX up to NB32', '450mm'],
    ],
}
_PEX_SOURCE_ISSUE = (
    'No source diagram or diagram link was supplied for this entry. Its configuration tables are selector '
    'summaries; their completeness cannot be checked against a diagram.'
)
_BASE_INSTALLATION = (
    'Centre the SuperSTOPPER Circular in the wall opening with an annular gap of up to 20 mm. '
    'Fit mounting flanges on both faces. Use the standard flange for gaps up to 5 mm. '
    'For larger gaps up to 20 mm, use the updated four-sided flange with backing rod or locking screws. '
    'Fill the annular gap with FyreFLEX to at least 20 mm deep from each face and finish without a fillet.\n\n'
    'Cut the foam end plugs to fit closely around the service and fit one at each end. Plug visible gaps '
    'with foam offcuts or FyreFLEX or FyrePEX sealant.'
)
_WRAP_FIXINGS = (
    'Overlap the wrap by at least 50 mm along its length. Secure it with 4 mm wide steel cable ties '
    'at 200 mm centres, or with aluminium-reinforced tape around the wrap at each end and at the midpoint.'
)
_LOOSE_FILL = (
    'Remove the foil from the loose TWrap infill and pack it around the cables and any assessed cable tray '
    'for 300 mm from the casing on each side.'
)


def trafalgar_superstopper_installation_fields(record, fields):
    """Add the verified procedure when the selected variant still matches the source."""
    system_id = record.get('id')
    service = _SERVICES.get(system_id)
    if not service:
        return fields
    expected = {
        'Manufacturer': 'Trafalgar',
        'System Products': 'SuperSTOPPER Circular',
        'Barrier Type': 'Walls',
        'Orientation': 'Vertical',
        'Barrier Construction': 'AFS RW156C',
        'Service': service.name,
        'Service Size / Configuration': service.selector_size,
        'FRL': '-/120/120',
        'Annular Gap': 'up to 20mm',
        'Service Wrap': service.selector_wrap,
        'Seal Depth / Fillet Size': '20mm (Both Sides) / No Fillet',
        'Collar': 'Cutout to suit',
        'Report Number': 'FC10266-01-5',
    }
    field_by_label = {field['label']: field for field in fields}
    if len(field_by_label) != len(fields) or any(label in field_by_label for label in
            ('Installation Details', 'Assessment Scope')):
        return fields
    values = {label: field.get('value') for label, field in field_by_label.items()}
    if any(values.get(label) != value for label, value in expected.items()):
        return fields
    if any(values.get(label) for label in ('Maximum Opening Size', 'Max. Opening Size')):
        return fields
    if not any(link.get('url') == _REPORT_URL for link in field_by_label['Report Number'].get('report_links', [])):
        return fields

    pex = system_id == 'trafalgar-selector-8584'
    source_issue = field_by_label.get('Source Issues')
    reviewed = list(fields)
    if pex:
        size_field = field_by_label['Service Size / Configuration']
        wrap_field = field_by_label['Service Wrap']
        if (size_field.get('table') != _PEX_SUMMARY
                or wrap_field.get('table_links') != [{'field': size_field['label'], 'table_index': 0}]
                or not source_issue or source_issue.get('value') != _PEX_SOURCE_ISSUE
                or size_field.get('table_links') or source_issue.get('table_links')
                or any(field.get(key) for field in (size_field, wrap_field, source_issue)
                       for key in ('tables', 'images', 'report_links'))):
            return fields
        # The selector's 300 mm explanation overstates what is covered at NB25. Use the documented
        # 450 mm configuration for the full up-to-NB32 range without retaining the contradictory table.
        reviewed.remove(source_issue)
        reviewed[reviewed.index(size_field)] = {
            key: value for key, value in size_field.items() if key not in ('table', 'table_captions')
        }
        reviewed[reviewed.index(wrap_field)] = {
            key: value for key, value in wrap_field.items() if key != 'table_links'
        }
    elif source_issue:
        return fields

    if pex or service.loose_fill:
        wrap_field = next(field for field in reviewed if field['label'] == 'Service Wrap')
        wrap_value = f'{service.wrap_mm} mm from each face of the wall'
        if service.loose_fill:
            wrap_value += ', with 300 mm loose TWrap infill on each side'
        reviewed[reviewed.index(wrap_field)] = {**wrap_field, 'value': wrap_value}

    steps = [_BASE_INSTALLATION]
    if service.loose_fill:
        steps.append(_LOOSE_FILL)
    steps.append(f'Fit 25 mm thick TWrap over the casing and service to at least {service.wrap_mm} mm '
                 f'from each face of the wall. {_WRAP_FIXINGS}')
    sources = ['FC10266-01-5']
    if system_id not in {'trafalgar-selector-8582', 'trafalgar-selector-8588', 'trafalgar-selector-8595'}:
        sources.append(_CIRCULAR_MANUAL)
    index = reviewed.index(field_by_label['Report Number'])
    reviewed[index:index] = [
        {'label': 'Assessment Scope',
         'value': 'AFS Rediwall RW156C with its permanent formwork in place and a fire resistance level '
                  f'of at least -/120/120. {service.scope}',
         'source_labels': ['Trafalgar Dincel & AFS Style Concrete Walls technical manual', *sources]},
        {'label': 'Installation Details', 'value': '\n\n'.join(steps),
         'source_labels': sources},
    ]
    return reviewed
