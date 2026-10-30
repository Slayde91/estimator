"""Generic V2 checkpoint qualification prototype; no executable writer.

Historical operation pins remain literal. Current publication facts are a
separate ROOT judgment. This module never imports/configures the old runner,
calls PRIMARY, restores a snapshot, or writes a compact/current file.
"""
import ast
import copy
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import tomllib
import weakref

EXECUTION_ENABLED = False
DESCRIPTOR_SCHEMA = 'ROOT_GENERIC_DUAL_CONTEXT_CHECKPOINT_DESCRIPTOR_V2'
CANDIDATE_SCHEMA = 'STABLE_REVIEWED_IMAGE_BATCH_COMPACT_CANDIDATE_V2'
COMPACT_SCHEMA = 'STABLE_REVIEWED_IMAGE_BATCH_COMPACT_V2'
PIN_KEYS = {'path', 'bytes', 'mtime_ns', 'sha256'}
_ISSUED_HANDLES = weakref.WeakKeyDictionary()


class QualifiedCheckpoint:
    """Opaque issued handle; DATA and caller flags cannot construct one."""
    __slots__ = ('__weakref__',)

    def __new__(cls, *args, **kwargs):
        raise ValueError('PRIVATE_QUALIFICATION_HANDLE')

    @property
    def data(self):
        need(self in _ISSUED_HANDLES, 'PRIVATE_QUALIFICATION_HANDLE')
        return json.loads(_ISSUED_HANDLES[self][0])


def decode_current_judgment(raw):
    """Explicit legacy DATA decoder; never rewrite the pinned source document."""
    x = copy.deepcopy(raw)
    if raw['schema'] == 'ROOT_FINITE_CURRENT_PUBLICATION_CONTEXT_PRESERVATION_JUDGMENT_V1':
        mapping = {'operation_live':'actual_completed60_LIVE',
            'operation_outer0':'actual_completed60_ROOT_apply_outer0',
            'ordinary_parent':'original_ordinary_CP74_preserved',
            'ordinary_parent_outer0':'original_ordinary_CP74_outer0_preserved'}
        for target, source in mapping.items(): x[target] = raw[source]
        x['intervening_recoveries'] = [raw['separate_prior_four_recovery']]
        x['pointer_publications'] = [raw['actual_additive_marker_CAS']]
    else:
        need(raw['schema'] == 'ROOT_FINITE_CURRENT_PUBLICATION_CONTEXT_PRESERVATION_JUDGMENT_V2', 'CURRENT_JUDGMENT_SCHEMA')
    return x


def decode_publication(raw):
    x = copy.deepcopy(raw)
    if raw.get('schema') is None and raw.get('result') == 'ACTUAL_ADDITIVE_CURRENT_CAS_COMPLETED_AND_READBACK_EXACT':
        x['ordinary_parent_preserved'] = raw['ordinary_CP74_preserved']
        x['intervening_recoveries_preserved'] = raw['previous_four_recovery_preserved']
        x['control_mutations'] = raw['queue_registry_DB_owner_automation_mutations']
    else:
        need(raw['schema'] == 'ROOT_CURRENT_PUBLICATION_CAS_RECEIPT_V2', 'PUBLICATION_SCHEMA')
    return x


def decode_recovery(raw):
    x = copy.deepcopy(raw)
    if raw['schema'] == 'CLASSIFIRE_COMPLETED_CANONICAL_RECOVERY_COMPACT_V1':
        x['runtime_creation_versions'] = raw['actual_four_runtime_creation_versions']
    else:
        need(raw['schema'] == 'CLASSIFIRE_COMPLETED_CANONICAL_RECOVERY_COMPACT_V2', 'RECOVERY_SCHEMA')
    return x


def need(value, code):
    if not value:
        raise ValueError(code)


def physical_version(path):
    p = Path(path); before = p.stat(); raw = p.read_bytes(); after = p.stat()
    need((before.st_size, before.st_mtime_ns, before.st_ino) ==
         (after.st_size, after.st_mtime_ns, after.st_ino), 'READ_RACE')
    return dict(path=str(p), bytes=len(raw), mtime_ns=after.st_mtime_ns,
                sha256=hashlib.sha256(raw).hexdigest())


def physical_native(path):
    p = Path(path); s = p.stat()
    return [s.st_size, s.st_mtime_ns, s.st_dev, s.st_ino,
            getattr(s, 'st_file_attributes', 0), p.is_file()]


class Observation:
    def __init__(self, io):
        self.io = io; self.pins = {}; self.natives = {}

    def version(self, path):
        v = self.io['version'](path)
        need(path not in self.pins or self.pins[path] == v, 'PARTICIPANT_RACE')
        self.pins[path] = copy.deepcopy(v)
        return v

    def pinned(self, v):
        need(type(v) is dict and set(v) == PIN_KEYS and type(v['bytes']) is int and
             type(v['mtime_ns']) is int, 'PIN_SHAPE')
        need(self.version(v['path']) == v, 'PIN_BEFORE')
        raw = self.io['bytes'](v['path'])
        need(type(raw) is bytes and len(raw) == v['bytes'] and
             hashlib.sha256(raw).hexdigest() == v['sha256'], 'PIN_BYTES')
        need(self.version(v['path']) == v, 'PIN_AFTER')
        return raw

    def document(self, v):
        return json.loads(self.pinned(v))

    def native(self, path, expected):
        actual = self.io['native'](path)
        need(actual == expected, 'NATIVE_CHANGED')
        self.natives[path] = copy.deepcopy(expected)

    def module(self, v, expected):
        need(expected is not None and v == expected, 'UNTRUSTED_DEPENDENCY')
        ns = {'__name__': 'pinned_checkpoint_pure_dependency', '__file__': v['path']}
        exec(compile(self.pinned(v), v['path'], 'exec'), ns)
        need(self.version(v['path']) == v, 'MODULE_END')
        return ns

    def phase_io(self):
        return dict(self.io, version=self.version)

    def fence(self):
        need(all(self.io['version'](p) == v for p,v in self.pins.items()), 'END_PIN_RACE')
        need(all(self.io['native'](p) == v for p,v in self.natives.items()), 'END_NATIVE_RACE')


def reviewed_runner_ast(raw):
    stop = ast.parse("if __name__ == '__main__' and not (ROOT_AND_PEER_REVIEWED is True and RSB1_OPERATIONAL_ENABLED is True):\n    raise SystemExit('DISABLED_CURRENT_RECEIVING_PAIR_NOT_ENABLED')\n").body[0]
    main = ast.parse("if __name__ == '__main__':\n    main()\n").body[0]
    for node in ast.parse(raw).body:
        allowed = isinstance(node, (ast.Import, ast.ImportFrom, ast.Assign, ast.FunctionDef))
        allowed |= isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
        allowed |= isinstance(node, ast.If) and ast.dump(node) in (ast.dump(main), ast.dump(stop))
        need(allowed, 'RUNNER_TOP_LEVEL')


def archive(observed, retained, o):
    raw = o.pinned(retained)
    need(observed['path'] != retained['path'] and len(raw) == observed['bytes'] and
         hashlib.sha256(raw).hexdigest() == observed['sha256'], 'ARCHIVE_BYTES')
    return json.loads(raw)


def reconcile_logical_evidence(pf, backups, retired, o):
    """Keep logical PF slots; explicitly resolve only real physical archives."""
    old = pf['reviewed_evidence_versions']; result = {}; used = set()
    controls = {backups['bindings'][r]['source_snapshot']['path']: r for r in ('queue','registry')}
    for path, pin in old.items():
        need(path == pin['path'], 'LOGICAL_EVIDENCE_PATH')
        if path in controls:
            row = backups['bindings'][controls[path]]
            physical = row['backup_creation_version']
            need(row['source_snapshot'] == pin and all(physical[k] == pin[k]
                 for k in ('bytes','mtime_ns','sha256')), 'EXACT_CONTROL_BIJECTION')
            o.pinned(physical)
        elif path in retired:
            row = retired[path]; used.add(path)
            need(row['original_observation'] == pin, 'RETIRED_LOGICAL_SLOT')
            archive(pin, row['retained_copy'], o)
            o.pinned(row['current_version']); o.pinned(row['authority'])
            physical = row['retained_copy']
        else:
            physical = pin; o.pinned(pin)
        result[path] = dict(recorded_observation=pin, physical_version=physical)
    need(used == set(retired) and len(result) == len(old), 'CLOSED_EVIDENCE_RESOLUTION')
    return result


def _identity(obj, root, token):
    need(obj['owner_thread_id'] == root and obj['owner_execution_token'] == token,
         'OWNER_IDENTITY')


def _outer(pin, live_pin, root, token, o):
    x = o.document(pin)
    need(type(x['actual_exit_code']) is int and x['actual_exit_code'] == 0 and
         x['receipt_version'] == live_pin and x['observed_by_actual_root_thread_id'] == root and
         x['owner_execution_token'] == token and type(x['actual_completion_chunk']) is str and
         bool(x['actual_completion_chunk']) and (x['actual_exec_session'] is None or
         type(x['actual_exec_session']) is int and x['actual_exec_session'] > 0), 'ACTUAL_ROOT_OUTER0')
    for key in ('actual_browser_review','actual_packet_local0','applied_workflow'):
        o.pinned(x[key])
    return x


def _current_context(d, manifest, admission, live, o, env, typed, trusted):
    j = decode_current_judgment(o.document(d['current_judgment'])); f = o.document(d['current_facts'])
    root, token = d['owner_thread_id'], d['owner_execution_token']
    _identity(j, root, token)
    need(env.get('CODEX_THREAD_ID') == root, 'ACTUAL_PROCESS_OWNER')
    need(j['schema'] in ('ROOT_FINITE_CURRENT_PUBLICATION_CONTEXT_PRESERVATION_JUDGMENT_V1',
         'ROOT_FINITE_CURRENT_PUBLICATION_CONTEXT_PRESERVATION_JUDGMENT_V2') and
         j['root_preservation_judgment'] is True and j['current_publication_context_admitted'] is True and
         j['no_unlisted_or_future_change_admission'] is True and
         j['actual_fresh_current_facts'] == d['current_facts'] and
         j['allowed_completed_jobs'] == manifest['targets'] and
         all(j[k] is False for k in ('executable_checkpoint_writer_admitted','operational','enabled',
             'image_mutations_authorized','future_changes_authorized','new_generation_authorized',
             'new_acceptance_authorized','new_installation_authorized','technical_approval')),
         'FINITE_CURRENT_CONTEXT_ONLY')
    need(f['schema'] == 'ROOT_POST_INSTALL_CURRENT_PUBLICATION_SOURCE_PROTECTED_FACTS_NOT_ADMISSION_V1' and
         f['source_or_protected_preservation_admitted'] is False and f['ROOT_preservation_judgment'] is False and
         f['operational'] is False and f['enabled'] is False and f['shared_mutations'] == 0 and
         f['technical_approval'] is False and f['future_changes_authorized'] is False,
         'FACTS_NOT_AUTHORITY')
    owner = o.document(j['current_owner']); pointer = o.document(j['current_pointer'])
    need(owner['status'] in ('active','ACTIVE'), 'CURRENT_ACTIVE_RELEASED')
    for obj in (owner, pointer):
        _identity(obj, root, token)
        need(obj['image_publication_hold_active'] is False and
             obj['live_image_installation_hold_active'] is False, 'CURRENT_ACTIVE_RELEASED')
    need(j['current_owner'] == f['current_owner'] == manifest['controls']['owner'] and
         j['current_pointer'] == f['current_pointer'] and j['actual_owner_claim_guard_released'] is True and
         j['actual_all_image_mutations_guarded_until_valid_claim_and_app_retarget'] is False and
         pointer['all_image_mutations_guarded_until_valid_claim_and_app_retarget'] is False and
         pointer['current_image_mutations_require_reviewed_receiving_execution_image_successor'] is True and
         pointer['scope_complete'] is False and pointer['technical_approval'] is False and
         j['actual_same_active_owner_claim_and_release_preserved'] is True, 'CLAIM_RELEASE_NOT_OUTGOING_HOLD')
    automation = tomllib.loads(o.pinned(manifest['controls']['automation']).decode('utf8'))
    need(automation['kind'] == 'heartbeat' and automation['status'] == 'ACTIVE' and
         automation['target_thread_id'] == root, 'ACTIVE_OWNER_AUTOMATION')
    publications = j['pointer_publications']
    need(type(publications) is list and 1 <= len(publications) <= 12 and
         len({v['path'] for v in publications}) == len(publications), 'PUBLICATION_CHAIN_SCOPE')
    cursor = manifest['expected_current_pointer']; first = None
    for publication in publications:
        row = decode_publication(o.document(publication)); _identity(row, root, token)
        need(row['old_current'] == cursor and row['new_current']['path'] == cursor['path'] and
             row['ordinary_parent_preserved'] is True and row['intervening_recoveries_preserved'] is True and
             row['normal_checkpoint_success_claimed'] is False and row['control_mutations'] == 0,
             'EXACT_CURRENT_PUBLICATION_CHAIN')
        old_pointer = archive(row['old_current'], row['backup'], o)
        need(old_pointer['latest_completed_receipt'] == pointer['latest_completed_receipt'] == j['ordinary_parent'] and
             old_pointer['actual_checkpoint_root_outer0'] == pointer['actual_checkpoint_root_outer0'] == j['ordinary_parent_outer0'],
             'NORMAL_BASE_PRESERVED')
        if first is None: first = row
        cursor = row['new_current']
    need(cursor == j['current_pointer'], 'PUBLICATION_CHAIN_END')
    cas = dict(old_current=first['old_current'], backup=first['backup'], new_current=cursor)
    need(f['current_six_controls'] == j['current_six_controls'] == live['current_state_snapshots'], 'CURRENT_CONTROL_SCOPE')
    for v in f['current_six_controls'].values(): o.pinned(v)
    need(f['all63_policy_pins'] == j['all63_current_policy_members'] == admission['policy_members'], 'CURRENT_POLICY_SCOPE')
    for v in f['all63_policy_pins'].values(): o.pinned(v)
    o.pinned(f['active_policy_index'])
    source = f['actual_current_source']; before = admission['source']
    need(source['head'] == j['current_actual_source_HEAD'] == before['head'] and
         source['tree'] == j['current_actual_source_tree'] == before['tree'] and source['clean'] is True and
         source['fullpins'] == before['worktree_fullpins'] and
         source['tracked_count'] == j['current_source_count'] == len(source['fullpins']) and
         set(source['fullpins']) == set(source['native6']) == set(trusted['source_membership']) ==
         set(o.io['source_membership']()), 'CLOSED_SOURCE_SCOPE')
    need(o.io['git']() == dict(head=source['head'],tree=source['tree'],clean=True), 'CURRENT_GIT')
    prior = o.document(f['pre_install_facts'])
    need(source['fullpins'] == prior['actual_current_source']['fullpins'] and
         source['native6'] == prior['actual_current_source']['native6'], 'NO_UNLISTED_SOURCE_CHANGE')
    expected = dict(admission['protected']['fullpins']); runtime = live['actual_new_runtime_creation_versions']
    changes = j['exact_authorised_protected_changes']; need(set(changes) == set(f['protected_content_changes']), 'PROTECTED_CHANGE_SET')
    need(j['exact_authorised_protected_addition'] == f['protected_added'] == runtime and
         not set(runtime).intersection(expected), 'EXACT_RUNTIME_ADDITION')
    for path, row in changes.items():
        need(expected.get(path) == row['before'] and f['protected_content_changes'][path] == row and
             row['after'] == f['current_six_controls'][path], 'EXACT_REGISTRY_REPLACEMENT')
        expected[path] = row['after']
    expected.update(runtime)
    categories = dict(admission['protected']['categories']); categories.update({p:'private reference library' for p in runtime})
    need(expected == f['protected_fullpins'] and set(expected) == set(f['protected_native6']) and
         f['inventory_categories'] == categories and f['missing_fixed_paths'] == admission['protected']['missing_fixed_paths'] and
         f['existing_protected_count'] == j['current_protected_file_count'] == len(expected) and
         f['membership_names'] == j['current_membership_count'] == len(categories) and
         not f['protected_removed'] and not f['protected_category_changes'], 'CLOSED_PROTECTED_SCOPE')
    oldnative = prior['protected_native6']
    need(all(n == oldnative[p] for p,n in f['protected_native6'].items() if p not in set(changes)|set(runtime)),
         'UNLISTED_PROTECTED_NATIVE_CHANGE')
    for p,n in source['native6'].items(): o.native(p,n)
    for p,n in f['protected_native6'].items(): o.native(p,n)
    for v in list(runtime.values())+[row['after'] for row in changes.values()]: o.pinned(v)
    actual_categories, missing = o.io['inventory'](admission['protected']['inventory_definition'])
    need(actual_categories == categories and missing == f['missing_fixed_paths'], 'FRESH_INVENTORY')
    db = f['current_DB']; need(db == j['current_database'] == admission['database']['current_fullpin'], 'CURRENT_DB_PIN')
    need(all(not o.io['exists'](db['path']+s) for s in ('-wal','-shm','-journal')), 'DB_SIDECARS')
    state, folder = typed['typed_bytes'](o.pinned(db))
    need(state == f['current_typed_database_state'] == live['current_typed_database_state'] == admission['database']['typed_state'] and
         len(state['tables']) == j['current_tables'] == f['current_typed_tables'] and
         sum(t['rows'] for t in state['tables'].values()) == j['current_rows'] == f['current_typed_rows'], 'FULL_TYPED_DB')
    return j, f, cas, pointer, state


def _trusted_envelope(d, o, trusted, env):
    """The caller supplies these pins from its reviewed context, never the DATA."""
    need(type(trusted) is dict and set(trusted) == {'owner_path', 'owner_pin', 'root', 'token',
         'current_judgment', 'current_facts', 'phase_module', 'typed_reader', 'source_membership'},
         'TRUSTED_CALLER_ENVELOPE')
    need(d['owner_thread_id'] == trusted['root'] and d['owner_execution_token'] == trusted['token'] and
         env.get('CODEX_THREAD_ID') == trusted['root'], 'TRUSTED_PROCESS_IDENTITY')
    for role in ('current_judgment', 'current_facts', 'phase_module', 'typed_reader'):
        need(d[role] == trusted[role], 'TRUSTED_' + role.upper())
    need(trusted['owner_pin']['path'] == trusted['owner_path'], 'TRUSTED_OWNER_PATH')
    owner = o.document(trusted['owner_pin'])
    _identity(owner, trusted['root'], trusted['token'])
    need(owner['status'] in ('active','ACTIVE') and owner['image_publication_hold_active'] is False and
         owner['live_image_installation_hold_active'] is False, 'TRUSTED_OWNER_ACTIVE_RELEASED')
    j = o.document(trusted['current_judgment']); f = o.document(trusted['current_facts'])
    need(j['current_owner'] == f['current_owner'] == trusted['owner_pin'], 'TRUSTED_OWNER_BINDING')
    need(set(io_members := o.io['source_membership']()) == set(trusted['source_membership']) and
         len(io_members) == len(set(io_members)) == len(trusted['source_membership']), 'TRUSTED_SOURCE_MEMBERSHIP')


def _ordinary_parent(d, j, o):
    pin, outer_pin = d['ordinary_parent'], d['ordinary_parent_outer0']
    ordinary = o.document(pin); outer = o.document(outer_pin)
    need(pin == j['ordinary_parent'] and outer_pin == j['ordinary_parent_outer0'] and
         ordinary['schema'] == 'STABLE_REVIEWED_IMAGE_BATCH_COMPACT_V1' and ordinary['result'] == 'PASS' and
         outer['receipt_version'] == pin and type(outer['actual_exit_code']) is int and outer['actual_exit_code'] == 0,
         'REAL_ORDINARY_PARENT')
    native = o.document(outer['actual_native_completion_receipt'])
    need(type(native['actual_exit_code']) is int and native['actual_exit_code'] == 0 and
         native['actual_checkpoint'] == pin, 'ORDINARY_PARENT_NATIVE0')
    return ordinary


def _recovery(record, d, j, cas, ordinary_pin, phase, o):
    need(type(record) is dict and set(record) == {'root_bridge'}, 'RECOVERY_RECORD_SHAPE')
    bridge = o.document(record['root_bridge']); _identity(bridge,d['owner_thread_id'],d['owner_execution_token'])
    need(bridge['schema'] == 'ROOT_COMPLETED_CANONICAL_TO_NORMAL_CANONICAL_BRIDGE_V1' and
         bridge['root_preservation_judgment'] is True and bridge['no_unlisted_or_future_change_admission'] is True and
         bridge['historical_failures_preserved'] is True and bridge['strict_historical_FAIL_preserved'] is True and
         all(bridge[k] is False for k in ('enabled','operational','technical_approval','replay_authorized',
             'future_changes_authorized','image_mutations_authorized')) and
         bridge['prior_ordinary_completed_base']['checkpoint'] == ordinary_pin, 'FINITE_RECOVERY_BRIDGE')
    summary_pin = bridge['recovered_compact']; summary = decode_recovery(o.document(summary_pin))
    prior_live = o.document(bridge['recovered_live']); primary = o.document(bridge['actual_primary_completion'])
    apply = o.document(bridge['actual_apply_completion']); readonly = o.document(bridge['actual_readonly_native0'])
    need(summary['recovered_live'] == bridge['recovered_live'] and
         summary['original_PRIMARY_completion'] == bridge['actual_primary_completion'] and
         summary['original_apply_completion'] == bridge['actual_apply_completion'] and
         summary['actual_readonly_native0'] == bridge['actual_readonly_native0'] and
         summary['original_failure'] == bridge['original_failure'] and
         summary['normal_STABLE_checkpoint_claimed'] is False and
         type(apply['actual_exit_code']) is int and apply['actual_exit_code'] == 1 and
         type(primary['exit_code']) is int and primary['exit_code'] == 0 and
         type(readonly['actual_exit_code']) is int and readonly['actual_exit_code'] == 0 and
         summary['original_apply_exit_code'] == bridge['original_apply_exit_code'] == 1 and
         summary['original_PRIMARY_exit_code'] == bridge['original_PRIMARY_exit_code'] == 0,
         'RECOVERY_APPLY1_PRIMARY0_READONLY0')
    o.pinned(bridge['original_failure'])
    bindings = dict(bridge['original_physical_operation_bindings'],completion_pin=bridge['actual_primary_completion'])
    retired = copy.deepcopy(bridge['retired_reviewed_observations']); pp = cas['new_current']['path']
    need(pp in retired and retired[pp]['current_version'] == bridge['current_pointer'] == cas['old_current'],
         'RECOVERY_DATED_CURRENT_CHAIN')
    retired[pp]['current_version'] = cas['new_current']; retired[pp]['authority'] = d['current_judgment']
    archive(bridge['prior_pointer_observation'],bridge['retained_prior_pointer'],o)
    progress = o.document(bridge['current_progress'])
    need(progress['prior_exact_current_marker'] == bridge['prior_pointer_observation'] and
         progress['no_reinstall_performed'] is True, 'RECOVERY_POINTER_ARCHIVE_CHAIN')
    for role in ('historical_software_validation_fixture','historical_observation_replacements'):
        bindings[role] = bridge[role]
    jobs = o.document(bindings['strict_manifest'])['jobs']
    need(bindings['strict_manifest'] == bridge['exact_canonical_jobs_from_immutable_strict_manifest'], 'RECOVERY_EXACT_JOBS')
    history = phase['canonical_completed_history'](bindings,jobs,bridge['retained_completed_control_copies'],o.phase_io(),retired)
    need(history['result'] == 'PASS_PHYSICAL_COMPLETED_HISTORY_NOT_CURRENT_STATE', 'RECOVERY_PHYSICAL_HISTORY')
    runtime = summary['runtime_creation_versions']
    need(prior_live['schema'] == 'CLASSIFIRE_COMPLETED_CANONICAL_POSTINSTALL_READONLY_RECONCILIATION_V1' and
         {v['sha256'] for v in runtime.values()} == {row['output']['sha256'] for row in jobs} and
         len(runtime) == summary['historical_canonical_delta_counted_once'] ==
         prior_live['runtime_new_canonical_delta'] == len(jobs), 'RECOVERY_RUNTIME_COUNT')
    for pin in runtime.values(): o.pinned(pin)
    return dict(summary=summary_pin,root_bridge=record['root_bridge'],runtime_creation_versions=runtime,
         jobs=jobs,physical_history=history,historical_apply_exit_code=1,historical_PRIMARY_exit_code=0,
         readonly_reconciliation_exit_code=0,operation_kind='readonly_recovered_canonical',counted_once=True)


def prepare_v2(descriptor_pin, io, *, trusted, env=None):
    """Pure qualification. IO has no write callback; result is never a compact PASS."""
    o = Observation(io); d = o.document(descriptor_pin)
    need(d['schema'] == DESCRIPTOR_SCHEMA and d['technical_approval'] is False, 'V2_DESCRIPTOR')
    env = os.environ if env is None else env
    _trusted_envelope(d,o,trusted,env)  # No dependency can execute before caller identity and pins.
    phase = o.module(d['phase_module'],trusted['phase_module'])
    typed = o.module(d['typed_reader'],trusted['typed_reader'])
    proof = o.document(d['operation_history']); bindings = proof['original_operation_bindings']
    manifest = o.document(bindings['manifest']); admission = o.document(d['original_admission'])
    live_pin = d['operation_live']; live = o.document(live_pin)
    pf = o.document(bindings['preflight']); completion = o.document(bindings['completion_pin'])
    strict = o.document(bindings['strict_manifest']); jobs = strict['jobs']
    root, token = d['owner_thread_id'], d['owner_execution_token']
    _identity(manifest,root,token)
    need(manifest['actual_finite_source_data_admission'] == d['original_admission'] and
         manifest['targets'] == live['actual_completed_jobs'] == completion['target_jobs'] and
         live['plan_version'] == bindings['manifest'] and live['preflight_creation_version'] == bindings['preflight'] and
         live['result'] == 'PASS' and type(completion['exit_code']) is int and completion['exit_code'] == 0 and
         completion['actual_completion_observed'] is True, 'ORIGINAL_STRICT_LIVE_LINEAGE')
    apply = o.document(d['apply_native'])
    need(type(apply['actual_exit_code']) is int and apply['actual_exit_code'] == 0, 'ACTUAL_APPLY0_REQUIRED')
    need(bindings['manifest']['path'] in apply['argv'] and 'apply' in apply['argv'], 'APPLY_ARGV_LINEAGE')
    outer = _outer(d['apply_outer0'],live_pin,root,token,o)
    need(outer['actual_native_result'] == d['apply_native'] and
         outer['actual_strict_completion'] == bindings['completion_pin'] and
         apply['manifest'] == bindings['manifest'] and apply['preflight'] == bindings['preflight'] and
         apply['actual_primary_completion'] == bindings['completion_pin'] and apply['actual_live'] == live_pin and
         apply['actual_ROOT_thread_id'] == root and apply['actual_root_execution_token'] == token,
         'EXACT_APPLY_NATIVE_OUTER_BINDING')
    need(live['helper_creation_version'] == manifest['reviewed_runner'] == pf['helper_creation_version'] and
         live['common_engine_version'] == manifest['common_engine_version'] == pf['common_engine_version'], 'ORIGINAL_PAIR')
    reviewed_runner_ast(o.pinned(manifest['reviewed_runner'])); o.pinned(manifest['common_engine_version'])
    j,f,cas,pointer,state = _current_context(d,manifest,admission,live,o,env,typed,trusted)
    need(j['operation_live'] == live_pin and j['operation_outer0'] == d['apply_outer0'], 'CURRENT_JUDGMENT_OPERATION')
    retired = proof['retired_reviewed_observations']
    need(retired == {cas['old_current']['path']:dict(original_observation=cas['old_current'],retained_copy=cas['backup'],
         current_version=cas['new_current'],authority=d['current_judgment'])}, 'EXACT_POINTER_RETIREMENT')
    history = phase['canonical_completed_history'](bindings,jobs,proof['retained_after_copies'],o.phase_io(),retired)
    need(history['result'] == 'PASS_PHYSICAL_COMPLETED_HISTORY_NOT_CURRENT_STATE', 'PHYSICAL_HISTORY_REQUIRED')
    backups = o.document(bindings['backups'])
    resolution = reconcile_logical_evidence(pf,backups,retired,o)
    ordinary_pin = d['ordinary_parent']; ordinary = _ordinary_parent(d,j,o)
    records = d['intervening_recoveries']
    need(type(records) is list and len(records) <= 12, 'RECOVERY_LIST_SCOPE')
    admitted = admission.get('completed_recovery_bridges')
    if 'completed_recovery_bridge' in admission:
        single = [admission['completed_recovery_bridge']]
        need(admitted is None or admitted == single, 'CONTRADICTORY_RECOVERY_ROLES')
        admitted = single
    need([r['root_bridge'] for r in records] == admitted, 'ADMISSION_RECOVERY_BINDING')
    recoveries = [_recovery(r,d,j,cas,ordinary_pin,phase,o) for r in records]
    need([r['summary'] for r in recoveries] == j['intervening_recoveries'] and
         len({r['summary']['path'] for r in recoveries}) == len(recoveries), 'EXACT_RECOVERY_LIST')
    cumulative = copy.deepcopy(ordinary['cumulative_new_runtime_creation_versions'])
    for row in recoveries:
        need(not set(cumulative)&set(row['runtime_creation_versions']), 'RUNTIME_COUNTED_ONCE')
        cumulative.update(row['runtime_creation_versions'])
    current_runtime = live['actual_new_runtime_creation_versions']
    need(not set(cumulative)&set(current_runtime), 'RUNTIME_COUNTED_ONCE'); cumulative.update(current_runtime)
    need(live['protected_member_count_before'] == admission['protected']['existing_count'] and
         live['protected_file_count'] == live['protected_member_count_after'] == f['existing_protected_count'], 'BASELINE_COUNTS')
    def fence():
        need(io['git']() == dict(head=f['actual_current_source']['head'],tree=f['actual_current_source']['tree'],clean=True), 'END_GIT')
        need(set(io['source_membership']()) == set(trusted['source_membership']), 'END_SOURCE_MEMBERSHIP')
        categories,missing = io['inventory'](admission['protected']['inventory_definition'])
        need(categories == f['inventory_categories'] and missing == f['missing_fixed_paths'], 'END_INVENTORY')
        o.fence()
    fence()  # All gates precede candidate construction, and run again at construction.
    payload = dict(schema='QUALIFIED_DUAL_CONTEXT_CHECKPOINT_V2_READONLY',descriptor=d,descriptor_pin=descriptor_pin,
        manifest=manifest,bindings=bindings,pf=pf,live=live,live_pin=live_pin,outer=outer,current_judgment=j,
        current_facts=f,current_pointer=pointer,typed_state=state,ordinary=ordinary,ordinary_pin=ordinary_pin,
        ordinary_outer_pin=d['ordinary_parent_outer0'],recoveries=recoveries,cumulative_runtime=cumulative,
        evidence_resolution=resolution,physical_history=history,
        participating_pin_count=len(o.pins),all_gates_before_candidate=True,writer_authorized=False)
    handle = object.__new__(QualifiedCheckpoint)
    _ISSUED_HANDLES[handle] = (json.dumps(payload,sort_keys=True).encode('utf8'),fence)
    return handle


def build_candidate_v2(q):
    need(type(q) is QualifiedCheckpoint and q in _ISSUED_HANDLES, 'PRIVATE_QUALIFICATION_HANDLE')
    _ISSUED_HANDLES[q][1](); q = q.data
    need(q['schema'] == 'QUALIFIED_DUAL_CONTEXT_CHECKPOINT_V2_READONLY' and
         q['all_gates_before_candidate'] is True and q['writer_authorized'] is False, 'UNQUALIFIED_CANDIDATE')
    d,live,pf,m = q['descriptor'],q['live'],q['pf'],q['manifest']
    # V2 explicitly exposes the recovered interlude; never claim its apply1 was0.
    prior = [{k:v for k,v in row.items() if k not in ('jobs','physical_history')} for row in q['recoveries']]
    operation = dict(operation_kind='canonical',manifest=q['bindings']['manifest'],live=q['live_pin'],
        root_outer0=d['apply_outer0'],preflight=q['bindings']['preflight'],strict_completion=q['bindings']['completion_pin'],
        strict_manifest=q['bindings']['strict_manifest'],before_backups=q['bindings']['backups'])
    return dict(result='QUALIFIED_CANDIDATE_NOT_EXECUTED',schema=CANDIDATE_SCHEMA,final_schema_requires_review=COMPACT_SCHEMA,
        owner_thread_id=d['owner_thread_id'],owner_execution_token=d['owner_execution_token'],
        previous_base=q['ordinary_pin'],previous_base_outer0=q['ordinary_outer_pin'],
        intervening_completed_recoveries=prior,actual_batch_delta=operation,
        all_actual_bounded_deltas=copy.deepcopy(q['ordinary']['all_actual_bounded_deltas'])+prior+[operation],
        current_critical_versions=live['current_state_snapshots'],before_critical_versions=pf['critical'],
        current_automation=m['controls']['automation'],status_counts=live['status_counts'],
        registered_source_aliases=live['registered_source_aliases'],active_unique_registered_assets=live['active_unique_registered_assets'],
        before_protected_file_count=live['protected_member_count_before'],protected_file_count=live['protected_file_count'],
        cumulative_new_runtime_creation_versions=q['cumulative_runtime'],
        three_prior_runtime_creation_versions=q['ordinary']['three_prior_runtime_creation_versions'],
        new_PNGs=live['new_PNGs'],new_canonical_assets=live['new_canonical_assets'],actual_provider_calls_by_installer=0,
        finite_evidence_versions=pf['reviewed_evidence_versions'],historical_physical_evidence_resolution=q['evidence_resolution'],
        current_publication_judgment=d['current_judgment'],current_publication_facts=d['current_facts'],
        actual_current_pointer_at_qualification=q['current_judgment']['current_pointer'],
        installation_runner_version=m['reviewed_runner'],installation_common_engine_version=m['common_engine_version'],
        actual_browser_review=q['outer']['actual_browser_review'],actual_packet_local0=q['outer']['actual_packet_local0'],
        applied_workflow=q['outer']['applied_workflow'],current_typed_database_state=q['typed_state'],
        current_source_HEAD=q['current_facts']['actual_current_source']['head'],
        current_source_tree=q['current_facts']['actual_current_source']['tree'],
        actual_checkpoint_native_completion=None,actual_checkpoint_root_outer0=None,
        ordinary_checkpoint_written=False,pointer_mutations=0,operational=False,technical_approval=False,scope_complete=False)


def checkpoint_v2(*args, **kwargs):
    raise ValueError('V2_WRITER_DISABLED_PENDING_TRACKED_REVIEW_READER_REGISTRATION_AND_ROOT_WRITER_AUTHORITY')


if __name__ == '__main__':
    raise SystemExit('DISABLED_GENERIC_DUAL_CONTEXT_CHECKPOINT_NO_WRITER')
