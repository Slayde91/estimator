"""Generic synthetic multi-generation tests. No private audit or image inputs."""
from contextlib import contextmanager
import copy
import hashlib
import json
from pathlib import Path
import unittest

from estimator import image_checkpoint_recovery as core
from estimator import image_checkpoint_v2_reader as reader
from estimator import image_checkpoint_v2_writer as writer
from test_image_checkpoint_recovery import Memory
from test_image_checkpoint_v2_writer import MemoryStore
from estimator import recurring_v2_checkpoint as recurring


PHASE = b'''import copy,hashlib,json
def canonical_completed_history(bindings,jobs,after,io,retired):
    def doc(pin):
        assert io['version'](pin['path'])==pin
        raw=io['bytes'](pin['path'])
        assert hashlib.sha256(raw).hexdigest()==pin['sha256']
        return json.loads(raw)
    assert retired=={}
    pf=doc(bindings['preflight']);backups=doc(bindings['backups'])
    m=doc(bindings['manifest']);done=doc(bindings['completion_pin'])
    assert type(done['exit_code']) is int and done['exit_code']==0
    assert done['actual_PF_version']==bindings['preflight']
    assert done['target_jobs']==m['targets']==[j['job'] for j in jobs]
    old={}
    for role in ('queue','registry'):
        b=backups['bindings'][role];oldpin=b['source_snapshot'];archive=b['backup_creation_version']
        assert oldpin==pf['critical'][oldpin['path']]
        raw=io['bytes'](archive['path'])
        assert len(raw)==oldpin['bytes'] and hashlib.sha256(raw).hexdigest()==oldpin['sha256']
        old[role]=doc(archive)
        assert doc(after[role]['copy'])==doc(after[role]['observed'])
    expectedq=copy.deepcopy(old['queue']);expectedq['jobs']+=jobs
    expectedr=copy.deepcopy(old['registry'])
    for j in jobs:expectedr['images']['job-'+str(j['job'])]={'sha256':j['output']['sha256']}
    assert doc(after['queue']['observed'])==expectedq,'WHOLE_QUEUE_PROJECTION'
    assert doc(after['registry']['observed'])==expectedr,'WHOLE_REGISTRY_PROJECTION'
    return {'result':'PASS_PHYSICAL_COMPLETED_HISTORY_NOT_CURRENT_STATE'}
'''


class FullMemory(Memory):
    def put(self,path,raw,mtime=None):
        if path=='/queue':
            rows=[] if raw==b'before queue' else [dict(job=17,status='accepted',output=dict(sha256=hashlib.sha256(b'new image').hexdigest()))]
            raw=json.dumps({'jobs':rows},sort_keys=True).encode()
        if path=='/registry':
            images={} if raw==b'before registry' else {'job-17':dict(sha256=hashlib.sha256(b'new image').hexdigest())}
            raw=json.dumps({'images':images},sort_keys=True).encode()
        return super().put(path,raw,mtime)

    def doc(self,role,obj,path=None):
        if role=='pre-facts':
            for n in range(62):
                p='/policy-extra/'+str(n);self.policies[p]=self.put(p,str(n).encode())
            for n in range(4):
                p='/control-extra/'+str(n);self.controls[p]=self.put(p,str(n).encode())
        return super().doc(role,obj,path)


class Capability:
    def __init__(self,m,c,label):
        self.m,self.c,self.label=m,c,label
        wm=m.put(str(Path(writer.__file__).resolve()),Path(writer.__file__).read_bytes())
        cm=m.put(str(Path(c.__file__).resolve()),Path(c.__file__).read_bytes())
        archives={role:dict(observed=p,retained_copy=m.clone(p,'/archive/'+label+'/'+role))
                  for role,p in [('writer_module',wm),('qualifier_module',cm)]}
        review=m.doc(label+'-review',dict(schema=writer.REVIEW_SCHEMA,result='PASS',owner_thread_id='root',
            owner_execution_token='token',reviewed_commit='a'*40,retained_source_archives=archives))
        ci=m.doc(label+'-ci',dict(schema=writer.CI_SCHEMA,result='PASS',merged=True,all_required_checks_passed=True,
            head_is_ancestor_of_merge=True,head_commit='a'*40,merge_commit='b'*40,
            reviewed_source_sha256=dict(writer_module=wm['sha256'],qualifier_module=cm['sha256']),
            required_check_conclusions={'unit':'success','browser':'success','desktop':'success'}))
        outputs={r:'/audit/'+label+'/'+r+'.json' for r in ('journal','leaf','proposal')}
        permit=dict(schema=writer.PERMIT_SCHEMA,result='ROOT_EXPLICIT_FINITE_CHECKPOINT_WRITER_PERMIT',
            writer_enabled=True,owner_thread_id='root',owner_execution_token='token',descriptor=m.descriptor,
            current_owner=m.trusted['owner_pin'],current_judgment=m.trusted['current_judgment'],current_facts=m.trusted['current_facts'],
            before_publication_pointer=m.docs['judgment']['current_pointer'],writer_module=wm,qualifier_module=cm,
            code_review=review,merged_code_CI=ci,private_output_root='/audit/'+label,outputs=outputs,
            lock_path='/owner.lock',exclusive_owner_lock_required=True,new_namespace_only=True,merged_code_commit='b'*40)
        for k in ('new_generation_authorized','new_acceptance_authorized','new_installation_authorized','CURRENT_write_authorized',
                  'overwrite_authorized','resume_authorized','future_changes_authorized','technical_approval'):permit[k]=False
        permit_pin=m.doc(label+'-permit',permit)
        self.expected={k:permit[k] for k in ('writer_module','qualifier_module','code_review','merged_code_CI',
            'private_output_root','outputs','lock_path')}
        self.expected['permit']=permit_pin;self.store=MemoryStore(m)

    def write(self):
        return writer.write_checkpoint_v2(self.m.descriptor,self.m.io,core=self.c,trusted=self.m.trusted,
            writer_trusted=self.expected,store=self.store,env={'CODEX_THREAD_ID':'root'})


class Chain:
    def __init__(self):
        self.m=FullMemory(recovery=True);self.generation=0;self.current_core=core
        cap=Capability(self.m,core,'first');self.first_written=cap.write()
        self.publish(self.first_written,'first')

    def publish(self,written,label):
        # Explicitly SYNTHETIC process/publication records follow real MemoryStore
        # writer output. This unit fixture does not claim an actual native exit0.
        m=self.m;leaf=json.loads(m.raw[written['receipt_version']['path']])
        old=leaf['before_publication_pointer'];backup=m.clone(old,'/pub/'+label+'/before')
        policy=m.doc(label+'-policy-index',dict(policies=m.policies,policy_count=63,technical_approval=False))
        roles={k:m.doc(label+'-'+k,dict(synthetic=k)) for k in ('claim','receiving_authority','retarget','hold_release')}
        owner=copy.deepcopy(m.docs['owner']);owner.update(all_image_mutations_guarded_until_valid_claim_and_app_retarget=False,
            automation_retarget_pending=False,current_active_policy_index=policy,existing_automation_target_thread_id='root',
            automation_remains_ACTIVE=True,actual_claim_receipt=roles['claim'],actual_receiving_authority=roles['receiving_authority'],
            actual_retarget_verification=roles['retarget'],image_publication_hold_release=roles['hold_release'])
        m.owner=m.doc('owner',owner,path=m.owner['path'])
        native=m.doc(label+'-native',dict(schema=reader.NATIVE_SCHEMA,actual_exit_code=0,receipt_version=written['receipt_version'],
            writer_authority=leaf['writer_authority'],writer_journal=leaf['writer_journal'],publication_proposal=written['publication_proposal'],
            owner_thread_id='root',owner_execution_token='token',actual_completion_observed=True,no_primary_invoked=True,no_application_mutations=True))
        outer=m.doc(label+'-root-outer',dict(schema=reader.OUTER_SCHEMA,actual_exit_code=0,receipt_version=written['receipt_version'],
            actual_native_completion_receipt=native,observed_by_actual_root_thread_id='root',owner_execution_token='token'))
        pointer=copy.deepcopy(json.loads(m.raw[written['publication_proposal']['path']])['current_pointer_template'])
        pointer.update(actual_checkpoint_root_outer0=outer)
        m.pointer=m.doc(label+'-pointer',pointer,path=old['path'])
        readback=m.doc(label+'-readback',dict(schema=reader.READBACK_SCHEMA,new_current=m.pointer,
            checkpoint=written['receipt_version'],checkpoint_native=native,checkpoint_outer0=outer,readback_exact=True))
        cas=m.doc(label+'-cas',dict(schema=reader.CAS_SCHEMA,owner_thread_id='root',owner_execution_token='token',
            old_current=old,new_current=m.pointer,backup=backup,checkpoint=written['receipt_version'],
            checkpoint_native=native,checkpoint_outer0=outer,readback=readback,
            ordinary_parent_preserved=True,recoveries_preserved=True,control_mutations=0))
        facts=json.loads(m.raw[leaf['baseline_snapshot']['facts']['path']])
        facts.update(schema=reader.FACTS_SCHEMA,current_owner=m.owner,current_pointer=m.pointer,
            active_policy_index=policy,current_automation=m.automation,
            inventory_definition=json.loads(m.raw[json.loads(m.raw[leaf['baseline_snapshot']['descriptor']['path']])['original_admission']['path']])['protected']['inventory_definition'])
        facts_pin=m.doc(label+'-read-facts',facts)
        context=dict(schema=reader.CONTEXT_SCHEMA,owner_thread_id='root',owner_execution_token='token',
            root_preservation_judgment=True,no_unlisted_or_future_change_admission=True,completed_base=written['receipt_version'],
            publication_cas=cas,current_facts=facts_pin,current_owner=m.owner,current_pointer=m.pointer,
            baseline_snapshot=leaf['baseline_snapshot'],declared_current_facts=facts,
            declared_map_transitions={k:{} for k in ('source','protected','policies','controls')},
            actual_same_active_owner_claim_and_release_preserved=True,claim_release_evidence=roles)
        for k in ('operational','enabled','future_changes_authorized','image_mutations_authorized','new_generation_authorized',
                  'new_acceptance_authorized','new_installation_authorized','technical_approval'):context[k]=False
        ctx=m.doc(label+'-read-context',context)
        self.reader_trusted=dict(root='root',token='token',owner_path=m.owner['path'],owner_pin=m.owner,current_pointer=m.pointer,
            leaf=written['receipt_version'],native_completion=native,root_outer0=outer,publication_CAS=cas,
            current_context=ctx,current_facts=facts_pin,approved_dependencies={'typed_reader':m.typed},source_membership=list(m.membership))
        m.io.update(approved_dependencies={'typed_reader':m.typed},typed_bytes=lambda raw:(json.loads(raw),None))
        self.facts=facts;self.leaf=leaf;self.written=written

    def history(self,**kw):
        return recurring.read_published_v2_history(self.written['receipt_version'],self.m.io,
            trusted=self.reader_trusted,approved_reader=reader,env={'CODEX_THREAD_ID':'root'},**kw)

    def next_operation(self,job=59,mutation=None,runtime_bytes=None,queue_mutation=None,registry_mutation=None):
        m=self.m;self.generation+=1;label='step-'+str(self.generation)
        history=self.history();parent_binding=m.doc(label+'-parent',history['top_publication_binding'])
        before_controls=copy.deepcopy(self.facts['current_six_controls'])
        before_protected=copy.deepcopy(self.facts['protected_fullpins']);before_categories=copy.deepcopy(self.facts['inventory_categories'])
        qbefore=before_controls['/queue'];rbefore=before_controls['/registry']
        qb=m.clone(qbefore,'/'+label+'/queue-before');rb=m.clone(rbefore,'/'+label+'/registry-before')
        pre=m.doc(label+'-pre-facts',dict(actual_current_source=self.facts['actual_current_source'],
            protected_native6={p:m.native(p) for p in before_protected}))
        runtime=m.put('/app/job'+str(job)+'.png',runtime_bytes if runtime_bytes is not None else ('new runtime '+str(job)).encode())
        row=dict(job=job,status='accepted',output=dict(sha256=runtime['sha256']))
        q=json.loads(m.raw[qbefore['path']]);q['jobs'].append(row)
        reg=json.loads(m.raw[rbefore['path']]);reg['images']['job-'+str(job)]=dict(sha256=runtime['sha256'])
        if queue_mutation:queue_mutation(q)
        if registry_mutation:registry_mutation(reg)
        # Bypass only FullMemory's initial fixture text shortcuts, not reader IO.
        m.queue=Memory.put(m,'/queue',json.dumps(q,sort_keys=True).encode())
        m.registry=Memory.put(m,'/registry',json.dumps(reg,sort_keys=True).encode())
        m.controls=dict(before_controls,**{'/queue':m.queue,'/registry':m.registry})
        protected=dict(before_protected,**{'/registry':m.registry,runtime['path']:runtime})
        m.categories=dict(before_categories,**{runtime['path']:'private reference library'})
        source=self.facts['actual_current_source']
        admission=dict(source=dict(head=source['head'],tree=source['tree'],worktree_fullpins=source['fullpins']),
            protected=dict(fullpins=before_protected,native_metadata=self.facts['protected_native6'],categories=before_categories,missing_fixed_paths=m.missing,
                inventory_definition=m.docs['admission']['protected']['inventory_definition'],existing_count=len(before_protected)),
            database=dict(current_fullpin=m.db,typed_state=m.state),policy_members=m.policies,
            completed_base=dict(checkpoint=history['top_publication_binding']['checkpoint'],outer0=history['top_publication_binding']['ROOT_outer0'],
                pointer=m.pointer,six_controls=before_controls),completed_recovery_bridges=[])
        ap=m.doc(label+'-admission',admission)
        manifest=m.doc(label+'-manifest',dict(owner_thread_id='root',owner_execution_token='token',targets=[job],
            actual_finite_source_data_admission=ap,controls=dict(owner=m.owner,automation=m.automation),reviewed_runner=m.runner,
            common_engine_version=m.common,expected_current_pointer=m.pointer))
        pf=m.doc(label+'-pf',dict(result='PASS',helper_creation_version=m.runner,common_engine_version=m.common,critical=before_controls,
            reviewed_evidence_versions={'/queue':qbefore,'/registry':rbefore,'/current':m.pointer,'/app/source.py':m.source}))
        backups=m.doc(label+'-backups',dict(bindings=dict(queue=dict(source_snapshot=qbefore,backup_creation_version=qb),
            registry=dict(source_snapshot=rbefore,backup_creation_version=rb))))
        strict=m.doc(label+'-strict',dict(jobs=[row]))
        done=m.doc(label+'-strict0',dict(exit_code=0,actual_completion_observed=True,target_jobs=[job],actual_PF_version=pf))
        live=m.doc(label+'-live',dict(result='PASS',actual_completed_jobs=[job],plan_version=manifest,preflight_creation_version=pf,
            helper_creation_version=m.runner,common_engine_version=m.common,current_state_snapshots=m.controls,current_typed_database_state=m.state,
            actual_new_runtime_creation_versions={runtime['path']:runtime},protected_member_count_before=len(before_protected),
            protected_member_count_after=len(protected),protected_file_count=len(protected),status_counts={'accepted':len(q['jobs'])},
            registered_source_aliases=len(reg['images']),active_unique_registered_assets=len(reg['images']),new_PNGs=1,new_canonical_assets=1))
        apply=m.doc(label+'-apply',dict(actual_exit_code=0,argv=['apply',manifest['path']],manifest=manifest,preflight=pf,
            actual_primary_completion=done,actual_live=live,actual_ROOT_thread_id='root',actual_root_execution_token='token'))
        outer=m.doc(label+'-apply-outer',dict(actual_exit_code=0,receipt_version=live,observed_by_actual_root_thread_id='root',
            owner_execution_token='token',actual_completion_chunk='synthetic0',actual_exec_session=1,actual_native_result=apply,
            actual_strict_completion=done,actual_browser_review=m.review,actual_packet_local0=m.review,applied_workflow=m.review))
        changes={'/registry':dict(before=rbefore,after=m.registry,explanation='exact one new canonical projection')}
        facts=copy.deepcopy(self.facts);facts.update(schema='ROOT_POST_INSTALL_CURRENT_PUBLICATION_SOURCE_PROTECTED_FACTS_NOT_ADMISSION_V1',
            current_six_controls=m.controls,pre_install_facts=pre,protected_content_changes=changes,protected_added={runtime['path']:runtime},
            protected_fullpins=protected,protected_native6={p:m.native(p) for p in protected},inventory_categories=m.categories,
            existing_protected_count=len(protected),membership_names=len(m.categories))
        fp=m.doc(label+'-post-facts',facts)
        j=dict(schema=recurring.POST_CONTEXT_SCHEMA,owner_thread_id='root',owner_execution_token='token',
            root_preservation_judgment=True,current_publication_context_admitted=True,no_unlisted_or_future_change_admission=True,
            actual_fresh_current_facts=fp,allowed_completed_jobs=[job],completed_parent_v2=parent_binding,
            current_publication_state=recurring.UNPUBLISHED,pointer_publications=[],current_owner=m.owner,current_pointer=m.pointer,
            actual_owner_claim_guard_released=True,actual_all_image_mutations_guarded_until_valid_claim_and_app_retarget=False,
            actual_same_active_owner_claim_and_release_preserved=True,current_six_controls=m.controls,all63_current_policy_members=m.policies,
            current_actual_source_HEAD=source['head'],current_actual_source_tree=source['tree'],current_source_count=len(source['fullpins']),
            exact_authorised_protected_changes=changes,exact_authorised_protected_addition={runtime['path']:runtime},
            current_protected_file_count=len(protected),current_membership_count=len(m.categories),current_database=m.db,
            current_tables=1,current_rows=2,operation_live=live,operation_outer0=outer)
        for k in ('executable_checkpoint_writer_admitted','operational','enabled','image_mutations_authorized','future_changes_authorized',
                  'new_generation_authorized','new_acceptance_authorized','new_installation_authorized','technical_approval'):j[k]=False
        jp=m.doc('judgment',j,path='/'+label+'/judgment.json')
        after={role:dict(observed=pin,copy=m.clone(pin,'/'+label+'/'+role+'-after')) for role,pin in [('queue',m.queue),('registry',m.registry)]}
        bindings=dict(manifest=manifest,preflight=pf,strict_manifest=strict,completion_pin=done,backups=backups)
        proof=m.doc(label+'-proof',dict(original_operation_bindings=bindings,retained_after_copies=after,retired_reviewed_observations={}))
        phase=m.put('/'+label+'/approved-phase.py',PHASE)
        cp=m.version(str(Path(core.__file__).resolve()))
        rp=m.put(str(Path(reader.__file__).resolve()),Path(reader.__file__).read_bytes())
        d=dict(schema=core.DESCRIPTOR_SCHEMA,technical_approval=False,owner_thread_id='root',owner_execution_token='token',
            phase_module=phase,typed_reader=m.typed,current_judgment=jp,current_facts=fp,operation_history=proof,
            original_admission=ap,operation_live=live,apply_native=apply,apply_outer0=outer,
            ordinary_parent=history['top_publication_binding']['checkpoint'],ordinary_parent_outer0=history['top_publication_binding']['ROOT_outer0'],
            original_ordinary_root=history['original_ordinary_root'],
            intervening_recoveries=[],completed_parent_v2=parent_binding,parent_reader_pin=rp,original_core_pin=cp)
        if mutation:mutation(d,j,facts)
        m.descriptor=m.doc(label+'-descriptor',d)
        m.trusted=dict(owner_path=m.owner['path'],owner_pin=m.owner,root='root',token='token',current_judgment=jp,current_facts=fp,
            phase_module=phase,typed_reader=m.typed,source_membership=list(m.membership),completed_parent_v2=parent_binding,
            parent_reader_trusted=self.reader_trusted,parent_reader_pin=rp,original_core_pin=cp)
        self.current_core=recurring.create_recurring_core(core,reader,original_core_pin=cp,approved_reader_pin=rp)
        self.next_label=label;self.next_facts=facts
        self.new_done,self.new_live,self.new_apply=done,live,apply
        return self

    def qualify(self):
        return self.current_core.prepare_v2(self.m.descriptor,self.m.io,trusted=self.m.trusted,env={'CODEX_THREAD_ID':'root'})

    def write_next(self):
        return Capability(self.m,self.current_core,self.next_label).write()

    def full_read(self):
        pin=self.m.put(str(Path(reader.__file__).resolve()),Path(reader.__file__).read_bytes())
        current=recurring.create_recurring_reader(reader,approved_reader_pin=pin)
        return current.read_completed_base_v2(self.written['receipt_version'],self.m.io,trusted=self.reader_trusted,env={'CODEX_THREAD_ID':'root'})

    def rebind_synthetic_proposal(self,written):
        proposal=json.loads(self.m.raw[written['publication_proposal']['path']])
        proposal['checkpoint']=written['receipt_version']
        proposal['current_pointer_template']['latest_completed_receipt']=written['receipt_version']
        written['publication_proposal']=self.m.put(written['publication_proposal']['path'],json.dumps(proposal,sort_keys=True).encode())


class RecurringTests(unittest.TestCase):
    def test_first_frozen_history_and_full_reader(self):
        x=Chain();self.assertEqual(x.history()['ancestry_node_count'],1)
        v=reader.read_completed_base_v2(x.written['receipt_version'],x.m.io,trusted=x.reader_trusted,env={'CODEX_THREAD_ID':'root'})
        self.assertEqual(v['result'],'PASS_READ_ONLY_COMPLETED_BASE_V2')
    def test_two_generation_actual_memory_writer_roundtrip(self):
        x=Chain();first=x.written['receipt_version'];x.next_operation(59)
        with self.assertRaises(ValueError):reader.read_completed_base_v2(first,x.m.io,trusted=x.reader_trusted,env={'CODEX_THREAD_ID':'root'})
        self.assertFalse(x.history()['current_state_claimed'])
        q=x.qualify();candidate=x.current_core.build_candidate_v2(q)
        self.assertEqual(candidate['previous_base'],first);self.assertEqual(candidate['intervening_completed_recoveries'],[])
        written=x.write_next();x.publish(written,'second');h=x.history()
        self.assertEqual(h['ancestry_node_count'],2);self.assertEqual(len(h['ordered_operations']),2)
        self.assertEqual(h['intervening_completed_recoveries'][0]['historical_apply_exit_code'],1)
        self.assertEqual(x.full_read()['result'],'PASS_READ_ONLY_COMPLETED_BASE_V2')
    def test_three_generation_generic_roundtrip_and_retired_current_archives(self):
        x=Chain();x.next_operation(59);x.publish(x.write_next(),'second')
        x.next_operation(73);x.publish(x.write_next(),'third');h=x.history()
        self.assertEqual(h['ancestry_node_count'],3);self.assertEqual(len(h['ordered_operations']),3)
        self.assertEqual(len(h['intervening_completed_recoveries']),1)
        self.assertEqual(len(h['cumulative_new_runtime_creation_versions']),4)
        self.assertEqual(len(h['all_actual_bounded_deltas']),4)
        self.assertEqual(x.m.version('/current'),x.reader_trusted['current_pointer'])
        self.assertEqual(x.full_read()['immediate_completed_parent'],x.leaf['previous_base'])
    def test_history_not_constructor_forgeable(self):
        with self.assertRaisesRegex(ValueError,'ISSUED_HISTORY'):recurring.PublishedHistory()
    def test_unissued_history_instance_rejected(self):
        h=object.__new__(recurring.PublishedHistory)
        with self.assertRaisesRegex(ValueError,'ISSUED_HISTORY'):recurring.fence_published_history(h)
    def test_history_payload_is_copy(self):
        x=Chain();h=x.history();d=h.data;d['ordered_operations'].clear();self.assertEqual(len(h['ordered_operations']),1)
    def test_history_pin_fence_rechecks_current_pointer(self):
        x=Chain();h=x.history();x.m.pins['/current']['mtime_ns']+=1
        with self.assertRaisesRegex(ValueError,'END_PIN'):recurring.fence_published_history(h)
    def test_history_owner_hold_rejected(self):
        x=Chain();x.m.docs['owner']['image_publication_hold_active']=True
        x.m.owner=x.m.doc('owner',x.m.docs['owner'],path=x.m.owner['path']);x.reader_trusted['owner_pin']=x.m.owner
        with self.assertRaisesRegex(ValueError,'HISTORY_CURRENT_OWNER'):x.history()
    def test_unknown_parent_envelope_rejected(self):
        x=Chain();x.reader_trusted['foreign']=True
        with self.assertRaisesRegex(ValueError,'EXTERNAL_HISTORY'):x.history()
    def test_history_bound_independent_of_generation_budget(self):
        x=Chain();x.next_operation(59);x.publish(x.write_next(),'second')
        with self.assertRaisesRegex(ValueError,'EXCESS_ANCESTRY'):x.history(max_nodes=1)
        self.assertEqual(x.history(max_nodes=2)['ancestry_node_count'],2)
    def test_unknown_ancestry_bound_rejected(self):
        x=Chain()
        for bound in [0,True,257]:
            with self.subTest(bound=bound),self.assertRaisesRegex(ValueError,'FINITE_ANCESTRY'):x.history(max_nodes=bound)
    def test_history_alone_cannot_construct_checkpoint_candidate(self):
        x=Chain();x.next_operation()
        with self.assertRaises(ValueError):x.current_core.build_candidate_v2(x.history())
    def test_unissued_recurring_handle_rejected(self):
        x=Chain();x.next_operation();fake=object.__new__(recurring.QualifiedRecurring)
        with self.assertRaisesRegex(ValueError,'ISSUED_RECURRING'):x.current_core.build_candidate_v2(fake)
    def test_recurring_handle_payload_copy(self):
        x=Chain();x.next_operation();h=x.qualify();d=h.data;d['all_gates_before_candidate']=False
        self.assertEqual(x.current_core.build_candidate_v2(h)['result'],'QUALIFIED_CANDIDATE_NOT_EXECUTED')
    def test_missing_new_operation_strict0_rejects(self):
        x=Chain();x.next_operation();x.m.raw[x.new_done['path']]=b'{}'
        with self.assertRaises(ValueError):x.qualify()
    def test_old_parent_completion_cannot_substitute_for_new(self):
        x=Chain();x.next_operation();d=x.m.docs['step-1-descriptor'];d['apply_native']=x.first_written['receipt_version']
        x.m.descriptor=x.m.doc('step-1-descriptor',d)
        with self.assertRaises((ValueError,KeyError)):x.qualify()
    def test_new_apply_one_rejected(self):
        x=Chain();x.next_operation();x.m.raw[x.new_apply['path']]=b'{}'
        with self.assertRaises(ValueError):x.qualify()
    def test_post_pointer_drift_rejected(self):
        x=Chain();x.next_operation();Memory.put(x.m,'/current',b'drift')
        with self.assertRaises(ValueError):x.qualify()
    def test_unlisted_whole_queue_projection_rejected(self):
        x=Chain();x.next_operation();q=json.loads(x.m.raw['/queue']);q['jobs'].append({'job':999,'status':'accepted'})
        Memory.put(x.m,'/queue',json.dumps(q).encode())
        with self.assertRaises(ValueError):x.qualify()
    def test_dirty_source_rejected(self):
        x=Chain();x.next_operation();x.m.git['clean']=False
        with self.assertRaisesRegex(ValueError,'CURRENT_GIT'):x.qualify()
    def test_unlisted_source_membership_rejected(self):
        x=Chain();x.next_operation();x.m.membership.append('/unlisted')
        with self.assertRaises(ValueError):x.qualify()
    def test_database_sidecar_rejected(self):
        x=Chain();x.next_operation();x.m.put(x.m.db['path']+'-wal',b'sidecar')
        with self.assertRaisesRegex(ValueError,'SIDECARS'):x.qualify()
    def test_code_dependency_not_selected_by_descriptor_data(self):
        x=Chain();x.next_operation();d=x.m.docs['step-1-descriptor'];d['parent_reader_pin']=x.m.source
        x.m.descriptor=x.m.doc('step-1-descriptor',d)
        with self.assertRaisesRegex(ValueError,'APPROVED_RECURRING'):x.qualify()
    def test_end_control_race_stops_before_candidate(self):
        x=Chain();x.next_operation();h=x.qualify();x.m.pins['/registry']['mtime_ns']+=1
        with self.assertRaises(ValueError):x.current_core.build_candidate_v2(h)
    def test_false_claim_publication_not_required_or_fabricated(self):
        x=Chain();x.next_operation();h=x.qualify()
        self.assertEqual(h.data['descriptor']['current_publication_state'] if 'current_publication_state' in h.data['descriptor'] else recurring.UNPUBLISHED,recurring.UNPUBLISHED)
        self.assertEqual(x.m.docs['judgment']['pointer_publications'],[])
    def test_default_first_v1_route_delegates_unchanged(self):
        m=FullMemory(recovery=True)
        cp=m.put(str(Path(core.__file__).resolve()),Path(core.__file__).read_bytes())
        rp=m.put(str(Path(reader.__file__).resolve()),Path(reader.__file__).read_bytes())
        c=recurring.create_recurring_core(core,reader,original_core_pin=cp,approved_reader_pin=rp)
        h=c.prepare_v2(m.descriptor,m.io,trusted=m.trusted,env={'CODEX_THREAD_ID':'root'})
        self.assertEqual(c.build_candidate_v2(h)['previous_base'],m.ordinary)
    def test_semantic_new_apply_one_not_a_stale_pin(self):
        x=Chain();x.m.changes['step-1-apply']=lambda d:d.__setitem__('actual_exit_code',1);x.next_operation()
        with self.assertRaisesRegex(ValueError,'NEW_ACTUAL_APPLY0'):x.qualify()
    def test_semantic_boolean_new_apply_zero_rejected(self):
        x=Chain();x.m.changes['step-1-apply']=lambda d:d.__setitem__('actual_exit_code',False);x.next_operation()
        with self.assertRaisesRegex(ValueError,'NEW_ACTUAL_APPLY0'):x.qualify()
    def test_semantic_new_strict_failure_rejected(self):
        x=Chain();x.m.changes['step-1-strict0']=lambda d:d.__setitem__('exit_code',1);x.next_operation()
        with self.assertRaisesRegex(ValueError,'NEW_STRICT_LIVE'):x.qualify()
    def test_semantic_new_live_failure_rejected(self):
        x=Chain();x.m.changes['step-1-live']=lambda d:d.__setitem__('result','FAIL');x.next_operation()
        with self.assertRaisesRegex(ValueError,'NEW_STRICT_LIVE'):x.qualify()
    def test_fake_false_claim_publication_list_rejected(self):
        x=Chain();x.m.changes['judgment']=lambda d:d.__setitem__('pointer_publications',[{'normal_checkpoint_success_claimed':False}]);x.next_operation()
        with self.assertRaisesRegex(ValueError,'EXPLICIT_UNPUBLISHED'):x.qualify()
    def test_post_context_future_permission_rejected(self):
        x=Chain();x.m.changes['judgment']=lambda d:d.__setitem__('future_changes_authorized',True);x.next_operation()
        with self.assertRaisesRegex(ValueError,'FINITE_NEW_OPERATION'):x.qualify()
    def test_inherited_recovery_not_reappended(self):
        x=Chain();x.next_operation(mutation=lambda d,j,f:d.__setitem__('intervening_recoveries',[{'root_bridge':'not-new'}]))
        with self.assertRaisesRegex(ValueError,'NO_INHERITED_RECOVERY'):x.qualify()
    def test_duplicate_canonical_output_hash_rejected(self):
        x=Chain();x.next_operation(runtime_bytes=b'new image')
        with self.assertRaisesRegex(ValueError,'NEW_RUNTIME_COUNTED_ONCE'):x.qualify()
    def test_unknown_ancestor_schema_rejected(self):
        from test_image_checkpoint_v2_reader import Memory as ReaderFixture
        m=ReaderFixture({'ordinary':lambda d:d.__setitem__('schema','FOREIGN_SCHEMA')})
        with self.assertRaisesRegex(ValueError,'EXPLICIT_V2_PARENT'):
            recurring.read_published_v2_history(m.leaf,m.io,trusted=m.trusted,approved_reader=reader,env={'CODEX_THREAD_ID':'receiver'})
    def test_n4_apply_one_is_literal_not_promoted(self):
        from test_image_checkpoint_v2_reader import Memory as ReaderFixture
        m=ReaderFixture({'recovery-apply':lambda d:d.__setitem__('actual_exit_code',0)})
        with self.assertRaisesRegex(ValueError,'RECOVERY_REAL_PROCESS_EXIT'):
            recurring.read_published_v2_history(m.leaf,m.io,trusted=m.trusted,approved_reader=reader,env={'CODEX_THREAD_ID':'receiver'})
    def test_missing_ancestor_file_rejected(self):
        x=Chain();x.next_operation();written=x.write_next();x.publish(written,'second')
        ancestor=x.leaf['previous_base']['path'];del x.m.raw[ancestor]
        with self.assertRaises((ValueError,KeyError)):x.history()
    def test_retired_pointer_wrong_archive_even_when_repinned_rejected(self):
        x=Chain();x.next_operation();x.publish(x.write_next(),'second')
        cas=json.loads(x.m.raw[x.reader_trusted['publication_CAS']['path']])
        bad=x.m.put('/honest-but-wrong-archive',b'not the parent pointer')
        cas['backup']=bad;x.reader_trusted['publication_CAS']=x.m.doc('wrong-cas',cas)
        with self.assertRaisesRegex(ValueError,'ARCHIVE_BYTES'):x.history()
    def test_child_history_prefix_cannot_drop_or_repeat_parent_delta(self):
        for mode in ('drop','repeat'):
            with self.subTest(mode=mode):
                x=Chain();x.next_operation();written=x.write_next()
                leaf=json.loads(x.m.raw[written['receipt_version']['path']])
                if mode=='drop':leaf['all_actual_bounded_deltas']=leaf['all_actual_bounded_deltas'][1:]
                else:leaf['all_actual_bounded_deltas'].insert(0,leaf['all_actual_bounded_deltas'][0])
                written['receipt_version']=x.m.put(written['receipt_version']['path'],json.dumps(leaf,sort_keys=True).encode())
                x.rebind_synthetic_proposal(written)
                x.publish(written,'second')
                with self.assertRaisesRegex(ValueError,'EXACT_PARENT_HISTORY_PREFIX'):x.history()
    def test_child_v2_parent_without_explicit_selector_rejected(self):
        x=Chain();x.next_operation();written=x.write_next()
        leaf=json.loads(x.m.raw[written['receipt_version']['path']]);del leaf['completed_parent_v2']
        written['receipt_version']=x.m.put(written['receipt_version']['path'],json.dumps(leaf,sort_keys=True).encode())
        x.rebind_synthetic_proposal(written)
        x.publish(written,'second')
        with self.assertRaisesRegex(ValueError,'EXPLICIT_V2_PARENT'):x.history()
    def test_successor_reader_legacy_callback_unchanged(self):
        x=Chain();p=x.m.put(str(Path(reader.__file__).resolve()),Path(reader.__file__).read_bytes())
        r=recurring.create_recurring_reader(reader,approved_reader_pin=p);sentinel=object()
        self.assertIs(r.read_completed_base(x.m.ordinary,x.m.io,legacy_reader=lambda p,io:sentinel),sentinel)
    def test_semantic_unlisted_queue_object_rejected_by_independent_phase(self):
        x=Chain();x.next_operation(queue_mutation=lambda q:q['jobs'].append({'job':999,'status':'accepted'}))
        with self.assertRaisesRegex(AssertionError,'WHOLE_QUEUE_PROJECTION'):x.qualify()
    def test_semantic_unlisted_registry_alias_rejected_by_independent_phase(self):
        x=Chain();x.next_operation(registry_mutation=lambda r:r['images'].__setitem__('foreign',{'sha256':'e'*64}))
        with self.assertRaisesRegex(AssertionError,'WHOLE_REGISTRY_PROJECTION'):x.qualify()
    def test_initial_protected_baseline_cannot_shrink(self):
        x=Chain();x.m.changes['step-1-admission']=lambda a:a['protected']['fullpins'].pop('/app/source.py')
        x.next_operation()
        with self.assertRaisesRegex(ValueError,'INITIAL_ADMISSION_BASELINE_EXACT'):x.qualify()
    def test_repinned_top_CAS_publisher_is_external_identity(self):
        for key in ('owner_thread_id','owner_execution_token'):
            with self.subTest(key=key):
                x=Chain();cas=json.loads(x.m.raw[x.reader_trusted['publication_CAS']['path']]);cas[key]='foreign'
                x.reader_trusted['publication_CAS']=x.m.doc('wrong-publisher-cas',cas)
                with self.assertRaisesRegex(ValueError,'IDENTITY'):x.history()
    def test_default_factory_rechecks_approved_dependency_after_handle_issue(self):
        m=FullMemory(recovery=True)
        cp=m.put(str(Path(core.__file__).resolve()),Path(core.__file__).read_bytes())
        rp=m.put(str(Path(reader.__file__).resolve()),Path(reader.__file__).read_bytes())
        c=recurring.create_recurring_core(core,reader,original_core_pin=cp,approved_reader_pin=rp)
        h=c.prepare_v2(m.descriptor,m.io,trusted=m.trusted,env={'CODEX_THREAD_ID':'root'})
        m.pins[cp['path']]['mtime_ns']+=1
        with self.assertRaisesRegex(ValueError,'END_PIN_RACE'):c.build_candidate_v2(h)
    def test_semantic_PF_nonparticipating_critical_cannot_change_parent_baseline(self):
        x=Chain()
        x.m.changes['step-1-pf']=lambda pf:pf['critical'].__setitem__('/control-extra/0',x.m.source)
        x.next_operation()
        with self.assertRaisesRegex(ValueError,'NEW_PREFLIGHT_EXACT_PUBLISHED_PARENT_BASE'):x.qualify()


if __name__=='__main__':
    unittest.main()
