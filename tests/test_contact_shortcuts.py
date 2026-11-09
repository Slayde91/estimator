"""Lead-local copies never silently rewrite selected canonical directory records."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.contacts import ContactsConflict, ContactsStore


class ContactShortcutTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'directory.sqlite3'
        self.store = ContactsStore(self.path)

    def save(self, kind, fields, **extra):
        return self.store.save(kind, {'version': self.store.list()['version'], 'fields': fields, **extra})

    def account(self, company, abn=''):
        return self.save('accounts', {'company': company, 'abn_acn': abn})['account']

    def contact(self, company='Original Company'):
        return self.save('contacts', {'name': 'Alex Example', 'company': company, 'phone': '0400',
                                      'email': 'alex@example.test', 'title': 'Manager'})['contact']

    def test_nullable_migration_preserves_every_legacy_row_and_join_fallback(self):
        path = Path(self.temporary.name) / 'legacy.sqlite3'
        with closing(sqlite3.connect(path)) as db, db:
            db.executescript('''CREATE TABLE revision(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);
                INSERT INTO revision VALUES(1,7);
                CREATE TABLE accounts(id TEXT PRIMARY KEY,company TEXT NOT NULL,lookup_key TEXT NOT NULL UNIQUE,
                    billing_address TEXT NOT NULL,abn_acn TEXT NOT NULL DEFAULT '');
                CREATE TABLE contacts(id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL,title TEXT NOT NULL,
                    email TEXT NOT NULL,account_id TEXT REFERENCES accounts(id));
                CREATE TABLE leads(id TEXT PRIMARY KEY,contact_id TEXT NOT NULL UNIQUE REFERENCES contacts(id),
                    site_address TEXT NOT NULL,billing_address TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL);''')
            account, contact, lead = map(str, (uuid4(), uuid4(), uuid4()))
            db.execute('INSERT INTO accounts VALUES(?,?,?,?,?)', (account, 'Legacy Company', 'legacy company', 'HQ', 'ABN-OLD'))
            db.execute('INSERT INTO contacts VALUES(?,?,?,?,?,?)', (contact, 'Legacy Person', 'Old phone', 'Old title', 'old@example.test', account))
            db.execute('INSERT INTO leads VALUES(?,?,?,?,?,?)', (lead, contact, 'Site', 'Billing', 'Description', 'Qualified'))
            before = {table: db.execute('SELECT * FROM ' + table).fetchall() for table in ('revision','accounts','contacts','leads')}
        with ThreadPoolExecutor(2) as clients:
            migrated, other = list(clients.map(ContactsStore, [path, path]))
        self.assertEqual(other.list(), migrated.list())
        with closing(sqlite3.connect(path)) as db, db:
            for table in ('revision','accounts','contacts'):
                self.assertEqual(db.execute('SELECT * FROM ' + table).fetchall(), before[table])
            self.assertEqual(db.execute('SELECT id,contact_id,site_address,billing_address,description,status FROM leads').fetchall(), before['leads'])
            self.assertIsNone(db.execute('SELECT person_snapshot FROM leads').fetchone()[0])
            self.assertFalse(db.execute('PRAGMA foreign_key_check').fetchall())
            self.assertIn(('lead_contact', 0), [(row[1], row[2]) for row in db.execute('PRAGMA index_list(leads)')])
        record = migrated.list()['leads'][0]
        self.assertEqual((record['name'],record['phone'],record['company'],record['abn_acn']), ('Legacy Person','Old phone','Legacy Company','ABN-OLD'))
        migrated.save('contacts', {'id':contact,'version':7,'fields':{'name':'Explicit canonical edit','company':'Legacy Company'}})
        self.assertEqual(migrated.list()['leads'][0]['name'], 'Explicit canonical edit')
        with closing(sqlite3.connect(path)) as db, db:
            self.assertIsNone(db.execute('SELECT person_snapshot FROM leads').fetchone()[0])
        migrated.save('leads', {'version':8, 'contact_id':contact, 'account_id':account,
                                'fields':{'name':'Legacy Person', 'company':'Legacy Company', 'site_address':'Second site'}})
        self.assertEqual({row['site_address'] for row in migrated.list()['leads']}, {'Site', 'Second site'})

    def test_selected_contact_keeps_identity_and_ownership_while_lead_uses_its_chosen_client(self):
        self.account('Original Company', 'ABN-A')
        other = self.account('Lead Client', 'ABN-B')
        person = self.contact()
        before = self.store.list()
        result = self.save('leads', {'name':person['name'],'phone':'Lead phone','email':'lead@example.test',
            'company':'Lead Client','abn_acn':'ABN-B','site_address':'Lead site'}, contact_id=person['id'],account_id=other['id'])
        after = self.store.list()
        self.assertEqual(after['contacts'], before['contacts'])
        self.assertEqual(after['accounts'], before['accounts'])
        lead = after['leads'][0]
        self.assertEqual((lead['id'],lead['contact_id'],lead['account_id']), (result['id'],person['id'],other['id']))
        self.assertEqual((lead['company'],lead['phone'],lead['email'],lead['abn_acn']), ('Lead Client','Lead phone','lead@example.test','ABN-B'))
        self.assertEqual(len(after['contacts']), 1)

    def test_manual_lead_creates_initial_contact_once_then_edits_only_its_snapshot(self):
        created = self.save('leads', {'name':'Manual Person','company':'Manual Company','phone':'Original phone'})
        initial = self.store.list()
        lead = initial['leads'][0]
        self.save('leads', {'name':'Manual Person','company':'Manual Company','phone':'Lead override'},id=created['id'])
        after = self.store.list()
        self.assertEqual(after['contacts'], initial['contacts'])
        self.assertEqual(after['leads'][0]['contact_id'], lead['contact_id'])
        self.assertEqual(after['leads'][0]['phone'], 'Lead override')
        self.save('contacts', {'name':'Manual Person','company':'Manual Company','phone':'Explicit Contact edit'},id=lead['contact_id'])
        self.assertEqual(self.store.list()['contacts'][0]['phone'], 'Explicit Contact edit')
        self.assertEqual(self.store.list()['leads'][0]['phone'], 'Lead override')

    def test_duplicate_active_lead_and_invalid_links_or_abn_fail_atomically(self):
        account = self.account('Original Company', 'ABN-A')
        person = self.contact()
        fields = {'name':person['name'],'company':person['company'],'abn_acn':'ABN-A'}
        saved = self.save('leads', fields,contact_id=person['id'],account_id=account['id'])
        before = self.store.list()
        for extra, values in [({'contact_id':person['id']},fields),
                              ({'contact_id':str(uuid4())},fields),
                              ({'contact_id':person['id'],'account_id':str(uuid4()),'id':saved['id']},fields),
                              ({'contact_id':person['id'],'account_id':account['id'],'id':saved['id']},{**fields,'company':'Different company'}),
                              ({'contact_id':person['id'],'id':saved['id']},{**fields,'abn_acn':'DIFFERENT'})]:
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                self.save('leads',values,**extra)
            self.assertEqual(self.store.list(),before)
        with self.assertRaises(ContactsConflict):
            self.store.save('leads',{'id':saved['id'],'version':before['version']-1,'fields':fields,'contact_id':person['id']})
        self.assertEqual(self.store.list(),before)

    def test_same_contact_can_work_distinct_sites_and_clients_but_not_accidentally_repeat_a_site(self):
        person = self.contact()
        fields = {'name': person['name'], 'company': person['company'], 'site_address': '12 North Road'}
        original = self.save('leads', fields, contact_id=person['id'])
        self.save('leads', {**fields, 'site_address': '8 South Road'}, contact_id=person['id'])
        self.save('leads', {**fields, 'company': 'Another Client'}, contact_id=person['id'])
        before = self.store.list()
        self.assertEqual(len(before['contacts']), 1)
        self.assertEqual(len({row['id'] for row in before['leads']}), 3)
        for duplicate in (' 12  north ROAD ', ''):
            with self.subTest(site=duplicate), self.assertRaisesRegex(ValidationError, 'already has a lead'):
                self.save('leads', {**fields, 'site_address': duplicate}, contact_id=person['id'])
        with self.assertRaisesRegex(ValidationError, 'already has a lead'):
            self.save('leads', {**fields, 'site_address': '8 South Road'}, id=original['id'])
        self.assertEqual(self.store.list(), before)
        second_scope = self.save('leads', {**fields, 'description':'Separate tender'}, contact_id=person['id'], keep_separate_lead=True)
        self.save('leads', {**fields, 'description':'Separate tender', 'status':'Qualified'}, id=second_scope['id'])
        self.assertEqual(len(self.store.list()['leads']), 4)

    def test_existing_missing_site_does_not_claim_a_specific_site(self):
        person = self.contact()
        fields = {'name':person['name'], 'company':person['company']}
        self.save('leads', fields, contact_id=person['id'])
        self.save('leads', {**fields, 'site_address':'A known site', 'description':'North wing'}, contact_id=person['id'])
        self.save('leads', {**fields, 'site_address':'A known site', 'description':'South wing'}, contact_id=person['id'])
        self.assertEqual(len(self.store.list()['leads']), 3)

    def test_interrupted_migration_rolls_back_all_schema_and_lead_rows(self):
        # Simulate a legacy directory with an orphan. Copying it into the new
        # foreign-key-checked table must fail without altering the old file.
        path = Path(self.temporary.name) / 'broken-legacy.sqlite3'
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("""CREATE TABLE leads(id TEXT PRIMARY KEY, contact_id TEXT UNIQUE NOT NULL,
                site_address TEXT NOT NULL, billing_address TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL)""")
            db.execute("INSERT INTO leads VALUES('legacy','missing','Site','HQ','Keep my notes','New')")
            schema = db.execute("SELECT type,name,sql FROM sqlite_schema ORDER BY name").fetchall()
            rows = db.execute("SELECT * FROM leads").fetchall()
        with self.assertRaises(sqlite3.IntegrityError):
            ContactsStore(path)
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute("SELECT type,name,sql FROM sqlite_schema ORDER BY name").fetchall(), schema)
            self.assertEqual(db.execute("SELECT * FROM leads").fetchall(), rows)

    def test_editing_stage_after_company_rename_keeps_saved_client_and_canonical_id(self):
        company = self.account('First name', 'ABN-1')
        lead = self.save('leads', {'name': 'Mia', 'company': company['company'], 'abn_acn': 'ABN-1'})
        self.save('accounts', {'company': 'New name', 'abn_acn': 'ABN-2'}, id=company['id'])
        for extra in ({'account_id':company['id']}, {}):
            self.save('leads', {'name':'Mia', 'company':'First name', 'abn_acn':'ABN-1', 'status':'Qualified'},
                      id=lead['id'], **extra)
            directory = self.store.list()
            row = directory['leads'][0]
            self.assertEqual((row['account_id'], row['company'], row['abn_acn'], row['status']),
                             (company['id'], 'First name', 'ABN-1', 'Qualified'))
            self.assertEqual([a['company'] for a in directory['accounts']], ['New name'])
        self.save('leads', {'name':'New callback person', 'company':'First name', 'abn_acn':'ABN-1'},
                  id=lead['id'], account_id=company['id'], contact_id='')
        directory = self.store.list()
        self.assertEqual(len(directory['accounts']), 1)
        self.assertEqual({person['account_id'] for person in directory['contacts']}, {company['id']})

    def test_conversion_uses_lead_snapshot_and_replays_one_project_without_canonical_edits(self):
        self.account('Original Company')
        client = self.account('Lead Client')
        person = self.contact()
        self.save('leads', {'name':person['name'],'phone':'Lead phone','email':'lead@example.test','company':'Lead Client',
            'site_address':'Lead site'},contact_id=person['id'],account_id=client['id'])
        before = self.store.list();lead = before['leads'][0];calls=[]
        def create(value):
            calls.append(deepcopy(value))
            return {'project_no':'PN-01','path':'fixture/PN-01.cf.json'}
        body={'id':lead['id'],'version':before['version']}
        first=self.store.convert(body,create)
        self.assertEqual(self.store.convert(body,create),first)
        self.assertEqual(len(calls),1)
        self.assertEqual((calls[0]['contact_id'],calls[0]['account_id'],calls[0]['company'],calls[0]['phone']),
                         (person['id'],client['id'],'Lead Client','Lead phone'))
        self.assertEqual(self.store.list()['contacts'],before['contacts'])
        self.assertEqual(self.store.list()['leads'],[])

    def test_contact_save_returns_canonical_record_and_orphan_can_be_used_by_a_lead(self):
        account=self.account('Canonical Company','ABN-C')
        result=self.save('contacts',{'name':'Inline Contact','company':'canonical company','phone':'123','email':'inline@example.test'})
        self.assertEqual((result['contact']['company'],result['contact']['account_id'],result['contact']['abn_acn']),
                         ('Canonical Company',account['id'],'ABN-C'))
        self.store.import_rows('contacts',[(2,{'name':'Independent Person'})],self.store.list()['version'])
        orphan=next(person for person in self.store.list()['contacts'] if person['name']=='Independent Person')
        self.assertIsNone(orphan['account_id'])
        self.save('leads',{'name':orphan['name'],'company':'Canonical Company','phone':'0400','email':'independent@example.test','site_address':'Site'},contact_id=orphan['id'],account_id=account['id'])
        lead=self.store.list()['leads'][0]
        self.store.convert({'id':lead['id'],'version':self.store.list()['version']},lambda row:{'project_no':'PN-02','path':'fixture/PN-02.cf.json'})
        self.assertIsNone(next(row for row in self.store.list()['contacts'] if row['id']==orphan['id'])['account_id'])


if __name__ == '__main__':
    unittest.main()
