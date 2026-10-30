"""Synthetic SQLite/native records only; no application or private user inputs."""
from contextlib import closing
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import unittest

from estimator import image_checkpoint_v2_reader as reader
from estimator import recurring_v2_checkpoint as recurring
from estimator import modern_root_profile_v2_adapter as adapter
from test_image_checkpoint_v2_reader import Memory
from test_v2_normal_profile_adapter import Fixture, Published
from test_recurring_v2_checkpoint import Chain, FullMemory


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()


def database():
    with closing(sqlite3.connect(':memory:')) as db:
        db.execute('PRAGMA user_version=3')
        db.execute('CREATE TABLE certification_signer_defaults '
            '(id INTEGER PRIMARY KEY, fields TEXT, version INTEGER, updated_at TEXT, '
            'signature_image TEXT, signature_name TEXT)')
        db.execute('INSERT INTO certification_signer_defaults VALUES (1,?,?,?,?,?)',
            ('{"display":"Synthetic example"}', 1, '2031-01-01T00:00:00Z', None, ''))
        for n in range(20):
            db.execute('CREATE TABLE sample_'+str(n)+' (id INTEGER PRIMARY KEY, value TEXT)')
            db.executemany('INSERT INTO sample_'+str(n)+' VALUES (?,?)',
                [(i, 'synthetic '+str(i)) for i in range(12 if n < 10 else 11)])
        db.commit()
        return db.serialize()


def change_bytes(raw, sql, values=()):
    with closing(sqlite3.connect(':memory:')) as db:
        db.deserialize(raw)
        db.execute(sql, values)
        db.commit()
        return db.serialize()


def typed_bytes(raw):
    with closing(sqlite3.connect(':memory:')) as db:
        db.deserialize(raw)
        tables = {}
        for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            rows = db.execute('SELECT * FROM "'+name.replace('"','""')+'"').fetchall()
            typed = sorted([[(type(v).__name__, v) for v in row] for row in rows], key=repr)
            tables[name] = dict(rows=len(rows), sha256=hashlib.sha256(encoded(typed)).hexdigest())
        return dict(quick_check=db.execute('PRAGMA quick_check').fetchone()[0],
            user_version=db.execute('PRAGMA user_version').fetchone()[0],
            schema=[list(row) for row in db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')],
            tables=tables), None


class SQLMemoryMixin:
    def put(self, path, raw, mtime=None):
        if path == '/database' and raw.startswith(b'{'):
            raw = database()
            self.state = typed_bytes(raw)[0]
        if path == '/approved-typed.py':
            raw = b'from test_saved_signature_database_transition import typed_bytes\n'
        return super().put(path, raw, mtime)

    def typed_bytes(self, raw):
        self.typed_calls += 1
        return typed_bytes(raw)

    def fact_values(self, pointer):
        result = super().fact_values(pointer)
        result.update(current_typed_tables=len(self.state['tables']),
            current_typed_rows=sum(v['rows'] for v in self.state['tables'].values()))
        return result


class SQLMemory(SQLMemoryMixin, Memory):
    pass


class SQLPublished(SQLMemoryMixin, Published):
    pass


class SQLFullMemory(SQLMemoryMixin, FullMemory):
    def doc(self, role, obj, path=None):
        obj = copy.deepcopy(obj)
        if 'current_typed_tables' in obj:
            obj['current_typed_tables'] = len(self.state['tables'])
            obj['current_typed_rows'] = sum(v['rows'] for v in self.state['tables'].values())
        if 'current_tables' in obj:
            obj['current_tables'] = len(self.state['tables'])
            obj['current_rows'] = sum(v['rows'] for v in self.state['tables'].values())
        return super().doc(role, obj, path)


class SignatureChange:
    def __init__(self, m, trusted):
        self.m, self.trusted = m, copy.deepcopy(trusted)
        self.old_facts = json.loads(m.raw[trusted['current_facts']['path']])
        self.old_context = json.loads(m.raw[trusted['current_context']['path']])
        self.oldraw = m.raw[self.old_facts['current_DB']['path']]
        self.old_archive = m.clone(self.old_facts['current_DB'], '/signature/before.sqlite3')
        self.newraw = change_bytes(self.oldraw,
            'UPDATE certification_signer_defaults SET version=2, updated_at=?, signature_image=?, signature_name=? WHERE id=1',
            ('2031-01-02T00:00:00Z', 'synthetic signature data', 'synthetic-signature.png'))
        self.root, self.token = trusted['root'], trusted['token']
        self.refresh()

    def refresh(self):
        m = self.m
        self.after = m.put(self.old_facts['current_DB']['path'], self.newraw)
        self.new_archive = m.clone(self.after, '/signature/after.sqlite3')
        self.oldstate, unused = typed_bytes(self.oldraw)
        self.state, unused = typed_bytes(self.newraw)
        m.db, m.state = self.after, self.state
        self.facts = copy.deepcopy(self.old_facts)
        self.facts.update(current_DB=self.after, current_typed_database_state=self.state,
            current_typed_tables=len(self.state['tables']), current_typed_rows=sum(v['rows'] for v in self.state['tables'].values()))
        self.facts_pin = m.doc('signature-current-facts', self.facts)
        header = m.doc('signature-session', dict(type='session_meta', payload=dict(id=self.root)))
        title = 'Did you save the signer signature in this specific save?'
        self.question = dict(type='response_item', timestamp='2031-01-02T00:01:00Z', payload=dict(
            type='function_call', name='request_user_input_async', call_id='signature-question',
            arguments=json.dumps(dict(questions=[dict(title=title, options=['Yes, I saved it', 'No'])]))))
        self.answer = dict(type='response_item', timestamp='2031-01-02T00:02:00Z', payload=dict(
            type='message', role='user', content=[dict(type='input_text', text='<send_user_message_question_reply>\n'+
                json.dumps([dict(questionItemId=json.dumps(['request_user_input_async','signature-question',0]),
                    question=title, answer='Yes, I saved it')])+'\n</send_user_message_question_reply>')]))
        qp, ap = m.doc('signature-question', self.question), m.doc('signature-answer', self.answer)
        self.cause = dict(schema='ROOT_ACTUAL_DIRECT_HUMAN_CONFIRMS_NEW_SIGNER_SIGNATURE_SAVE_ONLY_V1',
            recorded_utc='2031-01-02T00:03:00Z', owner_thread_id=self.root, owner_execution_token=self.token,
            exact_human_answer='Yes, I saved it', question_call_id='signature-question', session_header=dict(raw_line=header),
            native_events=dict(actual_question=dict(raw_line=qp,byte_offset=10,line_number=2,timestamp=self.question['timestamp']),
                actual_human_answer=dict(raw_line=ap,byte_offset=20,line_number=3,timestamp=self.answer['timestamp'])),
            confirmed_DB_sha256=self.after['sha256'], confirmed_signature_image_sha256=hashlib.sha256(b'synthetic signature data').hexdigest(),
            cause_confirmed=True,only_this_recorded_change_confirmed=True)
        for k in ('future_or_unlisted_changes_authorized','baseline_updated','finite_database_consumer_qualified',
                  'source_or_protected_preservation_admitted','image_selection_acceptance_installation_authorized','technical_approval'):
            self.cause[k] = False
        self.cause_pin = m.doc('signature-cause', self.cause)
        def row(raw):
            with closing(sqlite3.connect(':memory:')) as db:
                db.deserialize(raw); db.row_factory = sqlite3.Row
                return dict(db.execute('SELECT * FROM certification_signer_defaults WHERE id=1').fetchone())
        before, after = row(self.oldraw), row(self.newraw)
        def fields(values):
            return dict(version=values['version'],updated_at=values['updated_at'],
                signature_image=reader._signature_value(values['signature_image']),
                signature_name=reader._signature_value(values['signature_name']))
        self.approval = dict(schema=reader.SAVED_SIGNATURE_SCHEMA,result='PASS_FINITE_SAVED_SIGNER_SIGNATURE_PRESERVATION',
            recorded_utc='2031-01-02T00:04:00Z',owner_thread_id=self.root,owner_execution_token=self.token,
            root_preservation_judgment=True,no_unlisted_or_future_change_admission=True,
            finite_saved_signature_preservation_admitted=True,future_saved_data_changes_authorized=False,shared_mutations=0,
            completed_base=self.trusted['leaf'],current_owner=self.trusted['owner_pin'],current_pointer=self.trusted['current_pointer'],
            historical_database=self.old_facts['current_DB'],historical_archive=self.old_archive,
            current_database=self.after,current_archive=self.new_archive,
            database_native6={role:m.native(pin['path']) for role,pin in (
                ('historical_archive',self.old_archive),('current_archive',self.new_archive),('current_database',self.after))},
            before_typed_state_sha256=reader._state_sha256(self.oldstate),after_typed_state_sha256=reader._state_sha256(self.state),
            exact_table_count=len(self.state['tables']),exact_row_count=sum(v['rows'] for v in self.state['tables'].values()),
            row_transition=dict(table='certification_signer_defaults',row_id=1,
                changed_columns=['signature_image','signature_name','updated_at','version'],before=fields(before),after=fields(after)),
            cause=self.cause_pin)
        for k in ('operational','enabled','future_changes_authorized','image_mutations_authorized','new_generation_authorized',
                  'new_acceptance_authorized','new_installation_authorized','technical_approval'):
            self.approval[k] = False
        self.repin_approval()

    def repin_approval(self):
        self.expected = self.m.doc('signature-approval', self.approval)
        self.context = copy.deepcopy(self.old_context)
        self.context.update(current_facts=self.facts_pin, declared_current_facts=self.facts)
        self.context[reader.SAVED_SIGNATURE_ROLE] = self.expected
        self.context_pin = self.m.doc('signature-current-context', self.context)
        self.trusted.update(current_context=self.context_pin, current_facts=self.facts_pin)

    def repin_cause(self):
        self.cause_pin = self.m.doc('signature-cause', self.cause)
        self.approval['cause'] = self.cause_pin
        self.repin_approval()

    def validator(self, expected=True):
        return reader.read_current_database_state(self.context,self.facts,self.old_facts,self.trusted,
            reader.Observation(self.m.io),expected_approval=self.expected if expected else None)

    def full_read(self, expected=True):
        return reader.read_completed_base_v2(self.trusted['leaf'],self.m.io,trusted=self.trusted,
            env={'CODEX_THREAD_ID':self.root},expected_database_transition_approval=self.expected if expected else None)

    def bound_reader(self):
        p=self.m.put(reader.__file__,Path(reader.__file__).read_bytes())
        return recurring.create_recurring_reader(reader,approved_reader_pin=p,
            expected_database_transition_approval=self.expected)


class SavedSignatureTests(unittest.TestCase):
    def fixture(self):
        m=SQLMemory();return SignatureChange(m,m.trusted)

    def rejected(self, f, code='.'):
        with self.assertRaisesRegex((ValueError,KeyError,sqlite3.Error),code):f.validator()

    def test_default_old_database_path_unchanged(self):
        m=SQLMemory();self.assertEqual(m.read()['current_typed_database_state'],m.state)

    def test_data_selector_without_source_approval_keeps_strict_guard(self):
        f=self.fixture()
        with self.assertRaisesRegex(ValueError,'DATABASE_REQUIRES_SEPARATE_FINITE_CONSUMER'):f.full_read(expected=False)

    def test_approved_real_sqlite_signature_passes_full_fresh_reader(self):
        f=self.fixture();result=f.full_read()
        self.assertEqual(result['current_typed_database_state'],f.state)
        self.assertEqual(result['historical_leaf_snapshot']['current_typed_database_state'],f.oldstate)
        self.assertEqual(len(f.state['tables']),21)
        self.assertEqual(sum(v['rows'] for v in f.state['tables'].values()),231)

    def test_recurring_factory_shares_expected_approval_with_fresh_reader(self):
        f=self.fixture();r=f.bound_reader()
        result=r.read_completed_base_v2(f.trusted['leaf'],f.m.io,trusted=f.trusted,env={'CODEX_THREAD_ID':f.root})
        self.assertEqual(result['current_database'],f.after)

    def test_factory_without_source_binding_cannot_use_data_selector(self):
        f=self.fixture();p=f.m.put(reader.__file__,Path(reader.__file__).read_bytes())
        bound=recurring.create_recurring_reader(reader,approved_reader_pin=p)
        with self.assertRaisesRegex(ValueError,'DATABASE_REQUIRES_SEPARATE_FINITE_CONSUMER'):
            bound.read_completed_base_v2(f.trusted['leaf'],f.m.io,trusted=f.trusted,env={'CODEX_THREAD_ID':f.root})

    def test_factory_expected_binding_is_copied_and_not_a_data_argument(self):
        f=self.fixture();p=f.m.put(reader.__file__,Path(reader.__file__).read_bytes());source=copy.deepcopy(f.expected)
        bound=recurring.create_recurring_reader(reader,approved_reader_pin=p,expected_database_transition_approval=source)
        source['sha256']='0'*64
        self.assertEqual(bound.read_current_database_state(f.context,f.facts,f.old_facts,f.trusted,
            reader.Observation(f.m.io)),f.state)
        with self.assertRaises(TypeError):
            bound.read_current_database_state(f.context,f.facts,f.old_facts,f.trusted,
                reader.Observation(f.m.io),expected_approval=f.expected)

    def test_bound_database_api_fences_approved_reader_dependency(self):
        f=self.fixture();bound=f.bound_reader()
        f.m.put(reader.__file__,b'changed approved reader dependency')
        with self.assertRaisesRegex(ValueError,'PIN_BEFORE'):
            bound.read_current_database_state(f.context,f.facts,f.old_facts,f.trusted,
                reader.Observation(f.m.io))

    def test_untrusted_selector_rejected_before_document_read(self):
        f=self.fixture();f.context[reader.SAVED_SIGNATURE_ROLE]=f.m.doc('untrusted',{'enabled':True})
        self.rejected(f,'EXTERNAL_APPROVAL_BINDING')

    def test_approval_pin_bytes_must_be_current(self):
        f=self.fixture();f.m.put(f.expected['path'],b'changed')
        self.rejected(f,'PIN_BEFORE')

    def test_approval_identity_missing_or_foreign(self):
        for key,value in [('owner_thread_id','other'),('owner_execution_token','other')]:
            with self.subTest(key=key):
                f=self.fixture();f.approval[key]=value;f.repin_approval();self.rejected(f,'IDENTITY')
        for key in ('owner_thread_id','owner_execution_token'):
            with self.subTest(missing=key):
                f=self.fixture();del f.approval[key];f.repin_approval();self.rejected(f)

    def test_approval_schema_and_finite_flags(self):
        for key,value in [('schema','ordinary continuation'),('root_preservation_judgment',False),
                          ('future_saved_data_changes_authorized',True),('future_changes_authorized',True),
                          ('new_installation_authorized',True),('shared_mutations',True)]:
            with self.subTest(key=key):
                f=self.fixture();f.approval[key]=value;f.repin_approval();self.rejected(f)
        f=self.fixture();f.approval['unlisted_future_row_permission']=True;f.repin_approval();self.rejected(f,'APPROVAL_SCHEMA')

    def test_wrong_owner_pointer_or_historical_leaf(self):
        for key in ['current_owner','current_pointer','completed_base']:
            with self.subTest(key=key):
                f=self.fixture();f.approval[key]=f.m.doc('foreign',{});f.repin_approval();self.rejected(f,'ACTOR_SCOPE')

    def test_active_owner_and_hold_fences(self):
        for key,value in [('status','inactive'),('automation_retarget_pending',True),('image_publication_hold_active',True)]:
            with self.subTest(key=key):
                f=self.fixture();d=json.loads(f.m.raw[f.trusted['owner_pin']['path']]);d[key]=value
                p=f.m.doc('changed-owner',d,path=f.trusted['owner_pin']['path']);f.trusted['owner_pin']=p
                f.approval['current_owner']=p;f.repin_approval();self.rejected(f)

    def test_schema_user_version_table_and_other_table_rows_rejected(self):
        for sql in ['CREATE TABLE unexpected (id INTEGER)', 'PRAGMA user_version=4',
                    "UPDATE sample_0 SET value='unlisted' WHERE id=0", 'INSERT INTO sample_0 VALUES (99,\'extra\')',
                    'ALTER TABLE certification_signer_defaults ADD COLUMN unexpected TEXT']:
            with self.subTest(sql=sql):
                f=self.fixture();f.newraw=change_bytes(f.newraw,sql);f.refresh();self.rejected(f)

    def test_unlisted_signer_text_change_rejected_even_with_repinned_evidence(self):
        f=self.fixture();f.newraw=change_bytes(f.newraw,"UPDATE certification_signer_defaults SET fields='changed'")
        f.refresh();self.rejected(f,'ONLY_FOUR_FIELDS')

    def test_appended_signer_row_rejected(self):
        f=self.fixture();f.newraw=change_bytes(f.newraw,"INSERT INTO certification_signer_defaults VALUES(2,'x',1,'2031-01-01T00:00:00Z',NULL,'')")
        f.refresh();self.rejected(f)

    def test_wrong_supported_row_or_unlisted_field_declaration(self):
        for key,value in [('row_id',2),('changed_columns',['signature_image','fields','updated_at','version'])]:
            with self.subTest(key=key):
                f=self.fixture();f.approval['row_transition'][key]=value;f.repin_approval();self.rejected(f,'ONLY_FOUR_FIELDS')

    def test_version_increment_not_arbitrary_or_boolean(self):
        for value in [1,3]:
            with self.subTest(version=value):
                f=self.fixture();f.newraw=change_bytes(f.newraw,'UPDATE certification_signer_defaults SET version=?',(value,));f.refresh();self.rejected(f)
        f=self.fixture();f.approval['row_transition']['before']['version']=True;f.repin_approval();self.rejected(f,'EXACT_FIELD_TRANSITION')

    def test_timestamp_invalid_older_or_after_human_answer(self):
        for value in ['not a timestamp','2030-01-01T00:00:00Z','2031-01-03T00:00:00Z','2031-01-02T00:00:00']:
            with self.subTest(value=value):
                f=self.fixture();f.newraw=change_bytes(f.newraw,'UPDATE certification_signer_defaults SET updated_at=?',(value,));f.refresh();self.rejected(f)

    def test_signature_hash_size_name_and_typed_hash_must_match(self):
        for key in ['signature_image','signature_name']:
            for field,value in [('sha256','0'*64),('utf8_bytes',1)]:
                with self.subTest(key=key,field=field):
                    f=self.fixture();f.approval['row_transition']['after'][key][field]=value;f.repin_approval();self.rejected(f,'EXACT_FIELD_TRANSITION')
        f=self.fixture();f.approval['after_typed_state_sha256']='0'*64;f.repin_approval();self.rejected(f,'WHOLE_TYPED_STATES')

    def test_snapshot_archives_exact_and_distinct_from_current(self):
        for role in ['historical_archive','current_archive']:
            with self.subTest(role=role):
                f=self.fixture();f.approval[role]=f.m.put('/wrong-archive',b'wrong bytes');f.repin_approval();self.rejected(f)
        f=self.fixture();f.approval['historical_archive']=f.old_facts['current_DB'];f.repin_approval();self.rejected(f)
        f=self.fixture();f.approval['current_archive']=f.after;f.repin_approval();self.rejected(f)

    def test_actual_current_bytes_must_equal_exact_new_snapshot(self):
        f=self.fixture();f.m.put(f.after['path'],change_bytes(f.newraw,'PRAGMA user_version=5'))
        self.rejected(f,'NATIVE_SCOPE')

    def test_old_baseline_wrong_typed_state_rejected(self):
        f=self.fixture();f.old_facts['current_typed_database_state']=copy.deepcopy(f.state)
        self.rejected(f,'WHOLE_TYPED_STATES')

    def test_database_is_not_inserted_in_protected_inventory(self):
        f=self.fixture();f.facts['protected_fullpins'][f.after['path']]=f.after
        self.rejected(f,'SEPARATE_EXACT_DATABASE_ROLE')

    def test_sidecars_and_late_database_race_rejected(self):
        for suffix in ['-wal','-shm','-journal']:
            with self.subTest(suffix=suffix):
                f=self.fixture();f.m.put(f.after['path']+suffix,b'sidecar');self.rejected(f,'DB_SIDECARS')
        f=self.fixture();original=f.m.io['typed_bytes'];calls=[]
        def raced(raw):
            result=original(raw);calls.append(raw)
            if len(calls)==2:f.m.put(f.after['path'],b'advanced during typed comparison')
            return result
        f.m.io['typed_bytes']=raced;self.rejected(f,'END_PIN_RACE')

    def test_database_and_archive_native_identity_is_exact(self):
        for role in ('historical_archive','current_archive','current_database'):
            with self.subTest(role=role):
                f=self.fixture();f.approval['database_native6'][role][2]+=1;f.repin_approval();self.rejected(f,'NATIVE_SCOPE')
        f=self.fixture();original=f.m.io['typed_bytes'];native=f.m.io['native'];changed=[]
        def raced(raw):
            result=original(raw);changed.append(1);return result
        def observed(path):
            result=native(path)
            if len(changed)>=2 and path==f.after['path']:result[2]+=1
            return result
        f.m.io.update(typed_bytes=raced,native=observed);self.rejected(f,'END_NATIVE_RACE')

    def test_sidecar_created_during_final_inventory_is_rejected(self):
        f=self.fixture();original=f.m.io['inventory'];calls=[]
        def inventory(definition):
            result=original(definition);calls.append(1)
            if len(calls)==2:f.m.put(f.after['path']+'-wal',b'late signature write')
            return result
        f.m.io['inventory']=inventory
        with self.assertRaisesRegex(ValueError,'DB_SIDECARS'):f.full_read()

    def test_sidecar_born_after_second_journal_check_is_fenced(self):
        f=self.fixture();exists=f.m.io['exists'];checks=[]
        def appeared(path):
            result=exists(path)
            if path==f.after['path']+'-journal':
                checks.append(1)
                if len(checks)==2:f.m.put(f.after['path']+'-wal',b'late concurrent write')
            return result
        f.m.io['exists']=appeared
        with self.assertRaisesRegex(ValueError,'DB_SIDECARS'):f.full_read()

    def test_cause_schema_scope_and_confirmed_hash_reject_unrelated_permission(self):
        for key,value in [('schema','ROOT_GENERIC_CONTINUE'),('cause_confirmed',False),
                          ('only_this_recorded_change_confirmed',False),('future_or_unlisted_changes_authorized',True),
                          ('confirmed_DB_sha256','0'*64),('confirmed_signature_image_sha256','0'*64)]:
            with self.subTest(key=key):
                f=self.fixture();f.cause[key]=value;f.repin_cause();self.rejected(f)

    def test_native_answer_must_be_direct_user_for_same_question(self):
        for field,value in [('role','assistant'),('type','function_call_output')]:
            with self.subTest(field=field):
                f=self.fixture();f.answer['payload'][field]=value
                f.cause['native_events']['actual_human_answer']['raw_line']=f.m.doc('signature-answer',f.answer)
                f.repin_cause();self.rejected(f,'DIRECT_USER_REPLY')
        f=self.fixture();f.answer['payload']['content'][0]['text']='continue automatically'
        f.cause['native_events']['actual_human_answer']['raw_line']=f.m.doc('signature-answer',f.answer)
        f.repin_cause();self.rejected(f,'EXPLICIT_QUESTION_REPLY')

    def test_native_reply_call_session_and_answer_are_exact(self):
        f=self.fixture();f.cause['question_call_id']='other';f.repin_cause();self.rejected(f,'DIRECT_USER_REPLY')
        f=self.fixture();f.cause['session_header']['raw_line']=f.m.doc('signature-session',dict(type='session_meta',payload=dict(id='foreign')))
        f.repin_cause();self.rejected(f,'NATIVE_SESSION')
        f=self.fixture();f.cause['exact_human_answer']='unrelated';f.repin_cause();self.rejected(f,'CAUSAL_HUMAN_ANSWER')

    def test_native_reply_index_boolean_is_not_integer_zero(self):
        f=self.fixture();text=f.answer['payload']['content'][0]['text']
        opening='<send_user_message_question_reply>';closing='</send_user_message_question_reply>'
        replies=json.loads(text.split(opening)[1].split(closing)[0])
        replies[0]['questionItemId']=json.dumps(['request_user_input_async','signature-question',False])
        f.answer['payload']['content'][0]['text']=opening+json.dumps(replies)+closing
        f.cause['native_events']['actual_human_answer']['raw_line']=f.m.doc('signature-answer',f.answer)
        f.repin_cause();self.rejected(f,'CAUSAL_HUMAN_ANSWER')

    def test_consistently_repinned_negative_uncertain_and_continue_are_not_confirmation(self):
        for answer in ["No, I didn't", "I'm not sure", 'Continue', 'Yes', '']:
            with self.subTest(answer=answer):
                f=self.fixture();text=f.answer['payload']['content'][0]['text']
                opening='<send_user_message_question_reply>';closing='</send_user_message_question_reply>'
                replies=json.loads(text.split(opening)[1].split(closing)[0]);replies[0]['answer']=answer
                f.answer['payload']['content'][0]['text']=opening+json.dumps(replies)+closing
                f.cause['exact_human_answer']=answer
                f.cause['native_events']['actual_human_answer']['raw_line']=f.m.doc('signature-answer',f.answer)
                f.repin_cause();self.rejected(f,'AFFIRMATIVE_ANSWER|CAUSAL_HUMAN_ANSWER')

    def test_native_question_bytes_and_order_are_fenced(self):
        f=self.fixture();p=f.cause['native_events']['actual_question']['raw_line'];f.m.put(p['path'],b'changed')
        self.rejected(f,'PIN_BEFORE')
        f=self.fixture();f.cause['native_events']['actual_human_answer']['line_number']=1;f.repin_cause();self.rejected(f,'CAUSE_CHRONOLOGY')

    def test_no_unused_transition_after_new_baseline(self):
        f=self.fixture();f.old_facts=copy.deepcopy(f.facts)
        self.rejected(f,'SEPARATE_EXACT_DATABASE_ROLE')

    def test_normal_profile_fresh_and_installed_phase_share_one_validator(self):
        normal=Fixture(memory_factory=SQLPublished);m=normal.m;f=SignatureChange(m,m.trusted)
        normal.binding['trusted']=f.trusted
        bound=f.bound_reader();normal.binding['reader_pin']=m.put(recurring.__file__,Path(recurring.__file__).read_bytes())
        normal.context['config'][adapter.OPTIONAL_ROLE]=f.context_pin
        normal.revise_admission(lambda a:(a.__setitem__(adapter.OPTIONAL_ROLE,f.context_pin),
            a['evidence_roles'].__setitem__(adapter.OPTIONAL_ROLE,f.context_pin),
            a['evidence_roles'].__setitem__('fresh_source_protected_qualification',f.facts_pin),
            a.__setitem__('database',dict(current_fullpin=f.after,immutable_raw_fullpin=f.new_archive,typed_state=f.state))))
        fresh=normal.qualify(approved_reader=bound)
        self.assertEqual(fresh['typed_state'],f.state)
        normal.install();normal.binding['reader_pin']=normal.binding['history_module_pin']
        after=normal.qualify(approved_reader=bound)
        self.assertEqual(after['typed_state'],f.state)
        self.assertEqual(after['leaf']['current_typed_database_state'],f.oldstate)
        self.assertEqual(after['v2_baseline_mode'],'DATED_PUBLISHED_V2_PLUS_SEPARATE_CURRENT_OPERATION_PHASE')

    def test_real_writer_two_generations_keep_old_baseline_then_new_default(self):
        chain=Chain(memory_factory=SQLFullMemory,typed_bytes=typed_bytes);m=chain.m
        f=SignatureChange(m,chain.reader_trusted);chain.reader_trusted=f.trusted;chain.facts=f.facts
        self.assertEqual(chain.full_read(f.expected)['current_typed_database_state'],f.state)
        chain.next_operation(job=25);chain.qualify();second=chain.write_next();chain.publish(second,'signature-second')
        self.assertEqual(chain.full_read()['current_typed_database_state'],f.state)
        self.assertEqual(chain.history()['ordinary_parent_snapshot']['schema'],'STABLE_REVIEWED_IMAGE_BATCH_COMPACT_V1')
        chain.next_operation(job=26);chain.qualify();third=chain.write_next();chain.publish(third,'signature-third')
        self.assertEqual(chain.full_read()['current_typed_database_state'],f.state)
        first=json.loads(m.raw[chain.first_written['receipt_version']['path']])
        self.assertEqual(first['current_typed_database_state'],f.oldstate)


if __name__ == '__main__':
    unittest.main()
