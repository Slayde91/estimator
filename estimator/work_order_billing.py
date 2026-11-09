"""A claim's billing snapshot and explicit creation of its named accounts contact."""
from collections.abc import Mapping
import json
import re
import zlib
from uuid import UUID, uuid5

from .catalog import ValidationError
from . import crm_activity, crm_identity
from .contacts import checked_fields, complete_contact_identity


FIELDS = {'address':1200, 'abn_acn':80, 'name':160, 'email':254, 'phone':60}
IDS = {'account_id','contact_id','new_contact_key'}
NAMESPACE = UUID('6f56d159-e32b-498e-96a2-dfa85eaa93f3')
COMPANY_REQUIRED = 'Link this project to a Company before adding an accounts contact.'
PERSON_REQUIRED = 'Enter the accounts name, email and phone, or choose an existing Contact.'
REOPEN = 'The saved Work Order changed. Reopen it before linking its accounts contact.'


def valid_id(value):
    try:
        if isinstance(value,str) and str(UUID(value)) == value:
            return value
    except ValueError:
        pass
    raise ValidationError('Choose a valid billing contact or company.')


def normalized(raw):
    if not isinstance(raw,dict) or raw.keys() - (FIELDS.keys() | IDS):
        raise ValidationError('Invalid Work Order billing details.')
    result = {}
    for key, value in raw.items():
        if key in IDS:
            if value != '':
                result[key] = valid_id(value)
        elif (not isinstance(value,str) or len(value)>FIELDS[key]
              or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff]',value)):
            raise ValidationError('Invalid Work Order billing details.')
        elif value.strip():
            result[key] = value.strip()
    if result.get('email') and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',result['email']):
        raise ValidationError('Enter a valid email address.')
    if 'new_contact_key' in result and result.get('account_id'):
        expected = contact_id(result)
        if 'contact_id' in result and result['contact_id']!=expected:
            raise ValidationError('Choose one accounts contact.')
        result['contact_id'] = expected
    person = any(key in result for key in ('name','email','phone','contact_id','new_contact_key'))
    if not person:
        result.pop('account_id',None)
    if person and not result.get('account_id'):
        raise ValidationError(COMPANY_REQUIRED)
    if person and (not result.get('name') or not (result.get('contact_id') or result.get('new_contact_key'))):
        raise ValidationError(PERSON_REQUIRED)
    if 'new_contact_key' in result and not all(result.get(key) for key in ('name','email','phone')):
        raise ValidationError(PERSON_REQUIRED)
    if not any(key in result for key in FIELDS):
        return {}
    return result


def contact_id(billing):
    if billing.get('new_contact_key'):
        return str(uuid5(NAMESPACE, billing['account_id']+':'+billing['new_contact_key']))
    return billing.get('contact_id')


def identity(billing):
    return tuple(billing.get(key,'') for key in ('account_id','contact_id','new_contact_key','name','email','phone'))


def project_context(details):
    """Keep only portable billing defaults when a Work Order has no project file yet."""
    if not details.get('account_id'):
        return {}
    result = {'account_id':valid_id(details['account_id'])}
    for key,limit in (('billing_address',1200),('abn_acn',80)):
        value = details.get(key,'')
        if not isinstance(value,str) or len(value)>limit:
            raise ValidationError('Invalid Work Order billing details.')
        result[key] = value
    return result


def unfiled_context(captured):
    if 'billing_project' in captured:
        return project_context(captured['billing_project'])
    for estimate in captured.get('estimates',[]):
        if estimate.get('id') == captured.get('active_estimate_id'):
            return project_context(estimate['workspace']['estimate'])
    return {}


class WorkOrderBilling:
    def __init__(self, directory, projects):
        self.directory = directory
        self.projects = projects

    @staticmethod
    def _person(db, billing, review, project, document_id, previous=None):
        mappings = crm_identity.aliases(db)
        account = mappings['accounts'].get(billing['account_id'], billing['account_id'])
        company = db.execute('SELECT company FROM accounts WHERE id=?',(account,)).fetchone()
        if not company:
            raise ValidationError(COMPANY_REQUIRED)
        ident = contact_id(billing)
        actual = db.execute('SELECT id,name,account_id FROM contacts WHERE id=?',(ident,)).fetchone()
        intent = crm_identity.digest([project,document_id,billing['account_id'],*[billing.get(field,'') for field in ('name','email','phone')]])
        if billing.get('new_contact_key'):
            receipt = None
            if db.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='work_order_billing_receipts'").fetchone():
                receipt = db.execute('SELECT contact_id,intent FROM work_order_billing_receipts WHERE creation_key=?',
                                     (billing['new_contact_key'],)).fetchone()
            if receipt or actual:
                if not (receipt and actual and tuple(receipt)==(ident,intent)):
                    raise ValidationError('The accounts contact request changed. Choose the contact again.')
                return account, ident, None, intent
        if actual:
            same_saved = (previous and contact_id(previous)==ident and previous.get('name')==billing.get('name')
                          and mappings['accounts'].get(previous.get('account_id'),previous.get('account_id'))==account)
            if not same_saved and (ident in mappings['contacts'] or actual['name'] != billing['name']
                    or mappings['accounts'].get(actual['account_id'],actual['account_id']) != account):
                raise ValidationError('Choose an existing Contact linked to this Company.')
            return account, ident, None, intent
        if not billing.get('new_contact_key'):
            raise ValidationError('Choose an existing Contact linked to this Company.')
        data = checked_fields('contacts',{'name':billing['name'],'title':'','company':company['company'],
                                         'phone':billing['phone'],'email':billing['email']})
        if not complete_contact_identity(data):
            raise ValidationError(PERSON_REQUIRED)
        crm_identity.check_save(db,'contacts',data,None,{'review_token':review},account)
        return account, ident, data, intent

    def validate_selection(self, billing, previous, project_account, review, project, document_id):
        if not contact_id(billing) or identity(billing)==identity(previous):
            return
        with self.directory.connection() as db:
            db.execute('BEGIN')
            mapping = crm_identity.aliases(db)['accounts']
            if not project_account or mapping.get(project_account,project_account) != mapping.get(billing['account_id'],billing['account_id']):
                raise ValidationError(COMPANY_REQUIRED)
            self._person(db,billing,review,project,document_id,previous)

    def _with_saved(self, source, doc_id, version, complete):
        from .commercial_documents import CommercialConflict
        def verified(doc, details, project):
            if not isinstance(doc,Mapping) or doc['kind']!='work_order' or doc['version']!=version:
                raise CommercialConflict(REOPEN)
            if project in self.projects._commercial_sources.ignored_owners():
                raise CommercialConflict(REOPEN)
            return complete(normalized(doc['fields'].get('billing',{})),details.get('account_id'),project)
        if not isinstance(source,dict) or len(source)!=2 or not isinstance(source.get('revision'),str):
            raise ValidationError(REOPEN)
        if 'project_token' in source:
            token = source['project_token']
            if not isinstance(token,str) or not token or len(token)>140:
                raise ValidationError(REOPEN)
            owner = self.projects.participant_project('native:'+token)
            if owner['revision'] != source['revision']:
                raise CommercialConflict(REOPEN)
            source = {'file_id':owner['source'],'revision':owner['revision']}
        file_id = source.get('file_id')
        if not isinstance(file_id,str):
            raise ValidationError(REOPEN)
        if file_id.startswith('local-'):
            service = self.projects.commercial
            with service._connect() as db:
                db.execute('BEGIN IMMEDIATE')
                owner = service.unfiled._owner(db,source)
                project = owner['project_id']
                service.unfiled._check_pending(db,owner['workspace'])
                row = db.execute('''SELECT d.data,m.estimates FROM local_commercial_documents m JOIN commercial_drafts d USING(workspace,id)
                                    WHERE m.workspace=? AND m.id=?''',(owner['workspace'],doc_id)).fetchone()
                document = json.loads(row[0]) if row else None
                saved_context = unfiled_context(json.loads(zlib.decompress(row[1]))) if row and row[1] else {}
                return verified(document,saved_context,project)
        else:
            with self.projects.commercial_file(file_id,source['revision']) as (_, snapshot, _revision, _commit):
                document = next((doc for doc in (snapshot.get('commercial_documents') or {}).get('documents',[]) if doc['id']==doc_id),None)
                saved_context = snapshot['estimate']
                project = (snapshot.get('commercial_documents') or {}).get('project_id')
                return verified(document,saved_context,project)

    def complete(self, body, actor=None):
        if not isinstance(body,dict) or body.keys()-{'source','id','version','new_contact_key','review_token'} or type(body.get('version')) is not int:
            raise ValidationError(REOPEN)
        ident = valid_id(body.get('id')); key = valid_id(body.get('new_contact_key'))
        # Acquire the directory lock before a source-file lock, as in lead conversion.
        # The source is the committed saved file or an explicitly enrolled unfiled
        # record. No client-supplied name, address or company is used here.
        with self.directory.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            def finish(billing, project_account, project):
                if billing.get('new_contact_key')!=key:
                    raise ValidationError(REOPEN)
                account, person, fields, intent = self._person(db,billing,body.get('review_token'),project,ident)
                if fields is not None:
                    mapping = crm_identity.aliases(db)['accounts']
                    if not project_account or mapping.get(project_account,project_account)!=account:
                        raise ValidationError(COMPANY_REQUIRED)
                    crm_activity.begin_tracking(db)
                    self.directory._person(db,person,fields,account_id=account)
                    db.execute("""CREATE TABLE IF NOT EXISTS work_order_billing_receipts (
                        creation_key TEXT PRIMARY KEY, contact_id TEXT UNIQUE NOT NULL REFERENCES contacts(id), intent TEXT NOT NULL)""")
                    db.execute('INSERT INTO work_order_billing_receipts VALUES (?,?,?)',(key,person,intent))
                    crm_activity.finish_tracking(db,actor)
                    crm_identity.index_changes(db)
                    db.execute('UPDATE revision SET version=version+1 WHERE id=1')
                # Publish while the verified owner/file or unfiled record is still locked.
                db.commit()
                return {'contact_id':person,'created':fields is not None}
            return self._with_saved(body.get('source'),ident,body['version'],finish)
