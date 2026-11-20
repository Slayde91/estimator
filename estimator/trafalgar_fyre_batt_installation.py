"""Source-verified installation summaries for selected FAS210123 wall systems."""

from .technical_brand_presentation import manufacturer_names


# Wall methods: Trafalgar FyreBATT 50 and ServoWrap wall manual, issue 180826,
# pp. 11–15, 25–27, and FAS200363 R2.4, sections 5–11 and 18 (AAC). The
# specification is one supported wall-seal method for the stated substrate.
# https://tfire.com.au/documents/FyreBATT-50-and-ServoWrap-wall-penetrations-technical-manual
# https://tfire.com.au/documents/FyreBATT-50-Substrate-Bulkheads
_WALL_SEAL = {
    ('Single Layer FR Plasterboard 13mm', '-/60/60'):
        'Frame the opening with studs. Fit two layers of FyreBATT 50 centrally in the wall.',
    ('Double Layer FR Plasterboard 13mm', '-/120/120'):
        'Frame the opening with studs. Fit two layers of FyreBATT 50 within the opening, flush with both wall faces.',
    ('Concrete/Masonry walls', '-/60/60'):
        'In a concrete or masonry wall at least 90 mm thick, surface-mount one FyreBATT 50 layer on each face '
        'with at least 50 mm overlap onto the wall.',
    ('Concrete/Masonry walls', '-/120/120'):
        'In a concrete or masonry wall at least 116 mm thick, surface-mount one FyreBATT 50 layer on each face '
        'with at least 100 mm overlap onto the wall.',
    ('CLT walls 130mm', '-/60/60'):
        'Fit two layers of FyreBATT 50 centrally within the opening in the CLT wall.',
    ('Korok Walls 51mm', '-/60/60'):
        'Fit one layer of FyreBATT 50 inside the opening and mount the other to the opposite face with a 100 mm overlap. '
        'For horizontal KOROK panels, cover a back-to-back C-track joint on one side with a 120 mm wide, 13 mm thick '
        'fire-rated plasterboard strip or KOROK metal flashing.',
    ('Korok Walls 78mm', '-/90/90'):
        'Fit one layer of FyreBATT 50 inside the opening and mount the other to the opposite face with at least 100 mm overlap. '
        'Join the batts with 100 mm spiral screws at 200 mm centres in rows 200 mm from the top and bottom of the opening. '
        'For horizontal KOROK panels, cover a back-to-back C-track joint on one side with a 120 mm wide, 13 mm thick '
        'fire-rated plasterboard strip or KOROK metal flashing.',
    ('Korok Walls 78mm', '-/120/120'):
        'Fit one layer of FyreBATT 50 inside the opening and mount the other to the opposite face with at least 100 mm overlap. '
        'Join the batts with 100 mm spiral screws at 200 mm centres in rows 200 mm from the top and bottom of the opening.',
    ('Speedpanel 78mm', '-/120/120'):
        'Frame the opening with metal channel. Friction-fit one layer of FyreBATT 50 on the exposed side '
        'and fix the second layer to the unexposed wall face with a 100 mm overlap.',
    ('AFS Rediwall 156C', '-/120/120'):
        'Fit two layers of FyreBATT 50 within the opening and finish the assembly flush with the wall faces.',
    ('Kingspan Walls - KRoc Firemaster Ultima Walls', '-/120/120'):
        'Friction-fit two layers of FyreBATT 50 in the opening of the K-Roc Firemaster Ultima wall. '
        'Set the unexposed batt face flush with the wall.',
    ('Kingspan Walls - KRoc Firemaster Ultima Walls', '-/180/180'):
        'Use a fire-rated 150 mm K-Roc Firemaster Ultima wall with an opening up to 600 mm high and '
        '1100 mm wide. Reinforce the opening with perimeter steel angles fixed at about 300 mm centres '
        'and bedded in FyreMASTIC A-R. Brush-coat the opening and friction-fit two FyreBATT 50 layers. '
        'Set the first layer flush with the unexposed face and apply a serpentine bead of FyreMASTIC A-R '
        'between the layers. Fit steel pigtail screws on the exposed batt face around the perimeter at '
        '200 mm centres, about 100 mm from the edge. Seal exposed joints with a nominal 5 mm bead.',
    ('Hebel Walls 75mm', '-/120/120'):
        'Fit one layer of FyreBATT 50 inside the opening and fix the second layer to the wall face with a 100 mm overlap.',
}

_BATT_EDGES = 'Coat the exposed cut edges with brush-grade FyreMASTIC A-R and seal the batt joints with FyreMASTIC A-R.'
_STRAP = 'Cut the batts closely around the service. Keep the gap at the opening to 1 mm or less. '
_STRAP_FINISH = 'Finish the strap-to-batt joint with a 5 × 5 mm fillet of FyreMASTIC A-R on each side.'
_STRAP_SEAL = '2 x layers of FyreBAND GWS on both sides of FyreBATT 50 / FyreMASTIC A-R 5 x 5mm fillet'
_STRAP_PRODUCTS = 'FyreBATT 50, FyreMASTIC A-R, FyreBAND GWS'
_HPR_PRODUCTS = 'FyreBATT 50, FyreMASTIC HP-R'
_STEEL_PRODUCTS = 'FyreBATT 50, FyreMASTIC A-R, ServoWrap'
_STEEL_FILLET = '30 x 30mm Fillet of FyreMASTIC A-R on Outside of Wrap'
_STEEL_WRAP = (
    'Support the steel independently. Cut the batts for a tight fit around the steel with a gap no greater '
    'than 1 mm. Fit 300 mm of ServoWrap on each side, tight to the batts. Fill the recesses around the web '
    'and flanges with ServoWrap so the wrap fits the section. Secure the wrap with stainless steel cable '
    'ties starting 50 mm from the batt face and spaced at 100 mm centres. Apply a 30 × 30 mm FyreMASTIC A-R '
    'fillet around the wrap at each batt face.'
)

# FAS210123 R2.0 (pp. 142, 168, 295) and Trafalgar's manuals (wall penetrations p. 16,
# structural penetrations p. 18) resolve three selector transcription errors.
# https://tfire.com.au/documents/FyreBATT-50-and-ServoWrap-wall-penetrations-technical-manual
# https://tfire.com.au/documents/RyanBatt-Structural-Penetration-Systems
_SELECTOR_SIZE_CORRECTIONS = (
    (range(9192, 9204), 'Conduits - PVC', _HPR_PRODUCTS, 'Wrap Free',
     'FyreMASTIC HP-R Full Depth/ Flush finish both sides', '25mm or 30mm PVC Conduit',
     '25 or 32 mm PVC conduit with two 2.5 mm² TPS cables'),
    (range(9300, 9312), 'Structural Elements - Steel', _STEEL_PRODUCTS, '300mm both sides', _STEEL_FILLET,
     'UB up to 410UB54 or C Purlin 200 x 12mm', 'UB up to 410UB54 or C purlin up to 200 × 1.2 mm'),
    (range(9312, 9324), 'Structural Elements - Steel', _STEEL_PRODUCTS, '300mm both sides', _STEEL_FILLET,
     'C Purlin 200 x 12mm', 'C purlin up to 200 × 1.2 mm'),
)

# The row identity guards retain the selected report, wall, service and
# products as well as the installation qualifiers supplied by the selector.
# Source: FAS210123 R2.0, section 5.4 and corresponding tested prototypes.
# https://tfire.com.au/documents/FyreBATT-50-Assessment-Report
_SERVICE_DETAILS = (
    # 21SFR00020, specimen B. Selector supplies the wrap length and external fillet.
    (range(9108, 9120), 'Pipes - Insulated, Pipes - Paircoil',
     '3 x Paircoil Bundles - 6.4 & 10mm copper pipe with 23 & 25mm insulation + 3 x 2.5mm2 TPS cables + PVC conduit',
     '300mm', 'FyreBATT 50, FyreMASTIC A-R, FyreMASTIC HP-R',
     'FyreMASTIC HP-R to full depth of FyreBATT 50 / FyreMASTIC A-R 30 x 30mm fillet outside wrap',
     'Use the 80 mm bundle with 31.5 mm outside diameter conduit and leave no more than 20 mm around the bundle. '
     'Fill the gap through both batts with FyreMASTIC HP-R. Fit 300 mm of ServoWrap on each side of the wall '
     'and apply a 30 × 30 mm FyreMASTIC A-R fillet where the wrap meets each batt.'),
    # 21SFR00018, specimens E/F, FAS210123 p. 121.
    (range(9132, 9144), 'Pipes - Insulated',
     'Copper up to 32mm Diameter with 20 - 40mm Thermobreak Insulation', 'Wrap Free',
     _STRAP_PRODUCTS, _STRAP_SEAL,
     'Keep the Thermobreak insulation continuous through the batts and leave no more than 5 mm around it. '
     'Fit two layers of FyreBAND GWS around the insulation at each face and seal the junction with '
     'a 5 × 5 mm FyreMASTIC A-R fillet.'),
    # PF20095 R3, specimens G/H, and FAS210123 p. 135 for the assessed pipe sizes.
    (range(9156, 9168), 'Pipes - PVC', '20 - 50mm Diameter uPVC pipe', 'Wrap Free',
     _STRAP_PRODUCTS, _STRAP_SEAL,
     'Use a 20, 32 or 40 mm uPVC pipe with a 2.61 mm pipe wall, or a 50 mm pipe with a 2.44 mm pipe wall. '
     + _STRAP + 'Wrap a piece of FyreBAND GWS twice around the pipe at each face of the batt seal. '
     + _STRAP_FINISH),
    # 22SFR00037, specimens A/C and E.
    (range(9168, 9180), 'Conduits - PVC', '20mm Diameter Flexi or Rigid PVC pipe', 'Wrap Free',
     _STRAP_PRODUCTS, _STRAP_SEAL,
     _STRAP + 'Fit two layers of FyreBAND GWS around the conduit at each side of the batt seal. ' + _STRAP_FINISH),
    (range(9180, 9192), 'Conduits - PVC', '3 x 25mm PVC conduits', 'Wrap Free',
     _STRAP_PRODUCTS, _STRAP_SEAL,
     _STRAP + 'Fit two layers of FyreBAND GWS around the bundle at each side of the batt seal. ' + _STRAP_FINISH),
    # 24SFR00068, specimens 5 and 6, FAS210123 pp. 142, 294–295.
    (range(9192, 9204), 'Conduits - PVC', '25 or 32 mm PVC conduit with two 2.5 mm² TPS cables',
     'Wrap Free', _HPR_PRODUCTS, 'FyreMASTIC HP-R Full Depth/ Flush finish both sides',
     'Use one 25 or 32 mm PVC conduit with a nominal 2 mm wall and two 2.5 mm² TPS cables inside it. '
     'Leave an 8–12 mm gap around the conduit. Fill the gap through both batts with FyreMASTIC HP-R and '
     'finish flush on both faces. Leave the conduit unwrapped.'),
    # 25SFR00004, specimen 3, and Trafalgar wall manual, conduit method.
    (range(9204, 9216), 'Conduits - PVC', '50mm PVC conduit', 'Wrap Free',
     'FyreBATT 50, FyreMASTIC HP-R',
     'FyreMASTIC HP-R Full Depth/ 15 x 15mm Fillet of FyreMASTIC HP-R Both Sides',
     'Use the conduit containing five 2.5 mm² 2C+E TPS cables and five CAT6 cables. Leave an 8 mm gap '
     'around the conduit. Fill the gap with FyreMASTIC HP-R through both batts and finish with '
     'a 15 × 15 mm fillet of the same sealant on each face.'),
    # PF20095 R3 specimens A/C, FAS210123 pp. 44 and 145 explicitly cover both 16 mm materials.
    (range(9216, 9228), 'Pipes - PEX Pipes', '16mm PE-Xa or 16mm PEX - Al - PEX Pipe', 'Wrap Free',
     _HPR_PRODUCTS, 'FyreMASTIC HP-R Full Depth / Flush finish both sides',
     'Use a 16 mm PE-Xa or PEX-Al-PEX pipe with a nominal 2.29 mm wall. Leave a 10–30 mm gap '
     'around the pipe. Fill the gap with FyreMASTIC HP-R through both 50 mm batts. Finish the sealant '
     'flush with both batt faces. Leave the pipe unwrapped.'),
    # 23SFR00073, specimen A, FAS210123 p. 150, and the exact seal in the selector.
    (range(9228, 9240), 'Cable Trays, Cables - Power',
     'Appendix D1 Copper Power Cables, with or without cable tray', 'Wrap Free',
     'FyreBATT 50, FyreMASTIC A-R , FyreMASTIC HP-R',
     'FyreMASTIC HP-R Full Depth / Bead of FyreMASTIC A-R Around the Sides and Bottom of Cable Tray',
     'Independently support the D1 cable set. Keep the opening within 450 × 50 mm and the gap within 50 mm. '
     'Pack the gaps around and between the cables with FyreMASTIC HP-R through the full depth of the batts. '
     'If a cable tray is used, seal its sides and underside to the batts with a bead of FyreMASTIC A-R.'),
    # PF20096 R3, specimen A, FAS210123 pp. 153–154, 216.
    (range(9240, 9252), 'Cables - Data & Comms', 'Up to 21 x Cat6 cables', 'Wrap Free',
     'FyreBATT 50, FyreMASTIC A-R', 'FyreMASTIC A-R Full Depth / 30 x 30mm Fillet both sides',
     'Bundle the 5 mm diameter CAT6 cables within a 30 mm diameter. Cut a close-fitting opening in the batts, '
     'leaving a gap of no more than 2 mm. Fill the gap through both batts with FyreMASTIC A-R and '
     'finish with a 30 × 30 mm fillet on each face.'),
    # 25SFR00004, specimen 7, and Trafalgar wall manual, Unicorn cable-bundle method.
    (range(9252, 9264), 'Cables - Power', '3 x 6mm2 3C+E TPS cable + 8 x 16mm2 3C+E TPS cable',
     '300mm Twrap both sides', 'FyreBATT 50, FyreMASTIC HP-R, Unicorn Collar, TWrap',
     'FyreMASTIC HP-R Full Depth of FyreBATT 50 and Full Depth of Unicorn Collar',
     'Keep the cable bundle within 82 mm diameter and leave an 11 mm gap around it. '
     'Fill the gap through both batts with FyreMASTIC HP-R. Fit a Unicorn Collar on each face '
     'and secure the collars to both faces with three M6 × 120 mm bolts. Fill through the full collar depth '
     'with FyreMASTIC HP-R and apply 300 mm of TWrap on each side.'),
    # PF20098 R2, specimen B, assessed nominal 45 × 285 mm timber, FAS210123 p. 158.
    (range(9264, 9276), 'Structural Elements - Timber', 'Timber Purlin maximum 45mm wide x 285mm high',
     '300mm both sides', 'FyreBATT 50, FyreMASTIC A-R, ServoWrap',
     '30 x 30mm Fillet of FyreMASTIC A-R on Outside of Wrap',
     'Keep the gap around the purlin to 5 mm or less. Apply a 5 mm layer and a 10 mm layer of ServoWrap '
     'for 300 mm on each side, with 100 mm overlap around the purlin. Secure the wrap with steel ties '
     'at 100 mm centres, starting 50 mm from each batt face. Apply a 30 × 30 mm FyreMASTIC A-R fillet '
     'where the wrap meets the batt on each side.'),
    # 25SFR00022, specimen C.
    (range(9288, 9300), 'Structural Elements - Steel', 'C Purlin up to 400 x 30mm', 'Wrap Free',
     'FyreBATT 50, FyreMASTIC A-R', '20 x 20mm FyreMASTIC A-R',
     'Cut the batts in sections around the 400DHS30 purlin and compression-fit them into the opening '
     'and around the steel. '
     'Apply a nominal 5 mm bead of FyreMASTIC A-R to the batt mating joints, including concealed joints. '
     'Seal the batt-to-purlin junction with a 20 × 20 mm FyreMASTIC A-R fillet on each side. Keep the installation symmetrical.'),
    (range(9300, 9312), 'Structural Elements - Steel', 'UB up to 410UB54 or C purlin up to 200 × 1.2 mm',
     '300mm both sides', _STEEL_PRODUCTS, _STEEL_FILLET, _STEEL_WRAP),
    (range(9312, 9324), 'Structural Elements - Steel', 'C purlin up to 200 × 1.2 mm',
     '300mm both sides', _STEEL_PRODUCTS, _STEEL_FILLET, _STEEL_WRAP),
)


def _selector_id(record):
    prefix = 'trafalgar-selector-'
    key = record.get('id', '')
    number = key[len(prefix):]
    if key.startswith(prefix) and number.isascii() and number.isdecimal() and len(number) <= 5:
        return int(number)
    return 0


def present_verified_fyre_batt_service_sizes(record):
    """Correct matching service sizes on the projected record before it is indexed."""
    selector = _selector_id(record)
    match = next((scope for ids, *scope in _SELECTOR_SIZE_CORRECTIONS if selector in ids), None)
    if match is None or manufacturer_names(record) != {'trafalgar'}:
        return
    service, products, wrap, fillet, original, corrected = match
    fields = record['fields']
    by_label = {field['label']: field for field in fields}
    expected = {'Report Number': 'FAS 210123', 'Orientation': 'Vertical', 'Barrier Type': 'Walls',
                'Service': service, 'System Products': products, 'Service Wrap': wrap,
                'Seal Depth / Fillet Size': fillet, 'Service Size / Configuration': original}
    wall = (by_label.get('Barrier Construction', {}).get('value'), by_label.get('FRL', {}).get('value'))
    if (len(by_label) != len(fields) or wall not in _WALL_SEAL
            or any(by_label.get(label, {}).get('value') != value for label, value in expected.items())):
        return
    field = by_label['Service Size / Configuration']
    field['value'] = corrected


def trafalgar_fyre_batt_installation(record, fields):
    """Add an assessed method only to the reviewed, unchanged selector configuration."""
    selector = _selector_id(record)
    if not selector:
        return fields
    match = next((details for selectors, *details in _SERVICE_DETAILS if selector in selectors), None)
    if not match or manufacturer_names(record) != {'trafalgar'}:
        return fields
    labels = {field['label']: field.get('value', '') for field in fields}
    if (len(labels) != len(fields) or labels.get('Report Number') != 'FAS 210123'
            or labels.get('Orientation') != 'Vertical' or labels.get('Barrier Type') != 'Walls'
            or labels.get('Installation Details') or labels.get('Source Issues')):
        return fields
    barrier, frl = labels.get('Barrier Construction'), labels.get('FRL')
    wall = _WALL_SEAL.get((barrier, frl))
    if 9228 <= selector < 9240 and frl in {'-/60/30', '-/90/30', '-/120/30'}:
        # The D1 service limits the combined insulation FRL to 30 minutes.
        _, integrity, _ = frl.split('/')
        wall = _WALL_SEAL.get((barrier, f'-/{integrity}/{integrity}'))
    service_labels = ('Service', 'Service Size / Configuration', 'Service Wrap',
                      'System Products', 'Seal Depth / Fillet Size')
    if not wall or tuple(labels.get(label) for label in service_labels) != tuple(match[:-1]):
        return fields
    result = list(fields)
    instructions = '\n\n'.join((wall + ' ' + _BATT_EDGES, match[-1]))
    detail = {'label': 'Installation Details', 'value': instructions}
    if 9192 <= selector < 9204:
        detail['source_labels'] = ['FAS210123 R2.0, 24SFR00068 specimens 5 and 6', 'Trafalgar FyreBATT 50 wall penetrations manual']
    elif 9216 <= selector < 9228:
        detail['source_labels'] = ['FAS210123 R2.0, PF20095 R3 specimens A and C']
    elif 9300 <= selector < 9324:
        detail['source_labels'] = ['FAS210123 R2.0, 24SFR00064', 'Trafalgar FyreBATT 50 structural penetrations manual']
    for index, field in enumerate(result):
        if field['label'] == 'Installation Details':
            result[index] = {**field, **detail}
            return result
    result.insert(next((index for index, field in enumerate(result) if field['label'] == 'Report Number'), len(result)),
                  detail)
    return result
