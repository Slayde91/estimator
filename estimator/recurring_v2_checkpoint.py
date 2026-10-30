"""Private recurring V2 history/qualification prototype, no writer or script.

The caller supplies approved Python namespaces; receipt DATA never selects code.
Published history and fresh current-state qualification are separate proofs.
"""
from collections.abc import Mapping
import copy
import json
import os
from pathlib import PureWindowsPath
from types import SimpleNamespace
import weakref

DEFAULT_ENABLED = False
PARENT_SCHEMA = 'ROOT_PUBLISHED_V2_COMPLETED_PARENT_BINDINGS_V1'
POST_CONTEXT_SCHEMA = 'ROOT_FINITE_RECURRING_V2_POST_OPERATION_CURRENT_CONTEXT_V1'
UNPUBLISHED = 'INSTALLED_OPERATION_UNPUBLISHED'
MAX_ANCESTRY_NODES = 256
PARENT_KEYS = {'schema', 'checkpoint', 'actual_native_completion', 'ROOT_outer0',
               'publication_CAS', 'readback', 'published_pointer_observation', 'publisher_identity'}
_HISTORY = weakref.WeakKeyDictionary()
_QUALIFICATIONS = weakref.WeakKeyDictionary()


def need(value, code):
    if not value:
        raise ValueError(code)


def ns(value):
    return value if isinstance(value, dict) else vars(value)


class PublishedHistory(Mapping):
    """Opaque issued proof. Reading .data never exposes its stored payload."""
    __slots__ = ('__weakref__',)
    __hash__ = object.__hash__
    __eq__ = object.__eq__

    def __new__(cls, *args, **kwargs):
        raise ValueError('ISSUED_HISTORY_REQUIRED')

    @property
    def data(self):
        need(self in _HISTORY, 'ISSUED_HISTORY_REQUIRED')
        return json.loads(_HISTORY[self][0])

    def __getitem__(self, key):
        return self.data[key]

    def __iter__(self):
        return iter(self.data)

    def __len__(self):
        return len(self.data)


class QualifiedRecurring:
    __slots__ = ('__weakref__',)

    def __new__(cls, *args, **kwargs):
        raise ValueError('ISSUED_RECURRING_QUALIFICATION_REQUIRED')

    @property
    def data(self):
        need(self in _QUALIFICATIONS, 'ISSUED_RECURRING_QUALIFICATION_REQUIRED')
        return json.loads(_QUALIFICATIONS[self][0])


def fence_published_history(handle):
    need(type(handle) is PublishedHistory and handle in _HISTORY, 'ISSUED_HISTORY_REQUIRED')
    _HISTORY[handle][1]()


def _operation(leaf, o, r):
    op = leaf['actual_batch_delta']
    m, live, complete, strict, outer = (o.document(op[k]) for k in
        ('manifest', 'live', 'strict_completion', 'strict_manifest', 'root_outer0'))
    targets = m['targets']
    need(type(targets) is list and 1 <= len(targets) <= 12 and all(type(n) is int for n in targets)
         and len(set(targets)) == len(targets), 'NEW_OPERATION_TARGETS')
    need(op['operation_kind'] == 'canonical' and live['result'] == 'PASS'
         and live['plan_version'] == op['manifest'] and live['preflight_creation_version'] == op['preflight']
         and targets == live['actual_completed_jobs'] == complete['target_jobs']
         and complete['actual_completion_observed'] is True
         and outer['receipt_version'] == op['live'], 'NEW_OPERATION_LINEAGE')
    r['integer'](complete['exit_code'], 0, 'NEW_OPERATION_STRICT0')
    r['integer'](outer['actual_exit_code'], 0, 'NEW_OPERATION_OUTER0')
    apply = o.document(outer['actual_native_result'])
    r['integer'](apply['actual_exit_code'], 0, 'NEW_OPERATION_APPLY0')
    need(apply['actual_live'] == op['live'] and apply['manifest'] == op['manifest']
         and apply['actual_primary_completion'] == op['strict_completion'], 'NEW_OPERATION_NATIVE_BINDING')
    runtime = live['actual_new_runtime_creation_versions']
    need(len(runtime) == len(strict['jobs']) == len(targets)
         and {p['sha256'] for p in runtime.values()} == {j['output']['sha256'] for j in strict['jobs']},
         'NEW_OPERATION_RUNTIME')
    need(len({p['sha256'] for p in runtime.values()}) == len(runtime), 'NEW_OPERATION_DISTINCT_RUNTIME')
    for path, pin in runtime.items():
        need(path == pin['path'], 'RUNTIME_PATH'); o.pinned(pin)
    for key in ('preflight', 'before_backups'):
        o.pinned(op[key])
    return op, runtime


def _published_node(binding, leaf, leaf_pin, descendant, o, r):
    need(type(binding) is dict and set(binding) == PARENT_KEYS and binding['schema'] == PARENT_SCHEMA
         and binding['checkpoint'] == leaf_pin, 'PARENT_BINDING_SHAPE')
    native = o.document(binding['actual_native_completion']); outer = o.document(binding['ROOT_outer0'])
    root, token = leaf['owner_thread_id'], leaf['owner_execution_token']
    r['identity'](native, root, token)
    need(native['schema'] == r['NATIVE_SCHEMA'] and native['receipt_version'] == leaf_pin
         and native['writer_authority'] == leaf['writer_authority'] and native['writer_journal'] == leaf['writer_journal']
         and native['actual_completion_observed'] is True and native['no_primary_invoked'] is True
         and native['no_application_mutations'] is True, 'PARENT_NATIVE_LINEAGE')
    r['integer'](native['actual_exit_code'], 0, 'PARENT_NATIVE0')
    proposal = o.document(native['publication_proposal'])
    permit = o.document(leaf['writer_authority']['permit'])
    need(proposal['schema'] == 'ROOT_IMAGE_CHECKPOINT_V2_PRIVATE_PUBLICATION_PROPOSAL_V1'
         and proposal['checkpoint'] == leaf_pin and proposal['old_current'] == leaf['before_publication_pointer']
         and proposal['writer_authority'] == leaf['writer_authority'] and proposal['writer_journal'] == leaf['writer_journal']
         and native['publication_proposal']['path'] == permit['outputs']['proposal']
         and proposal['actual_native_completion_required'] is True and proposal['actual_ROOT_outer0_required'] is True
         and proposal['current_pointer_written'] is False and proposal['technical_approval'] is False,
         'PARENT_PROPOSAL_LINEAGE')
    r['identity'](proposal, root, token)
    r['integer'](proposal['application_mutations'], 0, 'PARENT_PROPOSAL_MUTATIONS')
    need(outer['schema'] == r['OUTER_SCHEMA'] and outer['receipt_version'] == leaf_pin
         and outer['actual_native_completion_receipt'] == binding['actual_native_completion']
         and outer['observed_by_actual_root_thread_id'] == root and outer['owner_execution_token'] == token,
         'PARENT_ROOT_OUTER_LINEAGE')
    r['integer'](outer['actual_exit_code'], 0, 'PARENT_ROOT_OUTER0')
    cas = o.document(binding['publication_CAS'])
    publisher = binding['publisher_identity']
    need(set(publisher) == {'owner_thread_id', 'owner_execution_token'}, 'PUBLISHER_IDENTITY')
    r['identity'](cas, publisher['owner_thread_id'], publisher['owner_execution_token'])
    observed = binding['published_pointer_observation']
    need(cas['schema'] == r['CAS_SCHEMA'] and cas['old_current'] == leaf['before_publication_pointer']
         and cas['new_current'] == observed and cas['checkpoint'] == leaf_pin
         and cas['checkpoint_native'] == binding['actual_native_completion']
         and cas['checkpoint_outer0'] == binding['ROOT_outer0'] and cas['readback'] == binding['readback']
         and cas['ordinary_parent_preserved'] is True and cas['recoveries_preserved'] is True,
         'PARENT_CAS_LINEAGE')
    r['integer'](cas['control_mutations'], 0, 'PARENT_CAS_MUTATIONS')
    before = json.loads(o.archive(cas['old_current'], cas['backup']))
    need(before['latest_completed_receipt'] == leaf['previous_base']
         and before['actual_checkpoint_root_outer0'] == leaf['previous_base_outer0'], 'PARENT_CAS_PRIOR_BASE')
    if descendant is None:
        pointer = o.document(observed)
    else:
        # The actual child's CAS, not a caller's virtual old-path view, retires
        # its parent's published CURRENT observation into honest retained bytes.
        need(descendant['cas']['old_current'] == descendant['leaf']['before_publication_pointer'] == observed,
             'CAUSAL_DESCENDANT_POINTER_EDGE')
        pointer = json.loads(o.archive(observed, descendant['cas']['backup']))
    need(pointer['latest_completed_receipt'] == leaf_pin
         and pointer['actual_checkpoint_root_outer0'] == binding['ROOT_outer0'], 'PUBLISHED_POINTER_CONTENT')
    readback = o.document(binding['readback'])
    need(readback['schema'] == r['READBACK_SCHEMA'] and readback['new_current'] == observed
         and readback['checkpoint'] == leaf_pin and readback['checkpoint_native'] == binding['actual_native_completion']
         and readback['checkpoint_outer0'] == binding['ROOT_outer0'] and readback['readback_exact'] is True,
         'PARENT_READBACK')
    return dict(cas=cas, leaf=leaf, pointer=pointer, outer=outer, binding=binding)


def read_published_v2_history(leaf_pin, io, *, trusted, approved_reader, env=None, max_nodes=MAX_ANCESTRY_NODES):
    """Return dated published history only, without requalifying current Q/RI."""
    r = ns(approved_reader)
    need(type(trusted) is dict and set(trusted) == r['TRUSTED_KEYS'] and trusted['leaf'] == leaf_pin,
         'EXTERNAL_HISTORY_ENVELOPE')
    need(type(max_nodes) is int and 1 <= max_nodes <= MAX_ANCESTRY_NODES, 'FINITE_ANCESTRY_BOUND')
    env = os.environ if env is None else env
    need(env.get('CODEX_THREAD_ID') == trusted['root'] and trusted['owner_pin']['path'] == trusted['owner_path'],
         'ACTUAL_HISTORY_PROCESS')
    o = r['Observation'](io)
    owner = o.document(trusted['owner_pin'])
    r['identity'](owner, trusted['root'], trusted['token'])
    need(owner['status'] in ('active', 'ACTIVE') and owner['image_publication_hold_active'] is False
         and owner['live_image_installation_hold_active'] is False
         and owner['all_image_mutations_guarded_until_valid_claim_and_app_retarget'] is False
         and owner['automation_retarget_pending'] is False, 'HISTORY_CURRENT_OWNER')
    top_cas = o.document(trusted['publication_CAS'])
    r['identity'](top_cas,trusted['root'],trusted['token'])
    binding = dict(schema=PARENT_SCHEMA, checkpoint=leaf_pin, actual_native_completion=trusted['native_completion'],
        ROOT_outer0=trusted['root_outer0'], publication_CAS=trusted['publication_CAS'], readback=top_cas['readback'],
        published_pointer_observation=trusted['current_pointer'],
        publisher_identity=dict(owner_thread_id=trusted['root'],owner_execution_token=trusted['token']))
    seen = set(); nodes = []
    def visit(b, descendant=None):
        key = (b['checkpoint']['path'], b['checkpoint']['sha256'])
        need(key not in seen and len(seen) < max_nodes, 'CYCLIC_OR_EXCESS_ANCESTRY')
        seen.add(key); leaf = o.document(b['checkpoint'])
        need(leaf['schema'] == r['COMPACT_SCHEMA'] and leaf['result'] == 'PASS'
             and leaf['ordinary_checkpoint_written'] is True and leaf['publication_completed'] is False
             and leaf['operational'] is False and leaf['technical_approval'] is False and leaf['scope_complete'] is False
             and leaf['actual_checkpoint_native_completion'] is None and leaf['actual_checkpoint_root_outer0'] is None,
             'PUBLISHED_V2_LEAF')
        r['integer'](leaf['pointer_mutations'], 0, 'LEAF_POINTER_MUTATIONS')
        r['_code_authority'](b['checkpoint'], leaf, o)
        publication = _published_node(b, leaf, b['checkpoint'], descendant, o, r)
        nodes.append(publication)
        parent = o.document(leaf['previous_base'])
        if parent['schema'] == 'STABLE_REVIEWED_IMAGE_BATCH_COMPACT_V1':
            need('completed_parent_v2' not in leaf, 'CONTRADICTORY_PARENT_SELECTOR')
            ordinary, recoveries, op, cumulative = r['_historical_base'](leaf, o)
            root = dict(checkpoint=leaf['previous_base'],outer0=leaf['previous_base_outer0'])
            return ordinary, root, recoveries, [op], cumulative, leaf['all_actual_bounded_deltas']
        need(parent['schema'] == r['COMPACT_SCHEMA'] and 'completed_parent_v2' in leaf, 'EXPLICIT_V2_PARENT_REQUIRED')
        parent_b = leaf['completed_parent_v2']
        need(parent_b['checkpoint'] == leaf['previous_base'] and parent_b['ROOT_outer0'] == leaf['previous_base_outer0'],
             'IMMEDIATE_V2_PARENT_BINDING')
        if 'completed_parent_v2_binding' in leaf:
            need(o.document(leaf['completed_parent_v2_binding']) == parent_b, 'PARENT_LITERAL_BINDING_DOCUMENT')
        ordinary, root, recoveries, operations, cumulative, prefix = visit(parent_b, publication)
        need(leaf['intervening_completed_recoveries'] == [], 'NEW_RECOVERIES_REQUIRE_EXPLICIT_CONTRACT')
        op, runtime = _operation(leaf, o, r)
        need(not set(cumulative).intersection(runtime)
             and not {p['sha256'] for p in cumulative.values()}.intersection(p['sha256'] for p in runtime.values()),
             'RUNTIME_OR_DELTA_COUNTED_TWICE')
        need(op not in operations and op['strict_completion'] not in [x['strict_completion'] for x in operations],
             'REPEATED_OPERATION_DELTA')
        cumulative = dict(cumulative, **runtime)
        need(leaf['all_actual_bounded_deltas'] == prefix + [op]
             and leaf['cumulative_new_runtime_creation_versions'] == cumulative, 'EXACT_PARENT_HISTORY_PREFIX')
        need(leaf['original_ordinary_root'] == root, 'ORIGINAL_ORDINARY_ROOT_PRESERVED')
        return ordinary, root, recoveries, operations + [op], cumulative, prefix + [op]
    ordinary, root, recoveries, operations, cumulative, deltas = visit(binding)
    pointer = nodes[0]['pointer']
    r['identity'](pointer, trusted['root'], trusted['token'])
    need(pointer['image_publication_hold_active'] is False and pointer['live_image_installation_hold_active'] is False
         and pointer['all_image_mutations_guarded_until_valid_claim_and_app_retarget'] is False, 'HISTORY_CURRENT_POINTER')
    o.fence()
    payload = dict(result='PASS_DATED_PUBLISHED_V2_HISTORY_NOT_CURRENT_SCOPE', historical_leaf_snapshot=nodes[0]['leaf'],
        outer_document=nodes[0]['outer'],pointer_document=pointer,original_ordinary_root=root,ordinary_parent_snapshot=ordinary,
        immediate_completed_parent=nodes[0]['leaf']['previous_base'],intervening_completed_recoveries=recoveries,
        ordered_operations=operations,all_actual_bounded_deltas=deltas,cumulative_new_runtime_creation_versions=cumulative,
        top_publication_binding=binding,ancestry_node_count=len(nodes),participation_versions=o.pins,participation_native=o.natives,
        history_only=True,current_state_claimed=False,installer_invocation_authorized=False,replay_authorized=False,
        shared_mutations=0,technical_approval=False)
    handle = object.__new__(PublishedHistory)
    _HISTORY[handle] = (json.dumps(payload,sort_keys=True).encode(),o.fence)
    return handle


_BASE_TRUSTED_KEYS = {'owner_path', 'owner_pin', 'root', 'token', 'current_judgment',
                     'current_facts', 'phase_module', 'typed_reader', 'source_membership'}
_RECURRING_TRUSTED_KEYS = _BASE_TRUSTED_KEYS | {'completed_parent_v2', 'parent_reader_trusted',
                                             'parent_reader_pin', 'original_core_pin'}


def _post_current(d, manifest, admission, live, o, typed, trusted, history, c):
    """New operation is installed; its checkpoint has not yet been published."""
    j = o.document(d['current_judgment']); f = o.document(d['current_facts'])
    root, token = d['owner_thread_id'], d['owner_execution_token']
    c['_identity'](j, root, token)
    need(j['schema'] == POST_CONTEXT_SCHEMA and j['root_preservation_judgment'] is True
         and j['current_publication_context_admitted'] is True and j['no_unlisted_or_future_change_admission'] is True
         and j['actual_fresh_current_facts'] == d['current_facts']
         and j['allowed_completed_jobs'] == manifest['targets']
         and j['completed_parent_v2'] == d['completed_parent_v2']
         and j['current_publication_state'] == UNPUBLISHED and j['pointer_publications'] == [],
         'EXPLICIT_UNPUBLISHED_OPERATION_CONTEXT')
    need(all(j[k] is False for k in ('executable_checkpoint_writer_admitted','operational','enabled',
         'image_mutations_authorized','future_changes_authorized','new_generation_authorized',
         'new_acceptance_authorized','new_installation_authorized','technical_approval')), 'FINITE_NEW_OPERATION_CONTEXT')
    need(f['schema'] == 'ROOT_POST_INSTALL_CURRENT_PUBLICATION_SOURCE_PROTECTED_FACTS_NOT_ADMISSION_V1'
         and all(f[k] is False for k in ('source_or_protected_preservation_admitted','ROOT_preservation_judgment',
             'operational','enabled','technical_approval','future_changes_authorized'))
         and type(f['shared_mutations']) is int and f['shared_mutations'] == 0, 'POST_FACTS_NOT_AUTHORITY')
    owner = o.document(j['current_owner']); pointer = o.document(j['current_pointer'])
    need(owner['status'] in ('active','ACTIVE'), 'ACTIVE_NEW_OPERATION_OWNER')
    for obj in (owner, pointer):
        c['_identity'](obj, root, token)
        need(obj['image_publication_hold_active'] is False and obj['live_image_installation_hold_active'] is False,
             'CURRENT_HOLDS')
    b = history['top_publication_binding']
    need(j['current_owner'] == f['current_owner'] == manifest['controls']['owner'] == trusted['owner_pin']
         and j['current_pointer'] == f['current_pointer'] == manifest['expected_current_pointer']
         == b['published_pointer_observation']
         and pointer['latest_completed_receipt'] == b['checkpoint']
         and pointer['actual_checkpoint_root_outer0'] == b['ROOT_outer0']
         and j['actual_owner_claim_guard_released'] is True
         and j['actual_all_image_mutations_guarded_until_valid_claim_and_app_retarget'] is False
         and pointer['all_image_mutations_guarded_until_valid_claim_and_app_retarget'] is False
         and pointer['current_image_mutations_require_reviewed_receiving_execution_image_successor'] is True
         and pointer['scope_complete'] is False and pointer['technical_approval'] is False
         and j['actual_same_active_owner_claim_and_release_preserved'] is True, 'CURRENT_PARENT_POINTER_AND_RELEASE')
    import tomllib
    auto = tomllib.loads(o.pinned(manifest['controls']['automation']).decode('utf8'))
    need(auto['kind'] == 'heartbeat' and auto['status'] == 'ACTIVE' and auto['target_thread_id'] == root,
         'CURRENT_ACTIVE_AUTOMATION')
    need(f['current_six_controls'] == j['current_six_controls'] == live['current_state_snapshots']
         and len(f['current_six_controls']) == 6, 'NEW_OPERATION_CONTROL_SCOPE')
    for path, pin in f['current_six_controls'].items():
        need(path == pin['path'], 'CONTROL_PATH'); o.pinned(pin)
    need(f['all63_policy_pins'] == j['all63_current_policy_members'] == admission['policy_members']
         and len(f['all63_policy_pins']) == 63, 'NEW_OPERATION_POLICY_SCOPE')
    for path, pin in f['all63_policy_pins'].items():
        need(path == pin['path'], 'POLICY_PATH'); o.pinned(pin)
    o.pinned(f['active_policy_index'])
    source, before = f['actual_current_source'], admission['source']
    members = o.io['source_membership']()
    need(source['head'] == j['current_actual_source_HEAD'] == before['head']
         and source['tree'] == j['current_actual_source_tree'] == before['tree'] and source['clean'] is True
         and source['fullpins'] == before['worktree_fullpins']
         and source['tracked_count'] == j['current_source_count'] == len(source['fullpins'])
         and set(source['fullpins']) == set(source['native6']) == set(trusted['source_membership']) == set(members)
         and len(members) == len(set(members)) == len(trusted['source_membership']), 'NEW_OPERATION_SOURCE_SCOPE')
    need(o.io['git']() == dict(head=source['head'],tree=source['tree'],clean=True), 'CURRENT_GIT')
    pre = o.document(f['pre_install_facts'])
    need(source['fullpins'] == pre['actual_current_source']['fullpins']
         and source['native6'] == pre['actual_current_source']['native6'], 'NO_UNLISTED_SOURCE_CHANGE')
    protected = dict(admission['protected']['fullpins']); runtime = live['actual_new_runtime_creation_versions']
    changes = j['exact_authorised_protected_changes']
    need(set(changes) == set(f['protected_content_changes'])
         and j['exact_authorised_protected_addition'] == f['protected_added'] == runtime
         and not set(runtime).intersection(protected), 'FINITE_NEW_PROTECTED_DELTA')
    for path, row in changes.items():
        need(protected.get(path) == row['before'] and f['protected_content_changes'][path] == row
             and row['after'] == f['current_six_controls'][path], 'EXACT_NEW_PROTECTED_REPLACEMENT')
        protected[path] = row['after']
    protected.update(runtime)
    categories = dict(admission['protected']['categories'])
    categories.update({p:'private reference library' for p in runtime})
    need(protected == f['protected_fullpins'] and set(protected) == set(f['protected_native6'])
         and f['inventory_categories'] == categories
         and f['missing_fixed_paths'] == admission['protected']['missing_fixed_paths']
         and f['existing_protected_count'] == j['current_protected_file_count'] == len(protected)
         and f['membership_names'] == j['current_membership_count'] == len(categories)
         and f['protected_removed'] == [] and f['protected_category_changes'] == {}, 'CLOSED_POST_PROTECTED_SCOPE')
    need(all(n == pre['protected_native6'][p] for p,n in f['protected_native6'].items()
         if p not in set(changes) | set(runtime)), 'UNLISTED_PROTECTED_NATIVE')
    for pins,natives in ((source['fullpins'],source['native6']),(protected,f['protected_native6'])):
        for path,pin in pins.items():
            need(path == pin['path'] and natives[path][:2] == [pin['bytes'],pin['mtime_ns']],
                 'SOURCE_PROTECTED_NATIVE_METADATA_SCOPE')
            o.native(path,natives[path])
    for pin in list(runtime.values()) + [row['after'] for row in changes.values()]: o.pinned(pin)
    need(o.io['inventory'](admission['protected']['inventory_definition'])
         == (categories, f['missing_fixed_paths']), 'FRESH_POST_INVENTORY')
    db = f['current_DB']
    need(db == j['current_database'] == admission['database']['current_fullpin'], 'CURRENT_DATABASE_PIN')
    need(all(not o.io['exists'](db['path'] + s) for s in ('-wal','-shm','-journal')), 'DATABASE_SIDECARS')
    state, unused = typed['typed_bytes'](o.pinned(db))
    need(state == f['current_typed_database_state'] == live['current_typed_database_state']
         == admission['database']['typed_state']
         and len(state['tables']) == j['current_tables'] == f['current_typed_tables']
         and sum(t['rows'] for t in state['tables'].values()) == j['current_rows'] == f['current_typed_rows'],
         'FULL_POST_TYPED_DATABASE')
    return j, f, pointer, state


def create_recurring_core(original_core, approved_reader, *, original_core_pin, approved_reader_pin):
    """Approved caller namespaces only; no executable dependency comes from DATA."""
    c, r = ns(original_core), ns(approved_reader)
    need(original_core_pin['path'] == c['__file__'] and approved_reader_pin['path'] == r['__file__'],
         'APPROVED_NAMESPACE_PATHS')
    default_proofs = weakref.WeakKeyDictionary()

    def trusted_envelope(d, o, trusted, env):
        for pin in (original_core_pin, approved_reader_pin): o.pinned(pin)
        if 'completed_parent_v2' not in d:
            return c['_trusted_envelope'](d,o,trusted,env)
        need(type(trusted) is dict and set(trusted) == _RECURRING_TRUSTED_KEYS, 'EXTERNAL_RECURRING_ENVELOPE')
        need(d['completed_parent_v2'] == trusted['completed_parent_v2']
             and d['parent_reader_pin'] == trusted['parent_reader_pin'] == approved_reader_pin
             and d['original_core_pin'] == trusted['original_core_pin'] == original_core_pin, 'APPROVED_RECURRING_DEPENDENCIES')
        parent = trusted['parent_reader_trusted']
        need(parent['root'] == trusted['root'] and parent['token'] == trusted['token']
             and parent['owner_pin'] == trusted['owner_pin'], 'PARENT_CURRENT_IDENTITY')
        c['_trusted_envelope'](d,o,{k:trusted[k] for k in _BASE_TRUSTED_KEYS},env)

    def prepare(descriptor_pin, io, *, trusted, env=None):
        o = c['Observation'](io); d = o.document(descriptor_pin)
        for pin in (original_core_pin, approved_reader_pin): o.pinned(pin)
        if 'completed_parent_v2' not in d:
            result = c['prepare_v2'](descriptor_pin,io,trusted=trusted,env=env)
            o.fence()
            default_proofs[result] = o
            return result
        env = os.environ if env is None else env
        need(d['schema'] == c['DESCRIPTOR_SCHEMA'] and d['technical_approval'] is False, 'RECURRING_DESCRIPTOR')
        trusted_envelope(d,o,trusted,env)
        parent_binding = o.document(d['completed_parent_v2'])
        history = read_published_v2_history(parent_binding['checkpoint'],io,
            trusted=trusted['parent_reader_trusted'],approved_reader=approved_reader,env=env)
        need(parent_binding == history['top_publication_binding'], 'EXACT_PUBLISHED_PARENT_BINDING')
        need(d['ordinary_parent'] == parent_binding['checkpoint']
             and d['ordinary_parent_outer0'] == parent_binding['ROOT_outer0']
             and d['original_ordinary_root'] == history['original_ordinary_root'], 'HONEST_IMMEDIATE_AND_ORDINARY_ROOT_ROLES')
        phase = o.module(d['phase_module'],trusted['phase_module'])
        typed = o.module(d['typed_reader'],trusted['typed_reader'])
        proof = o.document(d['operation_history']); bindings = proof['original_operation_bindings']
        m = o.document(bindings['manifest']); a = o.document(d['original_admission'])
        live = o.document(d['operation_live']); pf = o.document(bindings['preflight'])
        completion = o.document(bindings['completion_pin']); strict = o.document(bindings['strict_manifest'])
        jobs = strict['jobs']; root, token = d['owner_thread_id'], d['owner_execution_token']
        c['_identity'](m,root,token)
        need(m['actual_finite_source_data_admission'] == d['original_admission']
             and m['targets'] == live['actual_completed_jobs'] == completion['target_jobs']
             and live['plan_version'] == bindings['manifest'] and live['preflight_creation_version'] == bindings['preflight']
             and live['result'] == 'PASS' and type(completion['exit_code']) is int and completion['exit_code'] == 0
             and completion['actual_completion_observed'] is True, 'NEW_STRICT_LIVE_LINEAGE')
        apply = o.document(d['apply_native'])
        need(type(apply['actual_exit_code']) is int and apply['actual_exit_code'] == 0
             and bindings['manifest']['path'] in apply['argv'] and 'apply' in apply['argv'], 'NEW_ACTUAL_APPLY0')
        outer = c['_outer'](d['apply_outer0'],d['operation_live'],root,token,o)
        need(outer['actual_native_result'] == d['apply_native'] and outer['actual_strict_completion'] == bindings['completion_pin']
             and apply['manifest'] == bindings['manifest'] and apply['preflight'] == bindings['preflight']
             and apply['actual_primary_completion'] == bindings['completion_pin'] and apply['actual_live'] == d['operation_live']
             and apply['actual_ROOT_thread_id'] == root and apply['actual_root_execution_token'] == token, 'NEW_APPLY_NATIVE_OUTER_BINDING')
        need(live['helper_creation_version'] == m['reviewed_runner'] == pf['helper_creation_version']
             and live['common_engine_version'] == m['common_engine_version'] == pf['common_engine_version'], 'NEW_ORIGINAL_PAIR')
        c['reviewed_runner_ast'](o.pinned(m['reviewed_runner'])); o.pinned(m['common_engine_version'])
        need(a['completed_base']['checkpoint'] == parent_binding['checkpoint']
             and a['completed_base']['outer0'] == parent_binding['ROOT_outer0']
             and a['completed_base']['pointer'] == parent_binding['published_pointer_observation']
             and a['completed_base']['six_controls'] == history['historical_leaf_snapshot']['current_critical_versions'],
             'ADMISSION_EXACT_V2_PARENT')
        initial = o.document(trusted['parent_reader_trusted']['current_facts'])
        initial_context = o.document(trusted['parent_reader_trusted']['current_context'])
        r['_finite'](initial_context)
        r['identity'](initial_context,root,token)
        need(initial_context['schema'] == r['CONTEXT_SCHEMA']
             and initial_context['completed_base'] == parent_binding['checkpoint']
             and initial_context['current_facts'] == trusted['parent_reader_trusted']['current_facts']
             and initial_context['declared_current_facts'] == initial
             and initial['schema'] == r['FACTS_SCHEMA'], 'FINITE_INITIAL_CURRENT_SNAPSHOT')
        need(a['source']['head'] == initial['actual_current_source']['head']
             and a['source']['tree'] == initial['actual_current_source']['tree']
             and a['source']['worktree_fullpins'] == initial['actual_current_source']['fullpins']
             and a['protected']['fullpins'] == initial['protected_fullpins']
             and a['protected']['native_metadata'] == initial['protected_native6']
             and a['protected']['categories'] == initial['inventory_categories']
             and a['protected']['missing_fixed_paths'] == initial['missing_fixed_paths']
             and a['protected']['inventory_definition'] == initial['inventory_definition']
             and a['database']['current_fullpin'] == initial['current_DB']
             and a['database']['typed_state'] == initial['current_typed_database_state']
             and a['policy_members'] == initial['all63_policy_pins']
             and a['completed_base']['six_controls'] == initial['current_six_controls'],
             'INITIAL_ADMISSION_BASELINE_EXACT')
        need(pf['critical'] == a['completed_base']['six_controls']
             == history['historical_leaf_snapshot']['current_critical_versions']
             == initial['current_six_controls'], 'NEW_PREFLIGHT_EXACT_PUBLISHED_PARENT_BASE')
        j,f,pointer,state = _post_current(d,m,a,live,o,typed,trusted,history,c)
        initial_pre = o.document(f['pre_install_facts'])
        need(initial_pre['actual_current_source']['fullpins'] == initial['actual_current_source']['fullpins']
             and initial_pre['actual_current_source']['native6'] == initial['actual_current_source']['native6']
             and initial_pre['protected_native6'] == initial['protected_native6'], 'EXACT_NEW_OPERATION_BEFORE_NATIVE_SCOPE')
        need(j['operation_live'] == d['operation_live'] and j['operation_outer0'] == d['apply_outer0'],
             'POST_CONTEXT_NEW_OPERATION')
        need(proof['retired_reviewed_observations'] == {}, 'NO_NEW_OPERATION_RETIREMENT_EXCEPTION')
        physical = phase['canonical_completed_history'](bindings,jobs,proof['retained_after_copies'],o.phase_io(),{})
        need(physical['result'] == 'PASS_PHYSICAL_COMPLETED_HISTORY_NOT_CURRENT_STATE', 'NEW_PHYSICAL_PHASE_REQUIRED')
        resolution = c['reconcile_logical_evidence'](pf,o.document(bindings['backups']),{},o)
        need(d['intervening_recoveries'] == [] and a.get('completed_recovery_bridges',[]) == []
             and 'completed_recovery_bridge' not in a, 'NO_INHERITED_RECOVERY_REAPPEND')
        operation = dict(operation_kind='canonical',manifest=bindings['manifest'],live=d['operation_live'],
            root_outer0=d['apply_outer0'],preflight=bindings['preflight'],strict_completion=bindings['completion_pin'],
            strict_manifest=bindings['strict_manifest'],before_backups=bindings['backups'])
        verified_operation, verified_runtime = _operation({'actual_batch_delta':operation},o,r)
        cumulative = copy.deepcopy(history['cumulative_new_runtime_creation_versions'])
        runtime = live['actual_new_runtime_creation_versions']
        need(not set(cumulative).intersection(runtime)
             and not {p['sha256'] for p in cumulative.values()}.intersection(p['sha256'] for p in runtime.values()),
             'NEW_RUNTIME_COUNTED_ONCE')
        need(live['protected_member_count_before'] == a['protected']['existing_count']
             and live['protected_file_count'] == live['protected_member_count_after'] == f['existing_protected_count'],
             'NEW_BASELINE_COUNTS')
        cumulative.update(runtime)
        def fence():
            source = f['actual_current_source']
            need(io['git']() == dict(head=source['head'],tree=source['tree'],clean=True), 'END_GIT')
            members = io['source_membership']()
            need(set(members) == set(trusted['source_membership'])
                 and len(members) == len(set(members)) == len(trusted['source_membership']), 'END_SOURCE_MEMBERSHIP')
            need(io['inventory'](a['protected']['inventory_definition'])
                 == (f['inventory_categories'],f['missing_fixed_paths']), 'END_INVENTORY')
            fence_published_history(history); o.fence()
        fence()
        payload = dict(schema='QUALIFIED_RECURRING_V2_CHECKPOINT_READONLY_V1',descriptor=d,descriptor_pin=descriptor_pin,
            manifest=m,bindings=bindings,pf=pf,live=live,live_pin=d['operation_live'],outer=outer,
            current_facts=f,current_pointer=pointer,typed_state=state,parent_binding=parent_binding,
            parent_history=history.data,cumulative_runtime=cumulative,evidence_resolution=resolution,
            all_gates_before_candidate=True,writer_authorized=False)
        handle = object.__new__(QualifiedRecurring)
        _QUALIFICATIONS[handle] = (json.dumps(payload,sort_keys=True).encode(),fence)
        return handle

    def candidate(handle):
        if type(handle) is not QualifiedRecurring:
            # Default delegation preserves the original handle/result while
            # independently retaining this factory's approved code identities.
            dep = default_proofs.get(handle) if type(handle) is c['QualifiedCheckpoint'] else None
            if dep is not None: dep.fence()
            result = c['build_candidate_v2'](handle)
            if dep is not None: dep.fence()
            return result
        need(handle in _QUALIFICATIONS, 'ISSUED_RECURRING_QUALIFICATION_REQUIRED')
        _QUALIFICATIONS[handle][1](); q = handle.data
        need(q['all_gates_before_candidate'] is True and q['writer_authorized'] is False, 'RECURRING_HANDLE_SCOPE')
        d,m,live,pf,parent = q['descriptor'],q['manifest'],q['live'],q['pf'],q['parent_history']
        op = dict(operation_kind='canonical',manifest=q['bindings']['manifest'],live=q['live_pin'],
            root_outer0=d['apply_outer0'],preflight=q['bindings']['preflight'],
            strict_completion=q['bindings']['completion_pin'],strict_manifest=q['bindings']['strict_manifest'],
            before_backups=q['bindings']['backups'])
        return dict(schema=c['CANDIDATE_SCHEMA'],result='QUALIFIED_CANDIDATE_NOT_EXECUTED',final_schema_requires_review=c['COMPACT_SCHEMA'],
            owner_thread_id=d['owner_thread_id'],owner_execution_token=d['owner_execution_token'],
            previous_base=q['parent_binding']['checkpoint'],previous_base_outer0=q['parent_binding']['ROOT_outer0'],
            completed_parent_v2=q['parent_binding'],completed_parent_v2_binding=d['completed_parent_v2'],
            original_ordinary_root=parent['original_ordinary_root'],intervening_completed_recoveries=[],
            actual_batch_delta=op,all_actual_bounded_deltas=parent['all_actual_bounded_deltas']+[op],
            current_critical_versions=live['current_state_snapshots'],before_critical_versions=pf['critical'],
            current_automation=m['controls']['automation'],status_counts=live['status_counts'],
            registered_source_aliases=live['registered_source_aliases'],active_unique_registered_assets=live['active_unique_registered_assets'],
            before_protected_file_count=live['protected_member_count_before'],protected_file_count=live['protected_file_count'],
            cumulative_new_runtime_creation_versions=q['cumulative_runtime'],
            three_prior_runtime_creation_versions=parent['historical_leaf_snapshot']['three_prior_runtime_creation_versions'],
            new_PNGs=live['new_PNGs'],new_canonical_assets=live['new_canonical_assets'],actual_provider_calls_by_installer=0,
            finite_evidence_versions=pf['reviewed_evidence_versions'],historical_physical_evidence_resolution=q['evidence_resolution'],
            current_publication_judgment=d['current_judgment'],current_publication_facts=d['current_facts'],
            actual_current_pointer_at_qualification=q['current_facts']['current_pointer'],
            installation_runner_version=m['reviewed_runner'],installation_common_engine_version=m['common_engine_version'],
            actual_browser_review=q['outer']['actual_browser_review'],actual_packet_local0=q['outer']['actual_packet_local0'],
            applied_workflow=q['outer']['applied_workflow'],current_typed_database_state=q['typed_state'],
            current_source_HEAD=q['current_facts']['actual_current_source']['head'],
            current_source_tree=q['current_facts']['actual_current_source']['tree'],
            actual_checkpoint_native_completion=None,actual_checkpoint_root_outer0=None,
            ordinary_checkpoint_written=False,pointer_mutations=0,operational=False,technical_approval=False,scope_complete=False)

    exports = dict(c)
    exports.update(__file__=__file__,_trusted_envelope=trusted_envelope,prepare_v2=prepare,build_candidate_v2=candidate)
    return SimpleNamespace(**exports)


def create_recurring_reader(approved_reader, *, approved_reader_pin,
                            expected_database_transition_approval=None):
    """Versioned registration. The frozen V1/first-V2 routes are unchanged."""
    r = ns(approved_reader)
    need(approved_reader_pin['path'] == r['__file__'], 'APPROVED_BASE_READER_PATH')
    # Caller SOURCE policy supplies this fullpin, never config/admission DATA.
    expected_approval = copy.deepcopy(expected_database_transition_approval)
    if expected_approval is not None:
        r['pin_shape'](expected_approval)
        need(callable(r.get('read_current_database_state')), 'APPROVED_CURRENT_DATABASE_API')

    def current_database(context, facts, old, trusted, observation):
        observation.pinned(approved_reader_pin)
        result = r['read_current_database_state'](context, facts, old, trusted, observation,
            expected_approval=expected_approval)
        observation.pinned(approved_reader_pin)
        return result

    def read_v2(leaf_pin, io, *, trusted, env=None):
        dep = r['Observation'](io); dep.pinned(approved_reader_pin)
        leaf = dep.document(leaf_pin)
        if 'completed_parent_v2' not in leaf:
            options = {} if expected_approval is None else dict(expected_database_transition_approval=expected_approval)
            result = r['read_completed_base_v2'](leaf_pin,io,trusted=trusted,env=env,**options)
            dep.fence()
            return result
        history = read_published_v2_history(leaf_pin,io,trusted=trusted,approved_reader=approved_reader,env=env)
        # The immutable descriptor honestly names its immediate V2 parent in
        # the existing equality-only parent roles. Original CP74 is separate.
        options = {} if expected_approval is None else dict(expected_database_transition_approval=expected_approval)
        facts,state,current_fence = r['_current_scope'](leaf_pin,leaf,trusted,history['pointer_document'],
            dep,os.environ if env is None else env,**options)
        need(all(facts['protected_fullpins'].get(path) == pin for path,pin in history['cumulative_new_runtime_creation_versions'].items()),
             'ALL_ANCESTRAL_RUNTIME_STILL_PROTECTED')
        current_fence();fence_published_history(history);dep.fence()
        return dict(schema='NORMALIZED_COMPLETED_IMAGE_BASE_V2',result='PASS_READ_ONLY_COMPLETED_BASE_V2',
            checkpoint=copy.deepcopy(leaf_pin),outer0=copy.deepcopy(trusted['root_outer0']),
            actual_native_completion=copy.deepcopy(trusted['native_completion']),pointer=copy.deepcopy(trusted['current_pointer']),
            historical_writer_identity=dict(owner_thread_id=leaf['owner_thread_id'],owner_execution_token=leaf['owner_execution_token']),
            current_owner_identity=dict(owner_thread_id=trusted['root'],owner_execution_token=trusted['token']),
            ordinary_parent=history['original_ordinary_root']['checkpoint'],ordinary_parent_snapshot=history['ordinary_parent_snapshot'],
            immediate_completed_parent=leaf['previous_base'],original_ordinary_root=history['original_ordinary_root'],
            historical_leaf_snapshot=copy.deepcopy(leaf),intervening_completed_recoveries=history['intervening_completed_recoveries'],
            actual_batch_delta=copy.deepcopy(leaf['actual_batch_delta']),cumulative_new_runtime_creation_versions=history['cumulative_new_runtime_creation_versions'],
            all_actual_bounded_deltas=history['all_actual_bounded_deltas'],
            current_critical_versions=copy.deepcopy(facts['current_six_controls']),current_source=copy.deepcopy(facts['actual_current_source']),
            current_protected_fullpins=copy.deepcopy(facts['protected_fullpins']),current_protected_categories=copy.deepcopy(facts['inventory_categories']),
            current_protected_native=copy.deepcopy(facts['protected_native6']),current_missing_fixed_paths=copy.deepcopy(facts['missing_fixed_paths']),
            current_inventory_definition=copy.deepcopy(facts['inventory_definition']),current_policy_members=copy.deepcopy(facts['all63_policy_pins']),
            current_active_policy_index=copy.deepcopy(facts['active_policy_index']),current_automation=copy.deepcopy(facts['current_automation']),
            current_database=copy.deepcopy(facts['current_DB']),current_facts=copy.deepcopy(trusted['current_facts']),
            current_controls_equal_leaf_snapshot=True,status_counts=copy.deepcopy(leaf['status_counts']),
            registered_source_aliases=leaf['registered_source_aliases'],three_prior_runtime_creation_versions=copy.deepcopy(leaf['three_prior_runtime_creation_versions']),
            current_typed_database_state=state,current_context=copy.deepcopy(trusted['current_context']),
            historical_apply_failures_preserved=True,V1_masquerade=False,installer_invocation_authorized=False,
            image_mutations_authorized=False,future_changes_authorized=False,shared_mutations=0,technical_approval=False)

    def dispatch(leaf_pin, io, *, trusted=None, legacy_reader=None, env=None):
        o = r['Observation'](io); leaf = o.document(leaf_pin)
        if leaf.get('schema') == r['COMPACT_SCHEMA']:
            return read_v2(leaf_pin,io,trusted=trusted,env=env)
        return r['read_completed_base'](leaf_pin,io,trusted=trusted,legacy_reader=legacy_reader,env=env)

    exports = dict(r)
    exports.update(__file__=__file__,read_completed_base_v2=read_v2,read_completed_base=dispatch)
    if callable(r.get('read_current_database_state')):
        exports['read_current_database_state'] = current_database
    return SimpleNamespace(**exports)
