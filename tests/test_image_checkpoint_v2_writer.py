"""Synthetic capability/store tests; no audit contents or private image fixtures."""
from contextlib import contextmanager
import copy
import json
from pathlib import Path
import runpy
import tempfile
import unittest

from estimator import image_checkpoint_recovery as core
from estimator import image_checkpoint_v2_writer as writer
from test_image_checkpoint_recovery import Memory


class MemoryStore:
    def __init__(self,memory,fail_create=None,on_assert=None,on_enter=None):
        self.m=memory;self.creates=[];self.fail_create=fail_create
        self.on_assert=on_assert;self.on_enter=on_enter;self.assertions=0;self.lock_entries=0

    @contextmanager
    def owner_lock(self,path,payload):
        if path in self.m.raw:raise FileExistsError(path)
        self.lock_entries+=1;self.m.put(path,payload)
        original=self.m.version(path)
        def assert_owned():
            self.assertions+=1
            if self.on_assert:self.on_assert(self,self.assertions)
            writer.need(self.m.pins.get(path)==original and self.m.raw.get(path)==payload,'TEST_LOCK_LOST')
        try:
            if self.on_enter:self.on_enter(self)
            yield assert_owned
        finally:
            if self.m.pins.get(path)==original and self.m.raw.get(path)==payload:
                del self.m.raw[path];del self.m.pins[path]

    def create(self,path,raw):
        if path in self.m.raw:raise FileExistsError(path)
        if len(self.creates)+1==self.fail_create:raise OSError('simulated interrupted create')
        self.creates.append(path);return self.m.put(path,raw)


class Capability:
    def __init__(self,change_permit=None,change_review=None,change_ci=None,change_expected=None,memory=None):
        self.m=memory or Memory();m=self.m
        self.writer_module=m.put(str(Path(writer.__file__).resolve()),Path(writer.__file__).read_bytes())
        self.qualifier_module=m.put(str(Path(core.__file__).resolve()),Path(core.__file__).read_bytes())
        archives={}
        for role,pin in [('writer_module',self.writer_module),('qualifier_module',self.qualifier_module)]:
            archives[role]=dict(observed=pin,retained_copy=m.clone(pin,'/immutable-code/'+role+'.py'))
        review=dict(schema=writer.REVIEW_SCHEMA,result='PASS',owner_thread_id='root',owner_execution_token='token',
            reviewed_commit='a'*40,retained_source_archives=archives)
        if change_review:change_review(review)
        self.review=m.doc('writer-code-review',review)
        ci=dict(schema=writer.CI_SCHEMA,result='PASS',merged=True,all_required_checks_passed=True,
            head_is_ancestor_of_merge=True,head_commit='a'*40,merge_commit='b'*40,
            reviewed_source_sha256={r:p['sha256'] for r,p in [('writer_module',self.writer_module),('qualifier_module',self.qualifier_module)]},
            required_check_conclusions={'verify':'success','desktop':'success','browser':'success'})
        if change_ci:change_ci(ci)
        self.ci=m.doc('writer-merged-ci',ci)
        outputs=dict(journal='/audit/private-attempt/NEVER_REPLAY.json',leaf='/audit/private-attempt/COMPACT.json',
            proposal='/audit/private-attempt/PROPOSAL.json')
        permit=dict(schema=writer.PERMIT_SCHEMA,result='ROOT_EXPLICIT_FINITE_CHECKPOINT_WRITER_PERMIT',
            owner_thread_id='root',owner_execution_token='token',writer_enabled=True,descriptor=m.descriptor,
            current_owner=m.owner,current_judgment=m.judgment,current_facts=m.facts,before_publication_pointer=m.pointer,
            writer_module=self.writer_module,qualifier_module=self.qualifier_module,code_review=self.review,merged_code_CI=self.ci,
            private_output_root='/audit/private-attempt',outputs=outputs,lock_path='/owner.lock',
            exclusive_owner_lock_required=True,new_namespace_only=True,merged_code_commit='b'*40)
        for k in ('new_generation_authorized','new_acceptance_authorized','new_installation_authorized','CURRENT_write_authorized',
                  'overwrite_authorized','resume_authorized','future_changes_authorized','technical_approval'):permit[k]=False
        if change_permit:change_permit(permit)
        self.permit=m.doc('writer-permit',permit)
        self.expected={k:permit[k] for k in ('writer_module','qualifier_module','code_review','merged_code_CI','private_output_root','outputs','lock_path')}
        self.expected['permit']=self.permit
        if change_expected:change_expected(self.expected)
        self.store=MemoryStore(m)

    def write(self,store=None,expected='present'):
        return writer.write_checkpoint_v2(self.m.descriptor,self.m.io,core=core,trusted=self.m.trusted,
            writer_trusted=self.expected if expected=='present' else expected,store=store or self.store,
            env={'CODEX_THREAD_ID':'root'})


class CapabilityWriterTests(unittest.TestCase):
    def assert_blocked(self,cap,code):
        with self.assertRaisesRegex((ValueError,FileExistsError),code):cap.write()
        self.assertEqual(cap.store.creates,[])

    def test_missing_external_capability_has_no_lock_or_outputs(self):
        cap=Capability()
        with self.assertRaisesRegex(ValueError,'EXTERNAL_WRITER'):cap.write(expected=None)
        self.assertEqual(cap.store.lock_entries,0);self.assertEqual(cap.store.creates,[])

    def test_reviewed_write_creates_only_three_private_files(self):
        cap=Capability();before=copy.deepcopy(cap.m.raw);result=cap.write()
        self.assertEqual(set(cap.m.raw)-set(before),set(cap.expected['outputs'].values()))
        self.assertTrue(all(cap.m.raw[p]==raw for p,raw in before.items()))
        self.assertTrue(result['actual_exit_code_not_claimed']);self.assertFalse(result['publication_completed'])
        self.assertTrue(result['no_primary_invoked']);self.assertTrue(result['no_application_mutations'])
        leaf=json.loads(cap.m.raw[result['receipt_version']['path']])
        self.assertEqual(leaf['schema'],core.COMPACT_SCHEMA);self.assertEqual(leaf['result'],'PASS')
        self.assertNotIn('final_schema_requires_review',leaf)
        self.assertIsNone(leaf['actual_checkpoint_native_completion']);self.assertIsNone(leaf['actual_checkpoint_root_outer0'])
        self.assertEqual(leaf['baseline_snapshot'],dict(facts=cap.m.facts,root_judgment=cap.m.judgment,descriptor=cap.m.descriptor))
        self.assertEqual(leaf['writer_journal'],result['writer_journal'])
        self.assertEqual(cap.store.creates,[cap.expected['outputs'][r] for r in ('journal','leaf','proposal')])

    def test_writer_requires_real_process_identity_unless_synthetic_fixture(self):
        cap=Capability()
        with self.assertRaisesRegex(ValueError,'TRUSTED_PROCESS_IDENTITY'):
            writer.write_checkpoint_v2(cap.m.descriptor,cap.m.io,core=core,trusted=cap.m.trusted,
                writer_trusted=cap.expected,store=cap.store,env={'CODEX_THREAD_ID':'foreign'})
        self.assertEqual(cap.store.lock_entries,0)

    def test_unmerged_code_rejected(self):self.assert_blocked(Capability(change_ci=lambda x:x.__setitem__('merged',False)),'MERGED_EXACT')
    def test_failed_required_ci_rejected(self):self.assert_blocked(Capability(change_ci=lambda x:x['required_check_conclusions'].__setitem__('browser','failure')),'MERGED_EXACT')
    def test_pending_required_ci_rejected(self):self.assert_blocked(Capability(change_ci=lambda x:x.__setitem__('all_required_checks_passed',False)),'MERGED_EXACT')
    def test_other_source_hash_rejected(self):self.assert_blocked(Capability(change_ci=lambda x:x['reviewed_source_sha256'].__setitem__('writer_module','0'*64)),'MERGED_EXACT')
    def test_different_review_commit_rejected(self):self.assert_blocked(Capability(change_review=lambda x:x.__setitem__('reviewed_commit','c'*40)),'EXACT_REVIEWED_COMMIT')
    def test_code_archive_must_equal_reviewed_runtime_bytes(self):
        cap=Capability(change_review=lambda x:x['retained_source_archives']['writer_module'].__setitem__('observed',{}))
        self.assert_blocked(cap,'HONEST_REVIEWED_CODE_ARCHIVE')
    def test_current_write_permission_cannot_be_smuggled(self):self.assert_blocked(Capability(change_permit=lambda x:x.__setitem__('CURRENT_write_authorized',True)),'EXACT_FINITE')
    def test_install_permission_cannot_be_smuggled(self):self.assert_blocked(Capability(change_permit=lambda x:x.__setitem__('new_installation_authorized',True)),'EXACT_FINITE')
    def test_permit_cannot_choose_other_owner_lock(self):self.assert_blocked(Capability(change_permit=lambda x:x.__setitem__('lock_path','/other.lock')),'FIXED_OWNER_LOCK')
    def test_permit_cannot_escape_private_audit_namespace(self):self.assert_blocked(Capability(change_permit=lambda x:x.__setitem__('private_output_root','/')),'PRIVATE_AUDIT')
    def test_output_target_is_closed_to_private_root(self):self.assert_blocked(Capability(change_permit=lambda x:x['outputs'].__setitem__('leaf','/registry')),'CLOSED_THREE')
    def test_duplicate_output_paths_rejected(self):self.assert_blocked(Capability(change_permit=lambda x:x['outputs'].__setitem__('leaf',x['outputs']['journal'])),'CLOSED_THREE')
    def test_unapproved_current_module_path_rejected(self):
        cap=Capability(change_expected=lambda x:x['writer_module'].__setitem__('path','/other-writer.py'))
        self.assert_blocked(cap,'ACTUAL_APPROVED_MODULE_PATHS')
    def test_changed_module_bytes_rejected_before_lock(self):
        cap=Capability();cap.m.put(cap.writer_module['path'],b'changed code')
        self.assert_blocked(cap,'PIN_BEFORE');self.assertEqual(cap.store.lock_entries,0)
    def test_missing_explicit_store_rejected(self):
        cap=Capability()
        with self.assertRaisesRegex(ValueError,'EXPLICIT_CHECKPOINT_STORE'):
            writer.write_checkpoint_v2(cap.m.descriptor,cap.m.io,core=core,trusted=cap.m.trusted,
                writer_trusted=cap.expected,env={'CODEX_THREAD_ID':'root'})
    def test_existing_lock_prevents_qualification_and_outputs(self):
        cap=Capability();cap.m.put('/owner.lock',b'foreign owner')
        self.assert_blocked(cap,'/owner.lock')
    def test_existing_journal_never_replays(self):
        cap=Capability();cap.m.put(cap.expected['outputs']['journal'],b'earlier interrupted attempt')
        self.assert_blocked(cap,'NEVER_REPLAY')
    def test_existing_leaf_never_overwrites(self):
        cap=Capability();cap.m.put(cap.expected['outputs']['leaf'],b'old leaf')
        self.assert_blocked(cap,'NEVER_REPLAY')
    def test_partial_failure_retains_intent_and_forbids_replay(self):
        cap=Capability();store=MemoryStore(cap.m,fail_create=2)
        with self.assertRaisesRegex(OSError,'interrupted'):cap.write(store)
        self.assertIn(cap.expected['outputs']['journal'],cap.m.raw);self.assertNotIn(cap.expected['outputs']['leaf'],cap.m.raw)
        self.assert_blocked(cap,'NEVER_REPLAY')
    def test_owner_drift_inside_lock_stops_before_journal(self):
        cap=Capability();store=MemoryStore(cap.m,on_enter=lambda s:s.m.put('/owner.json',b'changed owner'))
        with self.assertRaisesRegex(ValueError,'PIN_BEFORE'):cap.write(store)
        self.assertEqual(store.creates,[])
    def test_lock_loss_before_intent_stops_all_outputs(self):
        cap=Capability()
        def lose(store,n):
            if n==2:store.m.put('/owner.lock',b'foreign replacement')
        store=MemoryStore(cap.m,on_assert=lose)
        with self.assertRaisesRegex(ValueError,'TEST_LOCK_LOST'):cap.write(store)
        self.assertEqual(store.creates,[])
    def test_control_drift_after_qualification_never_creates_leaf(self):
        cap=Capability()
        def drift(store,n):
            if n==2:store.m.put('/queue',b'concurrent control drift')
        store=MemoryStore(cap.m,on_assert=drift)
        with self.assertRaisesRegex(ValueError,'END_PIN_RACE'):cap.write(store)
        self.assertNotIn(cap.expected['outputs']['leaf'],cap.m.raw)
    def test_created_journal_leaf_and_proposal_are_fenced(self):
        for role,stage in [('journal',3),('leaf',4),('proposal',5)]:
            with self.subTest(role=role):
                cap=Capability()
                def tamper(store,n):
                    if n==stage:store.m.put(cap.expected['outputs'][role],b'tampered output')
                store=MemoryStore(cap.m,on_assert=tamper)
                with self.assertRaisesRegex(ValueError,'END_PIN_RACE'):cap.write(store)
                self.assertIn(cap.expected['outputs']['journal'],cap.m.raw)
                retry=MemoryStore(cap.m)
                with self.assertRaisesRegex(ValueError,'NEVER_REPLAY'):cap.write(retry)
                self.assertEqual(retry.creates,[])
    def test_windows_stream_device_and_trailing_alias_paths_rejected(self):
        for path in ['C:/audit/session/output/file:stream','C:/audit/session/output/CON.json',
                     'C:/audit/session/output/name.','C:/audit/session/output/name ',
                     'C:/audit/session/output/COM¹.txt']:
            with self.subTest(path=path):
                with self.assertRaisesRegex(ValueError,'REGULAR_PORTABLE'):writer.lexical(path)
    def test_windows_case_and_separator_aliases_rejected(self):
        trusted=dict(private_output_root='C:/audit/session/output',lock_path='C:/audit/owner.lock',
            outputs=dict(journal='C:/audit/session/output/intent.json',leaf='c:\\AUDIT\\session\\output\\INTENT.JSON',
                         proposal='C:/audit/session/output/proposal.json'))
        with self.assertRaisesRegex(ValueError,'CLOSED_THREE'):writer._paths(trusted,'C:/audit/owner.json')
    def test_windows_output_spelling_cannot_differ_from_creation_pin(self):
        trusted=dict(private_output_root='C:\\audit\\session\\output',lock_path='C:\\audit\\owner.lock',
            outputs=dict(journal='C:\\audit\\session\\output\\intent.json',leaf='C:/audit/session/output/leaf.json',
                         proposal='C:\\audit\\session\\output\\proposal.json'))
        with self.assertRaisesRegex(ValueError,'CANONICAL_NATIVE'):writer._paths(trusted,'C:\\audit\\owner.json')
    def test_backend_returned_pin_must_bind_exact_role_path(self):
        cap=Capability()
        class WrongPinStore(MemoryStore):
            def create(self,path,raw):
                pin=super().create(path,raw);pin['path']='/other-role';return pin
        with self.assertRaisesRegex(ValueError,'CREATED_OUTPUT_ROLE_PATH'):cap.write(WrongPinStore(cap.m))
        self.assertIn(cap.expected['outputs']['journal'],cap.m.raw)
        self.assertNotIn(cap.expected['outputs']['leaf'],cap.m.raw)
    def test_output_tamper_during_final_candidate_inventory_is_caught(self):
        cap=Capability();original=cap.m.io['inventory'];calls=0
        def inventory(definition):
            nonlocal calls
            calls+=1
            if calls==6:cap.m.put(cap.expected['outputs']['proposal'],b'tampered during final inventory')
            return original(definition)
        cap.m.io['inventory']=inventory
        with self.assertRaisesRegex(ValueError,'END_PIN_RACE'):cap.write()
        self.assertEqual(calls,6)
    def test_direct_script_is_disabled(self):
        with self.assertRaisesRegex(SystemExit,'NO_DEFAULT_V2_WRITER'):runpy.run_path(writer.__file__,run_name='__main__')


class NativeStoreTests(unittest.TestCase):
    def test_exclusive_write_and_lock_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='checkpoint-store-') as folder:
            root=Path(folder);store=writer.PhysicalCheckpointStore(version=core.physical_version,native=core.physical_native)
            path=str(root/'private.json');pin=store.create(path,b'new bytes')
            self.assertEqual(pin,core.physical_version(path))
            with self.assertRaises(FileExistsError):store.create(path,b'replacement')
            lock=str(root/'owner.lock')
            with store.owner_lock(lock,b'owned lock') as check:
                check()
                with self.assertRaises(FileExistsError):
                    with store.owner_lock(lock,b'other'):pass
            self.assertFalse(Path(lock).exists());self.assertEqual(Path(path).read_bytes(),b'new bytes')
    def test_lock_substitution_is_not_removed(self):
        with tempfile.TemporaryDirectory(prefix='checkpoint-store-') as folder:
            path=Path(folder)/'owner.lock';store=writer.PhysicalCheckpointStore(version=core.physical_version,native=core.physical_native)
            with self.assertRaisesRegex(ValueError,'EXACT_OWNED_CHECKPOINT_LOCK'):
                with store.owner_lock(str(path),b'owned') as check:
                    path.write_bytes(b'changed');check()
            self.assertEqual(path.read_bytes(),b'changed')


if __name__ == '__main__':
    unittest.main()
