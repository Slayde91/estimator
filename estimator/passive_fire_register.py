"""Validate portable register drafts and render completed installation records."""
import base64
import binascii
from io import BytesIO
from uuid import UUID

from PIL import Image as PillowImage, UnidentifiedImageError
from reportlab.lib.pagesizes import A4
from reportlab.platypus import Image, PageBreak, SimpleDocTemplate, Spacer, Table

from .catalog import ValidationError
from .company_settings import company_logo
from .documentation_catalog import register_options
from .pdf_fonts import FONT_REGULAR
from .report import _Report, _company_header, _register_fonts, _LINE, _MUTED
from .swms import _text, validate_signature
from .swms_pdf import Signature


FIELDS = {
    'location': 'Location', 'seal_type': 'Seal type', 'frl': 'FRL',
    'substrate': 'Substrate', 'orientation': 'Orientation',
    'installation_type': 'Installation type', 'service_types': 'Service type',
    'manufacturer': 'Manufacturer', 'report': 'Report', 'products': 'Products',
}
PHASES = {'before': 'Before', 'during': 'During', 'after': 'After', 'label': 'Label'}
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
    other = {'side1', 'side2', 'access', 'photos', 'comments', 'solution', 'signature'}
    if numbered:
        other.update(('entry_id','number'))
    _fields(raw, set(FIELDS) | other, 'Register entry')
    identity,number = _entry_number(raw,position,numbered)
    entry = {'entry_id':identity,'number':number}
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
    return entry


def _entry_number(raw, position, numbered):
    number = raw.get('number') if numbered else position
    if type(number) is not int or not 1<=number<=MAX_NUMBER:
        raise ValidationError('The register entry number is invalid.')
    if numbered:
        identity = raw.get('entry_id')
        try:
            valid = isinstance(identity,str) and str(UUID(identity))==identity
        except ValueError:
            valid = False
        if not valid:
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
    _fields(value, {'entries','next_number'}, 'Passive Fire Register')
    source = value.get('entries')
    if not isinstance(source, list) or len(source) > 200:
        raise ValidationError('The Passive Fire Register accepts up to 200 entries.')
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


def _ready(entry, number, options):
    reports = options['reports'].get(entry['manufacturer'], [])
    required = [label for key, label in FIELDS.items()
                if not entry[key] and (key != 'report' or reports)]
    for key, choices in options.items():
        if key == 'reports' or (key == 'solution' and entry['access'] != 'NA'):
            continue
        values = entry[key] if isinstance(entry[key], list) else [entry[key]]
        if any(value and value not in choices for value in values):
            raise ValidationError(f'Choose a listed {FIELDS.get(key, key)} for register entry {number}.')
    if entry['report'] and entry['report'] not in reports:
        raise ValidationError(f'Choose a report matching the manufacturer for register entry {number}.')
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
        raise ValidationError(f'Complete register entry {number}: ' + ', '.join(required) + '.')


def _append_evidence(report, title, groups, width):
    # Keep each caption with its own image. Later rows can flow to a fresh
    # page and still identify the side and stage of every photo.
    cells = []
    for label, photos in groups:
        for index, photo in enumerate(photos, 1):
            image = Image(BytesIO(base64.b64decode(photo[len(JPEG_PREFIX):])))
            image._restrictSize(width / 2 - 12, 124)
            image.hAlign = 'LEFT'
            caption = f'{title} - {label}'
            if len(photos) > 1:
                caption += f' ({index}/{len(photos)})'
            cells.append([report.p(caption, 'subheading'), image])
    if cells:
        rows = [cells[index:index + 2] for index in range(0, len(cells), 2)]
        report.story.append(Table(rows, colWidths=[width / 2] * 2,
                                  style=[('VALIGN', (0, 0), (-1, -1), 'TOP')]))


def render_register_pdf(register, details, *, company):
    entries = normalize_register(register)['entries']
    if not entries:
        raise ValidationError('Add a register entry before downloading the PDF.')
    options = register_options()
    for index, entry in enumerate(entries, 1):
        _ready(entry, index, options)
    _register_fonts()
    report = _Report({})
    logo = company_logo(company)
    output = BytesIO()
    margin = 36
    width, height = A4
    content = width - 2 * margin - 12
    document = SimpleDocTemplate(output, pagesize=A4, leftMargin=margin, rightMargin=margin,
                                 topMargin=90, bottomMargin=43, title='Passive Fire Register',
                                 author=company.get('name') or 'CLASSIFIRE')

    for number, entry in enumerate(entries, 1):
        if number > 1:
            report.story.append(PageBreak())
        report.story.extend([report.p('Passive Fire Register', 'title'),
                             report.p(f'Entry {number} of {len(entries)}', 'small')])
        rows = []
        for label, value in [('Project number', details.get('project_no')), ('Client', details.get('client')),
                             ('Site address', details.get('site_address'))]:
            if value:
                rows.append((label, value))
        for key, label in FIELDS.items():
            value = entry[key]
            if value:
                rows.append((label, ', '.join(value) if isinstance(value, list) else value))
        rows.append(('Access to the other side', entry['access']))
        if entry['access'] == 'NA':
            rows.append(('Solution', entry['solution']))
        cells = [[report.p(label, 'cell'), report.p(value, 'cell')] for label, value in rows]
        cells.append([report.p('Signature', 'cell'), Signature(entry['signature'], 144, 36)])
        report.story.append(report.table(['Installation record', 'Details'],
                                         cells, [content * .32, content * .68], compact=True))
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
        _company_header(canvas, logo, width, height, margin, 'Passive Fire Register', company=company)
        canvas.setStrokeColor(_LINE)
        canvas.line(margin, 32, width - margin, 32)
        canvas.setFillColor(_MUTED)
        canvas.setFont(FONT_REGULAR, 7.5)
        canvas.drawString(margin, 20, 'Passive Fire Register')
        canvas.drawRightString(width - margin, 20, f'Page {doc.page}')
        canvas.restoreState()

    document.build(report.story, onFirstPage=decorate, onLaterPages=decorate)
    return output.getvalue()
