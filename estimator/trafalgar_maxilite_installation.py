"""Reviewed SuperSTOPPER Maxi and Square Mini installs in flat Maxilite wall seals."""

from typing import NamedTuple


_SUPERSTOPPER = 'FC10266-01-5'
_SUPERSTOPPER_URL = 'https://tfire.com.au/documents/Superstopper-orange-box-Range-Test-Report'
_MAXILITE = 'FCO 2586 Revision I'
_MAXILITE_URL = 'https://tfire.com.au/documents/FyreBOARD-Maxilite-Bulkheads-Penetrations-Test-Report'
_MANUAL = 'Trafalgar FyreBOARD Maxilite Penetration Systems Technical Manual'
_SELECTOR_OPENING = 'Size of aperture to be maximum 1.8m long and have a maximum area of 1.62m²'


class _Service(NamedTuple):
    name: str
    selector_size: str
    reviewed_size: str
    selector_wrap_mm: int = 300
    wrap_mm: int = 300
    loose_fill: bool = False


# FC10266-01-5 tables 11, 14 and 16, and the Maxilite manual pp. 14, 18 and 30.
_SERVICES = (
    _Service('Pipes - Steel', 'Up to 60mm OD', 'Uninsulated steel pipe up to 60 mm outside diameter'),
    _Service('Pipes - Copper', 'Up to 50mm OD', 'Uninsulated copper pipe up to 50 mm outside diameter'),
    _Service('Cables - Data & Comms', 'Appendix D2 Comms',
             'AS 1530.4 Appendix D2 Group B copper-core communications cables in assessed discrete bundles',
             400, 450, True),
    _Service('Cables - Power', 'Appendix D1 Power',
             'AS 1530.4 Appendix D1 Group A copper-core power cables in assessed discrete bundles',
             600, 600, True),
    _Service('Pipes - Insulated',
             'Copper up to 50mm with FR or PE insulation or Copper up to 20mm with rockwool-type insulation',
             'Copper pipe up to 50 mm outside diameter with fire-rated insulation or PE insulation up to 20 mm thick, '
             'or copper pipe up to 20 mm outside diameter with 38 mm rockwool-type insulation'),
    _Service('Paircoil Bundle', 'Up to 9.5 and 19mm Copper with up to 13mm PE insulation or 20mm FR insulation',
             'Copper paircoil pipes up to 9.5 mm and 19 mm with up to 13 mm PE or 20 mm fire-rated insulation'),
    _Service('Cables - Fire', 'TPS Fire Cables', 'Up to twelve 2.5 mm² copper-core TPS cables in a discrete bundle'),
    _Service('Cables - Fibre Optic', 'Fibre Optic Cables', 'NBN-grade fibre-optic cable'),
    _Service('Cables - Aluminium', '120mm2, 240mm2 28mm OD, 70mm2 17mm OD',
             'Single-core aluminium cable bundles up to three 240 mm² cables of 28 mm outside diameter, '
             'four 120 mm² cables or nine 70 mm² cables of 17 mm outside diameter'),
)


class _Wall(NamedTuple):
    selector_construction: str
    assessed_construction: str
    board_fixings: str


# FC10266-01-5 pp. 17, 29 and 35 define the supporting wall minimums.
# FCO 2586 Rev I table 1 and figures 19–20 define how the board connects to each wall.
_FRAMED_OPENING = (
    'Frame the wall opening and line it with the same number of layers of fire-rated plasterboard as the wall. '
    'Fix the aperture lining with two rows of screws at 150 mm centres. '
)
_ANGLE_FIXINGS = (
    'Use steel angles at least 50 × 50 × 0.9 mm, no longer than 1200 mm, with 20 mm clearance between angles. '
    'Fix the angles into the framing with at least 8g × 45 mm screws at 200 mm centres. '
    'Fix the 60 mm board to the steel angles with at least 8g × 80 mm screws at 200 mm centres.'
)
_SHAFTLINER = _Wall(
    'Shaftliner (CH Stud 25mm + 2x16mm)',
    'a shaft wall with minimum 64 mm CH steel studs, 25 mm shaftliner and two 16 mm fire-rated '
    'plasterboard layers on the plasterboard side',
    _FRAMED_OPENING + _ANGLE_FIXINGS + ' Fix the board to the CH studs via the angles on the plasterboard side only.',
)
_CONCRETE = _Wall(
    'Concrete/Masonry', 'a concrete or solid masonry wall at least 120 mm thick',
    'Fix the 60 mm board to the wall with at least M6 × 100 mm masonry anchors at no more than 400 mm centres, '
    '50 mm from the board edge.',
)
_PLASTERBOARD = _Wall(
    'Double Layer FR Plasterboard (Min. 2x13mm)',
    'a wall with steel studs at least 64 mm deep and two layers of 13 mm fire-rated plasterboard on each face',
    _FRAMED_OPENING + _ANGLE_FIXINGS,
)

# The ID order in each group matches _SERVICES. Keep the wall, barrier group and
# casing variant tied to the original selector rather than inferring a match by product name.
_SELECTORS = {
    f'trafalgar-selector-{system_id}': (wall, barrier_type, casing, service)
    for wall, barrier_type, casing, ids in (
        (_SHAFTLINER, 'Shaft Walls', 'Maxi', (4279, 4280, 4283, 4284, 4285, 4286, 4288, 4290, 4291)),
        (_SHAFTLINER, 'Shaft Walls', 'Mini', (4294, 4295, 4298, 4299, 4300, 4301, 4303, 4305, 4306)),
        (_CONCRETE, 'Walls', 'Maxi', (4401, 4400, 4397, 4396, 4395, 4394, 4392, 4390, 4387)),
        (_CONCRETE, None, 'Mini', (4386, 4385, 4382, 4381, 4380, 4379, 4377, 4375, 4372)),
        (_PLASTERBOARD, 'Walls', 'Mini', (4460, 4459, 4456, 4455, 4454, 4453, 4451, 4449, 4446)),
    )
    for system_id, service in zip(ids, _SERVICES, strict=True)
}

_CASING_SCOPE = {
    'Maxi': 'Assessed Maxis are 350, 550, 650, 750 or 1100 mm wide by 125 mm high and 250 mm deep.',
    'Mini': 'Use the assessed Square Mini casing, 102 × 102 mm outside dimensions by 250 mm deep.',
}
_RESIDUALS = {
    'Maxi': 'For larger spans, use only the span and minimum residual widths listed for the selected Maxi in '
            'FCO 2586 Revision I, Table 1a. For a two-sheet seal, cut both sheets equally within 20 mm and '
            'fill any joint up to 10 mm wide through the full board depth with FyreFLEX.',
    'Mini': 'Use only spans up to 850 mm for this Square Mini detail.',
}


def trafalgar_maxilite_installation_fields(record, fields):
    """Correct and document the reviewed flat-wall assemblies on unchanged selectors."""
    variant = _SELECTORS.get(record.get('id'))
    if variant is None or record.get('user_authored') is True:
        return fields

    wall, barrier_type, casing, service = variant
    expected = {
        'Manufacturer': 'Trafalgar',
        'System Products': f'FyreBOARD Maxilite, SuperSTOPPER {casing}',
        'Orientation': 'Vertical',
        'Barrier Construction': wall.selector_construction,
        'Service': service.name,
        'Service Size / Configuration': service.selector_size,
        'FRL': '-/120/120 (Min. 60mm Maxilite)',
        'Maximum Opening Size': _SELECTOR_OPENING,
        'Service Wrap': f'{service.selector_wrap_mm}mm',
        'Seal Depth / Fillet Size': '20mm (Both Sides) / No Fillet',
        'Report Number': _SUPERSTOPPER,
    }
    if barrier_type is not None:
        expected['Barrier Type'] = barrier_type
    by_label = {field['label']: field for field in fields}
    # The catalogue may replace the displayed ID with its public variant code.
    values = {label: field.get('value') for label, field in by_label.items() if label != 'ID'}
    if len(by_label) != len(fields) or 'ID' not in by_label or values != expected:
        return fields
    if any(set(field) - {'label', 'value', 'source_labels', 'report_links'} for field in fields):
        return fields
    original_link = {'label': _SUPERSTOPPER, 'url': _SUPERSTOPPER_URL}
    if by_label['Report Number'].get('report_links') != [original_link]:
        return fields

    wrap = f'{service.wrap_mm} mm beyond each exposed face of the wall and Maxilite assembly'
    if service.loose_fill:
        wrap += ' with 300 mm foil-free TWrap infill each side'
    updated_values = {
        'Service Size / Configuration': service.reviewed_size,
        'Maximum Opening Size': 'Host opening up to 1.8 m long and 1.62 m². Each dimension must also be no greater '
                                'than the permitted Maxilite board dimension less 200 mm. The assessed wall '
                                'opening, board support span and residual widths can further reduce these limits.',
        'Service Wrap': wrap,
        'Seal Depth / Fillet Size': 'FyreFLEX to full depth of Maxilite at the casing. Seal the board-to-wall '
                                   'junction separately with a 15 × 15 mm FyreFLEX fillet.',
        'Report Number': f'{_SUPERSTOPPER}\n{_MAXILITE}',
    }
    report_index = fields.index(by_label['Report Number'])
    reviewed = [{**field, 'value': updated_values[field['label']]} if field['label'] in updated_values else field
                for field in fields]
    reviewed[report_index]['report_links'] = [original_link, {'label': _MAXILITE, 'url': _MAXILITE_URL}]

    steps = [
        'Use the flat, face-fixed arrangement with 60 mm thick Maxilite supported on all edges. '
        'Overlap the wall opening by at least 100 mm on all sides. ' + wall.board_fixings + ' '
        'Seal the junction between the board and wall with a 15 × 15 mm FyreFLEX fillet.',
        'Centre the casing through the Maxilite thickness. Keep a 5–10 mm gap on all sides and '
        'fill the gap with FyreFLEX through the full depth of the board. Fix the steel mounting flanges '
        'on both faces with 8g × 50 mm screws at no more than 200 mm centres. '
        'Support the services independently of the board, with the assessed loading fitting inside the casing. '
        'Cut the foam plugs to fit the services tightly at both ends and seal visible gaps with foam offcuts, '
        'FyreFLEX or FyrePEX sealant.',
    ]
    if service.loose_fill:
        steps.append('Remove the foil from the loose TWrap infill and pack it around the cable bundle '
                     'for 300 mm out from the casing on each side.')
    steps.append('Cover the full exposed casing and wrap the services with 25 mm thick TWrap on both sides. '
                 f'Extend the wrap at least {service.wrap_mm} mm beyond each exposed face of the wall and Maxilite '
                 'assembly. Overlap the wrap by at least 50 mm along the seam. Secure it with aluminium '
                 'foil tape and stainless steel cable ties at least 4.6 mm wide at no more than 200 mm centres.')

    reviewed[report_index:report_index] = [
        {'label': 'Annular Gap', 'value': '5–10 mm between the casing and Maxilite', 'source_labels': [_MAXILITE, _MANUAL]},
        {'label': 'Assessment Scope',
         'value': f'Use {wall.assessed_construction}. The wall must independently achieve at least -/120/120 '
                  'with the proposed opening. The host opening must satisfy the listed size and board conditions. '
                  f'{_CASING_SCOPE[casing]} Measure the span between the board supports. For spans up to 850 mm, '
                  'leave at least 150 mm of residual board from each short and long edge of the casing cutout '
                  f'to the corresponding outside edge of the assembled board. {_RESIDUALS[casing]}',
         'source_labels': [_MAXILITE, _SUPERSTOPPER]},
        {'label': 'Installation Details', 'value': '\n\n'.join(steps), 'source_labels': [_MAXILITE, _SUPERSTOPPER, _MANUAL]},
    ]
    return reviewed
