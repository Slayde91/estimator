"""Private generic optional V2 normal-profile adapter. Disabled without binding.
Frozen producer modules remain untouched. This prototype reuses their pure
gates; it cannot select, accept, install, publish CURRENT or write a checkpoint.
"""
import ast
import copy
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import subprocess
import tomllib

OPTIONAL_ROLE = 'completed_base_v2_current_scope'
DEFAULT_ENABLED = False
ORIGINAL_QUALIFY_AST_SHA256 = '201bb3e3c668d5e69439024fd2a3d177cdc442dda8eff4dcb37f87fcb3e57199'


def need(value, code):
    if not value: raise ValueError(code)


def namespace(module):
    return module if isinstance(module, dict) else vars(module)


def create_profile_adapter(original_profile, approved_reader, *, binding=None, standard_release=None):
    original, reader = namespace(original_profile), namespace(approved_reader)
    result = {k: original[k] for k in ('source_guard','protected_guard','database_guard','admitted_base')}
    def qualify(context, admission_pin, expected_admission_pin, io, helpers):
        if context['config'].get(OPTIONAL_ROLE) is None or original['amr_current'](context['config']):
            return original['qualify'](context, admission_pin, expected_admission_pin, io, helpers)
        need(binding is not None, 'V2_NORMAL_PROFILE_DISABLED_WITHOUT_EXTERNAL_BINDING')
        return qualify_optional_v2(context, admission_pin, expected_admission_pin, io, helpers,
            original=original,reader=reader,binding=binding,standard_release=standard_release)
    result['qualify'] = qualify
    return result


def original_inventory_callback(expected_pin, io, app_root):
    """Only caller-approved original inventory code, three inspected definitions."""
    need(io['version'](expected_pin['path']) == expected_pin, 'APPROVED_INVENTORY_PIN')
    raw = io['bytes'](expected_pin['path'])
    need(len(raw) == expected_pin['bytes'] and hashlib.sha256(raw).hexdigest() == expected_pin['sha256'],
         'APPROVED_INVENTORY_BYTES')
    definitions = [n for n in ast.parse(raw).body if isinstance(n,ast.FunctionDef)
                   and n.name in ('require','safe','inventory')]
    need([n.name for n in definitions] == ['require','safe','inventory'], 'ORIGINAL_INVENTORY_DEFINITIONS')
    ns = dict(Path=Path,os=os,APP=Path(app_root),__name__='approved_original_inventory_definitions')
    exec(compile(ast.Module(body=definitions,type_ignores=[]),expected_pin['path'],'exec'),ns)
    need(io['version'](expected_pin['path']) == expected_pin, 'INVENTORY_LOAD_END')
    def inventory(definition):
        need(definition['reader_fullpin'] == expected_pin and len(definition['fixed133_seed_map']) == 133,
             'EXACT_ORIGINAL_133_INVENTORY')
        return ns['inventory'](None,definition['fixed133_seed_map'])
    return inventory


def actual_source_membership(app_root):
    raw = subprocess.run(['git','--no-optional-locks','-C',str(app_root),'ls-files','-z'],
                         check=True,capture_output=True).stdout
    return [str(Path(app_root)/relative) for relative in raw.decode('utf8').split('\0') if relative]


def _bound_io(context,a,c,io,helpers,original,reader,binding):
    need(type(binding) is dict and set(binding) == {'profile_pin','reader_pin','trusted',
         'inventory_reader_pin','inventory_callback','source_membership','history_module','history_module_pin'},
         'EXTERNAL_V2_PROFILE_BINDING')
    trust = copy.deepcopy(binding['trusted'])
    observation = reader['Observation'](io)
    for role,ns in [('profile_pin',original),('reader_pin',reader)]:
        need(ns.get('__file__') == binding[role]['path'], 'APPROVED_PROFILE_READER_PATH')
        observation.pinned(binding[role])
    need(a.get(OPTIONAL_ROLE) == c.get(OPTIONAL_ROLE) == a['evidence_roles'].get(OPTIONAL_ROLE) ==
         trust['current_context'] and trust['current_context'] is not None, 'EXACT_V2_OPTIONAL_ROLE')
    need(a['completed_base']['checkpoint'] == trust['leaf'] and a['completed_base']['outer0'] == trust['root_outer0'] and
         a['completed_base']['pointer'] == trust['current_pointer'] and context['owner_pin'] == trust['owner_pin'] and
         context['root'] == trust['root'] and context['token'] == trust['token'], 'V2_RECEIVING_BASE_BINDINGS')
    typed_pin = trust['approved_dependencies']['typed_reader']
    need(helpers.get('__file__') == typed_pin['path'], 'ACTUAL_APPROVED_TYPED_HELPER')
    observation.pinned(typed_pin); observation.pinned(binding['inventory_reader_pin'])
    need(a['protected']['inventory_definition']['reader_fullpin'] == binding['inventory_reader_pin'],
         'ACTUAL_ORIGINAL_INVENTORY_READER')
    need(callable(binding['inventory_callback']) and callable(binding['source_membership']), 'APPROVED_ACTUAL_IO_CALLBACKS')
    participation = io['_participation']
    for path,pin in observation.pins.items():
        need(path not in participation or participation[path] == pin, 'V2_APPROVED_CODE_PARTICIPATION')
        participation[path] = copy.deepcopy(pin)
    def observed_version(path):
        version = io['version'](path)
        need(path not in participation or participation[path] == version, 'V2_PARTICIPANT_ADVANCED')
        participation[path] = copy.deepcopy(version)
        return version
    def inventory(definition=None):
        definition = a['protected']['inventory_definition'] if definition is None else definition
        need(definition == a['protected']['inventory_definition'], 'V2_INVENTORY_DEFINITION')
        return binding['inventory_callback'](definition)
    read_io = dict(io,version=observed_version,inventory=inventory,
        source_membership=binding['source_membership'],approved_dependencies=trust['approved_dependencies'],
        typed_bytes=helpers['typed_bytes'])
    return read_io,trust,observation


def _equal_snapshot(a,normalized,facts):
    cp,src,p,db = a['completed_base'],a['source'],a['protected'],a['database']
    need(cp['six_controls'] == normalized['current_critical_versions'] == facts['current_six_controls'] == a['controls'],
         'V2_CURRENT_CONTROL_MAP')
    need(src['head'] == facts['actual_current_source']['head'] and src['tree'] == facts['actual_current_source']['tree'] and
         src['worktree_fullpins'] == facts['actual_current_source']['fullpins'] and src['clean'] is True and
         src['tracked_count'] == facts['actual_current_source']['tracked_count'], 'V2_CURRENT_SOURCE_MAP')
    need(p['fullpins'] == facts['protected_fullpins'] and p['native_metadata'] == facts['protected_native6'] and
         p['categories'] == facts['inventory_categories'] and p['missing_fixed_paths'] == facts['missing_fixed_paths'] and
         p['inventory_definition'] == facts['inventory_definition'] and p['existing_count'] == facts['existing_protected_count'],
         'V2_CURRENT_PROTECTED_MAP')
    need(db['current_fullpin'] == facts['current_DB'] and db['typed_state'] == facts['current_typed_database_state'] and
         a['policy_members'] == facts['all63_policy_pins'] and a['active_policy_index'] == facts['active_policy_index'],
         'V2_CURRENT_DB_POLICY_MAP')


def resolve_v2_scope(context,a,c,io,helpers,original,reader,binding,env=None):
    """Resolve immutable history and the prospective operation's before-state.

    Queued qualification runs every strict fresh-reader gate. Installed
    qualification retains that dated published base and applies only existing
    strict-completion phase observations to this operation's Q/RI/PNG changes.
    """
    read_io,trust,permission = _bound_io(context,a,c,io,helpers,original,reader,binding)
    observation = reader['Observation'](read_io)
    phase = helpers['normal_current_phase']()
    if phase is None:
        normalized = reader['read_completed_base_v2'](trust['leaf'],read_io,trusted=trust,env=env)
        leaf = normalized['historical_leaf_snapshot']
        outer = observation.document(trust['root_outer0']); pointer = observation.document(trust['current_pointer'])
        facts = observation.document(trust['current_facts'])
        mode = 'FULL_FRESH_PUBLISHED_V2_BASE'
        fence = observation.fence
    else:
        need(phase['result'] == 'PASS_EXACT_PHASE_AND_REVIEWED_EVIDENCE' and
             phase['phase'] == 'installed_with_actual_completion', 'V2_ONLY_ACTUAL_COMPLETED_OPERATION_PHASE')
        module,code = binding['history_module'],binding['history_module_pin']
        need(module is not None and code is not None, 'APPROVED_SHARED_V2_HISTORY_REQUIRED')
        history_api = namespace(module)
        need(history_api.get('__file__') == code['path'], 'ACTUAL_APPROVED_HISTORY_PATH')
        permission.pinned(code)
        need(read_io['version'](code['path']) == code, 'ACTUAL_HISTORY_CODE_PARTICIPATION')
        history = history_api['read_published_v2_history'](trust['leaf'],read_io,trusted=trust,approved_reader=reader,env=env)
        need(history['result'] == 'PASS_DATED_PUBLISHED_V2_HISTORY_NOT_CURRENT_SCOPE' and
             history['history_only'] is True and history['current_state_claimed'] is False, 'EXACT_V2_HISTORY_ONLY_SCOPE')
        leaf,outer,pointer = (history[k] for k in ('historical_leaf_snapshot','outer_document','pointer_document'))
        preflight_path = str(PureWindowsPath(c['work_directory'])/'PREFLIGHT.json')
        preflight = observation.document(read_io['version'](preflight_path))
        need(preflight['critical'] == a['completed_base']['six_controls'] == leaf['current_critical_versions'],
             'V2_ACTUAL_PREFLIGHT_CAUSAL_PARENT_CONTROLS')
        facts,state,current_fence = _phase_current_scope(trust['leaf'],leaf,trust,pointer,observation,
            os.environ if env is None else env,helpers,reader,phase)
        need(callable(history_api.get('fence_published_history')), 'PUBLIC_ISSUED_HISTORY_FENCE_REQUIRED')
        def fence():
            current_fence(); history_api['fence_published_history'](history)
        normalized = dict(current_critical_versions=facts['current_six_controls'])
        mode = 'DATED_PUBLISHED_V2_PLUS_SEPARATE_CURRENT_OPERATION_PHASE'
    _equal_snapshot(a,normalized,facts)
    need(c['controls']['owner'] == context['owner_pin'] and c['controls']['automation'] == facts['current_automation'],
         'V2_CURRENT_AUTOMATION_OWNER_BINDING')
    need(leaf['schema'] == reader['COMPACT_SCHEMA'] and leaf['result'] == 'PASS', 'LITERAL_V2_SCHEMA_PRESERVED')
    need(observation.document(trust['current_context'])['baseline_snapshot'] == leaf['baseline_snapshot'],
         'LITERAL_V2_BASELINE_CONTEXT')
    permission.fence(); fence()
    return dict(leaf=leaf,outer=outer,pointer=pointer,policy_members=facts['all63_policy_pins'],facts=facts,
        relative_source_native={str(PureWindowsPath(path).relative_to(PureWindowsPath('C:/ESTIMATOR/app'))).replace('\\','/'):native
            for path,native in facts['actual_current_source']['native6'].items()},mode=mode,phase=phase,
        scope_fence=fence,permission=permission,read_io=read_io)


def qualify_optional_v2(context,admission_pin,expected_admission_pin,io,helpers,*,original,reader,binding,env=None,standard_release=None):
    """Pure opt-in entry; actual manifests must pass the complete old gate body."""
    original,reader = namespace(original),namespace(reader)
    if standard_release is not None:
        parent = original
        original = dict(original)
        original['lineage_views'] = lambda q,read_io: lineage_views_with_standard_release(q,read_io,parent,standard_release)
    need(context['config'].get(OPTIONAL_ROLE) is not None and context['config']['operation_kind'] == 'canonical',
         'EXPLICIT_CANONICAL_V2_ROLE_REQUIRED')
    # Normal create_profile_adapter omits env and uses actual process identity;
    # direct pure unit tests supply synthetic env without modifying old globals.
    result,snapshot = _qualify_v2_core(context,admission_pin,expected_admission_pin,io,helpers,original,reader,binding,env)
    read_io = snapshot['read_io']; phase = snapshot['phase']
    runtime = {}
    if phase is not None:
        for entry in result['objects']['modern_retained_lineage']['entries'].values():
            path = str(PureWindowsPath('C:/ESTIMATOR/app/.runtime/reference-library/replicas') /
                       (entry['selected_private_return']['sha256']+'.png'))
            need(path not in result['protected_fullpins'], 'V2_NEW_RUNTIME_NOT_ALREADY_PROTECTED')
            pin = read_io['version'](path)
            need(pin['sha256'] == entry['selected_private_return']['sha256'], 'V2_ACTUAL_NEW_RUNTIME_HASH')
            runtime[path] = pin
    original['protected_guard'](result,read_io,{p:None for p in helpers['MUTABLE_CURRENT_CONTROLS']},runtime)
    original['source_guard'](result,read_io,{p:None for p in helpers['MUTABLE_CURRENT_CONTROLS']})
    snapshot['scope_fence'](); snapshot['permission'].fence()
    need(helpers['normal_current_phase'](result['projected_jobs']) == phase, 'V2_CURRENT_PHASE_END')
    result.update(v2_completed_base_schema=reader['COMPACT_SCHEMA'],v2_baseline_mode=snapshot['mode'],
                  v2_current_operation_phase_separate=True)
    return result


def _qualify_v2_core(context, admission_pin, expected_admission_pin, io, helpers, original, reader, binding, env=None):
    original['need'](expected_admission_pin is not None and admission_pin == expected_admission_pin, 'EXTERNAL_ADMISSION_NULL_OR_DIFFERENT')
    io = dict(io, _participation={})
    doc, pinned = (helpers['document'], helpers['pinned'])
    a, c = (doc(admission_pin, io), context['config'])
    ids = original['targets'](c, helpers['HARD_HELD'])
    original['need'](a['schema'] == original['ADMISSION_SCHEMA'] and a['result'] == 'ROOT_MODERN_CANONICAL_FINITE_SOURCE_PROTECTED_ADMISSION', 'ADMISSION_SCHEMA')
    original['need'](a['owner_thread_id'] == c['owner_thread_id'] == context['root'] and a['owner_execution_token'] == c['owner_execution_token'] == context['token'], 'RECEIVING_IDENTITY')
    original['need'](a['targets'] == ids and a['operation_kind'] == 'canonical' and (a['batch_id'] == c['batch_id']) and (a['work_directory'] == c['work_directory']), 'EXACT_FINITE_SCOPE')
    original['need'](all((a[k] is True for k in ('source_and_protected_preservation_admitted', 'strict_historical_FAIL_preserved', 'no_unlisted_or_future_change_admission'))) and a['technical_approval'] is False, 'FINITE_JUDGMENT')
    original['need'](all((a[k] is None for k in ('actual_manifest', 'actual_preflight', 'actual_acceptance', 'actual_install', 'actual_LIVE', 'actual_checkpoint'))), 'FUTURE_FIELDS_NULL')
    objects = {k: doc(v, io) for k, v in a['evidence_roles'].items()}
    original['need']({'stable_source_capture', 'modern_retained_lineage', 'root_private_adoption', 'fresh_source_protected_qualification'} <= set(objects), 'EVIDENCE_ROLES')
    capture, history, fresh = (objects[k] for k in ('stable_source_capture', 'modern_retained_lineage', 'fresh_source_protected_qualification'))
    original['need'](capture['schema'] == original['CAPTURE_SCHEMA'] and capture['primary_pending_seeds'] == ids and (history['schema'] == original['LINEAGE_SCHEMA']) and (history['targets'] == ids) and (capture['modern_retained_lineage'] == a['evidence_roles']['modern_retained_lineage']), 'CAPTURE_LINEAGE_BOUNDARY')
    snapshot = resolve_v2_scope(context, a, c, io, helpers, original, reader, binding, env=env)
    expected_native = snapshot['relative_source_native']
    original['current_policy_scope'](context, a, capture, io, helpers)
    original['need'](a['policy_members'] == snapshot['policy_members'], 'CURRENT_POLICY_QUALIFICATION')
    original['need'](a['PRIMARY']['sha256'] == original['PRIMARY_SHA'], 'POLICIES_PRIMARY')
    pinned(a['PRIMARY'], io)
    for path, pin in capture['all_current_source_ref_prompt_final_native_pins'].items():
        original['need'](path == pin['path'], 'SOURCE_INPUT_MAP_PATH')
        helpers['normal_observation'](pin, io)
    p, db, src = (a['protected'], a['database'], a['source'])
    original['need'](src['clean'] is True and len(src['worktree_fullpins']) == src['tracked_count'] and (len(p['fullpins']) == len(p['native_metadata']) == p['existing_count']) and (set(p['fullpins']) == set(p['native_metadata']) == set(p['retained_cache_provenance'])) and (len(p['missing_fixed_paths']) == 6) and (p['fresh_all_old_bytes_rehashed'] is False) and (len(p['inventory_definition']['fixed133_seed_map']) == 133) and (len(p['inventory_definition']['explicit_three_saved_projects']) == 3), 'COMPLETE_CURRENT_SCOPE')
    original['normal_database_declaration'](a, c, io, helpers)
    original['need'](pinned(db['immutable_raw_fullpin'], io) == pinned(db['current_fullpin'], io), 'IMMUTABLE_CURRENT_DB')
    if src['producer_release_fullpin'] is not None:
        doc(src['producer_release_fullpin'], io)
    leaf, outer, pointer = (snapshot['leaf'], snapshot['outer'], snapshot['pointer'])
    original['need'](io['git']() == dict(head=src['head'], tree=src['tree'], clean=True), 'GIT_CURRENT')
    source_native = {}
    original['need'](set(expected_native) == {str(PureWindowsPath(p).relative_to(PureWindowsPath('C:/ESTIMATOR/app'))).replace('\\', '/') for p in src['worktree_fullpins']}, 'SOURCE_NATIVE_CLOSED_MAP')
    for path, pin in src['worktree_fullpins'].items():
        relative = str(PureWindowsPath(path).relative_to(PureWindowsPath('C:/ESTIMATOR/app'))).replace('\\', '/')
        before = io['native'](path)
        original['need'](pin['path'] == path and before == expected_native[relative] and (before[:2] == [pin['bytes'], pin['mtime_ns']]), 'ADMITTED_SOURCE_NATIVE_CACHE')
        source_native[path] = before
    for pin in list(a['policy_members'].values()) + list(a['controls'].values()):
        if pin['path'] not in helpers['MUTABLE_CURRENT_CONTROLS']:
            original['need'](io['version'](pin['path']) == pin, 'POLICY_CONTROL_FULLPIN')
    result = dict(admission=a, admission_pin=admission_pin, objects=objects, protected_fullpins=p['fullpins'], protected_native=p['native_metadata'], protected_categories=p['categories'], leaf=leaf, outer=outer, pointer=pointer, context=context, typed_state=db['typed_state'], source_native=source_native, helpers=helpers)
    result['qualified_lineage_views'] = original['lineage_views'](result, io)
    review_pin = a['evidence_roles']['root_private_adoption']
    original['need'](all((binding['adoption_key'] == key and binding['review'] == review_pin for key, binding in c['individual_root_reviews'].items())), 'CURRENT_ROOT_REVIEW_BINDINGS')
    reviewed = {key: objects['root_private_adoption'] for key in map(str, ids)}
    projected = original['project'](result, original['source_union'](capture), c, reviewed, io, str(PureWindowsPath(c['work_directory']) / 'CANONICAL_PROMPT_PROJECTION.json'))
    result['projected_jobs'], result['projected_prompts'], result['projected_selected'] = projected
    original['database_guard'](result, io)
    participation_native = {}
    for path, pin in io['_participation'].items():
        before = io['native'](path)
        original['need'](before[:2] == [pin['bytes'], pin['mtime_ns']] and io['version'](path) == pin and (io['native'](path) == before), 'PARTICIPATION_CAPTURE')
        participation_native[path] = before
    for path, pin in io['_participation'].items():
        original['need'](io['version'](path) == pin, 'PARTICIPATION_END_FULLPIN')
    original['need'](all((io['native'](p) == v for p, v in participation_native.items())) and all((io['native'](p) == v for p, v in source_native.items())), 'PARTICIPATION_SOURCE_END')
    result.update(participation_versions=dict(io['_participation']), participation_native=participation_native)
    original['source_guard'](result, io, {p: None for p in helpers['MUTABLE_CURRENT_CONTROLS']})
    result['mutable_controls_require_exact_phase_projection'] = sorted(helpers['MUTABLE_CURRENT_CONTROLS'])
    return result, snapshot


ORIGINAL_READER_CURRENT_SCOPE_AST_SHA256 = '5c129156db23ac9cd668835c98148c52aca829d6a4b1c250d52ac8bafb756cee'

def _phase_current_scope(leaf_pin, leaf, trusted, pointer, o, env, helpers, reader, phase):
    context = o.document(trusted['current_context'])
    facts = o.document(trusted['current_facts'])
    reader['need'](context['schema'] == reader['CONTEXT_SCHEMA'] and context['completed_base'] == leaf_pin and (context['publication_cas'] == trusted['publication_CAS']) and (context['current_facts'] == trusted['current_facts']) and (context['current_owner'] == trusted['owner_pin']) and (context['current_pointer'] == trusted['current_pointer']) and (context['baseline_snapshot'] == leaf['baseline_snapshot']), 'TRUSTED_CURRENT_CONTEXT')
    reader['identity'](context, trusted['root'], trusted['token'])
    reader['_finite'](context)
    reader['need'](env.get('CODEX_THREAD_ID') == trusted['root'] and trusted['owner_pin']['path'] == trusted['owner_path'], 'ACTUAL_CURRENT_PROCESS')
    owner = o.document(trusted['owner_pin'])
    for obj in (owner, pointer):
        reader['identity'](obj, trusted['root'], trusted['token'])
        reader['need'](obj['image_publication_hold_active'] is False and obj['live_image_installation_hold_active'] is False and (obj['all_image_mutations_guarded_until_valid_claim_and_app_retarget'] is False), 'CURRENT_OWNER_RELEASED')
    reader['need'](owner['status'] in ('active', 'ACTIVE') and owner['automation_retarget_pending'] is False and (context['actual_same_active_owner_claim_and_release_preserved'] is True), 'CURRENT_CLAIM_RELEASE')
    roles = context['claim_release_evidence']
    reader['need'](set(roles) == {'claim', 'receiving_authority', 'retarget', 'hold_release'} and owner['actual_claim_receipt'] == roles['claim'] and (owner['actual_receiving_authority'] == roles['receiving_authority']) and (owner['actual_retarget_verification'] == roles['retarget']) and (owner['image_publication_hold_release'] == roles['hold_release']), 'CLAIM_RELEASE_PIN_ROLES')
    for pin in roles.values():
        o.pinned(pin)
    reader['need'](facts['schema'] == reader['FACTS_SCHEMA'] and facts['current_owner'] == trusted['owner_pin'] and (facts['current_pointer'] == trusted['current_pointer']) and all((facts[k] is False for k in ('source_or_protected_preservation_admitted', 'ROOT_preservation_judgment', 'operational', 'enabled', 'future_changes_authorized', 'technical_approval'))), 'FRESH_FACTS_NOT_AUTHORITY')
    reader['integer'](facts['shared_mutations'], 0, 'FRESH_FACTS_MUTATIONS')
    baseline = leaf['baseline_snapshot']
    old = o.document(baseline['facts'])
    judgment = o.document(baseline['root_judgment'])
    descriptor = o.document(baseline['descriptor'])
    reader['need'](descriptor['current_facts'] == baseline['facts'] and descriptor['current_judgment'] == baseline['root_judgment'] and (judgment['actual_fresh_current_facts'] == baseline['facts']) and (judgment['root_preservation_judgment'] is True) and (judgment['no_unlisted_or_future_change_admission'] is True), 'DATED_BASELINE_SNAPSHOT')
    reader['identity'](judgment, leaf['owner_thread_id'], leaf['owner_execution_token'])
    reader['need'](descriptor['ordinary_parent'] == leaf['previous_base'] and descriptor['ordinary_parent_outer0'] == leaf['previous_base_outer0'] and (descriptor['operation_live'] == leaf['actual_batch_delta']['live']) and (descriptor['apply_outer0'] == leaf['actual_batch_delta']['root_outer0']) and (descriptor['intervening_recoveries'] == [{'root_bridge': r['root_bridge']} for r in leaf['intervening_completed_recoveries']]) and (old['current_pointer'] == leaf['before_publication_pointer']), 'BASELINE_EXACT_OPERATION')
    reader['need'](leaf['current_source_HEAD'] == old['actual_current_source']['head'] and leaf['current_source_tree'] == old['actual_current_source']['tree'] and (leaf['current_critical_versions'] == old['current_six_controls']) and (leaf['current_typed_database_state'] == old['current_typed_database_state']) and (leaf['protected_file_count'] == old['existing_protected_count']), 'BASELINE_EXACT_CANDIDATE_SNAPSHOT')
    reader['need'](facts['current_six_controls'] == old['current_six_controls'], 'CONTROL_CHANGE_REQUIRES_SEPARATE_WHOLE_COUNTS_QUALIFICATION')
    reader['need'](context['declared_current_facts'] == facts, 'DECLARED_WHOLE_CURRENT_FACTS')
    transitions = context['declared_map_transitions']
    reader['need'](set(transitions) == {'source', 'protected', 'policies', 'controls'}, 'FINITE_TRANSITION_ROLES')
    for role, a, b in (('source', old['actual_current_source']['fullpins'], facts['actual_current_source']['fullpins']), ('protected', old['protected_fullpins'], facts['protected_fullpins']), ('policies', old['all63_policy_pins'], facts['all63_policy_pins']), ('controls', old['current_six_controls'], facts['current_six_controls'])):
        reader['_transition'](a, b, transitions[role], o, 'CLOSED_' + role.upper() + '_TRANSITION')
    source = facts['actual_current_source']
    protected = facts['protected_fullpins']
    reader['need'](source['clean'] is True and type(source['tracked_count']) is int and (source['tracked_count'] == len(source['fullpins'])) and (set(source['fullpins']) == set(source['native6']) == set(trusted['source_membership'])) and (len(trusted['source_membership']) == len(set(trusted['source_membership']))) and (set(o.io['source_membership']()) == set(trusted['source_membership'])), 'CURRENT_SOURCE_MEMBERSHIP')
    expected_git = dict(head=source['head'], tree=source['tree'], clean=True)
    reader['need'](o.io['git']() == expected_git, 'CURRENT_GIT')
    for pins, natives in ((source['fullpins'], source['native6']), (protected, facts['protected_native6'])):
        reader['need'](set(pins) == set(natives), 'COMPLETE_NATIVE_MAP')
        for path, pin in pins.items():
            reader['need'](pin['path'] == path, 'FULLPIN_MAP_PATH')
            if path == str(PureWindowsPath('C:/ESTIMATOR/app/.runtime/reference-library/replicas/index.json')):
                helpers['normal_observation'](pin, o.io)
                if o.io['version'](path) != pin:
                    reader['need'](phase['phase'] == 'installed_with_actual_completion', 'V2_REGISTRY_ONLY_AFTER_ACTUAL_COMPLETION')
                    continue
            o.native(path, pin, natives[path])
    categories, missing = (facts['inventory_categories'], facts['missing_fixed_paths'])
    original_admission = o.document(descriptor['original_admission'])
    reader['need'](facts['inventory_definition'] == original_admission['protected']['inventory_definition'] and missing == old['missing_fixed_paths'] and all((categories[p] == old['inventory_categories'][p] for p in set(categories).intersection(old['inventory_categories']))), 'INVENTORY_RULE_AND_RETAINED_CATEGORIES')
    reader['need'](set(categories) == set(protected) | set(missing) and (not set(protected).intersection(missing)) and (len(missing) == len(set(missing))) and (facts['existing_protected_count'] == len(protected)) and (facts['membership_names'] == len(categories)), 'CURRENT_INVENTORY_CLOSED')
    'Membership is enforced by unchanged original protected_guard before qualification returns.'
    reader['need'](len(facts['all63_policy_pins']) == 63 and len(facts['current_six_controls']) == 6, 'POLICY_CONTROL_COUNTS')
    for mapping in (facts['all63_policy_pins'], facts['current_six_controls']):
        for path, pin in mapping.items():
            reader['need'](path == pin['path'], 'POLICY_CONTROL_MAP_PATH')
            if mapping is facts['current_six_controls'] and path in helpers['MUTABLE_CURRENT_CONTROLS']:
                helpers['normal_observation'](pin,o.io)
            else:
                o.pinned(pin)
    index = o.document(facts['active_policy_index'])
    fields = [k for k in owner if k == 'current_active_policy_index' or (k.startswith('current_active_policy_index') and k[len('current_active_policy_index'):].isdigit())]
    if not fields:
        fields = ['active_policy_index']
    reader['need'](len(fields) == 1 and owner[fields[0]] == facts['active_policy_index'], 'OWNER_ACTIVE_POLICY_INDEX')
    reader['need'](index['policies'] == facts['all63_policy_pins'] and index['policy_count'] == 63 and (index['technical_approval'] is False), 'COMPLETE_POLICY_INDEX')
    automation = tomllib.loads(o.pinned(facts['current_automation']).decode('utf8'))
    reader['need'](automation['kind'] == 'heartbeat' and automation['status'] == 'ACTIVE' and (automation['target_thread_id'] == trusted['root']) and (owner['existing_automation_target_thread_id'] == trusted['root']) and (owner['automation_remains_ACTIVE'] is True), 'CURRENT_AUTOMATION')
    reader['need'](trusted['approved_dependencies'] == o.io['approved_dependencies'] and set(trusted['approved_dependencies']) == {'typed_reader'}, 'APPROVED_READER_DEPENDENCIES')
    o.pinned(trusted['approved_dependencies']['typed_reader'])
    db = facts['current_DB']
    reader['need'](db == old['current_DB'], 'DATABASE_REQUIRES_SEPARATE_FINITE_CONSUMER')
    reader['need'](all((not o.io['exists'](db['path'] + suffix) for suffix in ('-wal', '-shm', '-journal'))), 'DB_SIDECARS')
    state, unused_folder = o.io['typed_bytes'](o.pinned(db))
    reader['need'](state == facts['current_typed_database_state'] == old['current_typed_database_state'] and len(state['tables']) == facts['current_typed_tables'] and (sum((row['rows'] for row in state['tables'].values())) == facts['current_typed_rows']), 'FULL_TYPED_DATABASE')

    def fence():
        reader['need'](o.io['git']() == expected_git, 'END_GIT')
        members = o.io['source_membership']()
        reader['need'](len(members) == len(set(members)) == len(trusted['source_membership']) and set(members) == set(trusted['source_membership']), 'END_SOURCE_MEMBERSHIP')
        'Membership is enforced by unchanged original protected_guard before qualification returns.'
        o.fence()
    return (facts, state, fence)


STANDARD_RELEASE_ROLE = 'approved_standard_native_reader_release_v1'
APPROVED_STANDARD_READER_SHA = '49b8a87c256570fd109f26cb05d9ae1b94668b1c200951adbf695615c349cd24'
PREVIOUS_STANDARD_READER_SHA = 'ccbdd1a1602157648ff2c79b1c3ae3efd0486a9808ba193ed7c6d45fc1d5753a'
ORIGINAL_STANDARD_LINEAGE_AST_SHA256 = 'd2b3a09568d8d240473e4ee657c223700af3e002f67a28ec930ccbd993d574a2'


def standard_api_ast_equivalent(old_bytes,new_bytes):
    """The release adds a literal selector; standard validators stay literal."""
    old,new = ast.parse(old_bytes),ast.parse(new_bytes)
    for node in old.body:
        if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name != 'read_native_attempt':
            need(any(type(other) is type(node) and ast.dump(node,include_attributes=False) ==
                     ast.dump(other,include_attributes=False) for other in new.body), 'STANDARD_INTERNAL_AST_CHANGED')
    old_public = next(n for n in old.body if isinstance(n,ast.FunctionDef) and n.name=='read_native_attempt')
    new_public = copy.deepcopy(next(n for n in reversed(new.body) if isinstance(n,ast.FunctionDef) and n.name=='read_native_attempt'))
    expected = ast.parse("if 'literal_family' in binding:\n    return _read_literal_attempt(binding,context,read_pinned)").body[0]
    statement = next(n for n in new_public.body if isinstance(n,ast.Try))
    need(statement.body and ast.dump(statement.body[0],include_attributes=False) == ast.dump(expected,include_attributes=False),
         'EXACT_KNOWN_LITERAL_DISPATCH')
    statement.body.pop(0)
    need(ast.dump(old_public,include_attributes=False) == ast.dump(new_public,include_attributes=False),
         'STANDARD_PUBLIC_API_CHANGED')
    return True


def validate_standard_release(q,io,original,release):
    """Exact caller-approved software release, independent of image approval."""
    need(type(release) is dict and set(release)=={'approval','reader','old_archive','merge','activation','ast_proof'},
         'EXTERNAL_EXACT_STANDARD_RELEASE_REQUIRED')
    h,c,a = q['helpers'],q['context']['config'],q['admission']
    approval = h['document'](release['approval'],io)
    need(a.get(STANDARD_RELEASE_ROLE) == c.get(STANDARD_RELEASE_ROLE) ==
         a['evidence_roles'].get(STANDARD_RELEASE_ROLE) == release['approval'], 'STANDARD_RELEASE_ROLE_BINDING')
    need(approval['schema']=='ROOT_APPROVED_KNOWN_STANDARD_NATIVE_READER_RELEASE_V1' and
         approval['root_code_release_admitted'] is True and approval['technical_approval'] is False and
         approval['future_code_releases_authorized'] is False and
         all(approval[k] == release[k] for k in ('reader','old_archive','merge','activation','ast_proof')),
         'ROOT_EXPLICIT_KNOWN_STANDARD_RELEASE')
    pin = release['reader']
    need(pin['sha256']==APPROVED_STANDARD_READER_SHA and release['old_archive']['sha256']==PREVIOUS_STANDARD_READER_SHA and
         c['native_generation_reader']==a['native_generation_reader']==
         q['objects']['stable_source_capture']['native_generation_reader']==pin, 'EXACT_KNOWN_STANDARD_READER')
    old_raw,new_raw = h['pinned'](release['old_archive'],io),h['pinned'](pin,io)
    standard_api_ast_equivalent(old_raw,new_raw)
    proof = h['document'](release['ast_proof'],io)
    need(proof['schema']=='DATA_ONLY_STANDARD_NATIVE_READER_RELEASE_GATE_REPRO_AND_AST_COMPARISON_V1' and
         proof['actual_current_APP_reader']==pin and proof['old_reader_honest_archive']==release['old_archive'] and
         proof['all_internal_ASTs_equal'] is True and
         proof['standard_public_wrapper_AST_equal_after_removing_only_literal_family_dispatch'] is True,
         'EXACT_STANDARD_API_PROVENANCE')
    merge = h['document'](release['merge'],io)
    need(merge['schema']=='ROOT_ACTUAL_PR285_ALL_CI_PASS_AND_MERGE_VERIFIED_V1' and
         merge['actual_merge_result']['merged'] is True and merge['actual_postmerge_fields']['merged'] is True and
         merge['actual_merge_result']['sha']==merge['actual_postmerge_fields']['merge_commit_sha']==merge['verified_origin_main'] and
         merge['implementation_head']==merge['actual_postmerge_fields']['head_sha'] and
         type(merge['actual_fetch_exit_code']) is int and merge['actual_fetch_exit_code']==0 and
         type(merge['actual_ancestry_verification_exit_code']) is int and merge['actual_ancestry_verification_exit_code']==0 and
         merge['verified_changed_paths']==['estimator/image_receipt_lineage.py','tests/test_image_receipt_lineage.py'],
         'ACTUAL_MERGED_KNOWN_READER_RELEASE')
    runs=merge['actual_workflow_runs_for_exact_head']['workflow_runs']
    need(runs and all(r['head_sha']==merge['implementation_head'] and r['status']=='completed' and r['conclusion']=='success' for r in runs) and
         {j['name'] for j in merge['actual_jobs']}=={'verify','windows-desktop','takeoff-browser'} and
         all(j['status']=='completed' and j['conclusion']=='success' for j in merge['actual_jobs']), 'ALL_EXACT_RELEASE_CI_PASSED')
    activation=h['document'](release['activation'],io)
    need(activation['schema']=='ROOT_ACTUAL_PR285_NARROW_LIVE_CHECKOUT_ACTIVATION_NOT_IMAGE_ADMISSION_V1' and
         activation['actual_merge_evidence']==release['merge'] and activation['source_clean'] is True and
         activation['actual_new_code_fullpins']['estimator/image_receipt_lineage.py']==pin and
         activation['other1166_source_native6_unchanged'] is True and activation['all7534_protected_native6_unchanged'] is True and
         activation['image_calls']==activation['image_selection_acceptance_installation']==0 and activation['technical_approval'] is False,
         'ACTUAL_NARROW_READER_RELEASE_ACTIVATION')
    return pin


def lineage_views_with_standard_release(q,io,original,release):
    """Only the standard known-release path changes; literal/default routes do not."""
    c=q['context']['config']
    if original['amr_current'](c) or c.get(STANDARD_RELEASE_ROLE) is None:
        return original['lineage_views'](q,io)
    attempts=[attempt for entry in q['objects']['modern_retained_lineage']['entries'].values() for attempt in entry['attempts']]
    need(attempts and all('literal_family' not in attempt['native_reader_binding'] for attempt in attempts),
         'STANDARD_RELEASE_REJECTS_LITERAL_DISPATCH_FIELD')
    need({a['receipt_family'] for a in attempts}=={original['_NATIVE_GENERATION_FAMILY']}, 'STANDARD_RELEASE_EXCLUSIVE_FAMILY')
    validate_standard_release(q,io,original,release)
    marker=original.get('_RETAINED_GENERATOR_MARKER')
    if marker is not None and marker in c:
        generator_context=original['retained_generator_context'](q,io)
        result=_standard_release_lineage_views(dict(q,context=generator_context),io,original)
        original['retained_generator_context'](q,io)
        return result
    return _standard_release_lineage_views(q,io,original)

def _standard_release_lineage_views(q, io, original):
    history = q['objects']['modern_retained_lineage']
    families = {a['receipt_family'] for e in history['entries'].values() for a in e['attempts']}
    if original['_NATIVE_GENERATION_FAMILY'] not in families:
        return _native_generation_legacy_lineage_views(q, io)
    h, c, context = (q['helpers'], q['context']['config'], q['context'])
    original['need'](families == {original['_NATIVE_GENERATION_FAMILY']} and (not original['amr_current'](c)), 'NATIVE_EXCLUSIVE_PENDING_FAMILY')
    original['need'](history['schema'] == original['LINEAGE_SCHEMA'] and history['targets'] == q['admission']['targets'] and (set(history['entries']) == set(map(str, history['targets']))), 'NATIVE_EXACT_LINEAGE_SCOPE')
    reader_pin = c['native_generation_reader']
    original['need'](reader_pin == q['admission']['native_generation_reader'] == q['objects']['stable_source_capture']['native_generation_reader'] and reader_pin['sha256'] == APPROVED_STANDARD_READER_SHA, 'NATIVE_REVIEWED_READER_BINDING')
    reader_bytes = h['pinned'](reader_pin, io)
    original['need'](hashlib.sha256(reader_bytes).hexdigest() == APPROVED_STANDARD_READER_SHA, 'NATIVE_READER_BYTES')
    namespace = {'__name__': 'reviewed_native_generation_reader'}
    exec(compile(reader_bytes, reader_pin['path'], 'exec'), namespace)
    result, native_items, candidate_hashes = ({}, set(), set())
    for key, entry in history['entries'].items():
        n = int(key)
        accounting = h['document'](entry['run_accounting'], io)
        original['need'](accounting['owner_thread_id'] == context['root'] and accounting['owner_execution_token'] == context['token'] and (accounting['technical_approval'] is False) and (type(accounting['max_new_unique']) is int) and (accounting['max_new_unique'] == 12) and (len(accounting['unique_jobs']) <= 12) and (len(set(accounting['unique_jobs'])) == len(accounting['unique_jobs'])) and (set(accounting['per_job']) == set(map(str, accounting['unique_jobs']))), 'NATIVE_CLOSED_BUDGET_OWNER')
        row = accounting['per_job'][key]
        count = row['actual_calls']
        original['need'](n in accounting['unique_jobs'] and type(count) is int and all((type(row[k]) is int and row[k] == count for k in ('actual_returns', 'root_reviews', 'independent_reviews'))) and (type(row['max_attempts']) is int) and (1 <= count <= row['max_attempts'] <= 2) and (row['more_calls_allowed'] is False) and (sum((v['actual_calls'] for v in accounting['per_job'].values())) == accounting['actual_calls']) and (sum((v['actual_returns'] for v in accounting['per_job'].values())) == accounting['actual_returns']), 'NATIVE_ALL_ACTUAL_ATTEMPTS_CLOSED')
        original['need']([a['attempt'] for a in entry['attempts']] == list(range(1, count + 1)), 'NATIVE_ALL_ATTEMPTS')
        views = []
        for attempt in entry['attempts']:
            number = attempt['attempt']
            binding = attempt['native_reader_binding']
            original['need'](binding['qualification'] == attempt['qualification'] and binding['dispatch'] == attempt['dispatch'] and (binding['returned'] == attempt['returned']) and (attempt['dated_reviews'] == [binding['root_review'], binding['independent_review']]), 'NATIVE_EXACT_ATTEMPT_REVIEW_BINDINGS')
            before, job, raw = original['qualification_source'](attempt['qualification'], io, h, context['root'], context['token'])
            original['need'](before['job'] == n and before['attempt'] == number, 'NATIVE_QUALIFICATION_IDENTITY')
            records = q['objects']['stable_source_capture']['full_current_records']
            direct = {r['record_id']: records[r['record_id']]['raw'] for r in job['references']}
            trusted = dict(job=n, attempt=number, root=context['root'], token=context['token'], held_jobs=h['HARD_HELD'], provider_root='C:/Users/tanas/.codex/generated_images', session_directory=context['session'], current_job=q['objects']['stable_source_capture']['full_current_jobs'][key], current_records=direct)
            v = namespace['read_native_attempt'](binding, trusted, lambda pin: h['pinned'](pin, io))
            original['need'](v['literal_qualification'] == before and v['complete_RAW_view'] == direct and (entry['source_version'] == before['ordered_ALL_references'][0]), 'NATIVE_SOURCE_VIEW')
            if views:
                previous = entry['attempts'][number - 2]
                original['need'](binding['prior_return'] == previous['returned'] and binding['prior_root_review'] == previous['native_reader_binding']['root_review'] and (binding['prior_arguments'] == views[-1]['historical_qualification_verbatim']['exact_arguments']), 'NATIVE_EXACT_RETAINED_CORRECTION_PARENT')
            original['need'](v['actual_native_item_id'] not in native_items and v['private_candidate']['sha256'] not in candidate_hashes, 'NATIVE_UNIQUE_ITEM_AND_CANDIDATE')
            native_items.add(v['actual_native_item_id'])
            candidate_hashes.add(v['private_candidate']['sha256'])
            for pin in (v['provider'], v['private_candidate']):
                with original['Image'].open(original['BytesIO'](h['pinned'](pin, io))) as image:
                    original['need'](image.format == 'PNG' and image.width > 0 and (image.height > 0), 'NATIVE_DECODED_WHOLE_PNG')
                    image.verify()
            views.append(dict(attempt=number, return_index=0, derived_return_index_not_RAW_field=True, family=original['_NATIVE_GENERATION_FAMILY'], qualification=attempt['qualification'], returned=attempt['returned'], provider_original=v['provider'], private_return=v['private_candidate'], arguments=v['arguments'], exact_prompt=before['exact_prompt'], ALL_references=before['ordered_ALL_references'], historical_qualification_verbatim=before, historical_return_verbatim=v['literal_return'], historical_dispatch_verbatim=v['literal_dispatch'], dispatch_pin=attempt['dispatch'], actual_return_observed_at=v['literal_return']['recorded_utc'], timing_evidence_scope='Exact native completed generation and whole-view events; recorded return receipt time; no provider start or RPC UUID inferred', dated_reviews_verbatim=[v['ROOT_review'], v['independent_review']], recorded_fields_absent=v['absent_return_fields'], correction_review_time_limits=[], native_generation_evidence=binding['native_evidence'], native_generation_item_id=v['actual_native_item_id'], technical_approval=False))
        result[key] = views
    return result
