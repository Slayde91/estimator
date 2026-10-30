"""Synthetic, write-free tests of the V2 boundary, not private audit fixtures."""
import copy
import hashlib
import json
import unittest

from estimator import image_checkpoint_recovery as c


class Memory:
    def __init__(self, changes=None, recovery=False):
        self.raw = {}; self.pins = {}; self.docs = {}; self.tick = 100
        self.changes = changes or {}; self.membership = ['/app/source.py']
        self.git = dict(head='head',tree='tree',clean=True)
        self.owner = self.doc('owner',dict(owner_thread_id='root',owner_execution_token='token',
            status='ACTIVE',image_publication_hold_active=False,live_image_installation_hold_active=False))
        self.automation = self.put('/automation',b'kind="heartbeat"\nstatus="ACTIVE"\ntarget_thread_id="root"\n')
        self.source = self.put('/app/source.py',b'reviewed source')
        self.registry_before = self.put('/registry',b'before registry')
        self.queue_before = self.put('/queue',b'before queue')
        self.registry_backup = self.clone(self.registry_before,'/registry-before')
        self.queue_backup = self.clone(self.queue_before,'/queue-before')
        self.registry = self.put('/registry',b'after registry')
        self.queue = self.put('/queue',b'after queue')
        self.runtime = self.put('/app/new.png',b'new image')
        self.state = dict(tables=dict(example=dict(rows=2,fingerprint='typed')))
        self.db = self.put('/database',json.dumps(self.state).encode())
        self.policy = self.put('/policy',b'policy'); self.policy_index = self.put('/policy-index',b'index')
        self.policies = {'/policy':self.policy}; self.controls = {'/queue':self.queue,'/registry':self.registry}
        self.ordinary = self.doc('ordinary',dict(schema='STABLE_REVIEWED_IMAGE_BATCH_COMPACT_V1',result='PASS',
            cumulative_new_runtime_creation_versions={},all_actual_bounded_deltas=[],three_prior_runtime_creation_versions={}))
        self.ordinary_native = self.doc('ordinary-native',dict(actual_exit_code=0,actual_checkpoint=self.ordinary))
        self.ordinary_outer = self.doc('ordinary-outer',dict(receipt_version=self.ordinary,actual_exit_code=0,
            actual_native_completion_receipt=self.ordinary_native))
        pointer = dict(owner_thread_id='root',owner_execution_token='token',image_publication_hold_active=False,
            live_image_installation_hold_active=False,all_image_mutations_guarded_until_valid_claim_and_app_retarget=False,
            current_image_mutations_require_reviewed_receiving_execution_image_successor=True,
            scope_complete=False,technical_approval=False,latest_completed_receipt=self.ordinary,
            actual_checkpoint_root_outer0=self.ordinary_outer)
        self.old_pointer = self.doc('old-pointer',pointer,path='/current')
        self.pointer_archive = self.clone(self.old_pointer,'/current-before')
        pointer['progress'] = 'installed'
        self.pointer = self.doc('pointer',pointer,path='/current')
        self.cas = self.doc('cas',dict(schema='ROOT_CURRENT_PUBLICATION_CAS_RECEIPT_V2',owner_thread_id='root',
            owner_execution_token='token',old_current=self.old_pointer,new_current=self.pointer,backup=self.pointer_archive,
            ordinary_parent_preserved=True,intervening_recoveries_preserved=True,normal_checkpoint_success_claimed=False,control_mutations=0))
        phase = b"def canonical_completed_history(bindings,jobs,after,io,retired):\n    for role in ('manifest','preflight','strict_manifest','completion_pin'): io['version'](bindings[role]['path'])\n    return {'result':'PASS_PHYSICAL_COMPLETED_HISTORY_NOT_CURRENT_STATE'}\n"
        typed = b"import json\ndef typed_bytes(raw):\n    return json.loads(raw), None\n"
        self.phase = self.put('/approved-phase.py',phase); self.typed = self.put('/approved-typed.py',typed)
        self.runner = self.put('/runner.py',b"def main(): pass\nif __name__ == '__main__' and not (ROOT_AND_PEER_REVIEWED is True and RSB1_OPERATIONAL_ENABLED is True):\n    raise SystemExit('DISABLED_CURRENT_RECEIVING_PAIR_NOT_ENABLED')\nif __name__ == '__main__':\n    main()\n")
        self.common = self.put('/common.py',b'reviewed common')
        before = {'/app/source.py':self.source,'/registry':self.registry_before}
        categories = {'/app/source.py':'source','/registry':'registry','/missing':'fixed'}
        self.recovery_records = []; self.summary_pins = []
        if recovery:
            self.prior_runtime = self.put('/app/prior.png',b'prior image')
            before[self.prior_runtime['path']] = self.prior_runtime
            categories[self.prior_runtime['path']] = 'private reference library'
            self.make_recovery()
        self.before_protected = before; self.before_categories = categories
        self.current_protected = dict(before,**{'/registry':self.registry,'/app/new.png':self.runtime})
        self.categories = dict(categories,**{'/app/new.png':'private reference library'})
        self.missing = ['/missing']
        self.pre_facts = self.doc('pre-facts',dict(actual_current_source=dict(fullpins={'/app/source.py':self.source},
            native6={'/app/source.py':self.native('/app/source.py')}),protected_native6={p:self.native(p) for p in before if p!='/registry'}))
        protected = dict(fullpins=before,categories=categories,missing_fixed_paths=self.missing,
            inventory_definition={'fixed_seeds':['/missing']},existing_count=len(before))
        self.admission = self.doc('admission',dict(source=dict(head='head',tree='tree',worktree_fullpins={'/app/source.py':self.source}),
            protected=protected,database=dict(current_fullpin=self.db,typed_state=self.state),policy_members=self.policies,
            completed_recovery_bridges=[r['root_bridge'] for r in self.recovery_records]))
        self.manifest = self.doc('manifest',dict(owner_thread_id='root',owner_execution_token='token',targets=[17],
            actual_finite_source_data_admission=self.admission,controls=dict(owner=self.owner,automation=self.automation),
            reviewed_runner=self.runner,common_engine_version=self.common,expected_current_pointer=self.old_pointer))
        self.pf = self.doc('pf',dict(helper_creation_version=self.runner,common_engine_version=self.common,critical={},
            reviewed_evidence_versions={'/queue':self.queue_before,'/registry':self.registry_before,'/current':self.old_pointer,
                '/app/source.py':self.source}))
        self.backups = self.doc('backups',dict(bindings=dict(queue=dict(source_snapshot=self.queue_before,backup_creation_version=self.queue_backup),
            registry=dict(source_snapshot=self.registry_before,backup_creation_version=self.registry_backup))))
        self.jobs = [dict(output=dict(sha256=self.runtime['sha256']))]
        self.strict = self.doc('strict',dict(jobs=self.jobs))
        self.completion = self.doc('completion',dict(exit_code=0,target_jobs=[17],actual_completion_observed=True))
        self.live = self.doc('live',dict(result='PASS',actual_completed_jobs=[17],plan_version=self.manifest,
            preflight_creation_version=self.pf,helper_creation_version=self.runner,common_engine_version=self.common,
            current_state_snapshots=self.controls,current_typed_database_state=self.state,actual_new_runtime_creation_versions={'/app/new.png':self.runtime},
            protected_member_count_before=len(before),protected_member_count_after=len(self.current_protected),protected_file_count=len(self.current_protected),
            status_counts={'accepted':1},registered_source_aliases=1,active_unique_registered_assets=1,new_PNGs=1,new_canonical_assets=1))
        self.review = self.doc('review',dict(result='reviewed'))
        self.apply = self.doc('apply',dict(actual_exit_code=0,argv=['apply',self.manifest['path']],
            manifest=self.manifest,preflight=self.pf,actual_primary_completion=self.completion,actual_live=self.live,
            actual_ROOT_thread_id='root',actual_root_execution_token='token'))
        self.outer = self.doc('outer',dict(actual_exit_code=0,receipt_version=self.live,observed_by_actual_root_thread_id='root',
            owner_execution_token='token',actual_completion_chunk='native0',actual_exec_session=1,
            actual_browser_review=self.review,actual_packet_local0=self.review,applied_workflow=self.review,
            actual_native_result=self.apply,actual_strict_completion=self.completion))
        changes = {'/registry':dict(before=self.registry_before,after=self.registry,explanation='exact installed projection')}
        self.facts = self.doc('facts',dict(schema='ROOT_POST_INSTALL_CURRENT_PUBLICATION_SOURCE_PROTECTED_FACTS_NOT_ADMISSION_V1',
            source_or_protected_preservation_admitted=False,ROOT_preservation_judgment=False,operational=False,enabled=False,shared_mutations=0,
            technical_approval=False,future_changes_authorized=False,
            current_owner=self.owner,current_pointer=self.pointer,current_six_controls=self.controls,all63_policy_pins=self.policies,active_policy_index=self.policy_index,
            actual_current_source=dict(head='head',tree='tree',clean=True,tracked_count=1,fullpins={'/app/source.py':self.source},
                native6={'/app/source.py':self.native('/app/source.py')}),pre_install_facts=self.pre_facts,
            protected_content_changes=changes,protected_added={'/app/new.png':self.runtime},protected_fullpins=self.current_protected,
            protected_native6={p:self.native(p) for p in self.current_protected},inventory_categories=self.categories,missing_fixed_paths=self.missing,
            existing_protected_count=len(self.current_protected),membership_names=len(self.categories),protected_removed=[],protected_category_changes={},
            current_DB=self.db,current_typed_database_state=self.state,current_typed_tables=1,current_typed_rows=2))
        judgment = dict(schema='ROOT_FINITE_CURRENT_PUBLICATION_CONTEXT_PRESERVATION_JUDGMENT_V2',owner_thread_id='root',owner_execution_token='token',
            root_preservation_judgment=True,current_publication_context_admitted=True,no_unlisted_or_future_change_admission=True,
            actual_fresh_current_facts=self.facts,allowed_completed_jobs=[17],current_owner=self.owner,current_pointer=self.pointer,
            actual_owner_claim_guard_released=True,actual_all_image_mutations_guarded_until_valid_claim_and_app_retarget=False,
            actual_same_active_owner_claim_and_release_preserved=True,pointer_publications=[self.cas],ordinary_parent=self.ordinary,
            ordinary_parent_outer0=self.ordinary_outer,current_six_controls=self.controls,all63_current_policy_members=self.policies,
            current_actual_source_HEAD='head',current_actual_source_tree='tree',current_source_count=1,
            exact_authorised_protected_changes=changes,exact_authorised_protected_addition={'/app/new.png':self.runtime},
            current_protected_file_count=len(self.current_protected),current_membership_count=len(self.categories),
            current_database=self.db,current_tables=1,current_rows=2,operation_live=self.live,operation_outer0=self.outer,
            intervening_recoveries=self.summary_pins)
        for k in ('executable_checkpoint_writer_admitted','operational','enabled','image_mutations_authorized','future_changes_authorized',
                  'new_generation_authorized','new_acceptance_authorized','new_installation_authorized','technical_approval'): judgment[k]=False
        self.judgment = self.doc('judgment',judgment)
        self.bindings = dict(manifest=self.manifest,preflight=self.pf,strict_manifest=self.strict,completion_pin=self.completion,backups=self.backups)
        self.proof = self.doc('proof',dict(original_operation_bindings=self.bindings,retained_after_copies={},
            retired_reviewed_observations={'/current':dict(original_observation=self.old_pointer,retained_copy=self.pointer_archive,
                current_version=self.pointer,authority=self.judgment)}))
        descriptor = dict(schema=c.DESCRIPTOR_SCHEMA,technical_approval=False,owner_thread_id='root',owner_execution_token='token',
            phase_module=self.phase,typed_reader=self.typed,current_judgment=self.judgment,current_facts=self.facts,operation_history=self.proof,
            original_admission=self.admission,operation_live=self.live,apply_native=self.apply,apply_outer0=self.outer,
            ordinary_parent=self.ordinary,ordinary_parent_outer0=self.ordinary_outer,intervening_recoveries=self.recovery_records)
        self.descriptor = self.doc('descriptor',descriptor)
        self.trusted = dict(owner_path=self.owner['path'],owner_pin=self.owner,root='root',token='token',current_judgment=self.judgment,
            current_facts=self.facts,phase_module=self.phase,typed_reader=self.typed,source_membership=list(self.membership))
        self.io = dict(version=self.version,bytes=lambda p:self.raw[p],native=self.native,exists=lambda p:p in self.raw,
            git=lambda:copy.deepcopy(self.git),source_membership=lambda:list(self.membership),
            inventory=lambda definition:(copy.deepcopy(self.categories),list(self.missing)))

    def put(self,path,raw,mtime=None):
        self.tick += 1
        pin=dict(path=path,bytes=len(raw),mtime_ns=self.tick if mtime is None else mtime,sha256=hashlib.sha256(raw).hexdigest())
        self.raw[path]=raw; self.pins[path]=pin
        return copy.deepcopy(pin)

    def doc(self,role,obj,path=None):
        obj=copy.deepcopy(obj)
        if role in self.changes:self.changes[role](obj)
        self.docs[role]=obj
        return self.put(path or '/'+role+'.json',json.dumps(obj,sort_keys=True).encode())

    def clone(self,pin,path):return self.put(path,self.raw[pin['path']],pin['mtime_ns'])
    def version(self,path):return copy.deepcopy(self.pins[path])
    def native(self,path):
        p=self.pins[path];return [p['bytes'],p['mtime_ns'],1,p['mtime_ns'],0,True]
    def qualify(self):return c.prepare_v2(self.descriptor,self.io,trusted=self.trusted,env={'CODEX_THREAD_ID':'root'})

    def make_recovery(self):
        strict=self.doc('recovery-strict',dict(jobs=[dict(output=dict(sha256=self.prior_runtime['sha256']))]))
        primary=self.doc('recovery-primary',dict(exit_code=0));apply=self.doc('recovery-apply',dict(actual_exit_code=1))
        readonly=self.doc('recovery-readonly',dict(actual_exit_code=0));failure=self.doc('recovery-failure',dict(result='FAIL'))
        live=self.doc('recovery-live',dict(schema='CLASSIFIRE_COMPLETED_CANONICAL_POSTINSTALL_READONLY_RECONCILIATION_V1',runtime_new_canonical_delta=1))
        summary=self.doc('recovery-summary',dict(schema='CLASSIFIRE_COMPLETED_CANONICAL_RECOVERY_COMPACT_V2',recovered_live=live,
            original_PRIMARY_completion=primary,original_apply_completion=apply,actual_readonly_native0=readonly,original_failure=failure,
            normal_STABLE_checkpoint_claimed=False,original_apply_exit_code=1,original_PRIMARY_exit_code=0,
            runtime_creation_versions={'/app/prior.png':self.prior_runtime},historical_canonical_delta_counted_once=1))
        old=dict(path='/current',bytes=self.old_pointer['bytes'],mtime_ns=2,sha256=self.old_pointer['sha256'])
        archive_pin=self.clone(self.pointer_archive,'/earlier-current')
        progress=self.doc('recovery-progress',dict(prior_exact_current_marker=old,no_reinstall_performed=True))
        reviewed=self.doc('historical-review',dict(result='reviewed'))
        bindings=dict(manifest=reviewed,preflight=reviewed,strict_manifest=strict)
        bridge=dict(schema='ROOT_COMPLETED_CANONICAL_TO_NORMAL_CANONICAL_BRIDGE_V1',owner_thread_id='root',owner_execution_token='token',
            root_preservation_judgment=True,no_unlisted_or_future_change_admission=True,historical_failures_preserved=True,strict_historical_FAIL_preserved=True,
            prior_ordinary_completed_base=dict(checkpoint=self.ordinary),recovered_compact=summary,recovered_live=live,
            actual_primary_completion=primary,actual_apply_completion=apply,actual_readonly_native0=readonly,original_failure=failure,
            original_apply_exit_code=1,original_PRIMARY_exit_code=0,original_physical_operation_bindings=bindings,
            retired_reviewed_observations={'/current':dict(current_version=self.old_pointer)},current_pointer=self.old_pointer,
            prior_pointer_observation=old,retained_prior_pointer=archive_pin,current_progress=progress,
            historical_software_validation_fixture=reviewed,historical_observation_replacements=reviewed,
            exact_canonical_jobs_from_immutable_strict_manifest=strict,retained_completed_control_copies={})
        for k in ('enabled','operational','technical_approval','replay_authorized','future_changes_authorized','image_mutations_authorized'):bridge[k]=False
        bridge_pin=self.doc('recovery-bridge',bridge)
        self.recovery_records=[dict(root_bridge=bridge_pin)];self.summary_pins=[summary]


class CheckpointRecoveryTests(unittest.TestCase):
    def bad(self,role,key,value,code=None,recovery=False):
        m=Memory({role:lambda x:x.__setitem__(key,value)},recovery=recovery)
        with self.assertRaisesRegex((ValueError,KeyError),code or '.') :m.qualify()

    def test_qualifies_candidate_without_writer(self):
        m=Memory();q=m.qualify();candidate=c.build_candidate_v2(q)
        self.assertEqual(candidate['schema'],c.CANDIDATE_SCHEMA)
        self.assertFalse(candidate['ordinary_checkpoint_written']);self.assertFalse(candidate['operational'])
        self.assertEqual(candidate['previous_base'],m.ordinary)
    def test_pointer_without_status_is_valid(self):self.assertNotIn('status',Memory().docs['pointer']);Memory().qualify()
    def test_lowercase_active_is_valid(self):Memory({'owner':lambda x:x.__setitem__('status','active')}).qualify()
    def test_inactive_owner_rejected(self):self.bad('owner','status','paused','TRUSTED_OWNER_ACTIVE')
    def test_owner_hold_rejected(self):self.bad('owner','image_publication_hold_active',True,'TRUSTED_OWNER_ACTIVE')
    def test_wrong_token_rejected(self):self.bad('descriptor','owner_execution_token','other','TRUSTED_PROCESS')
    def test_wrong_process_rejected(self):
        m=Memory()
        with self.assertRaisesRegex(ValueError,'TRUSTED_PROCESS'):c.prepare_v2(m.descriptor,m.io,trusted=m.trusted,env={'CODEX_THREAD_ID':'other'})
    def test_fake_owner_same_identity_rejected(self):
        m=Memory();fake=m.doc('fake-owner',m.docs['owner']);m.trusted['owner_pin']=fake
        with self.assertRaisesRegex(ValueError,'TRUSTED_OWNER_PATH'):m.qualify()
    def test_self_pinned_forged_judgment_rejected(self):
        m=Memory();d=copy.deepcopy(m.docs['descriptor']);d['current_judgment']=m.doc('forged',m.docs['judgment']);m.descriptor=m.doc('descriptor-new',d)
        with self.assertRaisesRegex(ValueError,'TRUSTED_CURRENT_JUDGMENT'):m.qualify()
    def test_malicious_dependency_never_executes(self):
        m=Memory();d=copy.deepcopy(m.docs['descriptor']);d['phase_module']=m.put('/evil.py',b"raise RuntimeError('EXECUTED')")
        m.descriptor=m.doc('descriptor-new',d)
        with self.assertRaisesRegex(ValueError,'TRUSTED_PHASE_MODULE'):m.qualify()
    def test_changed_owner_rejected_before_dependency_exec(self):
        m=Memory();m.put(m.owner['path'],b'changed owner')
        with self.assertRaisesRegex(ValueError,'PIN_BEFORE'):m.qualify()
    def test_missing_trusted_envelope_rejected(self):
        m=Memory()
        with self.assertRaises(TypeError):c.prepare_v2(m.descriptor,m.io)
    def test_unlisted_source_member_rejected(self):
        m=Memory();m.membership.append('/app/unlisted.py')
        with self.assertRaisesRegex(ValueError,'TRUSTED_SOURCE'):m.qualify()
    def test_self_declared_source_subset_rejected(self):
        m=Memory();m.trusted['source_membership'].append('/app/unlisted.py')
        with self.assertRaisesRegex(ValueError,'TRUSTED_SOURCE'):m.qualify()
    def test_source_content_or_native_drift_rejected(self):
        m=Memory();m.put('/app/source.py',b'new unlisted source')
        with self.assertRaisesRegex(ValueError,'NATIVE_CHANGED|PIN_BEFORE'):m.qualify()
    def test_unlisted_control_drift_rejected(self):
        m=Memory();m.put('/queue',b'changed queue')
        with self.assertRaisesRegex(ValueError,'PIN_BEFORE'):m.qualify()
    def test_pointer_guard_not_restored(self):self.bad('pointer','all_image_mutations_guarded_until_valid_claim_and_app_retarget',True,'CLAIM_RELEASE')
    def test_pointer_drift_rejected(self):
        m=Memory();m.put('/current',b'changed pointer')
        with self.assertRaisesRegex(ValueError,'PIN_BEFORE'):m.qualify()
    def test_missing_apply_zero(self):self.bad('apply','actual_exit_code',1,'ACTUAL_APPLY0')
    def test_boolean_apply_zero_rejected(self):self.bad('apply','actual_exit_code',False,'ACTUAL_APPLY0')
    def test_missing_strict_zero(self):self.bad('completion','exit_code',1,'ORIGINAL_STRICT')
    def test_boolean_strict_zero_rejected(self):self.bad('completion','exit_code',False,'ORIGINAL_STRICT')
    def test_missing_live_pass(self):self.bad('live','result','FAIL','ORIGINAL_STRICT')
    def test_outer_zero_not_inferred(self):self.bad('outer','actual_exit_code',1,'ACTUAL_ROOT_OUTER0')
    def test_other_apply_native_cannot_substitute(self):self.bad('outer','actual_native_result',{},'EXACT_APPLY_NATIVE')
    def test_apply_manifest_binding_required(self):self.bad('apply','manifest',{},'EXACT_APPLY_NATIVE')
    def test_automation_drift_rejected(self):
        m=Memory();m.put('/automation',b'kind="heartbeat"\nstatus="PAUSED"\ntarget_thread_id="root"\n')
        with self.assertRaisesRegex(ValueError,'PIN_BEFORE'):m.qualify()
    def test_database_typed_difference_rejected(self):self.bad('facts','current_typed_rows',99,'FULL_TYPED_DB')
    def test_database_sidecar_rejected(self):
        m=Memory();m.put('/database-wal',b'wal')
        with self.assertRaisesRegex(ValueError,'DB_SIDECARS'):m.qualify()
    def test_source_git_dirty_rejected(self):
        m=Memory();m.git['clean']=False
        with self.assertRaisesRegex(ValueError,'CURRENT_GIT'):m.qualify()
    def test_archive_bijection_rejected(self):
        m=Memory({'backups':lambda x:x['bindings']['registry'].__setitem__('backup_creation_version',dict(path='/wrong',bytes=0,mtime_ns=0,sha256='bad'))})
        with self.assertRaisesRegex(ValueError,'EXACT_CONTROL_BIJECTION'):m.qualify()
    def test_broad_runner_guard_rejected(self):
        with self.assertRaisesRegex(ValueError,'RUNNER_TOP_LEVEL'):c.reviewed_runner_ast(b'if True: main()')
    def test_main_body_injection_rejected(self):
        with self.assertRaisesRegex(ValueError,'RUNNER_TOP_LEVEL'):c.reviewed_runner_ast(b"if __name__ == '__main__':\n    arbitrary()")
    def test_recovery_keeps_apply_one_separate(self):
        m=Memory(recovery=True);q=m.qualify();x=c.build_candidate_v2(q)
        self.assertEqual(x['intervening_completed_recoveries'][0]['historical_apply_exit_code'],1)
        self.assertEqual(len(x['cumulative_new_runtime_creation_versions']),2)
    def test_omitted_recovery_rejected(self):self.bad('descriptor','intervening_recoveries',[],'ADMISSION_RECOVERY',recovery=True)
    def test_duplicate_recovery_rejected(self):
        m=Memory({'descriptor':lambda x:x['intervening_recoveries'].append(copy.deepcopy(x['intervening_recoveries'][0]))},recovery=True)
        with self.assertRaisesRegex(ValueError,'ADMISSION_RECOVERY|EXACT_RECOVERY_LIST'):m.qualify()
    def test_recovery_apply_one_cannot_be_zero(self):self.bad('recovery-apply','actual_exit_code',0,'RECOVERY_APPLY1',recovery=True)
    def test_recovery_primary_zero_required(self):self.bad('recovery-primary','exit_code',1,'RECOVERY_APPLY1',recovery=True)
    def test_recovery_readonly_zero_required(self):self.bad('recovery-readonly','actual_exit_code',1,'RECOVERY_APPLY1',recovery=True)
    def test_forged_qualification_flags_rejected(self):
        with self.assertRaisesRegex(ValueError,'PRIVATE_QUALIFICATION_HANDLE'):c.build_candidate_v2(dict(schema='QUALIFIED_DUAL_CONTEXT_CHECKPOINT_V2_READONLY',all_gates_before_candidate=True,writer_authorized=False))
    def test_handle_payload_exposes_copy(self):
        q=Memory().qualify();q.data['writer_authorized']=True;self.assertFalse(q.data['writer_authorized'])
    def test_handle_internal_payload_cannot_be_replaced(self):
        q=Memory().qualify()
        with self.assertRaises(AttributeError):q._payload=b'{"writer_authorized":true}'
    def test_handle_fence_cannot_be_replaced(self):
        q=Memory().qualify()
        with self.assertRaises(AttributeError):q._fence=lambda:None
    def test_unissued_instance_rejected(self):
        q=object.__new__(c.QualifiedCheckpoint)
        with self.assertRaisesRegex(ValueError,'PRIVATE_QUALIFICATION_HANDLE'):c.build_candidate_v2(q)
    def test_handle_constructor_not_public(self):
        with self.assertRaisesRegex(ValueError,'PRIVATE_QUALIFICATION_HANDLE'):c.QualifiedCheckpoint({})
    def test_facts_cannot_grant_future_authority(self):self.bad('facts','future_changes_authorized',True,'FACTS_NOT_AUTHORITY')
    def test_candidate_rechecks_end_fences(self):
        m=Memory();q=m.qualify();m.put('/queue',b'after qualification drift')
        with self.assertRaisesRegex(ValueError,'END_PIN_RACE'):c.build_candidate_v2(q)
    def test_candidate_rechecks_source_membership(self):
        m=Memory();q=m.qualify();m.membership.append('/app/new.py')
        with self.assertRaisesRegex(ValueError,'END_SOURCE_MEMBERSHIP'):c.build_candidate_v2(q)
    def test_writer_always_disabled(self):
        with self.assertRaisesRegex(ValueError,'V2_WRITER_DISABLED'):c.checkpoint_v2(Memory().qualify())


if __name__ == '__main__':
    unittest.main()
