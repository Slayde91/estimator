"""Bounded template definitions and server validation of typed form answers."""
import base64
import binascii
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import json
import re
from uuid import uuid4

from .catalog import ValidationError
from .commercial_files import filename
from .form_calculations import DERIVED, derive_tables, parse_formula

ROLES = {'viewer', 'editor', 'admin'}
LAYOUT = {'instruction','section','page_break'}
TYPES = LAYOUT | {'text','textarea','number','date','datetime','date_range','datetime_range','expiry_date',
                  'choice','multichoice','yes_no','person','attachment','photo','sketch','location','signature',
                  'manual_signature','approval','counter','table','group','action','lookup','relationship',
                  'weather','profile','profile_name','profile_company','profile_phone','id_text','scan_id','staff_wallet'}
COLUMN_TYPES = {'text','textarea','number','date','time','datetime','choice','multichoice','yes_no','person',
                'attachment','photo','manual_signature','signature','location','instruction'} | DERIVED
OPTION_TYPES = {'choice','multichoice'}
SUMMARY_CELL_TYPES = {'text','textarea','number','date','datetime','time','choice','multichoice',
                      'yes_no','list_property','formula'}
MAX_FILE = 5 * 1024 * 1024
MAX_TOTAL = 12 * 1024 * 1024
MIME = re.compile(r'[a-zA-Z0-9.+_-]+/[a-zA-Z0-9.+_-]+')


def text(value, limit, label, *, required=False):
    if (not isinstance(value,str) or len(value) > limit or required and not value.strip()
            or any(ord(c)<32 and c not in '\t\n\r' or 0xD800<=ord(c)<=0xDFFF for c in value)):
        raise ValidationError(f'Enter valid {label} (up to {limit} characters).')
    return value


def identifier(value):
    if (not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', value)
            or value in {'constructor','prototype','__proto__'}):
        raise ValidationError('Use a valid form field or stage identifier.')
    return value


def _roles(value, allowed):
    if (not isinstance(value,list) or not value or any(not isinstance(v,str) or v not in allowed for v in value)
            or len(value) != len(set(value))):
        raise ValidationError('Choose permitted Settings roles for this form.')
    return value


def _size_limited(value, size):
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
    except (ValueError, UnicodeError, RecursionError):
        raise ValidationError('Form data contains an invalid value.') from None
    if len(encoded) > size:
        raise ValidationError('The form exceeds its storage limit.')


def _options(value):
    if not isinstance(value,list) or len(value)>500:
        raise ValidationError('Use up to 500 choices per field.')
    for item in value:
        text(item,500,'choice text',required=True)
    if len(set(value)) != len(value):
        raise ValidationError('Each field choice must be distinct.')


def validate_template(body,staff=None):
    allowed = {'id','version','name','description','roles','status','mode','settings','fields'}
    if set(body)-allowed:
        raise ValidationError('The form template contains unknown properties.')
    _size_limited(body,2*1024*1024)
    name = text(body.get('name'),200,'template name',required=True).strip()
    description = text(body.get('description',''),4000,'template description')
    roles = _roles(body.get('roles'),ROLES)
    status, mode = body.get('status'), body.get('mode','timeline')
    if status not in ('draft','published','archived') or mode not in ('timeline','workflow'):
        raise ValidationError('Choose a valid template status and mode.')
    fields = body.get('fields')
    settings = body.get('settings',{})
    if not isinstance(settings,dict) or not isinstance(fields,list):
        raise ValidationError('Include the form settings and fields.')
    if status=='published' and not fields:
        raise ValidationError('Add at least one field before publishing.')
    stages = settings.get('stages',[])
    if not isinstance(stages,list) or len(stages)>50 or mode=='workflow' and status=='published' and not stages:
        raise ValidationError('Configure the workflow stages before publishing.')
    stage_ids = set()
    for stage in stages:
        if not isinstance(stage,dict):
            raise ValidationError('Include each stage name and permitted roles.')
        key = identifier(stage.get('id'))
        stage_roles = _roles(stage.get('roles'),{'admin','editor'})
        if key in stage_ids or status=='published' and mode=='workflow' and not set(stage_roles).intersection(roles):
            raise ValidationError('Each stage needs a unique identifier and a permitted template role.')
        stage_ids.add(key)
        text(stage.get('name'),200,'stage name',required=True)
        members = stage.get('member_ids',[])
        if (not isinstance(members,list) or len(members)>500 or any(not isinstance(m,str) or not m or
                staff is not None and m not in staff for m in members) or len(members)!=len(set(members))):
            raise ValidationError('Choose active staff members for the workflow stage.')
    if settings.get('orientation','portrait') not in ('portrait','landscape'):
        raise ValidationError('Choose a valid form orientation.')
    for part in ('header','footer'):
        text(settings.get(part,''),5000,f'form {part}')
    text(settings.get('display_id',''),80,'display identifier')
    if type(settings.get('photos_per_page',1)) is not int or settings.get('photos_per_page',1) not in (1,2,4,6,8,10):
        raise ValidationError('Choose 1, 2, 4, 6, 8 or 10 photos per page.')
    references = settings.get('attachments',[])
    if not isinstance(references,list) or len(references)>16:
        raise ValidationError('Choose up to 16 template reference files.')
    reference_size = 0
    for item in references:
        if not isinstance(item,dict) or set(item)!={'name','type','data'}:
            raise ValidationError('Include the name, media type and contents of each reference file.')
        filename(item['name'])
        media, uri = item['type'], item['data']
        if not isinstance(media,str) or not MIME.fullmatch(media) or not isinstance(uri,str) or not uri.startswith(f'data:{media};base64,'):
            raise ValidationError('Include a valid reference file.')
        try:
            reference_size += len(base64.b64decode(uri.split(',',1)[1],validate=True))
        except (ValueError,binascii.Error):
            raise ValidationError('Include a valid reference file.') from None
    if reference_size>1024*1024:
        raise ValidationError('Template reference files must total at most 1 MiB.')
    image_names = {item['name'] for item in references if item['type'] in ('image/png','image/jpeg','image/gif','image/webp')}
    kinds = ('logo','image','text','template_id','template_version','form_version','author','generated_at',
             'disclaimer','workspace','record_id')
    for key in ('header_layout','footer_layout'):
        layout = settings.get(key,[])
        if not isinstance(layout,list) or len(layout)>20:
            raise ValidationError('Use up to 20 items in each header and footer.')
        for block in layout:
            if (not isinstance(block,dict) or set(block)-{'kind','align','text','image'}
                    or block.get('kind') not in kinds or block.get('align') not in ('left','center','right')):
                raise ValidationError('Choose valid content and alignment for the form layout.')
            text(block.get('text',''),5000,'layout text')
            if block['kind']=='image' and (not isinstance(block.get('image'),str) or block['image'] not in image_names):
                raise ValidationError('Choose an attached image for the form layout.')
    def check_fields(items, *, table=False, nested=False):
        if not isinstance(items,list):
            raise ValidationError('Include the fields in a list.')
        previous = {}
        for field in items:
            if not isinstance(field,dict):
                raise ValidationError('Include a form field object.')
            key = identifier(field.get('id'))
            kind = field.get('type')
            if not isinstance(kind,str) or kind not in (COLUMN_TYPES if table else TYPES):
                raise ValidationError('Choose a supported field type.')
            if key in previous or not nested and key in root_ids:
                raise ValidationError('Use distinct field identifiers within each section.')
            if not nested:
                root_ids.add(key)
            text(field.get('label'),250,'field label',required=True)
            text(field.get('help',''),5000,'field instructions')
            if 'required' in field and type(field['required']) is not bool:
                raise ValidationError('Choose the required setting for this field.')
            stage_id = field.get('stage_id')
            if stage_id and (not isinstance(stage_id,str) or stage_id not in stage_ids):
                raise ValidationError('Choose an existing stage for each workflow field.')
            condition = field.get('condition')
            if condition:
                if (not isinstance(condition,dict) or not isinstance(condition.get('field_id'),str)
                        or condition['field_id'] not in previous or not isinstance(condition.get('value'),(str,int,bool))):
                    raise ValidationError('Choose an earlier field and matching value for the condition.')
            if kind in OPTION_TYPES:
                _options(field.get('options',[]))
                if status=='published' and not field.get('options'):
                    raise ValidationError('Add choices before publishing a choice field.')
            if kind=='formula' and (status=='published' or field.get('formula')):
                parse_formula(field.get('formula'))
            if kind=='list_property':
                source = field.get('source_column')
                choices = previous.get(source) if isinstance(source,str) else None
                mapping = field.get('mapping',{})
                if (not isinstance(mapping,dict) or (status=='published' or source) and
                        (not choices or choices['type']!='choice' or set(mapping)-set(choices.get('options',[])))):
                    raise ValidationError('Choose an earlier list column and map its choices to properties.')
                for item in mapping.values():
                    text(item,500,'list property')
            if kind=='time' and (type(field.get('interval',1)) is not int or not 1<=field.get('interval',1)<=1440):
                raise ValidationError('Choose a time interval between 1 and 1440 minutes.')
            if kind=='expiry_date' and 'reminder_days' in field and (type(field['reminder_days']) is not int or not 0<=field['reminder_days']<=365):
                raise ValidationError('Choose a reminder from 0 to 365 days before expiry.')
            if kind=='photo' and field.get('photo_size','medium') not in ('xs','small','medium','large','xl'):
                raise ValidationError('Choose a valid media display size.')
            if kind=='photo' and any(type(field.get(key,False)) is not bool for key in ('show_tags','show_description')):
                raise ValidationError('Use a checkbox setting for photo tags and descriptions.')
            if kind=='attachment' and field.get('accept') not in (None,'','application/pdf'):
                raise ValidationError('Choose the supported attachment filter.')
            if kind=='yes_no':
                options = field.get('options') or ['Yes','No','N/A']
                explanation = field.get('explanation_on',[])
                _options(options)
                _options(explanation)
                if set(options)-{'Yes','No','N/A'} or set(explanation)-set(options):
                    raise ValidationError('Select valid Yes/No responses for this field.')
            if kind=='profile' and field.get('profile_field','name') not in ('name','company','phone'):
                raise ValidationError('Choose a valid profile detail.')
            if kind in ('table','group'):
                if nested:
                    raise ValidationError('Groups and tables must be top-level fields.')
                children = field.get('columns' if kind=='table' else 'children',[])
                check_fields(children, table=kind=='table', nested=True)
                if status=='published' and not children:
                    raise ValidationError('Add columns or fields before publishing a table or group.')
                if kind=='table':
                    mode = field.get('table_mode','dynamic')
                    preset = field.get('default',[])
                    if mode not in ('fixed','dynamic') or not isinstance(preset,list) or len(preset)>500 or any(
                            not isinstance(row,dict) or set(row)-{col['id'] for col in children} for row in preset):
                        raise ValidationError('Choose a valid table mode and prefilled rows.')
                    if mode=='fixed' and status=='published' and not preset:
                        raise ValidationError('Add a prefilled row to the fixed table.')
            previous[key]=field
            counts.append(key)
            if len(counts)>500:
                raise ValidationError('Use up to 500 fields and table columns in a template.')
    counts, root_ids = [], set()
    check_fields(fields)
    top = {f['id']:f for f in fields}
    for stage_index,stage in enumerate(stages):
        eligible_stages = {s['id'] for s in stages[:stage_index+1]}
        conditions = stage.get('approval_conditions',[])
        if not isinstance(conditions,list) or len(conditions)>50:
            raise ValidationError('Choose up to 50 approval conditions for each stage.')
        for rule in conditions:
            if (not isinstance(rule,dict) or set(rule)!={'field_id','value'} or
                    not isinstance(rule['field_id'],str) or rule['field_id'] not in top):
                raise ValidationError('Choose an existing field for the approval condition.')
            source = top[rule['field_id']]
            if source['type']=='action':
                options = ('Pending','In progress','Completed','Cancelled')
            elif source['type']=='yes_no':
                options = source.get('options') or ['Yes','No','N/A']
            elif source['type'] in OPTION_TYPES:
                options = source.get('options',[])
            else:
                raise ValidationError('Choose a list, Yes/No, or action field for the approval condition.')
            if rule['value'] not in options or (source.get('stage_id') or stages[0]['id']) not in eligible_stages:
                raise ValidationError('Choose an available answer from this or an earlier workflow stage.')
    summary = settings.get('summary_fields',[])
    if (not isinstance(summary,list) or any(not isinstance(k,str) or k not in root_ids for k in summary)
            or settings.get('sort_field') and (not isinstance(settings['sort_field'],str) or settings['sort_field'] not in root_ids)):
        raise ValidationError('Choose existing fields for the form register.')
    cells = settings.get('summary_cells',[])
    if not isinstance(cells,list) or len(summary)+len(cells)>5 or len(set(summary))!=len(summary):
        raise ValidationError('Choose up to five distinct fields or fixed table cells for the form register.')
    used = set()
    for cell in cells:
        if not isinstance(cell,dict) or set(cell)!={'field_id','row','column_id'}:
            raise ValidationError('Choose a fixed table, row and column for the form register.')
        key,row,col = cell['field_id'],cell['row'],cell['column_id']
        table = top.get(key) if isinstance(key,str) else None
        if (not table or table['type']!='table' or table.get('table_mode')!='fixed'
                or type(row) is not int or not 0<=row<len(table.get('default',[])) or not isinstance(col,str)
                or not any(c['id']==col and c['type'] in SUMMARY_CELL_TYPES for c in table['columns'])):
            raise ValidationError('Choose an existing fixed table row and a text, date, choice or numeric column.')
        if (key,row,col) in used:
            raise ValidationError('Choose each register cell once.')
        used.add((key,row,col))
    return {'name':name,'description':description,'roles':roles,'status':status,'mode':mode,
            'settings':settings,'fields':fields}


def _blank(value):
    return value is None or value == '' or value == [] or value == {}


def _num(value):
    if type(value) not in (str,float,int) or len(str(value))>80:
        raise ValueError
    number = Decimal(str(value))
    if not number.is_finite() or abs(number)>Decimal('1e100'):
        raise ValueError
    return number


def _date(value, with_time, timezone=False):
    if not isinstance(value,str):
        raise ValueError
    if with_time:
        pattern = r'\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,6})?)?'
        if not re.fullmatch(pattern + (r'(?:Z|[+-]\d\d:\d\d)' if timezone else ''),value):
            raise ValueError
        return datetime.fromisoformat(value)
    if not re.fullmatch(r'\d{4}-\d\d-\d\d',value):
        raise ValueError
    return date.fromisoformat(value)


def _image_kind(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data.startswith((b'GIF87a',b'GIF89a')):
        return 'image/gif'
    if data[:4]==b'RIFF' and data[8:12]==b'WEBP':
        return 'image/webp'
    if len(data)>=12 and data[4:8]==b'ftyp':
        return 'video/mp4'
    if data.startswith(b'\x1a\x45\xdf\xa3') and b'webm' in data[:4096]:
        return 'video/webm'
    return ''


def validate_values(template, values, *, complete, previous, stage_id, staff=None, signer=None, lookup=None,counter=None):
    """Validate visible inputs, preserve signed stages and capture identity from the session."""
    if not isinstance(values,dict):
        raise ValidationError('Include form values keyed by field identifier.')
    _size_limited(values,18*1024*1024)
    attachment_bytes = {}
    def blob(encoded):
        if not isinstance(encoded,str) or not encoded or len(encoded) > 4*((MAX_FILE+2)//3):
            raise ValueError
        data = base64.b64decode(encoded, validate=True)
        attachment_bytes[encoded] = len(data)
        if len(data)>MAX_FILE:
            raise ValidationError('Each attached file may be up to 5 MiB, with up to 12 MiB per form.')
        return data

    def answer(field, value, old):
        kind = field['type']
        if kind in ('text','textarea','weather','id_text'):
            return text(value,16000,'form text')
        if kind=='number':
            number = _num(value)
            for limit in ('min','max'):
                if field.get(limit) not in (None,''):
                    bound = _num(field[limit])
                    if limit=='min' and number<bound or limit=='max' and number>bound:
                        raise ValueError
        elif kind in ('date','datetime','expiry_date'):
            _date(value,kind=='datetime',field.get('timezone'))
        elif kind=='time':
            if not isinstance(value,str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d',value):
                raise ValueError
            hour,minute = map(int,value.split(':'))
            if (hour*60+minute)%field.get('interval',1):
                raise ValueError
        elif kind in ('date_range','datetime_range'):
            if not isinstance(value,dict) or set(value)!={'start','end'}:
                raise ValueError
            dates = [_date(value[k],kind=='datetime_range',field.get('timezone')) if value[k] else None for k in ('start','end')]
            if all(dates) and dates[1]<dates[0] or complete and not all(dates):
                raise ValueError
        elif kind in ('choice','yes_no','multichoice'):
            options = (field.get('options') or ['Yes','No','N/A']) if kind=='yes_no' else field.get('options',[])
            if kind=='yes_no':
                selected_answer = value.get('answer') if isinstance(value,dict) else value
                if isinstance(value,dict) and set(value)-{'answer','explanation'}:
                    raise ValueError
                if isinstance(value,dict) or selected_answer in field.get('explanation_on',[]):
                    reason = value.get('explanation','') if isinstance(value,dict) else ''
                    text(reason,4000,'answer explanation',required=complete and selected_answer in field.get('explanation_on',[]))
                value_for_choice = selected_answer
            else:
                value_for_choice = value
            selected = value if kind=='multichoice' else [value_for_choice]
            if (not isinstance(selected,list) or any(not isinstance(v,str) or v not in options for v in selected)
                    or len(set(selected))!=len(selected)):
                raise ValueError
        elif kind=='scan_id':
            if not isinstance(value,str) or staff is not None and value not in staff and value!=old:
                raise ValueError
        elif kind=='person':
            people = value if isinstance(value,list) and field.get('multiple') else [value]
            if not all(isinstance(v,str) and (staff is None or v in staff or v==old or isinstance(old,list) and v in old) for v in people):
                raise ValueError
        elif kind in ('sketch','manual_signature'):
            image = value
            if kind=='manual_signature':
                if old and isinstance(old,dict) and old.get('at') or isinstance(old,str) and old:
                    if old==value:
                        return old
                    raise ValidationError('A captured signature cannot be overwritten.')
                if not isinstance(value,dict) or set(value)-{'name','company','image'}:
                    raise ValueError
                name = text(value.get('name',''),200,'signer name',required=complete or bool(value.get('image'))).strip()
                company = text(value.get('company',''),250,'signer company').strip()
                image = value.get('image')
                if not image and not complete:
                    return {'name':name,'company':company}
            if not isinstance(image,str) or not image.startswith('data:image/png;base64,') or _image_kind(blob(image.split(',',1)[1])) != 'image/png':
                raise ValueError
            if kind=='manual_signature':
                return {'name':name,'company':company,'image':image,'captured_by':signer['id'],'at':signer['at']}
        elif kind in ('attachment','photo'):
            if not isinstance(value,list) or len(value)>16:
                raise ValueError
            files = []
            for f in value:
                base = {'name','type','data'}
                allowed = base | {'tags','description'} if kind=='photo' else base
                if not isinstance(f,dict) or not base<=set(f)<=allowed:
                    raise ValueError
                filename(f['name'])
                if not isinstance(f['type'],str) or not MIME.fullmatch(f['type']):
                    raise ValueError
                data = blob(f['data'])
                if kind=='photo' and _image_kind(data)!=f['type']:
                    raise ValueError
                if field.get('accept')=='application/pdf' and (f['type']!='application/pdf' or b'%PDF-' not in data[:1024]):
                    raise ValueError
                file = {k:f[k] for k in base}
                if 'tags' in f:
                    tags = f['tags']
                    if not isinstance(tags,list) or len(tags)>20:
                        raise ValidationError('Use up to 20 tags per photo.')
                    tags = [text(tag,80,'photo tag',required=True).strip() for tag in tags]
                    if len({tag.casefold() for tag in tags})!=len(tags):
                        raise ValidationError('Choose distinct photo tags.')
                    if tags:
                        file['tags'] = tags
                if 'description' in f:
                    description = text(f['description'],2000,'photo description').strip()
                    if description:
                        file['description'] = description
                files.append(file)
            return files
        elif kind=='location':
            if not isinstance(value,dict) or set(value)!={'latitude','longitude'} or not -90<=_num(value['latitude'])<=90 or not -180<=_num(value['longitude'])<=180:
                raise ValueError
        elif kind in ('signature','staff_wallet'):
            if value==old and isinstance(old,dict):
                return old
            if isinstance(old,dict):
                raise ValidationError('A captured signature or staff identity cannot be overwritten.')
            ink = None
            if kind=='signature' and isinstance(value,dict) and set(value)=={'signature_image'}:
                from .certification_signature import validate_signature
                image = value['signature_image']
                if not isinstance(image,str) or not image.startswith('data:image/png;base64,'):
                    raise ValueError
                ink,_ = validate_signature(image)
            if value is not True and not ink or not signer:
                raise ValueError
            stamp = {'member_id':signer['id'],'member_name':signer['name'],'at':signer['at']}
            if kind=='staff_wallet':
                stamp['role'] = signer['role']
            elif signer.get('signature_image'):
                stamp.update(signature_image=signer['signature_image'],signature_name=signer['signature_name'])
            elif ink:
                stamp.update(signature_image=ink,signature_name='Signature.png')
            return stamp
        elif kind=='profile' or kind.startswith('profile_'):
            if value==old and isinstance(old,str):
                return old
            if isinstance(old,str) and old:
                raise ValidationError('A captured profile detail cannot be replaced.')
            if signer and value is True:
                detail = field.get('profile_field','name') if kind=='profile' else kind[8:]
                result = signer.get(detail,'')
                if not result and field.get('required') and complete:
                    raise ValidationError(f'Complete the profile detail for {field["label"]}.')
                return result
            raise ValueError
        elif kind=='approval':
            if type(value) is not bool or field.get('required') and complete and not value:
                raise ValueError
        elif kind in ('lookup','relationship'):
            if not isinstance(value,dict) or set(value)!={'entry_id'}:
                raise ValueError
            identifier(value['entry_id'])
            if lookup and value != old:
                lookup(value['entry_id'],field.get('source_template_id'))
        elif kind=='action':
            if not isinstance(value,dict) or set(value)-{'description','assignee','due_date','status'}:
                raise ValueError
            text(value.get('description',''),4000,'action description',required=complete)
            if value.get('status','Pending') not in ('Pending','In progress','Completed','Cancelled'):
                raise ValueError
            assignee = value.get('assignee')
            if assignee and (not isinstance(assignee,str) or staff is not None and assignee not in staff and not (isinstance(old,dict) and old.get('assignee')==assignee)):
                raise ValueError
            if value.get('due_date'):
                _date(value['due_date'],False)
        return value

    def fields_values(fields, provided, before, top):
        if not isinstance(provided,dict) or set(provided)-{f['id'] for f in fields}:
            raise ValidationError('The form contains values for unknown fields.')
        result = {}
        for f in fields:
            key, kind = f['id'], f['type']
            val, old = provided.get(key), before.get(key)
            if top and stage_id is not None:
                assigned = f.get('stage_id') or template['settings']['stages'][0]['id']
                if assigned != stage_id:
                    if key in provided and val != old and not (_blank(val) and _blank(old)):
                        raise ValidationError('Fields in another workflow step cannot be changed.')
                    if key in before:
                        result[key] = old
                    continue
            condition = f.get('condition')
            if condition:
                source = result.get(condition['field_id'])
                if isinstance(source,dict):
                    source = source.get('answer')
                matches = condition['value'] in source if isinstance(source,list) else source==condition['value']
                if not matches:
                    continue
            if kind in LAYOUT or kind in DERIVED:
                continue
            if _blank(val) and (kind in ('signature','staff_wallet') and isinstance(old,dict)
                    or (kind=='profile' or kind.startswith('profile_')) and isinstance(old,str) and old
                    or kind=='manual_signature' and (isinstance(old,str) or isinstance(old,dict) and old.get('at'))):
                raise ValidationError('A captured signature or staff profile cannot be cleared.')
            if kind=='counter':
                allocated = old if old is not None else counter
                if not _blank(val) and val != allocated:
                    raise ValidationError('The form counter is assigned automatically.')
                if allocated is not None:
                    result[key] = allocated
                continue
            if kind=='table' and f.get('table_mode')=='fixed' and (not isinstance(val,list) or len(val)!=len(f['default'])):
                raise ValidationError(f'Keep the prefilled rows in {f["label"]}.')
            if _blank(val):
                if complete and f.get('required'):
                    raise ValidationError(f'Complete the required field: {f["label"]}.')
                continue
            try:
                if kind in ('table','group'):
                    if not isinstance(val,list) or len(val)>500:
                        raise ValueError
                    children = f['columns' if kind=='table' else 'children']
                    prior = old if isinstance(old,list) else []
                    stamped = any(child['type'] in ('signature','manual_signature','profile','profile_name','profile_company',
                                      'profile_phone','person','scan_id','staff_wallet','action') for child in children)
                    old_rows = {row['_row_id']:row for row in prior if '_row_id' in row}
                    rows, seen = [], set()
                    for idx,row in enumerate(val):
                        if not isinstance(row,dict):
                            raise ValueError
                        row_id = row.get('_row_id')
                        former = prior[idx] if idx<len(prior) and '_row_id' not in prior[idx] else {}
                        if row_id is not None:
                            if not stamped or not isinstance(row_id,str) or row_id in seen or row_id not in old_rows:
                                raise ValidationError('Choose an existing form row once or add a new row.')
                            former = old_rows[row_id]
                            seen.add(row_id)
                        cleaned_row = fields_values(children,{k:v for k,v in row.items() if k!='_row_id'},former,False)
                        if stamped:
                            cleaned_row['_row_id'] = row_id or str(uuid4())
                        rows.append(cleaned_row)
                    result[key] = rows
                else:
                    result[key] = answer(f,val,old)
            except (ValueError, TypeError, InvalidOperation, binascii.Error) as exc:
                if isinstance(exc,ValidationError):
                    raise
                raise ValidationError(f'Check the value of {f["label"]}.') from None
        return result
    cleaned = fields_values(template['fields'],values,previous,True)
    # A workflow can acquire uploads over several stages. Include the preserved
    # bytes from locked stages as well as uploads that were just validated.
    def upload_bytes(fields,answers):
        size = 0
        for f in fields:
            value = answers.get(f['id'])
            if not value:
                continue
            if f['type'] in ('table','group'):
                children = f.get('columns') if f['type']=='table' else f.get('children')
                size += sum(upload_bytes(children,row) for row in value)
            elif f['type'] in ('attachment','photo','manual_signature','sketch','signature'):
                if isinstance(value,dict):
                    value = value.get('image') or value.get('signature_image')
                if not value:
                    continue
                contents = [item['data'] for item in value] if isinstance(value,list) else [value.split(',',1)[1]]
                for encoded in contents:
                    size += attachment_bytes.get(encoded, len(encoded)//4*3-encoded[-2:].count('='))
        return size
    if upload_bytes(template['fields'],cleaned)>MAX_TOTAL:
        raise ValidationError('A completed form may include up to 12 MiB of attachments.')
    frozen = {f['id'] for f in template['fields'] if stage_id is not None and
              (f.get('stage_id') or template['settings']['stages'][0]['id'])!=stage_id}
    for table, rows in derive_tables(template['fields'],cleaned,complete=complete,frozen=frozen).items():
        for row,derived in zip(cleaned.get(table,[]),rows):
            row.update(derived)
    return cleaned
