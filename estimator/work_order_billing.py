"""Work Order billing snapshots and directory changes tied to a saved claim."""
from collections.abc import Mapping
import json
import re
import zlib
from uuid import UUID, uuid5

from .catalog import ValidationError
from . import crm_activity, crm_identity
from .contacts import checked_fields, company_key, complete_contact_identity


FIELDS = {'address':1200, 'abn_acn':80, 'name':160, 'email':254, 'phone':60}
IDS = {'account_id','contact_id','new_contact_key','sync_key','company_key'}
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
    if not isinstance(raw,dict) or raw.keys() - (FIELDS.keys() | IDS | {'company_name', 'sync_fields'}):
        raise ValidationError('Invalid Work Order billing details.')
    result = {}
    for key, value in raw.items():
        if key in IDS:
            if value != '':
                result[key] = valid_id(value)
        elif key == 'sync_fields':
            if not isinstance(value,list) or not 1 <= len(value) <= len(FIELDS) or any(not isinstance(k,str) or k not in FIELDS for k in value):
                raise ValidationError('Invalid Work Order billing details.')
            result[key] = sorted(set(value))
        elif (not isinstance(value,str) or len(value)>FIELDS.get(key,240)
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
    if not person and not result.get('sync_key'):
        result.pop('account_id',None)
    if result.keys() & {'company_key','company_name','sync_fields','sync_key'}:
        if (not result.get('account_id') or not result.get('sync_key') or not result.get('sync_fields')
                or ('company_key' in result) != ('company_name' in result)):
            raise ValidationError('Invalid Work Order billing details.')
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


def separate_company_id(document_id, company_key):
    return str(uuid5(NAMESPACE, f'company:{document_id}:{company_key}'))


class BillingChoice(crm_identity.DuplicateReview):
    def __init__(self, decision):
        self.decision = decision
        ValidationError.__init__(self, 'Choose which billing details to keep.')


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
    def _remember_contact(db, account, person):
        db.execute('''CREATE TABLE IF NOT EXISTS work_order_accounts_contacts (
            account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
            contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE)''')
        current = db.execute('SELECT contact_id FROM work_order_accounts_contacts WHERE account_id=?',(account,)).fetchone()
        if current and current[0] == person:
            return False
        db.execute('''INSERT INTO work_order_accounts_contacts VALUES (?,?) ON CONFLICT(account_id)
            DO UPDATE SET contact_id=excluded.contact_id''',(account,person))
        return True

    @staticmethod
    def _preferred(db, account, mapping):
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE name IN ('work_order_billing_receipts','work_order_accounts_contacts')")}
        row = db.execute('SELECT contact_id FROM work_order_accounts_contacts WHERE account_id=?',(account,)).fetchone() if 'work_order_accounts_contacts' in tables else None
        if not row and 'work_order_billing_receipts' in tables:
            row = db.execute('''SELECT min(c.id) FROM work_order_billing_receipts r JOIN contacts c ON c.id=r.contact_id
                WHERE c.account_id=? HAVING count(*)=1''',(account,)).fetchone()
        if row:
            ident = mapping['contacts'].get(row[0],row[0])
            record = db.execute('SELECT id,name,email,phone,account_id FROM contacts WHERE id=?',(ident,)).fetchone()
            if record and mapping['accounts'].get(record['account_id'],record['account_id']) == account:
                return dict(record)

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

    def validate_selection(self, billing, previous, project_account, review, project, document_id, recipient=None):
        if billing.get('sync_key'):
            with self.directory.connection() as db:
                db.execute('BEGIN')
                if self._synced(db,billing,project,document_id):
                    return
                if billing == previous and not review:
                    known = {billing['account_id'],project_account,recipient}
                    if not any(i and db.execute('SELECT 1 FROM accounts WHERE id=?',(i,)).fetchone() for i in known):
                        return  # A portable copy can retain its snapshot without its original directory.
                self._sync_plan(db,billing,{recipient or project_account},review,project,document_id)
            return
        if not contact_id(billing) or identity(billing)==identity(previous):
            return
        with self.directory.connection() as db:
            db.execute('BEGIN')
            mapping = crm_identity.aliases(db)['accounts']
            if mapping.get(billing['account_id'],billing['account_id']) not in {
                    mapping.get(i,i) for i in (project_account,recipient) if i}:
                raise ValidationError(COMPANY_REQUIRED)
            self._person(db,billing,review,project,document_id,previous)

    def _with_saved(self, source, doc_id, version, complete, *, include_recipient=False):
        from .commercial_documents import CommercialConflict
        def verified(doc, details, project):
            if not isinstance(doc,Mapping) or doc['kind']!='work_order' or doc['version']!=version:
                raise CommercialConflict(REOPEN)
            if project in self.projects._commercial_sources.ignored_owners():
                raise CommercialConflict(REOPEN)
            owner = details.get('account_id')
            if include_recipient:
                owner = {doc['fields']['details'].get('account_id') or owner}
            return complete(normalized(doc['fields'].get('billing',{})),owner,project)
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

    def _sync_plan(self, db, billing, owners, review, project, document_id):
        """Compare only edited values. The same checks run again inside the write transaction."""
        choice = review if isinstance(review,dict) else {}
        identity_review = {'identity_reviews':choice.get('duplicates'),'review_token':review if isinstance(review,str) else None}
        mapping = crm_identity.aliases(db)
        company_id = mapping['accounts'].get(billing['account_id'],billing['account_id'])
        company = db.execute('SELECT id,company,billing_address,abn_acn FROM accounts WHERE id=?',(company_id,)).fetchone()
        if billing.get('company_key'):
            if billing['account_id'] != separate_company_id(document_id,billing['company_key']):
                raise ValidationError('Choose a valid billing contact or company.')
            if not company and not any(owner and db.execute('SELECT 1 FROM accounts WHERE id=?',(
                    mapping['accounts'].get(owner,owner),)).fetchone() for owner in owners):
                raise ValidationError(COMPANY_REQUIRED)
            if not company and db.execute('SELECT 1 FROM accounts WHERE lookup_key=?',(company_key(billing['company_name']),)).fetchone():
                raise ValidationError('A Company with this name already exists. Enter a different name.')
        elif company_id not in {mapping['accounts'].get(i,i) for i in owners} or not company:
            raise ValidationError(COMPANY_REQUIRED)
        company_fields = {k:company[k] for k in ('company','billing_address','abn_acn')} if company else {
            'company':billing['company_name'],'billing_address':'','abn_acn':''}
        ident = contact_id(billing)
        person = None
        if ident:
            ident = mapping['contacts'].get(ident,ident)
            person = db.execute('SELECT name,email,phone,title,account_id FROM contacts WHERE id=?',(ident,)).fetchone()
            if ((not person and not billing.get('new_contact_key')) or
                    (person and mapping['accounts'].get(person['account_id'],person['account_id']) != company_id)):
                raise ValidationError('Choose an existing Contact linked to this Company.')
        person_fields = {k:person[k] for k in ('name','email','phone','title')} if person else {
            'name':'','email':'','phone':'','title':''}
        person_fields['company'] = company_fields['company']
        changes, conflicts = set(), {}
        for key in FIELDS:
            target, db_key = ((company_fields, 'billing_address' if key=='address' else key)
                              if key in ('address','abn_acn') else (person_fields,key))
            if key not in billing['sync_fields'] and (company if target is company_fields else person):
                continue
            entered, stored = billing.get(key,''), target[db_key]
            if not entered or entered == stored:
                continue
            if stored:
                conflicts[key] = {'saved':stored,'entered':entered}
            target[db_key] = entered
            changes.add('accounts' if target is company_fields else 'contacts')
        preferred = self._preferred(db,company_id,mapping) if ident and ('name' in billing['sync_fields'] or not person) else None
        if preferred and preferred['id'] != ident:
            conflicts['billing_contact'] = {'saved':preferred['name'],'entered':billing['name'],
                                           'saved_contact':preferred}
        if conflicts:
            accepted = choice.get('replace')
            for field,pair in conflicts.items():
                pair['token'] = crm_identity.digest([project,document_id,billing['sync_key'],company_id,ident,field,pair])
            if not isinstance(accepted,dict) or any(accepted.get(k)!=v['token'] for k,v in conflicts.items()):
                raise BillingChoice({'kind':'claim','company':company_fields['company'],'conflicts':conflicts,
                                     'new_account_id':separate_company_id(document_id,billing['sync_key'])})
        if not company or 'accounts' in changes:
            checked_fields('accounts',company_fields)
            crm_identity.check_save(db,'accounts',company_fields,company_id if company else None,identity_review)
        if ident and (not person or 'contacts' in changes):
            checked_fields('contacts',person_fields)
            if not person and not complete_contact_identity(person_fields):
                raise ValidationError(PERSON_REQUIRED)
            crm_identity.check_save(db,'contacts',person_fields,ident if person else None,identity_review,company_id)
        return (company_id,company_fields,not company or 'accounts' in changes,
                ident,person_fields, bool(ident and (not person or 'contacts' in changes)),bool(ident and not person))

    @staticmethod
    def _synced(db,billing,project,document_id):
        if not db.execute("SELECT 1 FROM sqlite_schema WHERE name='work_order_billing_sync'").fetchone():
            return False
        prior = db.execute('SELECT intent FROM work_order_billing_sync WHERE sync_key=?',(billing['sync_key'],)).fetchone()
        if prior and prior[0] != crm_identity.digest([project,document_id,billing]):
            raise ValidationError('The billing details changed. Review the claim again.')
        return bool(prior)

    def _complete_sync(self, body, actor):
        if (body.keys()-{'source','id','version','sync_key','review_token'} or type(body.get('version')) is not int):
            raise ValidationError(REOPEN)
        document_id, key = valid_id(body.get('id')), valid_id(body.get('sync_key'))
        with self.directory.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            def finish(billing, owners, project):
                if billing.get('sync_key') != key:
                    raise ValidationError(REOPEN)
                db.execute('''CREATE TABLE IF NOT EXISTS work_order_billing_sync (
                    sync_key TEXT PRIMARY KEY, intent TEXT NOT NULL)''')
                intent = crm_identity.digest([project,document_id,billing])
                if self._synced(db,billing,project,document_id):
                    return {'account_id':billing['account_id'],'contact_id':contact_id(billing),'created':False}
                account, fields, write_account, ident, person, write_person, created = self._sync_plan(
                    db,billing,owners,body.get('review_token'),project,document_id)
                if write_account or write_person:
                    crm_activity.begin_tracking(db)
                    if write_account:
                        db.execute('''INSERT INTO accounts(id,company,lookup_key,billing_address,abn_acn) VALUES(?,?,?,?,?)
                            ON CONFLICT(id) DO UPDATE SET billing_address=excluded.billing_address,abn_acn=excluded.abn_acn''',
                            (account,fields['company'],company_key(fields['company']),fields['billing_address'],fields['abn_acn']))
                    if write_person:
                        self.directory._person(db,ident,person,account_id=account)
                    crm_activity.finish_tracking(db,actor)
                    crm_identity.index_changes(db)
                linked = ident and ('name' in billing['sync_fields'] or created) and self._remember_contact(db,account,ident)
                if write_account or write_person or linked:
                    db.execute('UPDATE revision SET version=version+1 WHERE id=1')
                db.execute('INSERT INTO work_order_billing_sync VALUES (?,?)',(key,intent))
                db.commit()
                return {'contact_id':ident,'account_id':account,'created':created}
            return self._with_saved(body.get('source'),document_id,body['version'],finish,include_recipient=True)

    def complete(self, body, actor=None):
        if isinstance(body,dict) and 'sync_key' in body:
            return self._complete_sync(body,actor)
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
                    self._remember_contact(db,account,person)
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
