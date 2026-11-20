"""Source-verified SuperSTOPPER Circular procedures for exact AFS selector rows."""


# Trafalgar's Dincel & AFS Style Concrete Walls technical manual (p. 4)
# allows the Circular system with permanent formwork retained using FC10266.
# The AFS Rediwall guide identifies RW156C as having a nominal 151 mm concrete
# core. FC10266-01-5, 24 October 2024, Table 16 and figures 24–26 and 34
# supply the service conditions, annular gap, wall installation and wrap.
# https://docadmin.tfire.com.au/exfiles/TFire_Technical_Manual_Dincel_%26_AFS_Style_concrete_walls_080724.pdf
# https://afsformwork.com.au/wp-content/uploads/2024/11/AFS-Rediwall-DCI-Guides-2024.pdf
_REPORT_URL = 'https://tfire.com.au/documents/Superstopper-orange-box-Range-Test-Report'

_SERVICES = {
    'trafalgar-selector-8582': (
        'Pipes - Steel', 'Up to NB50', 'Uninsulated steel pipes up to NB50.'),
    'trafalgar-selector-8588': (
        'Paircoil Bundle', 'Up to 9.5 and 19mm Copper with up to 13mm PE insulation or 20mm FR insulation',
        'Copper paircoil pipes up to 9.5 mm and 19 mm with up to 13 mm PE or 20 mm fire-rated insulation.'),
    'trafalgar-selector-8595': (
        'Conduits - PVC', 'Rigid or Flexible Conduits up to 32mm',
        'Rigid or flexible uPVC conduits up to NB32, with or without cables.'),
}

_INSTALLATION = (
    'Centre the SuperSTOPPER Circular in the wall opening with an annular gap of up to 20 mm. '
    'Fit mounting flanges on both faces. Use the standard flange for gaps up to 5 mm. '
    'For larger gaps up to 20 mm, use the updated four-sided flange with backing rod or locking screws. '
    'Fill the annular gap with FyreFLEX to at least 20 mm deep from each face and finish without a fillet.\n\n'
    'Cut the foam end plugs to fit closely around the service and fit one at each end. Plug visible gaps '
    'with foam offcuts or FyreFLEX or FyrePEX sealant.\n\n'
    'Fit 25 mm thick TWrap over the casing and service to at least 300 mm from each face of the wall. '
    'Overlap the wrap by at least 50 mm along its length. Secure it with 4 mm wide steel cable ties '
    'at 200 mm centres, or with aluminium-reinforced tape around the wrap at each end and at the midpoint.'
)


def trafalgar_superstopper_installation_fields(record, fields):
    """Add the verified procedure when the selected variant still matches the source."""
    service = _SERVICES.get(record.get('id'))
    if not service:
        return fields
    service_name, service_size, scope = service
    expected = {
        'Manufacturer': 'Trafalgar',
        'System Products': 'SuperSTOPPER Circular',
        'Barrier Type': 'Walls',
        'Orientation': 'Vertical',
        'Barrier Construction': 'AFS RW156C',
        'Service': service_name,
        'Service Size / Configuration': service_size,
        'FRL': '-/120/120',
        'Annular Gap': 'up to 20mm',
        'Service Wrap': '300mm',
        'Seal Depth / Fillet Size': '20mm (Both Sides) / No Fillet',
        'Collar': 'Cutout to suit',
        'Report Number': 'FC10266-01-5',
    }
    field_by_label = {field['label']: field for field in fields}
    if len(field_by_label) != len(fields) or any(label in field_by_label for label in
            ('Installation Details', 'Assessment Scope', 'Source Issues')):
        return fields
    values = {label: field.get('value') for label, field in field_by_label.items()}
    if any(values.get(label) != value for label, value in expected.items()):
        return fields
    if any(values.get(label) for label in ('Maximum Opening Size', 'Max. Opening Size')):
        return fields
    if not any(link.get('url') == _REPORT_URL for link in field_by_label['Report Number'].get('report_links', [])):
        return fields

    reviewed = list(fields)
    index = reviewed.index(field_by_label['Report Number'])
    reviewed[index:index] = [
        {'label': 'Assessment Scope',
         'value': 'AFS Rediwall RW156C with its permanent formwork in place and a fire resistance level '
                  f'of at least -/120/120. {scope}',
         'source_labels': ['Trafalgar Dincel & AFS Style Concrete Walls technical manual', 'FC10266-01-5']},
        {'label': 'Installation Details', 'value': _INSTALLATION,
         'source_labels': ['FC10266-01-5']},
    ]
    return reviewed
