"""HTTP surface for local role-scoped Forms templates and entries."""
from urllib.parse import parse_qs, urlsplit

from .catalog import ValidationError
from .forms import FORM_PDF_THEMES, FormError
from .forms_pdf import render_form_pdf
from .project_file import PROJECT_EXTENSION, project_download_header, project_filename
from .form_calculations import derive_tables
from .form_fields import validate_template


class FormsHTTP:
    def __init__(self, store):
        self.store = store

    def dispatch(self, handler, route):
        if not route.startswith('/api/forms/'):
            return False
        resource = route[len('/api/forms/'):]
        user = handler.crm_user
        reads = {
            'templates': ((), lambda _: self.store.templates(user)),
            'template': (('id','version'), lambda q: self.store.template(user,q.get('id'),q.get('version'))),
            'template/history': (('id',), lambda q: self.store.history(user,q.get('id'))),
            'template/assignees': (('id','version'), lambda q: self.store.assignees(user,q.get('id'),q.get('version'))),
            'entries': (('template_id',), lambda q: self.store.entries(user,q.get('template_id'))),
            'entry': (('id',), lambda q: self.store.entry(user,q.get('id'))),
            'entry/pdf': (('id','version','theme'), lambda q: self.store.entry(user,q.get('id'))),
            'staff': ((), lambda _: {'staff': [{'id':p['id'],'name':p['name']} for p in self.store.staff()]}),
            'signer': ((), lambda _: self.store.signer_details(user)),
        }
        writes = {
            'template/save': self.store.save_template,
            'entry/assign': self.store.assign_entry,
            'entry/save': self.store.save_entry,
            'entry/delete': self.store.delete_entry,
            'entry/approve': self.store.approve,
            'entry/reopen': self.store.reopen,
            'calculate': self.calculate,
        }
        query = parse_qs(urlsplit(handler.path).query, keep_blank_values=True)
        try:
            if resource in reads and handler.command=='GET':
                permitted, operation = reads[resource]
                if set(query)-set(permitted) or any(len(items)!=1 for items in query.values()):
                    raise ValidationError('Choose valid Forms parameters.')
                query = {key: values[0] for key,values in query.items()}
                if 'version' in query:
                    if not query['version'].isascii() or not query['version'].isdigit() or len(query['version'])>10:
                        raise ValidationError('Choose a valid template revision.')
                    query['version'] = int(query['version'])
                result = operation(query)
                if resource == 'entry/pdf':
                    if query.get('version',result['version']) != result['version']:
                        raise FormError('The form was updated. Open the latest version and download it again.',409)
                    theme = query.get('theme',result['pdf_theme'])
                    if theme not in FORM_PDF_THEMES:
                        raise ValidationError('Choose a valid form PDF colour theme.')
                    filename = project_filename(result['name']).removesuffix(PROJECT_EXTENSION) + f"-{result['id'][:8]}-v{result['version']}.pdf"
                    def reference(record_id):
                        try:
                            return self.store.entry(user,record_id)
                        except FormError:
                            return {}
                    pdf = render_form_pdf(result, theme, self.store.company(), self.store.staff(), reference)
                    handler.send_payload(200,pdf,'application/pdf',{'Content-Disposition':project_download_header(filename)})
                    return True
            elif resource in writes and handler.command=='POST':
                if query:
                    raise ValidationError('Send form changes in the request body.')
                result = writes[resource](user, handler.read_json())
            elif resource in reads or resource in writes:
                raise FormError('Method not allowed.',405)
            else:
                raise FormError('Not found.',404)
            handler.send_payload(200,result)
        except FormError as exc:
            handler.send_payload(exc.status,{'error':str(exc)})
        return True

    @staticmethod
    def calculate(user, body):
        if set(body)!={'fields','values'} or not isinstance(body['values'],dict):
            raise ValidationError('Send the table definitions and their current values.')
        fields = body['fields']
        # Calculation is stateless. Template conditions and workflow assignments are
        # outside this request, which contains only the table definitions.
        if not isinstance(fields,list) or any(not isinstance(f,dict) or f.get('type')!='table' for f in fields):
            raise ValidationError('Choose the tables to calculate.')
        shape = [{k:v for k,v in f.items() if k not in ('condition','stage_id')} for f in fields]
        validate_template({'name':'Calculation','fields':shape,'roles':['editor'],'status':'draft'})
        if set(body['values'])-{f['id'] for f in fields}:
            raise ValidationError('Choose the table values to calculate.')
        return {'values':derive_tables(fields,body['values'])}
