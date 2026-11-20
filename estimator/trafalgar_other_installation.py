"""Source-checked installation summaries for selected Trafalgar configurations."""


_INSTALLATION = 'Installation Details'
_FCO3527_FIELDS = {
    'Manufacturer': 'Trafalgar',
    'System Products': 'Unicorn Continous Collar, FyrePEX HP Sealant',
    'Barrier Type': 'Floors',
    'Orientation': 'Horizontal',
    'Barrier Construction': 'Concrete floor slabs',
    'FRL': '-/120/120',
    'Maximum Opening Size': 'Maximum 100mm Opening with up to 10mm Annular Gap',
    'Seal Depth / Fillet Size': '60mm fill depth and full depth of Collar',
    'Report Number': 'FCO 3527',
}
_FCO3527_SERVICES = {
    ('8244', '8354'): ('Cables - Power', 'Up to 11x 6mm^2 3C+E Power Cables', '300mm'),
    ('8246', '8356'): ('Cables - Data & Comms', 'Up to 2 of 2.5mm2 TPS cable (2C)', '300mm'),
    ('8247', '8357'): ('Cables - Data & Comms', 'Up to 30 of CAT6 communication cables (6.1mm OD)', '300mm'),
    ('8248', '8358'): ('Cables - Fibre Optic', 'Up to 5 of 6-core fibre optical cable (nom. 4.5mm OD)',
                       'No TWrap required'),
}

# CSIRO FCO-3527 revision G, manufacturer-hosted copy:
# https://tfire.com.au/documents/Trafalgar-Unicorn-Fire-Report
# SHA-256 cb7c835602e2c90e5cc5314b42042a2ac81c0710b2105df6d964e3e1a4494b0e.
# PDF pp9-10, 16, 18-19, 22, 24-25, 27-28, 54-55.
_COLLAR_STEPS = (
    '1. Use a concrete floor at least 150 mm thick. Keep the hole at or below 100 mm diameter and '
    'the gap around the cables at or below 10 mm. Support the cables within 500 mm above the floor.\n'
    '2. Fit the Unicorn collar to the underside of the floor, using up to 25 segments. Join the cut ends '
    'with the first tab and space the tabs evenly. Use two tabs below 50 mm collar internal diameter and '
    'three above 50 mm. Keep at least 40 mm between adjacent collar bodies. Fix through the tabs with '
    'minimum M6 x 50 mm Dynabolts, steel knock-in anchors or masonry anchors. Use at least three tabs '
    'where the collar is against an adjacent fire barrier.\n'
    '3. Fill the gaps around and between the cables with 60 mm of FyrePEX HP from the exposed face. '
    'Fill the gaps between cables and inside the collar for its full depth.'
)
_COLLAR_WRAP = (
    '\n4. Fit 25 mm TWrap for 300 mm above the floor. Overlap joints by at least 50 mm. '
    'Fit steel ties 50 mm from each end and at no more than 150 mm centres. If the penetration is less '
    'than 25 mm from an adjacent fire barrier, retain the full wrap length and use a three-sided wrap. '
    'Use minimum 30 x 0.9 mm steel straps along both sides, with no more than 50 mm between straps. '
    'Fix to plasterboard with minimum 8g x 45 mm screws or to masonry with M6 x 50 mm anchors, '
    '50 mm from each wrap end and at 150 mm centres.'
)

# The manufacturer’s IntRwall Penetrations technical manual publishes these
# 24SFR00065 cable details on pp. 4 and 9–11 and the IGNE-25042-01R PVC detail
# on p. 5. https://tfire.com.au/documents/intrwall-application-technical-manual
# SHA-256 be5b7de12bb9c971291437ee05d5097f9c274e74d60d952ee7de6714d1589ae4.
_INTRWALL_FIELDS = {
    'Manufacturer': 'Trafalgar',
    'Barrier Type': 'Walls',
    'Orientation': 'Vertical',
    'Barrier Construction': 'IntRwall (25+16mm)',
    'FRL': '-/60/60',
    'Service Wrap': 'No TWrap required',
}
_INTRWALL_PEX_SOURCE = {
    **_INTRWALL_FIELDS,
    'System Products': 'FyreCOLLAR Retro-fit, FyreFLEX Sealant',
    'Service': 'Pipes - PEX',
    'Service Size / Configuration': '25 mm PEX-A Pipe',
    'Maximum Opening Size': '10 mm Annular Gap',
    'Seal Depth / Fillet Size': '5mm (FyreCOLLAR fixing side only)/No Fillet',
    'Report Number': '24SFR00065',
}
# Trafalgar IntRwall manual, p. 15, 24SFR00065 specimen 5: 10 mm is the
# collar projection. The section does not give a numeric gap or seal depth.
_INTRWALL_PEX_CORRECTION = {
    'System Products': '25 mm FyreCOLLAR Conduit, FyreFLEX Sealant',
    'Maximum Opening Size': 'Opening to suit the inverted 25 mm FyreCOLLAR Conduit',
    'Seal Depth / Fillet Size': 'Fill gaps between collar and wall with FyreFLEX from the fixing-tab side',
}


def present_verified_intrwall_pex_scope(record):
    """Publish the exact tested collar and keep imported values in the source record."""
    if record['id'] != 'trafalgar-selector-7945':
        return
    fields = record['fields']
    by_label = {field['label']: field for field in fields}
    if (len(by_label) != len(fields) or 'Source Issues' in by_label
            or any(by_label.get(label, {}).get('value') != value for label, value in _INTRWALL_PEX_SOURCE.items())):
        return
    for label, value in _INTRWALL_PEX_CORRECTION.items():
        by_label[label]['value'] = value
    if record.get('summary') == _INTRWALL_PEX_SOURCE['System Products']:
        record['summary'] = _INTRWALL_PEX_CORRECTION['System Products']


_INTRWALL_CABLES = {
    '7947': (
        'FyrePEX HP', 'Cables - Aluminium', '25mm² 4C+E Aluminum Core Cable',
        'one 25 mm² 4C+E aluminium cable', 10,
    ),
    '7949': (
        'FyreFLEX', 'Cables - Data & Comms',
        '1x RG11 Coaxial Cable, and 3x CAT 6 Cables, Data Cable Bundle – 1x RG6 Coaxial Cable',
        'a bundle of one RG6 cable, one RG11 cable and three CAT6 cables', 5,
    ),
    '7950': (
        'FyreFLEX', 'Cables - Power', '25mm² 4C+E Copper Cored Cable',
        'one 25 mm² 4C+E copper cable', 10,
    ),
}
_INTRWALL_CABLE_FIELDS = {
    **_INTRWALL_FIELDS,
    'Report Number': '24SFR00065',
    'Seal Depth / Fillet Size': 'Full Depth / 50x50mm',
}
_INTRWALL_PIPE_FIELDS = {
    **_INTRWALL_FIELDS,
    'Report Number': 'IGNE-25042-01R',
    'System Products': 'Unicorn Continous Collar, FyrePEX HP Sealant',
    'Service': 'Pipes - PVC Stack',
    'Service Size / Configuration': 'Up to DN100',
    'Maximum Opening Size': 'Up to 7.5mm Annular Gap',
    'Seal Depth / Fillet Size': 'Full depth of Wall + Additional 16mm Fyrechek / No Fillet',
    'Collar': 'Cutout to suit',
}

# Southbrook specimen 5 is described in CSIRO FCO-3527 revision G, PDF pp. 65,
# 82 and 85–86. Keep the tested slab thickness and selector’s aperture.
_ALUMINIUM_CABLE_FIELDS = {
    **_FCO3527_FIELDS,
    'Report Number': '24SFR00055',
    'Service': 'Cables - Aluminium',
    'Service Size / Configuration': '4 x 240mm² Aluminium Cables',
    'Maximum Opening Size': 'Maximum 72mm Opening with up to 6mm Annular Gap',
    'Service Wrap': '300mm',
}

# CSIRO FCO-3576, pp. 4–7 and 9–11 covers DWV stacks through walls.
# https://tfire.com.au/documents/BladeRUNNER-Fire-Report
# SHA-256 ab5a4edfb7e7b94885c439db06c1e4701402f27b31173f63d665b0544bcc0275.
_BLADERUNNER_FIELDS = {
    'Manufacturer': 'Trafalgar',
    'System Products': 'BladeRUNNER, FyreFLEX Sealant',
    'Orientation': 'Vertical',
    'Barrier Construction': 'Concrete/Masonry',
    'FRL': '-/180/180',
    'Maximum Opening Size': '115 mm',
    'Service Wrap': 'No TWrap required',
    'Seal Depth / Fillet Size': '10mm (Both Sides) / No Fillet',
    'Collar': 'BladeRUNNER',
    'Report Number': 'FCO 3576',
}
_BLADERUNNER_PIPES = {
    '7177': ('PVC', '100mm PVC with elbow',
             'Use a DN100 DWV PVC stack and line up the elbow with the collar.'),
    '7178': ('HDPE', '110mm',
             'Use a DN100 HDPE stack with a 110 mm outside diameter. Keep sockets, elbows and '
             'other fittings out of the collars.'),
}

# Jensen Hughes FAS210023 R1.9, TBD1–5 and TPD12/41/42, pp. 5–6, 11, 23,
# 33, 49 and 52. FC10266-01-5 p. 9 records the FyreBOX name change.
# https://tfire.com.au/documents/FyreBATT-Test-Report
# SHA-256 c870d12130ce5eff058909f28bda5553caef26f7abe8ce2dd615583cdbbb047a.
_FYREBATT_REPORT_URL = 'https://tfire.com.au/documents/FyreBATT-Test-Report'
_FYREBATT_FIELDS = {
    'Manufacturer': 'Trafalgar',
    'System Products': 'FyreBATT 60, SuperSTOPPER Circular (150mm only)',
    'Service': 'Paircoil Bundle',
    'Service Wrap': '300mm',
    'Seal Depth / Fillet Size': 'Full depth / No Fillet',
    'Report Number': 'FAS 210023',
}
_FYREBATT_WALL_BUNDLE = (
    '3x CAT6 cables, 3x electrical cables, 3x20mm PVC drainpipes, '
    'Up to 3x 3/8 + 5/8 paircoils with 19mm FR insulation'
)
_FYREBATT_FLOOR_BUNDLES = (
    '1x 20mm PEX-AL-PEX, 1x 3/8 + 3/4 paircoils with 19mm FR insulation, 1x CAT6 cables, '
    '1x electrical cables, 20mm PEX-B, 3x25mm conduit',
    '1x 20mm PEX-AL-PEX, 1x CAT6 cables, 1x electrical cables, 20mm PEX-B, 3x25mm conduit, '
    'Up to 3x 3/8 + 3/4 paircoils with 19mm FR insulation',
)
_FYREBATT_SMALL_WALL = 'Up to 1000mm high x 1200mm wide'
_FYREBATT_LARGE_WALL = 'Up to 1200mm high x 2400mm wide'
_FYREBATT_PATTRESS = (
    'Friction-fit one 60 mm FyreBATT in the opening and face-fix a second 60 mm FyreBATT. '
    'Seal the perimeter and board joints with FyreFLEX. Form a 25 x 25 mm FyreFLEX fillet '
    'around the face-fixed board.'
)
_FYREBATT_PATTRESS_OVERLAP = (
    'Friction-fit one 60 mm FyreBATT flush with one wall face. Face-fix a second 60 mm FyreBATT on that '
    'face with the assessed pattress fixings and 100 mm overlap on all sides. Seal the perimeter and '
    'board joints with FyreFLEX and form a 25 x 25 mm FyreFLEX fillet around the face-fixed board.'
)
_FYREBATT_FRICTION = (
    'Friction-fit two 60 mm FyreBATT layers into the opening. Seal the perimeter and any '
    'board joints with FyreFLEX.'
)
_FYREBATT_WALLS = {
    '1165': (
        'Walls', 'Single Layer FR Plasterboard (Min. 13mm)', '-/60/60', _FYREBATT_SMALL_WALL,
        'Use a fire-rated steel-stud wall at least 90 mm thick with one 13 mm fire-rated plasterboard '
        'layer on each face.', _FYREBATT_PATTRESS_OVERLAP,
    ),
    '1183': (
        'Walls', 'Single Layer FR Plasterboard (Min. 16mm)', '-/90/90', _FYREBATT_SMALL_WALL,
        'Use a fire-rated steel-stud wall at least 96 mm thick with one 16 mm fire-rated plasterboard '
        'layer on each face.',
        _FYREBATT_PATTRESS,
    ),
    '1200': (
        'Walls', 'Double Layer FR Plasterboard (Min. 2x13mm)', '-/120/120', _FYREBATT_LARGE_WALL,
        'Use a fire-rated wall at least 116 mm thick with two 13 mm fire-rated plasterboard layers '
        'on each face.', _FYREBATT_FRICTION,
    ),
    '1215': (
        'Shaft Walls', 'Shaftliner (CH Stud 25mm + 2x16mm)', '-/120/120', _FYREBATT_LARGE_WALL,
        'Use a fire-rated CH stud shaft wall with 25 mm shaftliner and two 16 mm fire-rated board '
        'layers.', _FYREBATT_FRICTION,
    ),
    '1236': (
        '', 'Hebel 75mm', 'Up to -/120/120', _FYREBATT_SMALL_WALL,
        'Use a Hebel AAC wall at least 75 mm thick and assessed for the required fire rating.',
        _FYREBATT_PATTRESS_OVERLAP,
    ),
    '1254': (
        '', 'Speedpanel', 'Up to -/120/120', _FYREBATT_SMALL_WALL,
        'Use 78 mm Speedpanel for the 120-minute system. A 64 mm panel limits the rating to '
        '-/90/90. A 51 mm panel limits the rating to -/60/60 and the wall opening to 600 x 600 mm.',
        _FYREBATT_PATTRESS,
    ),
    '1272': (
        '', 'WALSC 75mm', 'Up to -/120/120', _FYREBATT_SMALL_WALL,
        'Use a 75 mm WALSC AAC wall assessed for the required fire rating.', _FYREBATT_PATTRESS,
    ),
    '1291': (
        '', 'Concrete/Masonry', 'Up to -/120/120', _FYREBATT_SMALL_WALL,
        'Use a concrete or masonry wall designed for the required fire rating with the penetration.',
        _FYREBATT_FRICTION,
    ),
    '2298': (
        'Shaft Walls', 'Shaftliner (CH Stud 25mm + 2x13mm)', '-/90/90', _FYREBATT_LARGE_WALL,
        'Use a fire-rated CH stud shaft wall with 25 mm shaftliner and two 13 mm fire-rated board '
        'layers.', _FYREBATT_FRICTION,
    ),
}
_FYREBATT_FLOORS = {
    '1312': ('Concrete floor slabs', '-/180/180', 0, 'above the floor'),
    '1313': ('Concrete floor slabs', '-/180/120', 1, 'on both sides of the floor'),
    '4821': ('Steel Deck floor slabs', '-/180/120', 1, 'on both sides of the floor'),
    '4822': ('Steel Deck floor slabs', '-/180/180', 0, 'above the floor'),
}
_FYREBATT_CORRECTIONS = {
    '1165': {'Maximum Opening Size': 'Up to 600 mm high x 600 mm wide'},
    '1236': {'Seal Depth / Fillet Size': 'Full depth around the casing / No casing fillet'},
    '4822': {
        'Barrier Construction': 'Concrete-filled KF70 steel deck floor slab',
        'Service Size / Configuration': _FYREBATT_FLOOR_BUNDLES[0],
    },
}


def _fyrebatt_procedure(number):
    source = ['FAS 210023 R1.9']
    if number in _FYREBATT_WALLS:
        barrier_type, barrier, rating, aperture, construction, batt_fit = _FYREBATT_WALLS[number]
        expected = {
            **_FYREBATT_FIELDS,
            'Orientation': 'Vertical',
            'Barrier Construction': barrier,
            'FRL': rating,
            'Maximum Opening Size': aperture,
            'Service Size / Configuration': _FYREBATT_WALL_BUNDLE,
        }
        if barrier_type:
            expected['Barrier Type'] = barrier_type
        aperture_mm = aperture.removeprefix('Up to ').replace('mm', ' mm')
        if number in {'1165', '1183'}:
            expected['Service Size / Configuration'] = (
                '3x 20mm PVC drainpipe, 3x CAT6 cables, 3x electrical cables, '
                'Up to 3x 3/8 + 5/8 paircoils with 19mm FR insulation'
            )
        if number == '1183':
            expected['System Products'] = 'FyreBATT 60, SuperSTOPPER Circular(150mm only)'
        if number == '1165':
            # Use the 600 x 600 mm branch supported by the 51 mm Speedpanel evidence
            # cited for the 13 mm wall in pp. 74–76, with the TBD3 pattress from p. 42.
            aperture_mm = _FYREBATT_CORRECTIONS[number]['Maximum Opening Size'].removeprefix('Up to ')
        if number == '1236':
            # TPD12 (pp. 11, 49, 113) requires full-depth sealing. TBD4 (pp. 42, 75, 107)
            # defines the two-batt pattress arrangement and aperture limit for the Hebel wall.
            expected['Seal Depth / Fillet Size'] = '100mm / No Fillet'
        wrap_target = 'the exposed casing and bundle' if number in {'1165', '1236'} else 'the bundle'
        steps = (
            f'1. {construction} Keep the wall opening within {aperture_mm}.\n'
            f'2. {batt_fit}\n'
            '3. Cut a nominal 170 mm opening in the batts. Install the 150 mm SuperSTOPPER '
            'Mini Round with the specified bundle. Secure its mounting flanges to the batts '
            'with pigtail screws. Fill the gap around the casing with FyreFLEX for the full '
            'depth.\n'
            f'4. Wrap {wrap_target} for 300 mm on both wall faces with 25 mm TWrap. Secure the '
            'wrap with steel cable ties.'
        )
        return expected, steps, [*source, 'TPD12']
    if number in _FYREBATT_FLOORS:
        barrier, rating, bundle_index, wrap_side = _FYREBATT_FLOORS[number]
        expected = {
            **_FYREBATT_FIELDS,
            'Barrier Type': 'Floors',
            'Orientation': 'Horizontal',
            'Barrier Construction': barrier,
            'FRL': rating,
            'Maximum Opening Size': 'Up to 1200mm long x 600mm wide',
            'Service Size / Configuration': _FYREBATT_FLOOR_BUNDLES[bundle_index],
        }
        if number == '4822':
            # The steel-deck manual (p. 18) identifies the Mini R150/FyreFLEX single-coil
            # -/180/180 configuration. TPD41 (pp. 23 and 125) gives the complete service bundle.
            expected['Service Size / Configuration'] = '0'
        construction = ('Use a concrete floor at least 150 mm thick with the required fire rating.'
                        if barrier == 'Concrete floor slabs'
                        else 'Use a concrete-filled steel deck floor with the required fire rating.')
        batt_fit = _FYREBATT_FRICTION
        wrap_target = 'the bundle'
        if number == '4822':
            construction = (
                'Use a concrete-filled KingFlor KF70 deck designed to AS 3600 for the required fire rating '
                'with the proposed opening. Provide at least 150 mm of concrete above the steel ribs. '
                'Install the firestop against the concrete and keep it clear of the steel deck.'
            )
            batt_fit = (
                'Friction-fit two 60 mm FyreBATT layers back-to-back. Seal the perimeter and any board joints '
                'with FyreFLEX.'
            )
            wrap_target = 'the exposed casing and bundle'
        steps = (
            f'1. {construction} Keep the floor opening within 1200 x 600 mm.\n'
            f'2. {batt_fit}\n'
            '3. Cut a nominal 170 mm opening in the batts. Insert the 150 mm SuperSTOPPER '
            'Mini Round with the specified bundle. Fix the top and bottom flanges to the '
            'batts with pigtail screws. Fill the gap around the casing with FyreFLEX for the '
            'full depth.\n'
            f'4. Wrap {wrap_target} for 300 mm {wrap_side} with 25 mm TWrap. Secure the wrap '
            'with steel cable ties.'
        )
        source.append('TPD42' if bundle_index else 'TPD41')
        if barrier == 'Steel Deck floor slabs':
            source.append('Trafalgar Steel Deck Floor Systems')
        return expected, steps, source
    return None


def _procedure(number):
    if number == '7945':
        steps = (
            '1. Run one 25 mm PEX-A pipe through the IntRwall assembly of 25 mm shaftliner and '
            '16 mm fire-rated plasterboard. Fit a 25 mm FyreCOLLAR Conduit inverted into the wall '
            'from the plasterboard face, with the collar projecting 10 mm.\n'
            '2. Secure the fixing tabs with 10g × 38 mm plasterboard laminating screws. Fill the gaps '
            'between the collar and the wall with FyreFLEX from the fixing-tab side. Leave the pipe unwrapped.'
        )
        return {**_INTRWALL_PEX_SOURCE, **_INTRWALL_PEX_CORRECTION}, steps, ['24SFR00065 specimen 5', 'Trafalgar IntRwall Penetrations']

    if number in _INTRWALL_CABLES:
        sealant, service, configuration, installed_service, gap = _INTRWALL_CABLES[number]
        expected = {
            **_INTRWALL_CABLE_FIELDS,
            'System Products': f'{sealant} Sealant',
            'Service': service,
            'Service Size / Configuration': configuration,
            'Maximum Opening Size': f'{gap} mm Annular Gap',
        }
        steps = (
            f'1. Pass {installed_service} through the IntRwall assembly of 25 mm shaftliner and '
            f'16 mm fire-rated plasterboard. Keep the gap around the service within {gap} mm.\n'
            f'2. Fill the gap for the full wall depth with {sealant}. Form a 50 x 50 mm fillet '
            'around the service on each wall face. The cables require no wrap.'
        )
        return expected, steps, ['24SFR00065', 'Trafalgar IntRwall Penetrations']

    if number == '8799':
        steps = (
            '1. Use an IntRwall assembly of 25 mm shaftliner and 16 mm fire-rated plasterboard. '
            'Fit one uPVC pipe up to DN100 with an annular gap no greater than 7.5 mm.\n'
            '2. Fix a 16 mm Fyrechek layer on each wall face. Extend it at least 75 mm past the '
            'collar in every direction. Use 10g x 38 mm Gyprock laminating screws at no more '
            'than 200 mm centres.\n'
            '3. Use FyrePEX HP to seal the gap for the full depth of the wall and added board. '
            'Fit the Unicorn collar with 8g x 50 mm plasterboard screws. The pipe requires '
            'neither a sealant fillet nor a wrap.'
        )
        return _INTRWALL_PIPE_FIELDS, steps, ['IGNE-25042-01R', 'Trafalgar IntRwall Penetrations']

    if number == '8261':
        steps = (
            '1. Pass four 240 mm² single-core aluminium cables through a 72 mm hole in a 175 mm '
            'concrete floor. Limit the gap around the bundle to 6 mm.\n'
            '2. Fix the Unicorn collar to the underside with masonry anchors through three tabs. '
            'Fill 60 mm of the gap with FyrePEX HP from the underside. Backfill the gaps between '
            'the cables and inside the collar for the full collar depth.\n'
            '3. Wrap the cables for 300 mm above the floor with TWrap. Secure the wrap with three '
            'stainless steel cable ties.'
        )
        return _ALUMINIUM_CABLE_FIELDS, steps, ['24SFR00055', 'FCO 3527 Revision G']

    if number in _BLADERUNNER_PIPES:
        material, configuration, pipe = _BLADERUNNER_PIPES[number]
        expected = {
            **_BLADERUNNER_FIELDS,
            'Service': f'Pipes - {material} Floor Waste, Pipes - {material} Stack',
            'Service Size / Configuration': configuration,
        }
        steps = (
            f'1. {pipe} Use pipe at least 3 mm thick. Install it through a fire-rated concrete '
            'wall at least 150 mm thick or a fire-rated masonry wall at least 160 mm thick.\n'
            '2. Keep the opening within 115 mm and leave a 2–6 mm gap around the pipe. Seal the '
            'gap with FyreFLEX to at least 10 mm deep from both wall faces.\n'
            '3. Fit a 100 mm BladeRUNNER collar on each wall face. Fix each collar with four '
            'M6 masonry anchors at least 50 mm long.'
        )
        return expected, steps, ['FCO 3576']

    fyrebatt = _fyrebatt_procedure(number)
    if fyrebatt is not None:
        return fyrebatt

    selected = next((values for ids, values in _FCO3527_SERVICES.items() if number in ids), None)
    if selected is None:
        return None
    service, configuration, wrap = selected
    expected = {**_FCO3527_FIELDS, 'Service': service, 'Service Size / Configuration': configuration,
                'Service Wrap': wrap}
    steps = _COLLAR_STEPS + (_COLLAR_WRAP if wrap == '300mm' else '\n4. This fibre-optic configuration is wrap-free.')
    return expected, steps, ['FCO 3527 Revision G']


def present_trafalgar_other_installation(record, fields):
    """Add a procedure only while the reviewed selector and its scope still match."""
    key = record.get('id', '')
    prefix = 'trafalgar-selector-'
    if not key.startswith(prefix):
        return fields
    number = key[len(prefix):]
    procedure = _procedure(number)
    if procedure is None:
        return fields
    by_label = {field['label']: field for field in fields}
    if len(by_label) != len(fields) or _INSTALLATION in by_label:
        return fields
    expected, steps, sources = procedure
    if any(by_label.get(label, {}).get('value') != value for label, value in expected.items()):
        return fields
    corrections = _FYREBATT_CORRECTIONS.get(number, {})
    if corrections:
        if ('Source Issues' in by_label
                or not any(link.get('url') == _FYREBATT_REPORT_URL
                           for link in by_label['Report Number'].get('report_links', []))):
            return fields
        if number == '1236' and by_label.get('Barrier Type', {}).get('value') not in (None, '', 'Walls'):
            return fields
    reviewed = [
        {**field, 'value': corrections[field['label']]} if field['label'] in corrections else field
        for field in fields
    ]
    insertion = reviewed.index(by_label['Report Number'])
    reviewed.insert(insertion, {'label': _INSTALLATION, 'value': steps, 'source_labels': sources})
    return reviewed
