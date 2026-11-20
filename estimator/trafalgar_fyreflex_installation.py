"""The wrap-free NB40 configuration verified against FCO-1579 Rev M."""

# https://tfire.com.au/documents/FyreFLEX-Test-Report
# Report SHA-256 28e744ad31f57480f71fdebc9e5f1a266d28d1646b09f4592d4ad7b1b2bebff3.
# Page 34, Table 10: the NB40 wrap-free branch shares the single-mesh AAC,
# gap and seal depth conditions. It has its own fillet and FRL values.
_SCOPE = {
    'Manufacturer': 'Trafalgar',
    'System Products': 'FyreFLEX Sealant',
    'Orientation': 'Vertical',
    'Barrier Construction': 'Hebel 75mm',
    'Service': 'Pipes - Steel',
    'Service Size / Configuration': 'Up to NB40',
    'FRL': '-/90/60',
    'Maximum Opening Size': '10 mm Annular Gap',
    'Service Wrap': 'No TWrap required',
    'Seal Depth / Fillet Size': 'Full depth of Hebel / 40x40mm (Both Sides)',
    'Report Number': 'FCO 1579',
}


def trafalgar_fyreflex_installation(record, fields):
    if record.get('id') != 'trafalgar-selector-8653':
        return fields
    values = {field['label']: field.get('value') for field in fields}
    if (len(values) != len(fields) or any(label in values for label in ('Installation Details', 'Assessment Scope', 'Source Issues'))
            or any(values.get(label) != value for label, value in _SCOPE.items())):
        return fields
    index = next(index for index, field in enumerate(fields) if field['label'] == 'Report Number')
    return [*fields[:index], {
        'label': 'Installation Details',
        'value': ('Use a medium-grade NB40 steel pipe in a single-mesh reinforced AAC panel wall at least '
                  '75 mm thick with a barrier rating of -/90/90. Keep the gap around the pipe to 10 mm or less. '
                  'Fill it through the full panel depth with FyreFLEX and finish with a minimum 40 × 40 mm '
                  'FyreFLEX fillet on both faces. Leave the pipe unwrapped.'),
        'source_labels': ['FCO 1579 Rev M'],
    }, {
        'label': 'Assessment Scope',
        'value': 'The selector says up to NB40. The assessed wrap-free configuration specifically lists NB40.',
    }, *fields[index:]]
