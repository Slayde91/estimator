"""Synthetic published-base and delegation tests; no private audit fixtures."""
import copy
import ast
import hashlib
import json
import unittest
from pathlib import Path
from pathlib import PureWindowsPath

from estimator import image_checkpoint_v2_reader as reader
from estimator import modern_root_profile_v2_adapter as adapter
from estimator import recurring_v2_checkpoint as history_api
from estimator import image_receipt_lineage as native_reader
from test_image_checkpoint_v2_reader import Memory as PublishedMemory

REGISTRY = r'C:\ESTIMATOR\app\.runtime\reference-library\replicas\index.json'
QUEUE = '/control/1'


def translate(value):
    if isinstance(value,str):
        if value.startswith('/app/'):
            return str(PureWindowsPath('C:/ESTIMATOR/app')/value[5:])
        if value=='/control/0': return REGISTRY
        return value
    if isinstance(value,dict): return {translate(k):translate(v) for k,v in value.items()}
    if isinstance(value,list): return [translate(v) for v in value]
    return value


class Published(PublishedMemory):
    def put(self,path,raw,mtime=None):return super().put(translate(path),raw,mtime)
    def version(self,path):return super().version(translate(path))
    def native(self,path):return super().native(translate(path))
    def doc(self,role,obj,path=None):
        obj=translate(obj)
        if role=='baseline-facts':
            self.inventory_reader=self.put('/approved-inventory',b'approved caller inventory identity')
            self.inventory=dict(reader_fullpin=self.inventory_reader,
                fixed133_seed_map={str(n):'fixed seed' for n in range(133)},explicit_three_saved_projects=['a','b','c'])
            obj['inventory_definition']=self.inventory
        if role in ('baseline-facts','facts'):
            obj['protected_fullpins'][REGISTRY]=copy.deepcopy(self.pins[REGISTRY])
            obj['protected_native6'][REGISTRY]=self.native(REGISTRY)
            obj['inventory_categories'][REGISTRY]='private reference library'
            obj['existing_protected_count']+=1;obj['membership_names']+=1
        if role=='leaf':obj['protected_file_count']+=1
        return super().doc(role,obj,translate(path) if path else None)
    def __init__(self,changes=None):
        super().__init__(changes=changes)
        for key,value in list(vars(self).items()):
            if key not in ('raw','pins','io','changes'):setattr(self,key,translate(value))
        self.protected[REGISTRY]=self.version(REGISTRY)
        self.categories[REGISTRY]='private reference library'


class Fixture:
    def __init__(self):
        self.m=Published();m=self.m;self.calls=[];self.failures=set();self.installed=False;self.strict0=True
        self.before=copy.deepcopy(m.controls);self.after=None;self.backups={};self.phase_nonce='one'
        self.selected=m.put('/selected-private.png',b'prospective selected candidate')
        self.newpath=str(PureWindowsPath('C:/ESTIMATOR/app/.runtime/reference-library/replicas')/(self.selected['sha256']+'.png'))
        self.jobs=[dict(output=dict(path=self.selected['path'],sha256=self.selected['sha256']))]
        self.capture=m.doc('capture-next',dict(schema='capture-schema',primary_pending_seeds=[23],
            all_current_source_ref_prompt_final_native_pins={m.source['path']:m.source}))
        self.history=m.doc('history-next',dict(schema='lineage-schema',targets=[23],entries={'23':dict(selected_private_return=self.selected)}))
        m.docs['capture-next']['modern_retained_lineage']=self.history
        self.capture=m.doc('capture-next',m.docs['capture-next'])
        self.adoption=m.doc('adoption-next',dict(illustration_only=True,technical_approval=False))
        facts=m.docs['facts'];p=dict(fullpins=facts['protected_fullpins'],native_metadata=facts['protected_native6'],
            categories=facts['inventory_categories'],existing_count=facts['existing_protected_count'],missing_fixed_paths=m.missing,
            retained_cache_provenance={p:'retained exact hash with unchanged native' for p in facts['protected_fullpins']},
            inventory_definition=m.inventory,fresh_all_old_bytes_rehashed=False)
        a=dict(schema='admission-schema',result='ROOT_MODERN_CANONICAL_FINITE_SOURCE_PROTECTED_ADMISSION',
            owner_thread_id='receiver',owner_execution_token='current-token',targets=[23],operation_kind='canonical',batch_id='next',work_directory=r'C:\audit\next',
            source_and_protected_preservation_admitted=True,strict_historical_FAIL_preserved=True,no_unlisted_or_future_change_admission=True,
            technical_approval=False,evidence_roles=dict(stable_source_capture=self.capture,modern_retained_lineage=self.history,
                root_private_adoption=self.adoption,fresh_source_protected_qualification=m.facts,
                completed_base_v2_current_scope=m.context),completed_base_v2_current_scope=m.context,
            protected=p,database=dict(current_fullpin=m.db,immutable_raw_fullpin=m.db,typed_state=m.state),
            source=dict(head=m.git['head'],tree=m.git['tree'],clean=True,worktree_fullpins={m.source['path']:m.source},tracked_count=1,producer_release_fullpin=None),
            controls=m.controls,policy_members=m.policies,active_policy_index=m.policy_index,
            completed_base=dict(checkpoint=m.leaf,outer0=m.root_outer,pointer=m.pointer,six_controls=m.controls),
            PRIMARY=m.put('/PRIMARY',b'unchanged installer'))
        for k in ('actual_manifest','actual_preflight','actual_acceptance','actual_install','actual_LIVE','actual_checkpoint'):a[k]=None
        self.admission=m.doc('admission-next',a);self.a=a
        config=dict(owner_thread_id='receiver',owner_execution_token='current-token',targets=[23],operation_kind='canonical',
            batch_id='next',work_directory=r'C:\audit\next',completed_base_v2_current_scope=m.context,
            controls=dict(owner=m.owner,automation=m.automation),
            individual_root_reviews={'23':dict(adoption_key='23',review=self.adoption)})
        self.context=dict(config=config,root='receiver',token='current-token',owner_pin=m.owner)
        def pinned(pin,io):
            adapter.need(io['version'](pin['path'])==pin,'PHYSICAL_PIN')
            raw=io['bytes'](pin['path']);adapter.need(hashlib.sha256(raw).hexdigest()==pin['sha256'],'PHYSICAL_BYTES')
            io['_participation'][pin['path']]=copy.deepcopy(pin);return raw
        self.helpers=dict(__file__=m.typed['path'],document=lambda pin,io:json.loads(pinned(pin,io)),pinned=pinned,
            typed_bytes=m.typed_bytes,HARD_HELD={99},MUTABLE_CURRENT_CONTROLS={REGISTRY,QUEUE},
            normal_current_phase=self.phase,normal_observation=self.observe)
        def called(name,check=lambda *args:True,result=None):
            def fn(*args):
                self.calls.append(name);adapter.need(check(*args),'DELEGATED_'+name)
                adapter.need(name not in self.failures,'DELEGATED_'+name)
                return result
            return fn
        def targets(c,held):
            self.calls.append('targets');adapter.need(c['targets']==[23] and not set(c['targets'])&held,'TARGETS');return c['targets']
        self.original=dict(__file__='/approved-profile',need=adapter.need,amr_current=lambda c:c.get('accepted_revision',False),
            ADMISSION_SCHEMA='admission-schema',CAPTURE_SCHEMA='capture-schema',LINEAGE_SCHEMA='lineage-schema',PRIMARY_SHA=a['PRIMARY']['sha256'],
            targets=targets,current_policy_scope=called('policy',lambda ctx,a,cap,io,h:a['policy_members']==m.policies),
            normal_database_declaration=called('db_declaration'),lineage_views=called('lineage',result={'23':'verified native attempt'}),
            source_union=called('union',result={'complete':'source'}),project=called('project',result=(self.jobs,{'23':'prompt'},{'23':self.selected})),
            database_guard=called('database'),source_guard=self.source_guard,protected_guard=self.protected_guard,
            admitted_base=called('admitted_base'),qualify=called('legacy',result='exact legacy result'))
        self.profile_pin=m.put('/approved-profile',b'approved original profile')
        self.reader_pin=m.put(reader.__file__,Path(reader.__file__).read_bytes())
        self.binding=dict(profile_pin=self.profile_pin,reader_pin=self.reader_pin,trusted=m.trusted,
            inventory_reader_pin=m.inventory_reader,inventory_callback=lambda definition:(copy.deepcopy(m.categories),list(m.missing)),
            source_membership=lambda:list(m.members),history_module=None,history_module_pin=None)

    def phase(self,jobs=None):
        if not self.installed:return None
        adapter.need(self.strict0 and (jobs is None or jobs==self.jobs),'REAL_STRICT_PHASE')
        adapter.need(all(self.m.version(p)==v for p,v in self.after.items()),'WHOLE_CONTROL_PROJECTION')
        adapter.need(self.m.version(self.newpath)['sha256']==self.selected['sha256'],'WHOLE_RUNTIME_PROJECTION')
        return dict(result='PASS_EXACT_PHASE_AND_REVIEWED_EVIDENCE',phase='installed_with_actual_completion',
            current_control_versions=self.after,nonce=self.phase_nonce)

    def observe(self,pin,io):
        if self.installed and pin['path'] in (REGISTRY,QUEUE):
            self.phase();adapter.need(pin==self.before[pin['path']],'BEFORE_CONTROL_SLOT')
            backup=self.backups[pin['path']]
            adapter.need(backup['path']!=pin['path'] and all(backup[k]==pin[k] for k in ('bytes','mtime_ns','sha256')),
                         'BEFORE_BACKUP_BIJECTION')
            return self.helpers['pinned'](backup,io)
        return self.helpers['pinned'](pin,io)

    def source_guard(self,q,io,mutable_ok):
        self.calls.append('source');self.phase(q['projected_jobs'])
        adapter.need('source' not in self.failures,'DELEGATED_source')
        for path,pin in self.before.items():
            if not self.installed or path not in (REGISTRY,QUEUE):adapter.need(io['version'](path)==pin,'SOURCE_CONTROL_UNLISTED')
        return {'source':'checked'}

    def protected_guard(self,q,io,mutable_ok,added):
        self.calls.append('protected');self.phase(q['projected_jobs'])
        adapter.need('protected' not in self.failures,'DELEGATED_protected')
        expected=dict(q['protected_categories']);expected.update({p:'private reference library' for p in added})
        adapter.need(io['inventory']()==(expected,self.m.missing),'EXACT_MEMBERSHIP')
        for path,native in q['protected_native'].items():
            if path not in mutable_ok:adapter.need(io['native'](path)==native,'PROTECTED_NATIVE')
        for path,pin in added.items():adapter.need(io['version'](path)==pin,'EXACT_NEW_RUNTIME')
        return {'protected':'checked'}

    def qualify(self):
        return adapter.qualify_optional_v2(self.context,self.admission,self.admission,self.m.io,self.helpers,
            original=self.original,reader=reader,binding=self.binding,env={'CODEX_THREAD_ID':'receiver'})

    def revise_admission(self,change):
        self.a=copy.deepcopy(self.a);change(self.a);self.admission=self.m.doc('admission-next',self.a)

    def install(self):
        self.preflight_path=str(PureWindowsPath(self.context['config']['work_directory'])/'PREFLIGHT.json')
        self.m.doc('prospective-preflight',dict(critical=self.before),path=self.preflight_path)
        for path in (REGISTRY,QUEUE):
            self.backups[path]=self.m.clone(self.before[path],'/prospective-before/'+('registry' if path==REGISTRY else 'queue'))
        self.after=copy.deepcopy(self.before)
        for path in (REGISTRY,QUEUE):self.after[path]=self.m.put(path,b'actual prospective-operation projection '+path.encode())
        self.m.put(self.newpath,self.m.raw[self.selected['path']]);self.m.categories[self.newpath]='private reference library'
        self.installed=True
        self.binding['history_module']=history_api
        self.binding['history_module_pin']=self.m.put(history_api.__file__,Path(history_api.__file__).read_bytes())


ORIGINAL_COMPLETED_BASE_BLOCK = "if 'completed_recovery_bridge' in a:\n    leaf, outer, pointer = normal_completed_bridge(a, c, io, helpers)\nelse:\n    cp = a['completed_base']\n    leaf, outer, pointer, child = (doc(cp[k], io) for k in ('checkpoint', 'outer0', 'pointer', 'actual_process_completion'))\n    need(leaf['result'] == 'PASS' and leaf['schema'] == 'STABLE_REVIEWED_IMAGE_BATCH_COMPACT_V1' and (leaf['current_critical_versions'] == cp['six_controls']) and (pointer['latest_completed_receipt'] == cp['checkpoint']) and (pointer['actual_checkpoint_root_outer0'] == cp['outer0']) and (outer['receipt_version'] == cp['checkpoint']) and (outer['actual_exit_code'] == 0) and (outer['actual_native_completion_receipt'] == cp['actual_process_completion']) and (cp['actual_native_completion'] is None) and (cp['actual_tool_completion'] == dict(chunk=outer['actual_completion_chunk'], exec_session=outer['actual_exec_session'], exit_code=0)) and (child['actual_exit_code'] == 0) and (json.loads(child['stdout'])['compact_receipt'] == cp['checkpoint']), 'COMPLETED_BASE_LITERAL_ROLES')\n    need(all((k in leaf for k in ('three_prior_runtime_creation_versions', 'cumulative_new_runtime_creation_versions', 'all_actual_bounded_deltas'))), 'COMPLETED_BASE_CHAIN')"


class NormalProfileTests(unittest.TestCase):
    def test_initial_fresh_profile_preserves_all_delegated_gates(self):
        f=Fixture();q=f.qualify()
        self.assertEqual(q['leaf']['schema'],reader.COMPACT_SCHEMA)
        self.assertEqual(q['v2_baseline_mode'],'FULL_FRESH_PUBLISHED_V2_BASE')
        for gate in ('targets','policy','db_declaration','lineage','union','project','database','source','protected'):
            self.assertIn(gate,f.calls)
        self.assertNotIn('legacy',f.calls)
    def test_default_legacy_delegation_exact(self):
        f=Fixture();f.context['config'].pop(adapter.OPTIONAL_ROLE)
        api=adapter.create_profile_adapter(f.original,reader)
        self.assertEqual(api['qualify'](f.context,f.admission,f.admission,f.m.io,f.helpers),'exact legacy result')
        self.assertEqual(f.calls,['legacy'])
    def test_explicit_role_disabled_without_external_binding(self):
        f=Fixture();api=adapter.create_profile_adapter(f.original,reader)
        with self.assertRaisesRegex(ValueError,'DISABLED_WITHOUT'):api['qualify'](f.context,f.admission,f.admission,f.m.io,f.helpers)
        self.assertEqual(f.calls,[])
    def test_accepted_revision_delegation_exact(self):
        f=Fixture();f.context['config']['accepted_revision']=True
        api=adapter.create_profile_adapter(f.original,reader)
        self.assertEqual(api['qualify'](f.context,f.admission,f.admission,f.m.io,f.helpers),'exact legacy result')
        self.assertEqual(f.calls,['legacy'])
    def test_unapproved_profile_bytes_rejected_before_delegated_policy(self):
        f=Fixture();f.m.put('/approved-profile',b'changed code')
        with self.assertRaisesRegex(ValueError,'PIN_BEFORE'):f.qualify()
        self.assertNotIn('policy',f.calls)
    def test_after_apply_uses_real_history_and_existing_phase_projections(self):
        f=Fixture();f.install()
        with self.assertRaises(ValueError):f.m.read()  # strict fresh-before reader must fail on changed Q/RI/runtime
        q=f.qualify()
        self.assertEqual(q['v2_baseline_mode'],'DATED_PUBLISHED_V2_PLUS_SEPARATE_CURRENT_OPERATION_PHASE')
        self.assertEqual(q['leaf']['schema'],reader.COMPACT_SCHEMA)
        self.assertEqual(q['leaf']['previous_base'],f.m.ordinary)
        self.assertEqual(q['leaf']['intervening_completed_recoveries'][0]['historical_apply_exit_code'],1)
        self.assertIn('protected',f.calls)
        self.assertIn(f.newpath,f.m.categories)
    def test_after_apply_missing_strict_zero_rejected(self):
        f=Fixture();f.install();f.strict0=False
        with self.assertRaisesRegex(ValueError,'REAL_STRICT_PHASE'):f.qualify()
    def test_after_apply_unknown_control_change_rejected(self):
        f=Fixture();f.install();f.m.put('/control/2',b'unknown change')
        with self.assertRaisesRegex(ValueError,'WHOLE_CONTROL'):f.qualify()
    def test_after_apply_unknown_inventory_file_rejected(self):
        f=Fixture();f.install();f.m.put('/extra-protected',b'extra');f.m.categories['/extra-protected']='private reference library'
        with self.assertRaisesRegex(ValueError,'EXACT_MEMBERSHIP'):f.qualify()
    def test_after_apply_source_native_drift_rejected(self):
        f=Fixture();f.install();f.m.put(f.m.source['path'],b'unknown source')
        with self.assertRaisesRegex(ValueError,'NATIVE_SCOPE'):f.qualify()
    def test_after_apply_DB_drift_rejected(self):
        f=Fixture();f.install();f.m.put('/database',b'unknown DB')
        with self.assertRaisesRegex(ValueError,'PIN_BEFORE'):f.qualify()
    def test_after_apply_policy_drift_rejected(self):
        f=Fixture();f.install();f.m.put('/policy/0',b'unknown policy')
        with self.assertRaisesRegex(ValueError,'PIN_BEFORE'):f.qualify()
    def test_after_apply_pointer_drift_rejected(self):
        f=Fixture();f.install();f.m.put('/current',b'unknown pointer')
        with self.assertRaisesRegex(ValueError,'PIN_BEFORE'):f.qualify()
    def test_history_module_required_after_apply(self):
        f=Fixture();f.install();f.binding['history_module']=None
        with self.assertRaisesRegex(ValueError,'APPROVED_SHARED_V2_HISTORY'):f.qualify()
    def test_changed_history_module_bytes_rejected(self):
        f=Fixture();f.install();f.m.put(history_api.__file__,b'changed history code')
        with self.assertRaisesRegex(ValueError,'PIN_BEFORE'):f.qualify()
    def test_all_original_verifier_errors_propagate(self):
        for gate in ('policy','db_declaration','lineage','project','database','source','protected'):
            with self.subTest(gate=gate):
                f=Fixture();f.failures.add(gate)
                with self.assertRaisesRegex(ValueError,'DELEGATED_'+gate):f.qualify()
    def test_admission_schema_not_bypassed(self):
        f=Fixture();f.revise_admission(lambda a:a.__setitem__('schema','wrong'))
        with self.assertRaisesRegex(ValueError,'ADMISSION_SCHEMA'):f.qualify()
    def test_admission_future_install_field_stays_null(self):
        f=Fixture();f.revise_admission(lambda a:a.__setitem__('actual_install',{}))
        with self.assertRaisesRegex(ValueError,'FUTURE_FIELDS_NULL'):f.qualify()
    def test_finite_preservation_judgment_required(self):
        f=Fixture();f.revise_admission(lambda a:a.__setitem__('source_and_protected_preservation_admitted',False))
        with self.assertRaisesRegex(ValueError,'FINITE_JUDGMENT'):f.qualify()
    def test_engineering_approval_not_inferred(self):
        f=Fixture();f.revise_admission(lambda a:a.__setitem__('technical_approval',True))
        with self.assertRaisesRegex(ValueError,'FINITE_JUDGMENT'):f.qualify()
    def test_receiving_identity_required(self):
        f=Fixture();f.context['token']='foreign'
        with self.assertRaisesRegex(ValueError,'RECEIVING_IDENTITY'):f.qualify()
    def test_exact_batch_and_work_scope(self):
        f=Fixture();f.revise_admission(lambda a:a.__setitem__('work_directory',r'C:\other'))
        with self.assertRaisesRegex(ValueError,'EXACT_FINITE_SCOPE'):f.qualify()
    def test_hard_held_target_rejected(self):
        f=Fixture();f.helpers['HARD_HELD'].add(23)
        with self.assertRaisesRegex(ValueError,'TARGETS'):f.qualify()
    def test_missing_evidence_role_rejected(self):
        f=Fixture();f.revise_admission(lambda a:a['evidence_roles'].pop('root_private_adoption'))
        with self.assertRaisesRegex(ValueError,'EVIDENCE_ROLES'):f.qualify()
    def test_actual_primary_pin_required(self):
        f=Fixture();f.m.put('/PRIMARY',b'changed installer')
        with self.assertRaisesRegex(ValueError,'PHYSICAL_PIN'):f.qualify()
    def test_current_root_review_binding_required(self):
        f=Fixture();f.context['config']['individual_root_reviews']['23']['review']={}
        with self.assertRaisesRegex(ValueError,'CURRENT_ROOT_REVIEW_BINDINGS'):f.qualify()
    def test_unknown_trusted_role_alias_rejected(self):
        f=Fixture();f.binding['extra_unreviewed']=True
        with self.assertRaisesRegex(ValueError,'EXTERNAL_V2_PROFILE_BINDING'):f.qualify()
    def test_reader_pin_cannot_be_self_selected_by_data(self):
        f=Fixture();f.binding['reader_pin']=dict(f.binding['reader_pin'],path='/other-reader')
        with self.assertRaisesRegex(ValueError,'APPROVED_PROFILE_READER_PATH'):f.qualify()
    def test_original_inventory_rule_exact(self):
        f=Fixture();f.revise_admission(lambda a:a['protected']['inventory_definition'].__setitem__('reader_fullpin',{}))
        with self.assertRaisesRegex(ValueError,'ACTUAL_ORIGINAL_INVENTORY_READER'):f.qualify()
    def test_after_apply_wrong_before_backup_rejected(self):
        f=Fixture();f.install();f.backups[REGISTRY]=f.backups[QUEUE]
        with self.assertRaisesRegex(ValueError,'BEFORE_BACKUP_BIJECTION'):f.qualify()
    def test_after_apply_unrelated_runtime_file_rejected(self):
        f=Fixture();f.install();f.m.put(f.newpath,b'wrong image')
        with self.assertRaisesRegex(ValueError,'WHOLE_RUNTIME_PROJECTION'):f.qualify()
    def test_unapproved_typed_callback_identity_rejected(self):
        f=Fixture();f.helpers['__file__']='/other-typed-reader'
        with self.assertRaisesRegex(ValueError,'ACTUAL_APPROVED_TYPED_HELPER'):f.qualify()
    def test_approved_code_pins_join_qualification_participation(self):
        f=Fixture();q=f.qualify()
        for pin in (f.profile_pin,f.reader_pin,f.m.inventory_reader,f.m.typed):
            self.assertEqual(q['participation_versions'][pin['path']],pin)
    def test_history_code_pin_joins_after_apply_participation(self):
        f=Fixture();f.install();q=f.qualify();pin=f.binding['history_module_pin']
        self.assertEqual(q['participation_versions'][pin['path']],pin)
    def test_config_automation_must_match_fresh_current_context(self):
        f=Fixture();f.context['config']['controls']['automation']={}
        with self.assertRaisesRegex(ValueError,'V2_CURRENT_AUTOMATION_OWNER_BINDING'):f.qualify()
    def test_postphase_preflight_cannot_claim_other_parent_controls(self):
        f=Fixture();f.install();critical=copy.deepcopy(f.before)
        critical['/control/2']=dict(critical['/control/2'],sha256='0'*64)
        f.m.doc('prospective-preflight',dict(critical=critical),path=f.preflight_path)
        with self.assertRaisesRegex(ValueError,'V2_ACTUAL_PREFLIGHT_CAUSAL_PARENT_CONTROLS'):f.qualify()
    def test_modern_generic_gate_AST_preserved_except_three_resolution_regions(self):
        tree=ast.parse(Path(adapter.__file__).read_text(encoding='utf8'))
        f=copy.deepcopy(next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_qualify_v2_core'))
        f.name='_cst_current_source_qualify';f.args.args=f.args.args[:-4];f.args.defaults=[]
        body=[]
        for node in f.body:
            if isinstance(node,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='snapshot' for x in node.targets):continue
            if isinstance(node,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='expected_native' for x in node.targets):
                node=ast.parse('expected_native = normal_fresh_scope(a,c,fresh,io,helpers)').body[0]
            if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Tuple) and [getattr(x,'id',None) for x in node.targets[0].elts]==['leaf','outer','pointer']:
                body.extend(ast.parse(ORIGINAL_COMPLETED_BASE_BLOCK).body);continue
            if isinstance(node,ast.Return):node.value=ast.Name(id='result',ctx=ast.Load())
            body.append(node)
        f.body=body
        class Reverse(ast.NodeTransformer):
            def visit_Subscript(self,node):
                if isinstance(node.value,ast.Name) and isinstance(node.slice,ast.Constant):
                    if node.value.id=='original':return ast.copy_location(ast.Name(id=node.slice.value,ctx=ast.Load()),node)
                    if node.value.id=='snapshot' and node.slice.value=='policy_members':
                        return ast.copy_location(ast.parse('canonical_current_source_policy_members(a,c,fresh,io,helpers)',mode='eval').body,node)
                return self.generic_visit(node)
        restored=ast.fix_missing_locations(Reverse().visit(f))
        self.assertEqual(hashlib.sha256(ast.dump(restored,include_attributes=False).encode()).hexdigest(),adapter.ORIGINAL_QUALIFY_AST_SHA256)
    def test_current_reader_gate_AST_preserved_except_explicit_physical_phase_resolution(self):
        tree=ast.parse(Path(adapter.__file__).read_text(encoding='utf8'))
        f=copy.deepcopy(next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_phase_current_scope'))
        f.name='_current_scope';f.args.args=f.args.args[:-3]
        class Reverse(ast.NodeTransformer):
            inventory=0
            def visit_Subscript(self,node):
                if isinstance(node.value,ast.Name) and node.value.id=='reader' and isinstance(node.slice,ast.Constant):
                    return ast.copy_location(ast.Name(id=node.slice.value,ctx=ast.Load()),node)
                return self.generic_visit(node)
            def visit_For(self,node):
                if isinstance(node.target,ast.Tuple) and [getattr(x,'id',None) for x in node.target.elts]==['path','pin']:
                    if ast.unparse(node.iter)=='pins.items()':
                        node.body=[node.body[0],ast.parse('o.native(path,pin,natives[path])').body[0]]
                    elif ast.unparse(node.iter)=='mapping.items()':
                        node.body=[node.body[0],ast.parse('o.pinned(pin)').body[0]]
                return self.generic_visit(node)
            def visit_Expr(self,node):
                if isinstance(node.value,ast.Constant) and node.value.value=='Membership is enforced by unchanged original protected_guard before qualification returns.':
                    self.inventory+=1;code='CURRENT_INVENTORY' if self.inventory==1 else 'END_INVENTORY'
                    return ast.parse("need(o.io['inventory'](facts['inventory_definition']) == (categories,missing),"+repr(code)+')').body[0]
                return self.generic_visit(node)
        restored=ast.fix_missing_locations(Reverse().visit(f))
        self.assertEqual(hashlib.sha256(ast.dump(restored,include_attributes=False).encode()).hexdigest(),adapter.ORIGINAL_READER_CURRENT_SCOPE_AST_SHA256)


def standard_historical_source(current_bytes):
    """Source-only historical code fixture; no file/version restoration."""
    source=current_bytes.decode('utf8');lines=source.splitlines(keepends=True);tree=ast.parse(source)
    private=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_private_disposition')
    added={n.lineno-1 for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and
           x.id in ('RUN17_FAMILY','RUN19_FAMILY') for x in n.targets)}
    prefix=''.join(line for i,line in enumerate(lines[:private.lineno-1]) if i not in added).rstrip('\n')
    public=next(n for n in reversed(tree.body) if isinstance(n,ast.FunctionDef) and n.name=='read_native_attempt')
    dispatch=next(n for n in ast.walk(public) if isinstance(n,ast.If))
    wrapper=''.join(line for i,line in enumerate(lines[public.lineno-1:public.end_lineno],public.lineno)
                    if not dispatch.lineno<=i<=dispatch.end_lineno)
    historical=(prefix+'\n\n\n'+wrapper).encode('utf8')
    assert hashlib.sha256(historical).hexdigest()==adapter.PREVIOUS_STANDARD_READER_SHA
    return historical


class StandardReleaseFixture:
    def __init__(self):
        self.f=Fixture();m=self.f.m;self.m=m;self.io=dict(m.io,_participation={})
        new=Path(native_reader.__file__).read_bytes();old=standard_historical_source(new)
        self.pin=m.put(native_reader.__file__,new);self.old=m.put('/software-archive/standard-before.py',old)
        self.proof=m.doc('standard-ast-proof',dict(schema='DATA_ONLY_STANDARD_NATIVE_READER_RELEASE_GATE_REPRO_AND_AST_COMPARISON_V1',
            actual_current_APP_reader=self.pin,old_reader_honest_archive=self.old,all_internal_ASTs_equal=True,
            standard_public_wrapper_AST_equal_after_removing_only_literal_family_dispatch=True))
        self.merge=m.doc('standard-merge',dict(schema='ROOT_ACTUAL_PR285_ALL_CI_PASS_AND_MERGE_VERIFIED_V1',
            implementation_head='a'*40,actual_merge_result=dict(merged=True,sha='b'*40),
            actual_postmerge_fields=dict(merged=True,merge_commit_sha='b'*40,head_sha='a'*40),verified_origin_main='b'*40,
            actual_fetch_exit_code=0,actual_ancestry_verification_exit_code=0,
            verified_changed_paths=['estimator/image_receipt_lineage.py','tests/test_image_receipt_lineage.py'],
            actual_workflow_runs_for_exact_head=dict(workflow_runs=[dict(head_sha='a'*40,status='completed',conclusion='success')]),
            actual_jobs=[dict(name=n,status='completed',conclusion='success') for n in ('verify','windows-desktop','takeoff-browser')]))
        self.activation=m.doc('standard-activation',dict(schema='ROOT_ACTUAL_PR285_NARROW_LIVE_CHECKOUT_ACTIVATION_NOT_IMAGE_ADMISSION_V1',
            actual_merge_evidence=self.merge,source_clean=True,actual_new_code_fullpins={'estimator/image_receipt_lineage.py':self.pin},
            other1166_source_native6_unchanged=True,all7534_protected_native6_unchanged=True,image_calls=0,
            image_selection_acceptance_installation=0,technical_approval=False))
        self.release=dict(reader=self.pin,old_archive=self.old,merge=self.merge,activation=self.activation,ast_proof=self.proof)
        approval=dict(schema='ROOT_APPROVED_KNOWN_STANDARD_NATIVE_READER_RELEASE_V1',root_code_release_admitted=True,
            owner_thread_id='receiver',owner_execution_token='current-token',
            future_code_releases_authorized=False,technical_approval=False,**self.release)
        self.release['approval']=m.doc('standard-approval',approval)
        history=dict(schema='standard-history-schema',targets=[23],entries={'23':dict(run_accounting=m.doc('standard-accounting',
            dict(owner_thread_id='wrong-owner')),attempts=[dict(receipt_family='standard-native-family',native_reader_binding={})])})
        c=dict(native_generation_reader=self.pin,approved_standard_native_reader_release_v1=self.release['approval'])
        a=dict(targets=[23],native_generation_reader=self.pin,approved_standard_native_reader_release_v1=self.release['approval'],
            evidence_roles={adapter.STANDARD_RELEASE_ROLE:self.release['approval']})
        self.q=dict(objects=dict(modern_retained_lineage=history,stable_source_capture=dict(native_generation_reader=self.pin)),
            admission=a,context=dict(config=c,root='receiver',token='current-token'),helpers=self.f.helpers)
        self.original=dict(self.f.original,LINEAGE_SCHEMA='standard-history-schema',_NATIVE_GENERATION_FAMILY='standard-native-family')


class StandardReleaseTests(unittest.TestCase):
    def test_known_release_source_only_AST_proof(self):
        new=Path(native_reader.__file__).read_bytes();old=standard_historical_source(new)
        self.assertEqual(hashlib.sha256(new).hexdigest(),adapter.APPROVED_STANDARD_READER_SHA)
        self.assertTrue(adapter.standard_api_ast_equivalent(old,new))
    def test_known_release_validates_without_changing_default_reader(self):
        f=StandardReleaseFixture()
        self.assertEqual(adapter.validate_standard_release(f.q,f.io,f.original,f.release),f.pin)
    def test_standard_release_requires_current_root_and_execution_token(self):
        for field in ('owner_thread_id','owner_execution_token'):
            for value in (None,'another-owner-or-execution'):
                with self.subTest(field=field,value=value):
                    f=StandardReleaseFixture();approval=copy.deepcopy(f.m.docs['standard-approval'])
                    if value is None:approval.pop(field)
                    else:approval[field]=value
                    f.release['approval']=f.m.doc('standard-approval',approval)
                    f.q['context']['config'][adapter.STANDARD_RELEASE_ROLE]=f.release['approval']
                    f.q['admission'][adapter.STANDARD_RELEASE_ROLE]=f.release['approval']
                    f.q['admission']['evidence_roles'][adapter.STANDARD_RELEASE_ROLE]=f.release['approval']
                    with self.assertRaisesRegex(ValueError,'STANDARD_RELEASE_CURRENT_ROOT_IDENTITY'):
                        adapter.validate_standard_release(f.q,f.io,f.original,f.release)
    def test_standard_lineage_keeps_original_closed_budget_owner_guard(self):
        f=StandardReleaseFixture()
        with self.assertRaisesRegex(ValueError,'NATIVE_CLOSED_BUDGET_OWNER'):
            adapter.lineage_views_with_standard_release(f.q,f.io,f.original,f.release)
    def test_standard_release_rejects_any_literal_selector_including_None(self):
        for family in (None,'RUN17_LITERAL_SINGLE_V1','RUN19_LITERAL_GROUP_RESERVATION_V1','unknown'):
            with self.subTest(family=family):
                f=StandardReleaseFixture();f.q['objects']['modern_retained_lineage']['entries']['23']['attempts'][0]['native_reader_binding']['literal_family']=family
                with self.assertRaisesRegex(ValueError,'STANDARD_RELEASE_REJECTS_LITERAL'):
                    adapter.lineage_views_with_standard_release(f.q,f.io,f.original,f.release)
    def test_absent_release_role_delegates_original_literal_default_route(self):
        f=StandardReleaseFixture();f.q['context']['config'].pop(adapter.STANDARD_RELEASE_ROLE)
        self.assertEqual(adapter.lineage_views_with_standard_release(f.q,f.io,f.original,None),{'23':'verified native attempt'})
    def test_accepted_revision_delegates_original(self):
        f=StandardReleaseFixture();f.original['amr_current']=lambda c:True
        self.assertEqual(adapter.lineage_views_with_standard_release(f.q,f.io,f.original,None),{'23':'verified native attempt'})
    def test_arbitrary_reader_release_rejected(self):
        f=StandardReleaseFixture();f.release['reader']=dict(f.pin,sha256='0'*64)
        with self.assertRaisesRegex(ValueError,'ROOT_EXPLICIT_KNOWN_STANDARD_RELEASE|EXACT_KNOWN_STANDARD_READER'):
            adapter.validate_standard_release(f.q,f.io,f.original,f.release)
    def test_unmerged_or_failed_CI_release_rejected(self):
        for change in ('merged','ci'):
            f=StandardReleaseFixture();body=copy.deepcopy(f.m.docs['standard-merge'])
            if change=='merged':body['actual_merge_result']['merged']=False
            else:body['actual_jobs'][0]['conclusion']='failure'
            f.release['merge']=f.m.doc('standard-merge',body)
            approval=copy.deepcopy(f.m.docs['standard-approval']);approval['merge']=f.release['merge']
            f.release['approval']=f.m.doc('standard-approval',approval)
            f.q['context']['config'][adapter.STANDARD_RELEASE_ROLE]=f.release['approval']
            f.q['admission'][adapter.STANDARD_RELEASE_ROLE]=f.release['approval']
            f.q['admission']['evidence_roles'][adapter.STANDARD_RELEASE_ROLE]=f.release['approval']
            with self.assertRaisesRegex(ValueError,'ACTUAL_MERGED|ALL_EXACT_RELEASE_CI'):
                adapter.validate_standard_release(f.q,f.io,f.original,f.release)
    def test_standard_lineage_AST_only_changes_known_code_pin_resolution(self):
        tree=ast.parse(Path(adapter.__file__).read_text(encoding='utf8'))
        f=copy.deepcopy(next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_standard_release_lineage_views'))
        f.name='lineage_views';f.args.args=f.args.args[:-1]
        class Restore(ast.NodeTransformer):
            def visit_Name(self,node):
                if isinstance(node.ctx,ast.Load) and node.id=='APPROVED_STANDARD_READER_SHA':
                    return ast.copy_location(ast.Name(id='_NATIVE_READER_SHA',ctx=ast.Load()),node)
                return node
            def visit_Subscript(self,node):
                if isinstance(node.value,ast.Name) and node.value.id=='original' and isinstance(node.slice,ast.Constant):
                    return ast.copy_location(ast.Name(id=node.slice.value,ctx=ast.Load()),node)
                return self.generic_visit(node)
        restored=ast.fix_missing_locations(Restore().visit(f))
        self.assertEqual(hashlib.sha256(ast.dump(restored,include_attributes=False).encode()).hexdigest(),
                         adapter.ORIGINAL_STANDARD_LINEAGE_AST_SHA256)


if __name__=='__main__':unittest.main()
