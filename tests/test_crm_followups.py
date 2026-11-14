from pathlib import Path
import json
import tempfile
import unittest
from uuid import uuid4

from estimator import crm_activity
from estimator.catalog import ValidationError
from estimator.contacts import ContactsConflict, ContactsStore


class LeadFollowupsTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "contacts.sqlite3"
        self.store = ContactsStore(self.path)
        self.fields = dict(name='Local contact', company='Synthetic Company', phone='0400000000',
                           email='local@example.test', site_address='Synthetic site')
        self.actor = {'id':str(uuid4()), 'name':'CRM staff'}

    def save(self, ident=None, **fields):
        return self.store.save('leads', {'id':ident, 'version':self.store.list()['version'],
                               'fields':{**self.fields, **fields}}, actor=self.actor)

    def test_legacy_three_column_database_reads_stable_ids_and_no_receipts_until_decision(self):
        saved = self.save()
        with self.store.connection() as db:
            db.execute('DROP TABLE lead_followups')
            db.execute('CREATE TABLE lead_followups (lead_id TEXT PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE, next_action TEXT NOT NULL, follow_up_date TEXT NOT NULL)')
            db.execute('INSERT INTO lead_followups VALUES(?,?,?)', (saved['id'],'Arrange site visit','2028-02-12'))
            events = db.execute('SELECT count(*) FROM crm_events').fetchone()[0]
        self.store = ContactsStore(self.path)
        lead, = self.store.list()['leads']
        row, = lead['follow_up_actions']
        self.assertEqual(row,dict(id=row['id'], next_action='Arrange site visit', follow_up_date='2028-02-12',status=''))
        self.save(saved['id'], status='Qualified')
        self.assertEqual(ContactsStore(self.path).list()['leads'][0]['follow_up_actions'], [row])
        with self.store.connection() as db:
            self.assertIsNone(db.execute('SELECT actions FROM lead_followups').fetchone()[0])
            self.assertEqual(db.execute('SELECT count(*) FROM crm_events').fetchone()[0],events)
        receipt = self.store.convert({'id':saved['id'],'version':self.store.list()['version']},
                                     lambda _:{'path':'C:/synthetic/QA.cf.json','project_no':'QA'}, actor=self.actor)
        archived, = self.store.list(lead_board=True)['converted_leads']
        self.assertEqual(archived['snapshot']['follow_up_actions'],[row])
        self.assertEqual(archived['project_no'],receipt['project_no'])
        with self.assertRaises(ValidationError):
            self.save(saved['id'], follow_up_actions=[{**row,'status':'Completed'}])
        # Already converted records from old installations also have stable action IDs.
        with self.store.connection() as db:
            legacy = dict(archived['snapshot'])
            legacy.pop('follow_up_actions')
            db.execute('UPDATE lead_conversion_details SET snapshot=? WHERE lead_id=?',(json.dumps(legacy),saved['id']))
        self.assertEqual(self.store.list(lead_board=True)['converted_leads'][0]['snapshot']['follow_up_actions'],[row])

    def test_multiple_actions_commit_decision_history_once_and_keep_old_editor_projection(self):
        def row(text, due):
            return dict(id=str(uuid4()), next_action=text, follow_up_date=due, status='')
        later, soon, undated = row('Visit','2028-03-01'), row('Call','2028-02-01'), row('Email','')
        ident = self.save(follow_up_actions=[later,soon,undated])['id']
        def lead():
            return self.store.list()['leads'][0]
        def events():
            with self.store.connection() as db:
                return crm_activity.timeline(db,'leads',ident)['events']
        self.assertEqual((lead()['next_action'],lead()['follow_up_date']),('Call','2028-02-01'))
        self.save(ident,next_action='Call again')
        soon['next_action'] = 'Call again'
        self.assertEqual(lead()['follow_up_actions'],[later,soon,undated])
        finished = [{**later,'status':'Completed'}, {**soon,'status':'Canceled'}, undated]
        version = self.store.list()['version']
        self.save(ident,follow_up_actions=finished)
        self.assertEqual((lead()['next_action'],lead()['follow_up_date']),('Email',''))
        recorded = events()
        decisions = {e['detail']['action_id']:e for e in recorded if e['event_type'].startswith('Follow-up ')}
        self.assertEqual(set(decisions),{later['id'],soon['id']})
        for action in finished[:2]:
            event=decisions[action['id']]
            self.assertEqual((event['event_type'],event['detail']['text'],event['due_date'],event['actor_id']),
                ('Follow-up '+action['status'].lower(), action['next_action'],action['follow_up_date'],self.actor['id']))
        with self.assertRaises(ContactsConflict):
            self.store.save('leads',{'id':ident,'version':version,'fields':{**self.fields,'follow_up_actions':finished}},actor=self.actor)
        self.save(ident,follow_up_actions=finished)
        self.assertEqual(events(),recorded)
        for invalid in (finished[1:], [dict(finished[0],status=''), *finished[1:]],
                        [dict(finished[0],next_action='Altered after completion'),*finished[1:]], [*finished,undated]):
            with self.assertRaises(ValidationError):
                self.save(ident,follow_up_actions=invalid)
        self.assertEqual(lead()['follow_up_actions'],finished)
        self.assertEqual(events(),recorded)

    def test_decision_and_action_roll_back_together_if_tail_of_save_fails(self):
        ident = self.save(next_action='Confirm access')['id']
        original=self.store.list()
        row,=original['leads'][0]['follow_up_actions']
        with self.assertRaisesRegex(ValidationError,'active staff'):
            self.store.save('leads',dict(id=ident,version=original['version'],owner_id='unknown',
                fields={**self.fields,'follow_up_actions':[dict(row,status='Completed')]}),actor=self.actor)
        self.assertEqual(self.store.list(), original)
        with self.store.connection() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM crm_events WHERE event_type LIKE 'Follow-up %'").fetchone()[0],0)

    def test_optional_fields_survive_old_forms_and_stale_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = ContactsStore(Path(tmp) / "directory.sqlite3")
            fields = {"name": "Sam", "company": "Sample", "phone": "111", "email": "sam@example.test",
                      "site_address": "East", "next_action": "Call", "follow_up_date": "2028-02-29"}
            result = store.save("leads", {"fields": fields, "version": 0})
            fields.pop("next_action")
            fields.pop("follow_up_date")
            def edit(version, **updates):
                return store.save("leads", {"id": result["id"], "fields": {**fields, **updates}, "version": version})
            def followup():
                lead, = store.list()["leads"]
                return lead["next_action"], lead["follow_up_date"]
            edit(1, status="Qualified")
            self.assertEqual(followup(), ("Call", "2028-02-29"))
            with self.assertRaises(ContactsConflict):
                edit(1, next_action="Stale")
            for invalid in ("2027-02-29", "20281109", "2028-W01-2"):
                with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                    edit(2, next_action="New", follow_up_date=invalid)
            self.assertEqual(followup(), ("Call", "2028-02-29"))
            edit(2, next_action="Email")
            self.assertEqual(followup(), ("Email", "2028-02-29"))
            edit(3, follow_up_date="", next_action="")
            self.assertEqual(followup(), ("", ""))
            with store.connection() as db:
                self.assertEqual(db.execute("SELECT count(*) FROM lead_followups").fetchone()[0], 0)
