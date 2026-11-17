"""Validate portable register drafts and render completed installation records."""
import base64
import binascii
from io import BytesIO

from PIL import Image as PillowImage, UnidentifiedImageError
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.platypus import Image, PageBreak, SimpleDocTemplate, Spacer, Table

from .catalog import ValidationError
from .company_settings import company_logo
from .date_display import display_date
from .documentation_catalog import register_options
from .document_theme import THEMES
from .library_filter_groups import display_category
from .pdf_fonts import FONT_REGULAR
from .report import _Report, _company_header, _register_fonts, _LINE, _MUTED, table_outline
from .reference_library import INSPECTION_FILTERS, ReferenceNotFound, identifier
from .technical_item_exports import (append_technical_heading, append_technical_tables,
                                     prepare_technical_item, technical_pdf_rows)
from .register_plans import _uuid, penetration_ids
from .swms import _date, _text, validate_signature
from .swms_pdf import Signature


FIELDS = {
    'location': 'Location', 'seal_type': 'Seal type', 'frl': 'FRL',
    'substrate': 'Substrate', 'orientation': 'Orientation',
    'installation_type': 'Installation type', 'service_types': 'Service type',
    'manufacturer': 'Manufacturer', 'report': 'Report', 'products': 'Products',
}
PHASES = {'before': 'Before', 'during': 'During', 'after': 'After', 'label': 'Label'}
LEGACY_CUSTOM_FIELDS = ('seal_type', 'installation_type', 'service_types')
JPEG_PREFIX = 'data:image/jpeg;base64,'
MAX_PHOTO_BYTES = 1_048_576
MAX_ENCODED_PHOTOS = 10 * 1_048_576
MAX_NUMBER = 999_999_999


def _fields(value, keys, label):
    if not isinstance(value, dict) or set(value) - keys:
        raise ValidationError(f'{label} contains unsupported fields.')
    return value


def _selection(value, label):
    if not isinstance(value, list) or len(value) > 100:
        raise ValidationError(f'{label} must be a list of up to 100 choices.')
    values = [_text(item, label, 300).strip() for item in value]
    if not all(values) or len(set(values)) != len(values):
        raise ValidationError(f'{label} contains an empty or duplicate choice.')
    return values


def _photos(value):
    if not isinstance(value, list) or len(value) > 20:
        raise ValidationError('Each register photo field accepts up to 20 photos.')
    return list(value)


def _entry(raw, position, numbered):
    other = {'side1', 'side2', 'access', 'photos', 'comments', 'solution', 'signature',
             'signature_details', 'technical_item_id', 'plan_pins'}
    if numbered:
        other.update(('entry_id','number'))
    if isinstance(raw, dict) and 'technical_item_id' in raw:
        other.update(('technical_filters', 'custom_entry'))
    _fields(raw, set(FIELDS) | other, 'Register entry')
    identity,number = _entry_number(raw,position,numbered)
    entry = {'entry_id':identity,'number':number}
    if 'technical_item_id' in raw:
        key = raw['technical_item_id']
        entry['technical_item_id'] = '' if key == '' else identifier(key)
        if type(raw.get('custom_entry', False)) is not bool:
            raise ValidationError('Custom entry must be a checkbox value.')
        if raw.get('custom_entry'):
            if key:
                raise ValidationError('A custom inspection cannot also reference a Technical Library item.')
            entry['custom_entry'] = True
        if 'technical_filters' in raw:
            selected = _fields(raw['technical_filters'], set(INSPECTION_FILTERS), 'Technical Library filters')
            entry['technical_filters'] = {facet: _text(value, facet.capitalize(), 1000).strip() for facet, value in selected.items()}
            if 'category' in selected:
                entry['technical_filters']['category'] = display_category(entry['technical_filters']['category'])
    for key, label in FIELDS.items():
        if key in ('service_types', 'products'):
            entry[key] = _selection(raw.get(key, []), label)
        else:
            entry[key] = _text(raw.get(key, ''), label, 1000).strip()
    for side in ('side1', 'side2'):
        keys = {'id_number', *PHASES}
        if numbered:
            keys.add('previous_id')
        values = _fields(raw.get(side, {}),keys,'Register side')
        entry[side] = {**_side_number(values,side,number,numbered),
                       **{key: _photos(values.get(key, [])) for key in PHASES}}
    entry['access'] = _text(raw.get('access', ''), 'Access', 3)
    entry['solution'] = _text(raw.get('solution', ''), 'Solution', 100)
    entry['photos'] = _photos(raw.get('photos', []))
    entry['comments'] = _text(raw.get('comments', ''), 'Comments', 4000).strip()
    entry['signature'] = validate_signature(raw.get('signature'))
    if 'technical_item_id' in entry and not entry['signature']:
        selected = entry.get('technical_filters', {})
        entry['technical_filters'] = {facet: selected.get(facet, '') for facet in INSPECTION_FILTERS}
    if 'signature_details' in raw:
        details = _fields(raw['signature_details'], {'member_id', 'name', 'date'}, 'Signature details')
        name = _text(details.get('name'), 'Signer name', 8000).strip()
        day = _date(details.get('date'), 'Signing date')
        if not entry['signature'] or not _uuid(details.get('member_id')) or not name or not day:
            raise ValidationError('Signature details require a signature, staff member, name and signing date.')
        entry['signature_details'] = {'member_id': details['member_id'], 'name': name, 'date': day}
    if 'plan_pins' in raw:
        from .register_plans import normalize_pins
        entry['plan_pins'] = normalize_pins(raw['plan_pins'])
    return entry


def _entry_number(raw, position, numbered):
    number = raw.get('number') if numbered else position
    if type(number) is not int or not 1<=number<=MAX_NUMBER:
        raise ValidationError('The register entry number is invalid.')
    if numbered:
        identity = raw.get('entry_id')
        if not _uuid(identity):
            raise ValidationError('The register entry identity is invalid.')
    else:
        # The register is local to one project. Reopening the same old file in a
        # second window must migrate its entries to the same stable identities.
        identity = f'00000000-0000-5000-8000-{position:012x}'
    return identity,number


def _side_number(values,side,number,numbered):
    side_number = f'{number:03d}' + ('-2' if side=='side2' else '')
    supplied = _text(values.get('id_number', ''), 'Side ID number', 200).strip()
    if numbered and supplied != side_number:
        raise ValidationError('Automatic register side IDs cannot be changed.')
    previous = _text(values.get('previous_id',''), 'Previous side ID',200).strip() if numbered else supplied
    result = {'id_number':side_number}
    if previous and previous!=side_number:
        result['previous_id'] = previous
    return result


def _photo_groups(entry):
    for side in ('side1', 'side2'):
        for phase in PHASES:
            yield entry[side][phase]
    yield entry['photos']


def _check_photos(entries):
    encoded_size = total_pixels = 0
    for entry in entries:
        for group in _photo_groups(entry):
            for photo in group:
                if not isinstance(photo, str) or not photo.startswith(JPEG_PREFIX):
                    raise ValidationError('Attach a JPEG image to the register.')
                encoded_size += len(photo)
                if encoded_size > MAX_ENCODED_PHOTOS:
                    raise ValidationError('Register photos exceed the 10 MiB combined encoded limit.')
                if len(photo) > len(JPEG_PREFIX) + 4 * ((MAX_PHOTO_BYTES + 2) // 3):
                    raise ValidationError('Each register photo must be at most 1 MiB.')
                try:
                    data = base64.b64decode(photo[len(JPEG_PREFIX):], validate=True)
                    if len(data) > MAX_PHOTO_BYTES:
                        raise ValidationError('Each register photo must be at most 1 MiB.')
                    with PillowImage.open(BytesIO(data), formats=['JPEG']) as image:
                        pixels = image.width * image.height
                        total_pixels += pixels
                        if pixels > 4_000_000 or total_pixels > 128_000_000:
                            raise ValidationError('Register photos exceed the image resolution limit.')
                        image.load()
                except ValidationError:
                    raise
                except (ValueError, binascii.Error, OSError, UnidentifiedImageError, PillowImage.DecompressionBombError) as error:
                    raise ValidationError('A register photo contains invalid JPEG data.') from error


def normalize_register(value, *, _validate_photos=True):
    """Project files may contain blank or partly completed entries."""
    _fields(value, {'entries','next_number'}, 'Passive Fire Inspections')
    source = value.get('entries')
    if not isinstance(source, list) or len(source) > 200:
        raise ValidationError('The Passive Fire Inspections accepts up to 200 entries.')
    numbered = 'next_number' in value
    entries = [_entry(row,index,numbered) for index,row in enumerate(source,1)]
    next_number = value.get('next_number',len(entries)+1)
    if type(next_number) is not int or not 1<=next_number<=MAX_NUMBER+1:
        raise ValidationError('The next register entry number is invalid.')
    if (any(row['number']>=next_number for row in entries) or len({row['number'] for row in entries})!=len(entries)
            or len({row['entry_id'] for row in entries})!=len(entries)):
        raise ValidationError('Register entries must have distinct IDs and numbers below the next available number.')
    if _validate_photos:
        _check_photos(entries)
    return {'entries':entries, 'next_number':next_number}


def preserve_register_numbers(previous, incoming):
    """The native project save token binds these checks to the exact file being replaced."""
    if isinstance(previous,dict) and 'next_number' in previous and (not isinstance(incoming,dict) or 'next_number' not in incoming):
        raise ValidationError('Reload this project before saving its numbered register.')
    def identities(register):
        # Recognise both raw and existing portable project shapes. Do not decode
        # every JPEG again inside the save lock that protects the identifier check.
        converted = normalize_register(register,_validate_photos=False)
        return converted['next_number'], {r['entry_id']:r for r in converted['entries']}
    prior_next, saved = identities(previous)
    new_next, rows = identities(incoming)
    if new_next < prior_next:
        raise ValidationError('The register number sequence cannot be reset.')
    # Imported files may already have high numbers. Only constrain the change
    # to a previously saved sequence. Ordinary add/remove gaps remain valid.
    if new_next-prior_next>1_000_000:
        raise ValidationError('The register number sequence advanced too far in one save.')
    for identity,row in rows.items():
        prior = saved.get(identity)
        if prior is None:
            valid = row['number']>=prior_next and not any(row[side].get('previous_id') for side in ('side1','side2'))
        else:
            valid = (row['number']==prior['number'] and
                     all(row[side].get('previous_id')==prior[side].get('previous_id') for side in ('side1','side2')))
        if not valid:
            raise ValidationError('Existing register side IDs cannot be reassigned or edited.')


def _ready(entry, options):
    ids = penetration_ids(entry)
    uses_library = 'technical_item_id' in entry
    custom = entry.get('custom_entry', False)
    reports = options['reports'].get(entry['manufacturer'], [])
    if uses_library:
        required = [] if entry['location'] else ['Location']
        selected = entry.get('technical_filters', {})
        if custom:
            if not entry['products']:
                required.append(FIELDS['products'])
            known_reports = any(name.casefold() == selected.get('manufacturer', '').casefold() for name in options['reports'])
            if known_reports and not entry['report']:
                required.append('Report/Assessment')
        elif not entry['technical_item_id']:
            required.append('Technical Library item')
        # Earlier inspections saved at most five facets, even when signed and exported.
        if custom or 'services' in selected or 'frl' in selected:
            required.extend('FRL' if key == 'frl' else key.capitalize()
                            for key in INSPECTION_FILTERS if not selected.get(key))
    else:
        required = [label for key, label in FIELDS.items()
                    if key not in LEGACY_CUSTOM_FIELDS and not entry[key] and (key != 'report' or reports)]
    for key, choices in options.items():
        if key in LEGACY_CUSTOM_FIELDS or (uses_library and key in FIELDS and not (custom and key == 'products')):
            continue
        if key == 'reports' or (key == 'solution' and entry['access'] != 'NA'):
            continue
        values = entry[key] if isinstance(entry[key], list) else [entry[key]]
        if any(value and value not in choices for value in values):
            raise ValidationError(f'Penetration ID {ids}: choose a listed {FIELDS.get(key, key)}.')
    if not uses_library and entry['report'] and entry['report'] not in reports:
        raise ValidationError(f'Penetration ID {ids}: choose a report matching the manufacturer.')
    for side in (('side1', 'side2') if entry['access'] == 'Yes' else ('side1',)):
        values = entry[side]
        for key, label in {'id_number': 'ID number', **PHASES}.items():
            if not values[key]:
                required.append(f'Side {side[-1]} {label.lower()}')
    if not entry['access']:
        required.append('Access to the other side')
    if entry['access'] == 'No' and not entry['photos']:
        required.append('Additional photos')
    if entry['access'] == 'NA' and not entry['solution']:
        required.append('Solution')
    if not entry['signature']:
        required.append('Signature')
    if required:
        raise ValidationError(f'Penetration ID {ids}: complete ' + ', '.join(required) + '.')


def _append_evidence(report, title, groups, width):
    # Keep each caption with its own image. Later rows can flow to a fresh
    # page and still identify the side and stage of every photo.
    cells = []
    for label, photos in groups:
        for index, photo in enumerate(photos, 1):
            image = Image(BytesIO(base64.b64decode(photo[len(JPEG_PREFIX):])))
            image._restrictSize(width / 2 - 12, 124)
            caption = f'{title} - {label}'
            if len(photos) > 1:
                caption += f' ({index}/{len(photos)})'
            cells.append([report.p(caption, 'photo_caption'), image])
    if cells:
        rows = [cells[index:index + 2] for index in range(0, len(cells), 2)]
        styles = [('VALIGN', (0, 0), (-1, -1), 'TOP'), ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                  ('INNERGRID', (0, 0), (-1, -1), .35, _INSPECTION_RED)]
        if len(rows[-1]) == 1:
            rows[-1].append('')
            styles.append(('SPAN', (0, -1), (1, -1)))
        report.story.append(Table(rows, colWidths=[width / 2] * 2,
                                  style=styles, renderCB=table_outline(_INSPECTION_RED)))


_INSPECTION_ORDER = ('Location', 'Substrate', 'Type', 'Orientation', 'Manufacturer',
                     'Penetration ID', 'System ID', 'Category', 'Service')
_INSTRUCTION_FIELDS = {'service wrap', 'local protection', 'installation details', 'installation instructions'}
_OMITTED_INSPECTION_FIELDS = _INSTRUCTION_FIELDS | {'barrier construction'}
_INSPECTION_RED = HexColor(THEMES['ceasefire'])


def _inspection_fields(report, entry, item):
    """Combine recorded site details and source fields in one printable table."""
    rows = [('Location', report.p(entry['location'], 'cell')),
            ('Penetration ID', report.p(penetration_ids(entry), 'cell'))]
    if item:
        rows.extend(('System ID' if label.casefold() == 'id' else label, cell)
                    for label, cell in technical_pdf_rows(report, item)
                    if label.casefold() not in _OMITTED_INSPECTION_FIELDS)
        source_code = item['record'].get('source_code')
        if source_code and not any(label == 'System ID' for label, _ in rows):
            rows.append(('System ID', report.p(source_code, 'cell')))
    elif entry.get('custom_entry'):
        selected = entry['technical_filters']
        labels = {'frl': 'FRL', 'services': 'Service'}
        rows.extend((labels.get(key, key.capitalize()), report.p(selected[key], 'cell')) for key in INSPECTION_FILTERS)
        for key in (*LEGACY_CUSTOM_FIELDS, 'products', 'report'):
            value = entry[key]
            if value:
                label = 'Report Number' if key == 'report' else FIELDS[key]
                rows.append((label, report.p(', '.join(value) if isinstance(value, list) else value, 'cell')))
    else:
        # Legacy inspections store the installation type and services directly.
        legacy_labels = {'installation_type': 'Type', 'service_types': 'Service', 'report': 'Report Number'}
        for key, label in FIELDS.items():
            value = entry[key]
            if value and key != 'location':
                rows.append((legacy_labels.get(key, label), report.p(', '.join(value) if isinstance(value, list) else value, 'cell')))
    order = {label: index for index, label in enumerate(_INSPECTION_ORDER)}
    # Keep other source fields in their original order and keep linked report numbers together.
    order['Report Number'] = len(_INSPECTION_ORDER) + 1
    rows.sort(key=lambda row: order.get(row[0], len(_INSPECTION_ORDER)))
    rows.append(('Access to the other side', report.p(entry['access'], 'cell')))
    if entry['access'] == 'NA':
        rows.append(('Solution', report.p(entry['solution'], 'cell')))
    signer = entry.get('signature_details') or {}
    rows.extend([('Name', report.p(signer.get('name') or '—', 'cell')),
                 ('Date', report.p(display_date(signer.get('date')) or '—', 'cell')),
                 ('Signature', Signature(entry['signature'], 144, 36))])
    return [[report.p(label, 'head'), cell] for label, cell in rows]


def render_register_pdf(register, details, *, library=None, company, plan_append=None):
    entries = normalize_register(register)['entries']
    if not entries:
        raise ValidationError('Add a register entry before downloading the PDF.')
    options = register_options()
    for entry in entries:
        _ready(entry, options)
    _register_fonts()
    report = _Report({})
    report.styles['photo_caption'] = report.styles['subheading'].clone('InspectionPhotoCaption', alignment=TA_CENTER)
    logo = company_logo(company)
    output = BytesIO()
    margin = 36
    width, height = A4
    content = width - 2 * margin - 12
    document = SimpleDocTemplate(output, pagesize=A4, leftMargin=margin, rightMargin=margin,
                                 topMargin=90, bottomMargin=43, title='Passive Fire Inspections',
                                 author=company.get('name') or 'CLASSIFIRE')

    report.story.append(report.p('Passive Fire Inspections', 'title'))
    project_rows = [[report.p(label, 'head'), report.p(details[key], 'cell')]
                    for key, label in [('project_no', 'Project number'), ('client', 'Client'), ('site_address', 'Site address')]
                    if details.get(key)]
    if project_rows:
        report.story.append(report.table(None, project_rows, [content * .3, content * .7],
                                         compact=True, row_header_color=_INSPECTION_RED, grid_color=_INSPECTION_RED))
        report.story.append(Spacer(1, 10))
    for number, entry in enumerate(entries, 1):
        if number > 1:
            report.story.append(PageBreak())
        item = None
        if key := entry.get('technical_item_id'):
            try:
                if library is None:
                    raise ReferenceNotFound()
                item = prepare_technical_item({'id': key}, library=library, include_diagrams=False,
                                              inspection_filters=entry.get('technical_filters', {}))
            except ReferenceNotFound as err:
                raise ValidationError(f'Penetration ID {penetration_ids(entry)}: the Technical Library item is unavailable. Select a replacement before downloading.') from err
            append_technical_heading(report, item)
        report.story.append(report.table(None, _inspection_fields(report, entry, item),
                                         [content * .3, content * .7], compact=True,
                                         row_header_color=_INSPECTION_RED, grid_color=_INSPECTION_RED))
        if item:
            append_technical_tables(report, (table for table in item['tables']
                                             if table['label'].casefold() not in _INSTRUCTION_FIELDS),
                                    content, row_header_color=_INSPECTION_RED, grid_color=_INSPECTION_RED)
        if entry['comments'] and entry['access'] == 'No':
            report.story.extend([report.p('Comments', 'subheading'), report.p(entry['comments'])])
        for side in (('side1', 'side2') if entry['access'] == 'Yes' else ('side1',)):
            values = entry[side]
            report.story.append(Spacer(1, 6))
            if values.get('previous_id'):
                report.story.append(report.p(f'Side {side[-1]} previous ID: {values["previous_id"]}', 'small'))
            _append_evidence(report, f'Side {side[-1]} - {values["id_number"]}',
                             ((label, values[key]) for key, label in PHASES.items()), content)
        if entry['access'] == 'No':
            _append_evidence(report, 'Additional photos', [('Access', entry['photos'])], content)

    def decorate(canvas, doc):
        canvas.saveState()
        _company_header(canvas, logo, width, height, margin, 'Passive Fire Inspections', company=company)
        canvas.setStrokeColor(_LINE)
        canvas.line(margin, 32, width - margin, 32)
        canvas.setFillColor(_MUTED)
        canvas.setFont(FONT_REGULAR, 7.5)
        canvas.drawString(margin, 20, 'Passive Fire Inspections')
        canvas.drawRightString(width - margin, 20, f'Page {doc.page}')
        canvas.restoreState()

    document.build(report.story, onFirstPage=decorate, onLaterPages=decorate)
    if any(entry.get('plan_pins') for entry in entries):
        if plan_append is None:
            raise ValidationError('Open the project with its Takeoffs drawings to download the pinned plans.')
        return plan_append(output.getvalue(), entries)
    return output.getvalue()
