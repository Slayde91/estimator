"""Synthetic in-memory reader tests; no private evidence or application state."""
import copy
import hashlib
import json
import unittest

from estimator import image_checkpoint_v2_reader as r


class Memory:
    def __init__(self, changes=None, source_change=False):
        self.raw, self.pins, self.docs, self.clock = {}, {}, {}, 100
        self.changes = changes or {}; self.typed_calls = 0
        self.roles = {k:self.doc('release-'+k, {'evidence':k}) for k in ('claim','receiving_authority','retarget','hold_release')}
        owner = dict(owner_thread_id='receiver',owner_execution_token='current-token',status='ACTIVE',
            image_publication_hold_active=False,live_image_installation_hold_active=False,
            all_image_mutations_guarded_until_valid_claim_and_app_retarget=False,automation_retarget_pending=False,
            existing_automation_target_thread_id='receiver',automation_remains_ACTIVE=True,
            actual_claim_receipt=self.roles['claim'],actual_receiving_authority=self.roles['receiving_authority'],
            actual_retarget_verification=self.roles['retarget'],image_publication_hold_release=self.roles['hold_release'])
        self.owner = self.doc('owner',owner,path='/owner')
        self.source = self.put('/app/source.py', b'source before')
        self.old_source = self.source; self.old_source_native = self.native(self.source['path'])
        self.source_archive = self.clone(self.source, '/archive/source-before')
        self.policies = {f'/policy/{i}':self.put(f'/policy/{i}',str(i).encode()) for i in range(63)}
        self.policy_index = self.doc('policy-index',dict(policies=self.policies,policy_count=63,technical_approval=False))
        owner['current_active_policy_index']=self.policy_index;self.owner=self.doc('owner',owner,path='/owner')
        self.controls = {f'/control/{i}':self.put(f'/control/{i}',str(i).encode()) for i in range(6)}
        self.automation = self.put('/automation', b'kind="heartbeat"\nstatus="ACTIVE"\ntarget_thread_id="receiver"\n')
        self.state = dict(tables=dict(example=dict(rows=2,fingerprint='typed')))
        self.db = self.put('/database',json.dumps(self.state).encode())
        self.typed = self.put('/approved-typed-reader',b'caller-reviewed typed callback identity')
        self.old_runtime = self.put('/runtime/old.png',b'old')
        self.recovery_runtime = self.put('/runtime/recovered.png',b'recovered')
        self.runtime = self.put('/runtime/new.png',b'new')
        self.protected = {p['path']:p for p in (self.old_runtime,self.recovery_runtime,self.runtime)}
        self.missing = ['/missing/'+str(i) for i in range(6)]
        self.categories = {**{p:'private reference library' for p in self.protected},**{p:'fixed seed' for p in self.missing}}
        self.inventory = dict(rule='synthetic complete inventory')
        self.git = dict(head='source-head',tree='source-tree',clean=True)
        self.members = ['/app/source.py']
        ordinary = dict(schema='STABLE_REVIEWED_IMAGE_BATCH_COMPACT_V1',result='PASS',
            cumulative_new_runtime_creation_versions={self.old_runtime['path']:self.old_runtime},all_actual_bounded_deltas=[{'ordinary':1}])
        self.ordinary = self.doc('ordinary',ordinary)
        self.ordinary_native = self.doc('ordinary-native',dict(actual_exit_code=0,actual_checkpoint=self.ordinary))
        self.ordinary_outer = self.doc('ordinary-outer',dict(actual_exit_code=0,receipt_version=self.ordinary,actual_native_completion_receipt=self.ordinary_native))
        oldpointer = dict(latest_completed_receipt=self.ordinary,actual_checkpoint_root_outer0=self.ordinary_outer)
        self.old_pointer = self.doc('old-pointer',oldpointer,path='/current')
        self.pointer_archive = self.clone(self.old_pointer,'/archive/current-before')
        self.recovery_apply = self.doc('recovery-apply',dict(actual_exit_code=1))
        self.recovery_primary = self.doc('recovery-primary',dict(exit_code=0))
        self.recovery_readonly = self.doc('recovery-readonly',dict(actual_exit_code=0))
        self.recovery_failure = self.doc('recovery-failure',dict(result='FAIL'))
        recovery_versions = {self.recovery_runtime['path']:self.recovery_runtime}
        summary = dict(schema='CLASSIFIRE_COMPLETED_CANONICAL_RECOVERY_COMPACT_V2',original_apply_exit_code=1,original_PRIMARY_exit_code=0,
            original_apply_completion=self.recovery_apply,original_PRIMARY_completion=self.recovery_primary,
            actual_readonly_native0=self.recovery_readonly,original_failure=self.recovery_failure,
            normal_STABLE_checkpoint_claimed=False,runtime_creation_versions=recovery_versions,historical_canonical_delta_counted_once=1)
        self.summary = self.doc('recovery-summary',summary)
        bridge = dict(schema='ROOT_COMPLETED_CANONICAL_TO_NORMAL_CANONICAL_BRIDGE_V1',root_preservation_judgment=True,
            no_unlisted_or_future_change_admission=True,recovered_compact=self.summary,prior_ordinary_completed_base=dict(checkpoint=self.ordinary),
            historical_failures_preserved=True,strict_historical_FAIL_preserved=True,
            actual_apply_completion=self.recovery_apply,actual_primary_completion=self.recovery_primary,
            actual_readonly_native0=self.recovery_readonly,original_failure=self.recovery_failure)
        for k in ('enabled','operational','technical_approval','replay_authorized','future_changes_authorized','image_mutations_authorized'):bridge[k]=False
        self.bridge = self.doc('recovery-bridge',bridge)
        self.recovery = dict(summary=self.summary,root_bridge=self.bridge,runtime_creation_versions=recovery_versions,
            counted_once=True,operation_kind='readonly_recovered_canonical',historical_apply_exit_code=1,
            historical_PRIMARY_exit_code=0,readonly_reconciliation_exit_code=0)
        self.manifest = self.doc('manifest',dict(targets=[17]))
        self.preflight = self.doc('preflight',dict(critical={}))
        self.strict = self.doc('strict',dict(jobs=[dict(output=dict(sha256=self.runtime['sha256']))]))
        self.primary = self.doc('primary',dict(target_jobs=[17],actual_completion_observed=True,exit_code=0))
        self.live = self.doc('live',dict(result='PASS',plan_version=self.manifest,preflight_creation_version=self.preflight,
            actual_completed_jobs=[17],actual_new_runtime_creation_versions={self.runtime['path']:self.runtime}))
        self.apply = self.doc('apply',dict(actual_exit_code=0,actual_live=self.live,manifest=self.manifest,actual_primary_completion=self.primary))
        self.apply_outer = self.doc('apply-outer',dict(actual_exit_code=0,receipt_version=self.live,actual_native_result=self.apply))
        self.backups = self.doc('backups',dict(retained=True))
        self.operation = dict(operation_kind='canonical',manifest=self.manifest,live=self.live,root_outer0=self.apply_outer,
            preflight=self.preflight,strict_completion=self.primary,strict_manifest=self.strict,before_backups=self.backups)
        baseline = self.fact_values(self.old_pointer)
        baseline['schema']='ROOT_POST_INSTALL_CURRENT_PUBLICATION_SOURCE_PROTECTED_FACTS_NOT_ADMISSION_V1'
        self.baseline_facts = self.doc('baseline-facts',baseline)
        self.baseline_judgment = self.doc('baseline-judgment',dict(owner_thread_id='writer',owner_execution_token='dated-token',actual_fresh_current_facts=self.baseline_facts,
            root_preservation_judgment=True,no_unlisted_or_future_change_admission=True))
        self.original_admission = self.doc('original-admission',dict(protected=dict(inventory_definition=self.inventory)))
        self.descriptor = self.doc('descriptor',dict(current_facts=self.baseline_facts,current_judgment=self.baseline_judgment,
            ordinary_parent=self.ordinary,ordinary_parent_outer0=self.ordinary_outer,operation_live=self.live,apply_outer0=self.apply_outer,
            intervening_recoveries=[{'root_bridge':self.bridge}],original_admission=self.original_admission))
        self.baseline = dict(facts=self.baseline_facts,root_judgment=self.baseline_judgment,descriptor=self.descriptor)
        self.writer = self.put('/historical-worktree/writer.py',b'reviewed writer')
        self.qualifier = self.put('/historical-worktree/qualifier.py',b'reviewed qualifier')
        self.writer_archive = self.clone(self.writer,'/archive/writer.py')
        self.qualifier_archive = self.clone(self.qualifier,'/archive/qualifier.py')
        self.review = self.doc('code-review',dict(schema='ROOT_GENERIC_V2_CHECKPOINT_CODE_REVIEW_V1',result='PASS',
            owner_thread_id='writer',owner_execution_token='dated-token',reviewed_commit='a'*40,retained_source_archives=dict(
            writer_module=dict(observed=self.writer,retained_copy=self.writer_archive),
            qualifier_module=dict(observed=self.qualifier,retained_copy=self.qualifier_archive))))
        self.ci = self.doc('ci',dict(schema='ROOT_GENERIC_V2_MERGED_CODE_CI_PROOF_V1',result='PASS',merged=True,
            all_required_checks_passed=True,head_is_ancestor_of_merge=True,head_commit='a'*40,merge_commit='b'*40,
            required_check_conclusions={'checks':'success'},reviewed_source_sha256=dict(writer_module=self.writer['sha256'],qualifier_module=self.qualifier['sha256'])))
        permit = dict(schema='ROOT_FINITE_GENERIC_V2_CHECKPOINT_WRITER_PERMIT_V1',result='ROOT_EXPLICIT_FINITE_CHECKPOINT_WRITER_PERMIT',
            writer_enabled=True,owner_thread_id='writer',owner_execution_token='dated-token',descriptor=self.descriptor,
            before_publication_pointer=self.old_pointer,writer_module=self.writer,qualifier_module=self.qualifier,code_review=self.review,merged_code_CI=self.ci,
            merged_code_commit='b'*40,outputs=dict(journal='/journal.json',leaf='/leaf.json',proposal='/proposal.json'))
        for k in ('new_generation_authorized','new_acceptance_authorized','new_installation_authorized','CURRENT_write_authorized',
                  'overwrite_authorized','resume_authorized','future_changes_authorized','technical_approval'):permit[k]=False
        self.permit = self.doc('permit',permit)
        self.authority = dict(permit=self.permit,writer_module=self.writer,qualifier_module=self.qualifier,code_review=self.review,merged_code_CI=self.ci)
        self.journal = self.doc('journal',dict(schema='IMAGE_CHECKPOINT_V2_NEVER_REPLAY_WRITE_INTENT_V1',result='WRITE_INTENT_NEVER_REPLAY',
            owner_thread_id='writer',owner_execution_token='dated-token',resume_authorized=False,technical_approval=False,
            PRIMARY_invocations=0,application_mutations=0,CURRENT_mutations=0,
            outputs=permit['outputs'],
            descriptor=self.descriptor,writer_authority=self.authority,before_publication_pointer=self.old_pointer))
        leaf = dict(schema=r.COMPACT_SCHEMA,result='PASS',owner_thread_id='writer',owner_execution_token='dated-token',
            previous_base=self.ordinary,previous_base_outer0=self.ordinary_outer,intervening_completed_recoveries=[self.recovery],
            actual_batch_delta=self.operation,all_actual_bounded_deltas=ordinary['all_actual_bounded_deltas']+[self.recovery,self.operation],
            cumulative_new_runtime_creation_versions=self.protected,baseline_snapshot=self.baseline,
            writer_authority=self.authority,writer_journal=self.journal,before_publication_pointer=self.old_pointer,
            current_source_HEAD=self.git['head'],current_source_tree=self.git['tree'],current_critical_versions=self.controls,
            current_typed_database_state=self.state,protected_file_count=len(self.protected),
            ordinary_checkpoint_written=True,publication_completed=False,pointer_mutations=0,operational=False,
            status_counts={'accepted':3},registered_source_aliases=3,three_prior_runtime_creation_versions={},
            actual_checkpoint_native_completion=None,actual_checkpoint_root_outer0=None,technical_approval=False,scope_complete=False)
        self.leaf = self.doc('leaf',leaf)
        self.proposal = self.doc('proposal',dict(schema='ROOT_IMAGE_CHECKPOINT_V2_PRIVATE_PUBLICATION_PROPOSAL_V1',owner_thread_id='writer',owner_execution_token='dated-token',
            checkpoint=self.leaf,old_current=self.old_pointer,writer_journal=self.journal,writer_authority=self.authority,
            actual_native_completion_required=True,actual_ROOT_outer0_required=True,current_pointer_written=False,technical_approval=False,application_mutations=0))
        self.native_completion = self.doc('native',dict(schema=r.NATIVE_SCHEMA,receipt_version=self.leaf,writer_authority=self.authority,
            writer_journal=self.journal,actual_completion_observed=True,no_primary_invoked=True,no_application_mutations=True,
            publication_proposal=self.proposal,owner_thread_id='writer',owner_execution_token='dated-token',actual_exit_code=0))
        self.root_outer = self.doc('root-outer',dict(schema=r.OUTER_SCHEMA,receipt_version=self.leaf,
            actual_native_completion_receipt=self.native_completion,observed_by_actual_root_thread_id='writer',owner_execution_token='dated-token',actual_exit_code=0))
        pointer = dict(owner_thread_id='receiver',owner_execution_token='current-token',latest_completed_receipt=self.leaf,
            actual_checkpoint_root_outer0=self.root_outer,image_publication_hold_active=False,live_image_installation_hold_active=False,
            all_image_mutations_guarded_until_valid_claim_and_app_retarget=False)
        self.pointer = self.doc('pointer',pointer,path='/current')
        self.readback = self.doc('readback',dict(schema=r.READBACK_SCHEMA,new_current=self.pointer,checkpoint=self.leaf,
            checkpoint_native=self.native_completion,checkpoint_outer0=self.root_outer,readback_exact=True))
        self.cas = self.doc('cas',dict(schema=r.CAS_SCHEMA,owner_thread_id='receiver',owner_execution_token='current-token',
            old_current=self.old_pointer,backup=self.pointer_archive,new_current=self.pointer,checkpoint=self.leaf,
            checkpoint_native=self.native_completion,checkpoint_outer0=self.root_outer,readback=self.readback,
            ordinary_parent_preserved=True,recoveries_preserved=True,control_mutations=0))
        if source_change:
            self.source = self.put('/app/source.py',b'source after separately finite ROOT review')
            self.git = dict(head='later-head',tree='later-tree',clean=True)
        current = self.fact_values(self.pointer)
        self.facts = self.doc('facts',current)
        transitions = {k:{} for k in ('source','protected','policies','controls')}
        if source_change:transitions['source'][self.source['path']]=dict(before=self.old_source,after=self.source,retained_before=self.source_archive)
        context = dict(schema=r.CONTEXT_SCHEMA,owner_thread_id='receiver',owner_execution_token='current-token',
            root_preservation_judgment=True,no_unlisted_or_future_change_admission=True,
            completed_base=self.leaf,publication_cas=self.cas,current_facts=self.facts,current_owner=self.owner,current_pointer=self.pointer,
            baseline_snapshot=self.baseline,declared_current_facts=self.docs['facts'],declared_map_transitions=transitions,
            actual_same_active_owner_claim_and_release_preserved=True,claim_release_evidence=self.roles)
        for key in ('operational','enabled','future_changes_authorized','image_mutations_authorized','new_generation_authorized',
                    'new_acceptance_authorized','new_installation_authorized','technical_approval'):context[key]=False
        self.context = self.doc('context',context)
        self.trusted = dict(root='receiver',token='current-token',owner_path='/owner',owner_pin=self.owner,current_pointer=self.pointer,
            leaf=self.leaf,native_completion=self.native_completion,root_outer0=self.root_outer,publication_CAS=self.cas,
            current_context=self.context,current_facts=self.facts,approved_dependencies={'typed_reader':self.typed},source_membership=list(self.members))
        self.io = dict(version=self.version,bytes=lambda p:self.raw[p],native=self.native,exists=lambda p:p in self.raw,
            git=lambda:copy.deepcopy(self.git),source_membership=lambda:list(self.members),
            inventory=lambda definition:(copy.deepcopy(self.categories),list(self.missing)),
            approved_dependencies={'typed_reader':self.typed},typed_bytes=self.typed_bytes)

    def fact_values(self,pointer):
        return dict(schema=r.FACTS_SCHEMA,current_owner=self.owner,current_pointer=pointer,source_or_protected_preservation_admitted=False,
            ROOT_preservation_judgment=False,shared_mutations=0,
            operational=False,enabled=False,future_changes_authorized=False,technical_approval=False,
            actual_current_source=dict(**self.git,tracked_count=1,fullpins={self.source['path']:self.source},native6={self.source['path']:self.native(self.source['path'])}),
            protected_fullpins=self.protected,protected_native6={p:self.native(p) for p in self.protected},
            inventory_categories=self.categories,missing_fixed_paths=self.missing,inventory_definition=self.inventory,
            existing_protected_count=len(self.protected),membership_names=len(self.categories),all63_policy_pins=self.policies,
            current_six_controls=self.controls,active_policy_index=self.policy_index,current_automation=self.automation,
            current_DB=self.db,current_typed_database_state=self.state,current_typed_tables=1,current_typed_rows=2)

    def put(self,path,raw,mtime=None):
        self.clock+=1;self.raw[path]=raw
        self.pins[path]=dict(path=path,bytes=len(raw),mtime_ns=self.clock if mtime is None else mtime,sha256=hashlib.sha256(raw).hexdigest())
        return copy.deepcopy(self.pins[path])

    def doc(self,role,obj,path=None):
        obj=copy.deepcopy(obj)
        if role in self.changes:self.changes[role](obj)
        self.docs[role]=obj
        return self.put(path or '/'+role+'.json',json.dumps(obj,sort_keys=True).encode())

    def clone(self,pin,path):return self.put(path,self.raw[pin['path']],pin['mtime_ns'])
    def version(self,path):return copy.deepcopy(self.pins[path])
    def native(self,path):
        p=self.pins[path];return [p['bytes'],p['mtime_ns'],1,p['mtime_ns'],0,True]
    def typed_bytes(self,raw):self.typed_calls+=1;return json.loads(raw),None
    def read(self):return r.read_completed_base_v2(self.leaf,self.io,trusted=self.trusted,env={'CODEX_THREAD_ID':'receiver'})


class CompletedBaseTests(unittest.TestCase):
    def bad(self,role,key,value,code='.'):
        m=Memory({role:lambda x:x.__setitem__(key,value)})
        with self.assertRaisesRegex((ValueError,KeyError),code):m.read()

    def test_reads_published_v2_without_prepare_or_writer(self):
        m=Memory();v=m.read();self.assertEqual(v['schema'],'NORMALIZED_COMPLETED_IMAGE_BASE_V2')
        self.assertEqual(v['ordinary_parent'],m.ordinary);self.assertFalse(v['V1_masquerade']);self.assertEqual(v['shared_mutations'],0)
        self.assertEqual(v['intervening_completed_recoveries'][0]['historical_apply_exit_code'],1)
        self.assertEqual(v['current_owner_identity']['owner_thread_id'],'receiver')
        self.assertEqual(v['historical_writer_identity']['owner_thread_id'],'writer')
        self.assertEqual(v['historical_leaf_snapshot']['schema'],r.COMPACT_SCHEMA)
        self.assertTrue(v['current_controls_equal_leaf_snapshot'])
    def test_exact_finite_later_source_transition(self):
        m=Memory(source_change=True);self.assertEqual(m.read()['current_source']['head'],'later-head')
    def test_old_mutable_code_paths_need_not_exist(self):
        m=Memory()
        for pin in (m.writer,m.qualifier):del m.raw[pin['path']];del m.pins[pin['path']]
        m.read()
    def test_changed_old_mutable_code_is_not_replayed(self):
        m=Memory();m.put(m.writer['path'],b'raise RuntimeError("never execute")');m.read()
    def test_explicit_v2_dispatch(self):
        m=Memory();self.assertEqual(r.read_completed_base(m.leaf,m.io,trusted=m.trusted,env={'CODEX_THREAD_ID':'receiver'})['checkpoint'],m.leaf)
    def test_legacy_callback_original_arguments_and_return_identity(self):
        m=Memory();sentinel=object();seen=[]
        out=r.read_completed_base(m.ordinary,m.io,legacy_reader=lambda p,io:(seen.append((p is m.ordinary,io is m.io)) or sentinel))
        self.assertIs(out,sentinel);self.assertEqual(seen,[(True,True)])
    def test_candidate_cannot_masquerade_as_completed(self):self.bad('leaf','schema','STABLE_REVIEWED_IMAGE_BATCH_COMPACT_CANDIDATE_V2','REAL_V2')
    def test_failed_leaf_rejected(self):self.bad('leaf','result','FAIL','REAL_V2')
    def test_self_native_pin_in_leaf_rejected(self):self.bad('leaf','actual_checkpoint_native_completion',{},'REAL_V2')
    def test_leaf_must_be_written(self):self.bad('leaf','ordinary_checkpoint_written',False,'REAL_V2')
    def test_leaf_cannot_claim_its_later_publication(self):self.bad('leaf','publication_completed',True,'REAL_V2')
    def test_leaf_cannot_authorize_operations(self):self.bad('leaf','operational',True,'REAL_V2')
    def test_leaf_cannot_claim_pointer_mutation(self):self.bad('leaf','pointer_mutations',1,'LEAF_POINTER')
    def test_leaf_boolean_pointer_zero_rejected(self):self.bad('leaf','pointer_mutations',False,'LEAF_POINTER')
    def test_output_roles_must_match_leaf(self):self.bad('permit','outputs',dict(journal='/journal.json',leaf='/other-leaf',proposal='/proposal.json'),'EXACT_WRITER_OUTPUT')
    def test_native_boolean_zero_rejected(self):self.bad('native','actual_exit_code',False,'NATIVE_EXIT0')
    def test_native_failure_rejected(self):self.bad('native','actual_exit_code',1,'NATIVE_EXIT0')
    def test_other_native_leaf_rejected(self):self.bad('native','receipt_version',{},'NATIVE_COMPLETED')
    def test_native_primary_invocation_rejected(self):self.bad('native','no_primary_invoked',False,'NATIVE_COMPLETED')
    def test_native_mutation_rejected(self):self.bad('native','no_application_mutations',False,'NATIVE_COMPLETED')
    def test_native_writer_identity_rejected(self):self.bad('native','owner_thread_id','receiver','IDENTITY')
    def test_root_outer_wrong_native_rejected(self):self.bad('root-outer','actual_native_completion_receipt',{},'ROOT_OUTER')
    def test_root_outer_boolean_zero_rejected(self):self.bad('root-outer','actual_exit_code',False,'ROOT_OUTER_EXIT0')
    def test_CAS_wrong_old_pointer_rejected(self):self.bad('cas','old_current',{},'EXACT_PUBLICATION')
    def test_CAS_control_mutation_rejected(self):self.bad('cas','control_mutations',1,'CAS_CONTROL')
    def test_CAS_boolean_zero_rejected(self):self.bad('cas','control_mutations',False,'CAS_CONTROL')
    def test_readback_wrong_leaf_rejected(self):self.bad('readback','checkpoint',{},'READBACK')
    def test_pointer_wrong_latest_rejected(self):self.bad('pointer','latest_completed_receipt',{},'CURRENT_LATEST')
    def test_owner_hold_rejected(self):self.bad('owner','image_publication_hold_active',True,'OWNER_RELEASED')
    def test_pointer_hold_rejected(self):self.bad('pointer','live_image_installation_hold_active',True,'OWNER_RELEASED')
    def test_owner_claim_guard_rejected(self):self.bad('owner','all_image_mutations_guarded_until_valid_claim_and_app_retarget',True,'OWNER_RELEASED')
    def test_owner_inactive_rejected(self):self.bad('owner','status','paused','CLAIM_RELEASE')
    def test_retarget_pending_rejected(self):self.bad('owner','automation_retarget_pending',True,'CLAIM_RELEASE')
    def test_process_identity_rejected(self):
        m=Memory()
        with self.assertRaisesRegex(ValueError,'ACTUAL_CURRENT_PROCESS'):r.read_completed_base_v2(m.leaf,m.io,trusted=m.trusted,env={'CODEX_THREAD_ID':'writer'})
    def test_forged_self_trusted_context_rejected(self):
        m=Memory();m.trusted['current_context']=m.leaf
        with self.assertRaisesRegex((ValueError,KeyError),'.'):m.read()
    def test_missing_trusted_envelope_rejected(self):
        m=Memory()
        with self.assertRaisesRegex(ValueError,'TRUSTED_CALLER'):r.read_completed_base_v2(m.leaf,m.io,trusted={},env={})
    def test_future_authority_rejected(self):self.bad('context','future_changes_authorized',True,'NO_FUTURE')
    def test_source_fact_cannot_admit_itself(self):self.bad('facts','source_or_protected_preservation_admitted',True,'FRESH_FACTS')
    def test_wrong_declared_whole_context_rejected(self):self.bad('context','declared_current_facts',{},'DECLARED_WHOLE')
    def test_unlisted_source_transition_rejected(self):
        m=Memory({'context':lambda x:x['declared_map_transitions'].__setitem__('source',{})},source_change=True)
        with self.assertRaisesRegex(ValueError,'CLOSED_SOURCE'):m.read()
    def test_unknown_transition_role_rejected(self):self.bad('context','declared_map_transitions',{'source':{},'protected':{},'policies':{},'controls':{},'all_future':{}},'FINITE_TRANSITION')
    def test_recovery_apply_one_preserved(self):self.bad('recovery-apply','actual_exit_code',0,'RECOVERY_REAL')
    def test_recovery_primary_zero_required(self):self.bad('recovery-primary','exit_code',1,'RECOVERY_REAL')
    def test_recovery_readonly_zero_required(self):self.bad('recovery-readonly','actual_exit_code',False,'RECOVERY_REAL')
    def test_recovery_cannot_be_claimed_ordinary(self):self.bad('recovery-summary','normal_STABLE_checkpoint_claimed',True,'RECOVERY_LITERAL')
    def test_operation_primary_zero_required(self):self.bad('primary','exit_code',1,'OPERATION_PRIMARY')
    def test_operation_apply_zero_required(self):self.bad('apply','actual_exit_code',1,'OPERATION_APPLY')
    def test_operation_wrong_native_lineage_rejected(self):self.bad('apply','manifest',{},'OPERATION_NATIVE')
    def test_CI_pending_rejected(self):self.bad('ci','all_required_checks_passed',False,'MERGED_CODE_CI')
    def test_reviewed_commit_mismatch_rejected(self):self.bad('code-review','reviewed_commit','c'*40,'EXACT_REVIEWED_COMMIT')
    def test_permit_merged_commit_mismatch_rejected(self):self.bad('permit','merged_code_commit','c'*40,'EXACT_REVIEWED_COMMIT')
    def test_permit_enable_not_inferred(self):self.bad('permit','writer_enabled',False,'EXACT_WRITER_PERMIT')
    def test_permit_future_permission_rejected(self):self.bad('permit','future_changes_authorized',True,'FINITE_WRITER_PERMIT')
    def test_journal_resume_permission_rejected(self):self.bad('journal','resume_authorized',True,'WRITER_INTENT')
    def test_journal_primary_invocation_rejected(self):self.bad('journal','PRIMARY_invocations',1,'JOURNAL_MUTATIONS')
    def test_proposal_claimed_pointer_write_rejected(self):self.bad('proposal','current_pointer_written',True,'PUBLICATION_PROPOSAL')
    def test_proposal_missing_outer_requirement_rejected(self):self.bad('proposal','actual_ROOT_outer0_required',False,'PUBLICATION_PROPOSAL')
    def test_recovery_replay_authority_rejected(self):self.bad('recovery-bridge','replay_authorized',True,'RECOVERY_LITERAL')
    def test_recovery_summary_apply_one_preserved(self):self.bad('recovery-summary','original_apply_exit_code',0,'RECOVERY_SUMMARY_APPLY1')
    def test_baseline_wrong_operation_rejected(self):self.bad('descriptor','operation_live',{},'BASELINE_EXACT_OPERATION')
    def test_baseline_wrong_current_source_rejected(self):self.bad('leaf','current_source_HEAD','wrong','BASELINE_EXACT_CANDIDATE')
    def test_baseline_wrong_controls_rejected(self):self.bad('leaf','current_critical_versions',{},'BASELINE_EXACT_CANDIDATE')
    def test_empty_canonical_targets_rejected(self):self.bad('manifest','targets',[],'OPERATION_TARGETS')
    def test_duplicate_canonical_targets_rejected(self):self.bad('manifest','targets',[17,17],'OPERATION_TARGETS')
    def test_changed_inventory_rule_rejected(self):self.bad('facts','inventory_definition',{},'INVENTORY_RULE')
    def test_index_cannot_claim_technical_approval(self):self.bad('policy-index','technical_approval',True,'COMPLETE_POLICY_INDEX')
    def test_owner_active_policy_index_must_match(self):self.bad('owner','current_active_policy_index',{},'OWNER_ACTIVE_POLICY')
    def test_multiple_owner_active_policy_aliases_rejected(self):self.bad('owner','current_active_policy_index2',{},'OWNER_ACTIVE_POLICY')
    def test_other_automation_target_rejected(self):self.bad('owner','existing_automation_target_thread_id','writer','CURRENT_AUTOMATION')
    def test_control_changes_cannot_reuse_completed_counts(self):self.bad('facts','current_six_controls',{},'CONTROL_CHANGE_REQUIRES')
    def test_factual_mutation_claim_rejected(self):self.bad('facts','shared_mutations',1,'FRESH_FACTS_MUTATIONS')
    def test_CI_wrong_hash_rejected(self):self.bad('ci','reviewed_source_sha256',{},'EXACT_REVIEWED_CI')
    def test_CI_failure_rejected(self):self.bad('ci','required_check_conclusions',{'checks':'failure'},'EXACT_REVIEWED_CI')
    def test_wrong_code_archive_bytes_rejected(self):
        m=Memory();m.raw[m.writer_archive['path']]=b'forged'
        with self.assertRaisesRegex(ValueError,'PIN_BYTES'):m.read()
    def test_source_membership_addition_rejected(self):
        m=Memory();m.members.append('/app/other.py')
        with self.assertRaisesRegex(ValueError,'SOURCE_MEMBERSHIP'):m.read()
    def test_source_native_drift_rejected(self):
        m=Memory();m.put('/app/source.py',b'changed')
        with self.assertRaisesRegex(ValueError,'NATIVE_SCOPE'):m.read()
    def test_git_dirty_rejected(self):
        m=Memory();m.git['clean']=False
        with self.assertRaisesRegex(ValueError,'CURRENT_GIT'):m.read()
    def test_inventory_difference_rejected(self):
        m=Memory();m.categories['/unlisted']='extra'
        with self.assertRaisesRegex(ValueError,'CURRENT_INVENTORY'):m.read()
    def test_DB_sidecar_rejected(self):
        m=Memory();m.put('/database-wal',b'sidecar')
        with self.assertRaisesRegex(ValueError,'DB_SIDECARS'):m.read()
    def test_typed_DB_difference_rejected(self):
        m=Memory();m.io['typed_bytes']=lambda b:({'tables':{}},None)
        with self.assertRaisesRegex(ValueError,'FULL_TYPED'):m.read()
    def test_unapproved_callback_identity_rejected_before_call(self):
        m=Memory();m.io['approved_dependencies']={};m.io['typed_bytes']=lambda b:self.fail('must not execute unapproved callback')
        with self.assertRaisesRegex(ValueError,'APPROVED_READER'):m.read()
    def test_end_git_race_rejected(self):
        m=Memory();calls=[]
        def git():
            calls.append(1);return dict(m.git,head='changed') if len(calls)>1 else copy.deepcopy(m.git)
        m.io['git']=git
        with self.assertRaisesRegex(ValueError,'END_GIT'):m.read()
    def test_end_pin_race_rejected(self):
        m=Memory();old=m.io['typed_bytes']
        def typed(raw):m.pins[m.owner['path']]['mtime_ns']+=1;return old(raw)
        m.io['typed_bytes']=typed
        with self.assertRaisesRegex(ValueError,'END_PIN'):m.read()
    def test_end_native_race_rejected(self):
        m=Memory();old=m.io['typed_bytes']
        def typed(raw):m.pins[m.source['path']]['mtime_ns']+=1;return old(raw)
        m.io['typed_bytes']=typed
        with self.assertRaisesRegex(ValueError,'END_NATIVE'):m.read()
    def test_unknown_schema_never_calls_legacy(self):
        m=Memory();pin=m.doc('unknown',{'schema':'unknown'})
        with self.assertRaisesRegex(ValueError,'UNREGISTERED'):r.read_completed_base(pin,m.io,legacy_reader=lambda *x:self.fail('wrong callback'))


class WriterReaderRoundtripTests(unittest.TestCase):
    def test_real_synthetic_writer_output_reads_after_separate_synthetic_publication(self):
        # These are genuine producer outputs in MemoryStore, followed by explicitly
        # synthetic process/publication/current-context records. No actual native0
        # or external CURRENT publication is asserted by this unit test.
        from test_image_checkpoint_recovery import Memory as ProducerMemory
        from test_image_checkpoint_v2_writer import Capability

        class FullMemory(ProducerMemory):
            def doc(self,role,obj,path=None):
                if role == 'pre-facts':
                    for n in range(62):
                        path2='/extra-policy/'+str(n);self.policies[path2]=self.put(path2,str(n).encode())
                    for n in range(4):
                        path2='/extra-control/'+str(n);self.controls[path2]=self.put(path2,str(n).encode())
                return super().doc(role,obj,path)

        cap=Capability(memory=FullMemory(recovery=True));m=cap.m;written=cap.write()
        leaf_pin=written['receipt_version'];leaf=json.loads(m.raw[leaf_pin['path']])
        self.assertEqual(set(cap.store.creates),set(cap.expected['outputs'].values()))
        self.assertNotIn('final_schema_requires_review',leaf)
        oldpointer=leaf['before_publication_pointer'];backup=m.clone(oldpointer,'/synthetic-publication-before')
        release={key:m.doc('reader-release-'+key,{'synthetic_evidence':key}) for key in ('claim','receiving_authority','retarget','hold_release')}
        index=m.doc('reader-policy-index',dict(policies=m.policies,policy_count=63,technical_approval=False))
        owner=copy.deepcopy(m.docs['owner']);owner.update(all_image_mutations_guarded_until_valid_claim_and_app_retarget=False,
            automation_retarget_pending=False,actual_claim_receipt=release['claim'],actual_receiving_authority=release['receiving_authority'],
            actual_retarget_verification=release['retarget'],image_publication_hold_release=release['hold_release'],
            current_active_policy_index=index,existing_automation_target_thread_id='root',automation_remains_ACTIVE=True)
        owner_pin=m.doc('reader-owner',owner,path=m.owner['path'])
        native=m.doc('reader-native-synthetic',dict(schema=r.NATIVE_SCHEMA,actual_exit_code=0,receipt_version=leaf_pin,
            writer_authority=leaf['writer_authority'],writer_journal=leaf['writer_journal'],publication_proposal=written['publication_proposal'],
            owner_thread_id='root',owner_execution_token='token',actual_completion_observed=True,no_primary_invoked=True,no_application_mutations=True))
        outer=m.doc('reader-outer-synthetic',dict(schema=r.OUTER_SCHEMA,actual_exit_code=0,receipt_version=leaf_pin,
            actual_native_completion_receipt=native,observed_by_actual_root_thread_id='root',owner_execution_token='token'))
        pointer=copy.deepcopy(json.loads(m.raw[written['publication_proposal']['path']])['current_pointer_template'])
        pointer.update(actual_checkpoint_root_outer0=outer)
        pointer_pin=m.doc('reader-current-synthetic',pointer,path=oldpointer['path'])
        readback=m.doc('reader-readback-synthetic',dict(schema=r.READBACK_SCHEMA,new_current=pointer_pin,checkpoint=leaf_pin,
            checkpoint_native=native,checkpoint_outer0=outer,readback_exact=True))
        cas=m.doc('reader-cas-synthetic',dict(schema=r.CAS_SCHEMA,owner_thread_id='root',owner_execution_token='token',old_current=oldpointer,
            backup=backup,new_current=pointer_pin,checkpoint=leaf_pin,checkpoint_native=native,checkpoint_outer0=outer,readback=readback,
            ordinary_parent_preserved=True,recoveries_preserved=True,control_mutations=0))
        facts=copy.deepcopy(m.docs['facts']);facts.update(schema=r.FACTS_SCHEMA,current_owner=owner_pin,current_pointer=pointer_pin,
            inventory_definition=m.docs['admission']['protected']['inventory_definition'],current_automation=m.automation)
        facts['active_policy_index']=index
        facts_pin=m.doc('reader-current-facts-synthetic',facts)
        context=dict(schema=r.CONTEXT_SCHEMA,owner_thread_id='root',owner_execution_token='token',root_preservation_judgment=True,
            no_unlisted_or_future_change_admission=True,completed_base=leaf_pin,publication_cas=cas,current_facts=facts_pin,
            current_owner=owner_pin,current_pointer=pointer_pin,baseline_snapshot=leaf['baseline_snapshot'],declared_current_facts=facts,
            declared_map_transitions={key:{} for key in ('source','protected','policies','controls')},
            actual_same_active_owner_claim_and_release_preserved=True,claim_release_evidence=release)
        for k in ('operational','enabled','future_changes_authorized','image_mutations_authorized','new_generation_authorized',
                  'new_acceptance_authorized','new_installation_authorized','technical_approval'):context[k]=False
        context_pin=m.doc('reader-current-context-synthetic',context)
        dependencies={'typed_reader':m.typed}
        trusted=dict(root='root',token='token',owner_path=owner_pin['path'],owner_pin=owner_pin,current_pointer=pointer_pin,
            leaf=leaf_pin,native_completion=native,root_outer0=outer,publication_CAS=cas,current_context=context_pin,current_facts=facts_pin,
            approved_dependencies=dependencies,source_membership=list(m.membership))
        io=dict(m.io,approved_dependencies=dependencies,typed_bytes=lambda raw:(json.loads(raw),None))
        result=r.read_completed_base_v2(leaf_pin,io,trusted=trusted,env={'CODEX_THREAD_ID':'root'})
        self.assertEqual(result['result'],'PASS_READ_ONLY_COMPLETED_BASE_V2')
        self.assertEqual(result['intervening_completed_recoveries'][0]['historical_apply_exit_code'],1)
        self.assertEqual(result['cumulative_new_runtime_creation_versions'],leaf['cumulative_new_runtime_creation_versions'])
        self.assertEqual(len(result['current_critical_versions']),6)
        self.assertFalse(result['V1_masquerade']);self.assertEqual(result['shared_mutations'],0)


if __name__ == '__main__':
    unittest.main()
