"""Presentation-only groups for existing library filter choices.

Groups never classify records, change option values or participate in source,
duplicate-review or saved-link identities. Unrecognised choices stay available.
"""
import re


SERVICE_GROUPS = (
    ('Electrical & communications', frozenset({
        'Busbar Trunking', 'Cable Bundles', 'Cable Trays', 'Coaxial Cables',
        'Conduits', 'D1 Power Cables', 'D2 Comms Cables', 'Data Cables',
        'Downlights', 'Fibre Optic', 'Fire Resistant Cables', 'Power Cables',
        'Single Cables', 'TPS & Fire Alarm Cables', 'Communications Cables',
        'Wall Sockets',
    })),
    ('Mechanical', frozenset({'Pair Coils'})),
    ('HVAC', frozenset({'Fire Dampers', 'Flexible Ducts', 'Air Transfer Grilles'})),
    ('Plastic pipes', frozenset({'uPVC pipe', 'uPVC floorwaste', 'PEX pipe', 'HDPE pipe'})),
    ('Lagged metal pipes', frozenset({'Lagged Copper Pipes', 'Lagged Steel Pipes'})),
    ('Unlagged metal pipes', frozenset({'Copper Pipes', 'Steel Pipes'})),
)
_SERVICE_GROUP = {value: group for group, values in SERVICE_GROUPS for value in values}
_SERVICE_ORDER = {group: index for index, (group, _) in enumerate(SERVICE_GROUPS)}
_FRL = re.compile(r'(?:-|\d+)\s*/\s*(\d+)\s*/\s*(?:-|\d+)\Z')


def grouped_filter_options(key, options, records=()):
    """Return new option dictionaries with unchanged values and source labels."""
    copied = [dict(option) for option in options]
    if key in {'services', 'service_type'}:
        for option in copied:
            group = _SERVICE_GROUP.get(option['value'])
            if group:
                option['group'] = group
        # N/A, Mixed Services and unknown/custom choices are deliberately outside
        # a discipline group; neither N/A nor a mixed bundle is a new service.
        return sorted(copied, key=lambda option: _SERVICE_ORDER.get(option.get('group'), -1))
    if key == 'frl':
        for option in copied:
            match = _FRL.fullmatch(option['value'].strip())
            if match:
                # The centre criterion is integrity, irrespective of the first
                # or last criterion. Keep existing 90/300 and any future values.
                option['group'] = str(int(match[1]))
        return sorted(copied, key=lambda option: int(option['group']) if option.get('group', '').isdigit() else -1)
    if key in {'report', 'document'}:
        ownership, unattributed = {}, set()
        for item in records:
            values = item.get('filter_values', {})
            names = {name for name in values.get('manufacturer', []) if name.strip()}
            for report in values.get(key, []):
                ownership.setdefault(report, set()).update(names)
                if not names:
                    unattributed.add(report)
        for option in copied:
            names = ownership.get(option['value'], set())
            # A shared/missing attribution cannot be assigned to one supplier.
            # Leave that report standalone instead of inventing an ownership.
            if len(names) == 1 and option['value'] not in unattributed:
                option['group'] = next(iter(names))
        return sorted(copied, key=lambda option: option.get('group', '').casefold())
    return copied
