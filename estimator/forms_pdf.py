"""Downloadable PDFs from the saved form record and its versioned template."""
import base64
from datetime import datetime
from functools import lru_cache
from io import BytesIO
from math import ceil


from PIL import Image as PILImage, ImageOps
from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.platypus import Image, LongTable, PageBreak, Paragraph, SimpleDocTemplate, Spacer, TableStyle

from .document_theme import THEMES
from .catalog import ROOT
from .date_display import display_date
from .pdf_fonts import FONT_BOLD, PdfParagraphStyle, register_pdf_fonts
from .forms_pdf_fonts import font_text
from .forms_pdf_browser import render_shaped_pdf
from .rich_paragraphs import RichParagraphs
from .form_fields import is_person_group


IMAGES = {'image/png','image/jpeg','image/webp','image/gif'}


def _dated(value):
    if not value:
        return ''
    date, separator, clock = str(value).partition('T')
    return str(display_date(date)) + (' ' + clock.replace('Z',' UTC') if separator else '')


def _joined(*parts):
    return ' · '.join(str(part) for part in parts if part is not None and part != '')


def _image(encoded, width, height):
    # Template and record evidence is embedded data. Never interpret it as an image URL.
    try:
        source = BytesIO(base64.b64decode(encoded.split(',')[-1],validate=True))
        with PILImage.open(source) as original:
            # JPEG draft mode decodes a smaller raster directly, including modern phone photos.
            if original.format == 'JPEG':
                original.draft('RGB',(1800,1800))
            if original.width * original.height > 32_000_000:
                raise ValueError('image dimensions')
            original.thumbnail((1800,1800))
            picture = ImageOps.exif_transpose(original)
            data = BytesIO()
            if original.format == 'PNG' or 'A' in picture.getbands() or 'transparency' in picture.info:
                picture.convert('RGBA').save(data,format='PNG')
            else:
                picture.convert('RGB').save(data,format='JPEG',quality=90)
            scale = min(width / picture.width,height / picture.height,1)
            data.seek(0)
            output = Image(data,width=picture.width*scale,height=picture.height*scale)
            output.hAlign = 'LEFT'
            output.form_image = data
            return output
    except (ValueError,OSError,PILImage.DecompressionBombError):
        return Paragraph('Image unavailable in this PDF.',PdfParagraphStyle('image warning',fontSize=9,leading=12))


def _visible(fields, values):
    available = set()
    for field in fields:
        condition = field.get('condition')
        if condition:
            source = values.get(condition['field_id'])
            if isinstance(source,dict):
                source = source.get('answer')
            matches = condition['value'] in source if isinstance(source,list) else source == condition['value']
            if condition['field_id'] not in available or not matches:
                continue
        available.add(field['id'])
        if not field.get('hide_in_pdf'):
            yield field


def _relationship_ids(fields, values):
    for field in _visible(fields, values):
        value = values.get(field['id'])
        if field['type'] == 'relationship' and value:
            yield value['entry_id']
        elif field['type'] in ('group', 'table'):
            children = field['children'] if field['type'] == 'group' else field['columns']
            for row in value or []:
                yield from _relationship_ids(children, row)


def render_form_pdf(entry, theme, company, staff, reference):
    """Append accessible related forms once, retaining each saved template's layout."""
    resolved = {entry['id']: entry}

    def lookup(record_id):
        if record_id not in resolved:
            resolved[record_id] = reference(record_id)
        return resolved[record_id]

    records = [entry]
    seen = {entry['id']}
    for record in records:
        for record_id in _relationship_ids(record['template']['fields'], record['values']):
            if record_id in seen:
                continue
            seen.add(record_id)
            linked = lookup(record_id)
            if linked:
                records.append(linked)
    if len(records) == 1:
        return _render_form_pdf(entry, theme, company, staff, lookup)
    output = BytesIO()
    with PdfWriter() as writer:
        for record in records:
            pdf = PdfReader(BytesIO(_render_form_pdf(record, theme, company, staff, lookup)))
            writer.append(pdf, outline_item=record['template']['name'])
        writer.add_metadata({'/Title': entry['template']['name'], '/Author': entry['created_by_name']})
        writer.write(output)
    return output.getvalue()


def _render_form_pdf(entry, theme, company, staff, reference):
    register_pdf_fonts()
    template = entry['template']
    settings = template['settings']
    size = landscape(A4) if settings.get('orientation') == 'landscape' else A4
    output = BytesIO()
    doc = SimpleDocTemplate(output,pagesize=size,title=template['name'],author=entry['created_by_name'],
                            leftMargin=15*mm,rightMargin=15*mm,topMargin=15*mm,bottomMargin=15*mm)
    # The standard ReportLab frame has six points of internal padding on each side.
    width, height = doc.width - 12, doc.height - 12
    accent = colors.HexColor(THEMES[theme])
    story, appendix = [], []
    people = {member['id']:member['name'] for member in staff}
    normal = PdfParagraphStyle('answer',fontSize=9,leading=13,spaceAfter=3)
    label = PdfParagraphStyle('label',parent=normal,fontName=FONT_BOLD,textColor=accent,
                              spaceBefore=6,spaceAfter=3,keepWithNext=True)
    headline = PdfParagraphStyle('title',parent=label,fontSize=16,leading=21)
    header = PdfParagraphStyle('column',parent=normal,fontName=FONT_BOLD,textColor=colors.white)

    needs_shaping = False
    def formatted_text(text, style):
        nonlocal needs_shaping
        markup, fallback = font_text(text,style.fontName)
        needs_shaping = needs_shaping or fallback
        return markup

    def p(value, style=normal):
        text = str(value)
        result = Paragraph(formatted_text(text, style),style)
        result.form_text = text
        return result

    def rich_paragraphs(value):
        if not isinstance(value,dict):
            return [p(value)]
        parser = RichParagraphs(lambda text: formatted_text(text, normal))
        parser.feed(value['html'])
        parser.flush()
        parts = []
        for markup in parser.paragraphs:
            paragraph = Paragraph(markup, normal)
            paragraph.form_markup = markup
            parts.append(paragraph)
        return parts

    def grid(rows, widths, headers=True):
        result = LongTable(rows,colWidths=widths,repeatRows=int(headers),splitInRow=1,hAlign='LEFT')
        style = [('VALIGN',(0,0),(-1,-1),'TOP'),('LINEBELOW',(0,0),(-1,-1),.5,colors.lightgrey)]
        if headers:
            style.append(('BACKGROUND',(0,0),(-1,0),accent))
        result.setStyle(TableStyle(style))
        result.form_rows = rows,widths,headers
        return result

    @lru_cache(maxsize=128)
    def link_name(record_id):
        linked = reference(record_id)
        return _joined(linked.get('name'),linked.get('created_by_name'),_dated(linked.get('created_at'))) or 'Form unavailable'

    def answer(field,value,max_width):
        kind = field['type']
        if kind == 'instruction':
            return rich_paragraphs(field.get('help') or '—')
        if value is None or value == '' or value == []:
            return [p('—')]
        if kind == 'textarea':
            return rich_paragraphs(value)
        if kind in ('attachment','photo'):
            pieces = []
            for attachment in value:
                caption = attachment['name']
                if field.get('photo_size') in ('large','xl'):
                    if field.get('show_tags'):
                        caption = _joined(caption,', '.join(attachment.get('tags',[])))
                    if field.get('show_description'):
                        caption = _joined(caption,attachment.get('description'))
                pieces.append(p(caption))
                if attachment['type'] in IMAGES:
                    image_height = {'xs':34,'small':60,'medium':100,'large':160,'xl':220}.get(field.get('photo_size'),100)
                    pieces.append(_image(attachment['data'],max_width,image_height))
                if kind == 'photo' and settings.get('photo_appendix'):
                    appendix.append((_joined(field['label'],caption),attachment))
            return pieces
        if kind in ('sketch','manual_signature','signature') or kind == 'approval' and isinstance(value,dict):
            ink = None
            if isinstance(value,str):
                ink = value
            elif isinstance(value,dict):
                ink = value.get('image') or value.get('signature_image')
            parts = [_image(ink,max_width,100)] if ink else []
            if isinstance(value,dict):
                parts.append(p(_joined(value.get('member_name') or value.get('name'),value.get('company'),_dated(value.get('at')))))
            return parts or [p('—')]
        if kind in ('date','expiry_date','datetime'):
            value = _dated(value)
        elif kind in ('date_range','datetime_range'):
            value = ' – '.join(_dated(value.get(end)) for end in ('start','end') if value.get(end))
        elif kind == 'person':
            value = ', '.join(people.get(person,person) for person in (value if isinstance(value,list) else [value]))
        elif kind == 'scan_id' and people.get(value) not in (None,value):
            value = _joined(people[value],value)
        elif kind in ('lookup','relationship'):
            value = link_name(value['entry_id'])
        elif kind == 'action':
            who = value.get('assignee')
            value = _joined(value.get('description'),people.get(who,who),_dated(value.get('due_date')),value.get('status'))
        elif kind == 'location':
            value = f"{value.get('latitude')}, {value.get('longitude')}"
        elif kind == 'staff_wallet' and isinstance(value,dict):
            value = _joined(value.get('member_name'),value.get('role'),value.get('member_id'),_dated(value.get('at')))
        elif kind == 'yes_no' and isinstance(value,dict):
            value = _joined(value.get('answer'),value.get('explanation'))
        elif kind == 'approval':
            value = 'Approved' if value else 'Not approved'
        elif isinstance(value,list):
            value = ', '.join(str(item) for item in value)
        return [p(value)]

    def render_fields(fields, values):
        for field in _visible(fields,values):
            kind, value = field['type'], values.get(field['id'])
            if kind == 'page_break':
                story.append(PageBreak())
                continue
            story.append(p(field['label'],label))
            if field.get('help'):
                story.extend(rich_paragraphs(field['help']) if kind == 'instruction' else [p(field['help'])])
            if kind in ('section','instruction'):
                continue
            if kind == 'group' and value:
                row_title = 'Person' if is_person_group(field) else 'Group'
                for index,row in enumerate(value,1):
                    story.append(p(f'{row_title} {index}',label))
                    render_fields(field['children'],row)
            elif kind == 'table':
                columns = [col for col in field['columns'] if not col.get('hide_in_pdf')]
                # Wide custom tables continue in bands so even portrait reports stay readable.
                preferred = {'xs':48,'s':66,'m':82,'l':109,'xl':130,'xxl':153,'xxxl':180}
                bands = []
                for col in columns:
                    nominal = preferred.get(col.get('width'),82)
                    if not bands or sum(weight for _,weight in bands[-1]) + nominal > width:
                        bands.append([])
                    bands[-1].append((col,nominal))
                for band in bands:
                    total = sum(weight for _,weight in band)
                    widths = [width * weight / total for _,weight in band]
                    rows = [[p(col['label'],header) for col,_ in band]]
                    for data in value or []:
                        shown = {col['id'] for col in _visible(field['columns'],data)}
                        rows.append([answer(col,data.get(col['id']),cell_width-12) if col['id'] in shown else ''
                                     for (col,_),cell_width in zip(band,widths)])
                    story.extend([grid(rows,widths),Spacer(1,4)])
            else:
                story.extend(answer(field,value,width))

    timestamp = datetime.now().astimezone().isoformat(timespec='seconds')
    layout_values = {'workspace':company.get('name') or 'CLASSIFIRE','template_id':_joined('Template ID',settings.get('display_id') or template['id']),
                     'template_version':_joined('Template version',template['version']),'form_version':_joined('Form version',entry['version']),
                     'author':_joined('Created by',entry['created_by_name']),'record_id':_joined('Record ID',entry['id']),
                     'counter':_joined('Form counter', entry.get('form_counter') or 'Assigned when saved.'),
                     'generated_at':_joined('Print date and time',_dated(timestamp)),'disclaimer':'Printed version is uncontrolled'}
    attachments = settings.get('attachments',[])
    def layout(key):
        for item in settings.get(key,[]):
            align = item.get('align','left')
            if item['kind'] in ('logo','image'):
                if item['kind'] == 'logo':
                    encoded = company.get('logo') or base64.b64encode((ROOT/'static/classifire-logo.png').read_bytes()).decode()
                else:
                    encoded = next((file['data'] for file in attachments if file['name']==item.get('image') and file['type'] in IMAGES),None)
                if encoded:
                    image = _image(encoded,150,50)
                    image.hAlign = align.upper()
                    story.append(image)
            else:
                value = item.get('text','') if item['kind']=='text' else layout_values.get(item['kind'],'')
                align_style = PdfParagraphStyle('layout',parent=normal,alignment={'center':TA_CENTER,'right':TA_RIGHT}.get(align,TA_LEFT))
                story.append(p(value,align_style))

    layout('header_layout')
    story.extend([p(template['name'],headline),p(f"Template version {template['version']} · Form version {entry['version']}")])
    for text in (settings.get('display_id'),template.get('description'),settings.get('header')):
        if text:
            story.append(p(text))
    if attachments:
        story.append(p('Template attachments',label))
        story.extend(p(file['name']) for file in attachments)
    render_fields(template['fields'],entry['values'])
    if appendix:
        per_page = settings.get('photos_per_page',1)
        count = per_page if per_page in (1,2,4,6,8,10) else 1
        columns = 1 if count == 1 else 2
        for start in range(0,len(appendix),count):
            story.extend([PageBreak(),p('Photo appendix',headline)])
            cells = []
            for caption,file in appendix[start:start+count]:
                cell = [p(caption)]
                if file['type'] in IMAGES:
                    cell.append(_image(file['data'],width/columns-15,min(400,(height-64)/ceil(count/columns)-42)))
                cells.append(cell)
            rows = [cells[i:i+columns] for i in range(0,len(cells),columns)]
            story.append(grid(rows,[width/columns]*columns,False))
    if settings.get('footer'):
        story.append(p(settings['footer']))
    layout('footer_layout')
    stage_names = {stage['id']:stage['name'] for stage in settings.get('stages',[])}
    for key,action in [('approvals','Approved'),('reversals','Reopened')]:
        if entry.get(key):
            records = [[p(action+' stage',header),p(action+' by',header),p('Date',header)]]
            for event in entry[key]:
                signature = [p(event['member_name'])]
                if event.get('signature_image'):
                    signature.append(_image(event['signature_image'],width*.3,70))
                records.append([p(stage_names.get(event['stage_id'],event['stage_id'])),signature,p(_dated(event['at']))])
            story.extend([Spacer(1,6),grid(records,[width*.35,width*.3,width*.35])])
    def page_number(canvas,document):
        canvas.setFont(normal.fontName,8)
        canvas.drawRightString(size[0]-15*mm,9*mm,str(document.page))
    if needs_shaping:
        return render_shaped_pdf(story,template['name'],THEMES[theme],settings.get('orientation','portrait'))
    doc.build(story,onFirstPage=page_number,onLaterPages=page_number)
    return output.getvalue()
