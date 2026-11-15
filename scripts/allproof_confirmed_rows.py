"""Eight rows from the January 2025 Allproof manuals with user-supplied corrections.

Keep the table locators, the reported values and the origin of the two
corrections visible in the installed entries and their exports.
"""


def confirmed_rows(family, source_url):
    if family == 'plumbing':
        return [{
            'key': 'plumbing-p43-t3-r01-floor',
            'title': 'Allproof DIFC100 — 90 mm HDPE pipe — 150 mm flat concrete slab — -/180/120',
            'page': 43,
            'source_url': source_url,
            'source_locator': 'Allproof Plumbing Technical Manual, January 2025, printed p. 40 '
                              '(PDF p. 43), flat slab table, row 1. Flat slab drawing on printed '
                              'p. 42. FRL corrected by the CLASSIFIRE user.',
            'additional_sources': [
                {'reference': 'Drop-in collar installation, printed p. 38', 'url': source_url, 'page': 41},
                {'reference': 'Flat slab installation detail, printed p. 42', 'url': source_url, 'page': 45},
            ],
            'reports': ['149096'],
            'diagrams': ['diagrams/p45-1.png'],
            'fields': {
                'System Products': 'Allproof Drop-In Fire Collar (DIFC100)',
                'Installation Type': 'Service penetration',
                'Barrier Type': 'Floor',
                'Barrier Construction': '150 mm flat concrete slab.',
                'Service': 'HDPE pipe',
                'Service Size / Configuration': '90 mm nominal HDPE pipe with 3.5 mm nominal wall '
                                                'thickness in a 142 mm opening.',
                'Installation Details': 'Core drill the opening and drop the collar in from above. '
                                        'Fix to the slab with two M5 × 22 mm metal pin anchors. '
                                        'At the underside, recess the collar by at most 5 mm or leave '
                                        'at most 60 mm exposed, as shown in the flat slab detail. '
                                        'Insert the pipe. Use PE backing rod as shown and seal the '
                                        'concrete-to-collar and collar-to-pipe gaps with Allproof MAS310 '
                                        'or Bostik Fireban One, at least 5 mm deep. Allproof recommends '
                                        '50 mm clearance from thermal or acoustic lagging.',
                'Install Notes': 'The flat slab table prints the FRL as “-180/120”. The CLASSIFIRE '
                                 'user confirmed -/180/120 on 16/11/2026. See report 149096. '
                                 'The manual describes the test end conditions as capped on the '
                                 'fire side and open on the non-fire side.',
            },
            'facets': {
                'substrate': ['Concrete/masonry floor'], 'orientation': ['Horizontal'],
                'type': ['Core hole'], 'category': ['Plumbing & Hydraulic'],
                'services': ['HDPE pipe'], 'frl': ['-/180/120'],
            },
        }]

    if family != 'electrical':
        raise ValueError(f'Unknown Allproof manual: {family}')

    cable_rows = (
        ('1 × TPS Cable', 'TPS & Fire Alarm Cables', 28, '-/30/30'),
        ('7 × TPS Cables', 'TPS & Fire Alarm Cables', 32, '-/30/-'),
        ('1 × CAT6 Data Cable', 'Data Cables', 28, '-/30/30'),
        ('10 × CAT6 Data Cables', 'Data Cables', 28, '-/30/30'),
        ('1 × Fire Alarm Cable', 'TPS & Fire Alarm Cables', 28, '-/30/30'),
        ('10 × Fire Alarm Cables', 'TPS & Fire Alarm Cables', 28, '-/30/30'),
        ('1 × 16 mm Mains Cable + 1 × 10 mm Earth Cable', 'Power Cables', 28, '-/30/30'),
    )
    rows = []
    for number, (service, service_group, opening, frl) in enumerate(cable_rows, 1):
        rows.append({
            'key': f'allproof-electrical-p10-r{number:02d}',
            'title': f'Allproof Low Profile Fire Collar ALLFC25: {service} — '
                     f'13 mm fire-rated plasterboard wall — {frl}',
            'page': 12,
            'source_url': source_url,
            'source_locator': 'Allproof Electrical Technical Manual, January 2025, printed p. 10 '
                              f'(PDF p. 12), cable table, row {number}, and dog screw detail. '
                              'Plasterboard specification confirmed by the CLASSIFIRE user.',
            'additional_sources': [
                {'reference': 'Low profile collar installation, printed p. 3', 'url': source_url, 'page': 5},
                {'reference': 'Collar dimensions and fixing tabs, printed p. 12', 'url': source_url, 'page': 14},
            ],
            'reports': ['148639'],
            'diagrams': ['diagrams/p12-dog.png'],
            'fields': {
                'System Products': 'Allproof Low Profile Fire Collar ALLFC25',
                'Installation Type': 'Face-fixed collar',
                'Barrier Type': 'Wall',
                'Barrier Construction': '90 mm wall with 64 mm steel studs and one layer of '
                                        '13 mm fire-rated plasterboard on each face.',
                'Service': service,
                'Service Size / Configuration': f'{service}. Penetration hole: {opening} mm.',
                'Installation Details': 'Use a flat, unobstructed mounting surface. Wrap a collar '
                                        'around the service at each wall face. Slide the tab into '
                                        'the slot and fold it back 180°. Fix both tabs on each '
                                        'collar directly into the plasterboard with 6.5 × 32 mm '
                                        'dog pan head screw anchors, clear of studs and framing. '
                                        'Apply fire-rated sealant between the service and plasterboard '
                                        'at both faces.',
                'Install Notes': 'The cable table heading says “non-fire rated”. The construction '
                                 'note specifies fire-rated plasterboard on both faces. The CLASSIFIRE '
                                 'user confirmed the construction note on 16/11/2026. See report 148639.',
            },
            'facets': {
                'substrate': ['Plasterboard wall'], 'orientation': ['Vertical'],
                'type': ['Core hole'], 'category': ['Electrical & Communications'],
                'services': [service_group], 'frl': [frl],
            },
        })
    return rows
