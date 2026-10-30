"""Pure V2 completed-base reader. No writer, code loader or mutation API.

Receipt pins never establish their own authority. A separately reviewed caller
supplies the trusted current envelope and the already approved typed reader.
Historical writer modules are verified through retained bytes, never executed
or restored at their former mutable paths. V1 dispatch remains a callback.
"""
import copy
import hashlib
import json
import os
import re
import tomllib

EXECUTION_ENABLED = False
COMPACT_SCHEMA = 'STABLE_REVIEWED_IMAGE_BATCH_COMPACT_V2'
CONTEXT_SCHEMA = 'ROOT_FINITE_COMPLETED_BASE_V2_CURRENT_CONTEXT_V1'
FACTS_SCHEMA = 'ROOT_COMPLETED_BASE_V2_CURRENT_FACTS_NOT_ADMISSION_V1'
NATIVE_SCHEMA = 'ACTUAL_IMAGE_CHECKPOINT_V2_WRITER_NATIVE_COMPLETION_V1'
OUTER_SCHEMA = 'ROOT_ACTUAL_IMAGE_CHECKPOINT_V2_OUTER0_V1'
CAS_SCHEMA = 'ROOT_IMAGE_CHECKPOINT_V2_PUBLICATION_CAS_V1'
READBACK_SCHEMA = 'ROOT_IMAGE_CHECKPOINT_V2_READBACK_V1'
PIN_KEYS = {'path', 'bytes', 'mtime_ns', 'sha256'}
AUTHORITY_ROLES = {'permit', 'writer_module', 'qualifier_module', 'code_review', 'merged_code_CI'}
TRUSTED_KEYS = {'root', 'token', 'owner_path', 'owner_pin', 'current_pointer',
                'leaf', 'native_completion', 'root_outer0', 'publication_CAS',
                'current_context', 'current_facts', 'approved_dependencies', 'source_membership'}


def need(value, code):
    if not value:
        raise ValueError(code)


def integer(value, expected, code):
    need(type(value) is int and value == expected, code)


def identity(obj, root, token):
    need(obj['owner_thread_id'] == root and obj['owner_execution_token'] == token, 'IDENTITY')


def pin_shape(pin):
    need(type(pin) is dict and set(pin) == PIN_KEYS and type(pin['path']) is str and bool(pin['path'])
         and type(pin['bytes']) is int and pin['bytes'] >= 0 and type(pin['mtime_ns']) is int
         and type(pin['sha256']) is str and re.fullmatch('[0-9a-f]{64}', pin['sha256']), 'PIN_SHAPE')


class Observation:
    def __init__(self, io):
        self.io, self.pins, self.natives = io, {}, {}

    def pinned(self, pin):
        pin_shape(pin)
        path = pin['path']
        need(path not in self.pins or self.pins[path] == pin, 'CONFLICTING_PIN_ROLE')
        need(self.io['version'](path) == pin, 'PIN_BEFORE')
        raw = self.io['bytes'](path)
        need(type(raw) is bytes and len(raw) == pin['bytes']
             and hashlib.sha256(raw).hexdigest() == pin['sha256'], 'PIN_BYTES')
        need(self.io['version'](path) == pin, 'PIN_AFTER')
        self.pins[path] = copy.deepcopy(pin)
        return raw

    def document(self, pin):
        result = json.loads(self.pinned(pin))
        need(type(result) is dict, 'DOCUMENT_SHAPE')
        return result

    def native(self, path, pin, native):
        pin_shape(pin)
        need(type(native) is list and len(native) == 6 and all(type(v) is int for v in native[:5])
             and native[:2] == [pin['bytes'], pin['mtime_ns']]
             and native[-1] is True and self.io['native'](path) == native, 'NATIVE_SCOPE')
        need(path not in self.natives or self.natives[path] == native, 'NATIVE_ROLE_CONFLICT')
        self.natives[path] = copy.deepcopy(native)

    def archive(self, observed, retained):
        pin_shape(observed)
        need(observed['path'] != retained['path'], 'ARCHIVE_NOT_ORIGINAL_PATH')
        raw = self.pinned(retained)
        need(len(raw) == observed['bytes'] and hashlib.sha256(raw).hexdigest() == observed['sha256'], 'ARCHIVE_BYTES')
        return raw

    def fence(self):
        need(all(self.io['version'](p) == v for p, v in self.pins.items()), 'END_PIN_RACE')
        need(all(self.io['native'](p) == v for p, v in self.natives.items()), 'END_NATIVE_RACE')


def _finite(obj):
    need(obj['root_preservation_judgment'] is True and obj['no_unlisted_or_future_change_admission'] is True,
         'FINITE_ROOT_JUDGMENT')
    need(all(obj[k] is False for k in ('operational', 'enabled', 'future_changes_authorized',
         'image_mutations_authorized', 'new_generation_authorized', 'new_acceptance_authorized',
         'new_installation_authorized', 'technical_approval')), 'NO_FUTURE_AUTHORITY')


def _code_authority(leaf_pin, leaf, o):
    a = leaf['writer_authority']
    need(type(a) is dict and set(a) == AUTHORITY_ROLES, 'WRITER_AUTHORITY_ROLES')
    review = o.document(a['code_review']); ci = o.document(a['merged_code_CI']); permit = o.document(a['permit'])
    identity(review, leaf['owner_thread_id'], leaf['owner_execution_token'])
    need(review['schema'] == 'ROOT_GENERIC_V2_CHECKPOINT_CODE_REVIEW_V1' and review['result'] == 'PASS', 'CODE_REVIEW')
    archives = review['retained_source_archives']
    need(set(archives) == {'writer_module', 'qualifier_module'}, 'CODE_ARCHIVE_ROLES')
    for role, row in archives.items():
        need(set(row) == {'observed', 'retained_copy'} and row['observed'] == a[role], 'DATED_CODE_IDENTITY')
        o.archive(row['observed'], row['retained_copy'])
    need(ci['schema'] == 'ROOT_GENERIC_V2_MERGED_CODE_CI_PROOF_V1' and ci['result'] == 'PASS'
         and ci['merged'] is True and ci['all_required_checks_passed'] is True
         and ci['head_is_ancestor_of_merge'] is True
         and all(type(ci[k]) is str and re.fullmatch('[0-9a-f]{40}', ci[k]) for k in ('head_commit', 'merge_commit')),
         'MERGED_CODE_CI')
    need(ci['reviewed_source_sha256'] == {r:a[r]['sha256'] for r in archives}
         and type(ci['required_check_conclusions']) is dict and bool(ci['required_check_conclusions'])
         and all(v == 'success' for v in ci['required_check_conclusions'].values()), 'EXACT_REVIEWED_CI_HASHES')
    need(review['reviewed_commit'] == ci['head_commit'] and permit['merged_code_commit'] == ci['merge_commit'], 'EXACT_REVIEWED_COMMIT')
    identity(permit, leaf['owner_thread_id'], leaf['owner_execution_token'])
    need(permit['schema'] == 'ROOT_FINITE_GENERIC_V2_CHECKPOINT_WRITER_PERMIT_V1'
         and permit['result'] == 'ROOT_EXPLICIT_FINITE_CHECKPOINT_WRITER_PERMIT' and permit['writer_enabled'] is True
         and permit['descriptor'] == leaf['baseline_snapshot']['descriptor']
         and permit['before_publication_pointer'] == leaf['before_publication_pointer']
         and permit['writer_module'] == a['writer_module'] and permit['qualifier_module'] == a['qualifier_module']
         and permit['code_review'] == a['code_review'] and permit['merged_code_CI'] == a['merged_code_CI'], 'EXACT_WRITER_PERMIT')
    need(all(permit[k] is False for k in ('new_generation_authorized', 'new_acceptance_authorized',
         'new_installation_authorized', 'CURRENT_write_authorized', 'overwrite_authorized',
         'resume_authorized', 'future_changes_authorized', 'technical_approval')), 'FINITE_WRITER_PERMIT')
    journal = o.document(leaf['writer_journal'])
    identity(journal, leaf['owner_thread_id'], leaf['owner_execution_token'])
    need(journal['schema'] == 'IMAGE_CHECKPOINT_V2_NEVER_REPLAY_WRITE_INTENT_V1' and journal['result'] == 'WRITE_INTENT_NEVER_REPLAY'
         and journal['resume_authorized'] is False and journal['technical_approval'] is False
         and journal['descriptor'] == leaf['baseline_snapshot']['descriptor'] and journal['writer_authority'] == a
         and journal['before_publication_pointer'] == leaf['before_publication_pointer'], 'WRITER_INTENT_JOURNAL')
    outputs = permit['outputs']
    need(type(outputs) is dict and set(outputs) == {'journal', 'leaf', 'proposal'}
         and all(type(p) is str and bool(p) for p in outputs.values())
         and len({p.replace('\\', '/').casefold() for p in outputs.values()}) == 3
         and journal['outputs'] == outputs and outputs['leaf'] == leaf_pin['path']
         and outputs['journal'] == leaf['writer_journal']['path'], 'EXACT_WRITER_OUTPUT_ROLES')
    for k in ('PRIMARY_invocations', 'application_mutations', 'CURRENT_mutations'): integer(journal[k], 0, 'JOURNAL_MUTATIONS')
    return a


def _publication(leaf_pin, leaf, trusted, o):
    native = o.document(trusted['native_completion']); outer = o.document(trusted['root_outer0'])
    root, token = leaf['owner_thread_id'], leaf['owner_execution_token']
    need(native['schema'] == NATIVE_SCHEMA and native['receipt_version'] == leaf_pin
         and native['writer_authority'] == leaf['writer_authority'] and native['writer_journal'] == leaf['writer_journal']
         and native['actual_completion_observed'] is True and native['no_primary_invoked'] is True
         and native['no_application_mutations'] is True, 'NATIVE_COMPLETED_LEAF')
    identity(native, root, token); integer(native['actual_exit_code'], 0, 'NATIVE_EXIT0')
    proposal = o.document(native['publication_proposal'])
    identity(proposal, root, token)
    need(proposal['schema'] == 'ROOT_IMAGE_CHECKPOINT_V2_PRIVATE_PUBLICATION_PROPOSAL_V1'
         and proposal['checkpoint'] == leaf_pin and proposal['old_current'] == leaf['before_publication_pointer']
         and proposal['writer_journal'] == leaf['writer_journal'] and proposal['writer_authority'] == leaf['writer_authority']
         and proposal['actual_native_completion_required'] is True and proposal['actual_ROOT_outer0_required'] is True
         and proposal['current_pointer_written'] is False and proposal['technical_approval'] is False, 'PUBLICATION_PROPOSAL')
    need(native['publication_proposal']['path'] == o.document(leaf['writer_authority']['permit'])['outputs']['proposal'], 'EXACT_PROPOSAL_OUTPUT_PATH')
    integer(proposal['application_mutations'], 0, 'PROPOSAL_MUTATIONS')
    need(outer['schema'] == OUTER_SCHEMA and outer['receipt_version'] == leaf_pin
         and outer['actual_native_completion_receipt'] == trusted['native_completion']
         and outer['observed_by_actual_root_thread_id'] == root and outer['owner_execution_token'] == token, 'ROOT_OUTER_BINDING')
    integer(outer['actual_exit_code'], 0, 'ROOT_OUTER_EXIT0')
    cas = o.document(trusted['publication_CAS']); identity(cas, trusted['root'], trusted['token'])
    need(cas['schema'] == CAS_SCHEMA and cas['old_current'] == leaf['before_publication_pointer']
         and cas['new_current'] == trusted['current_pointer'] and cas['checkpoint'] == leaf_pin
         and cas['checkpoint_native'] == trusted['native_completion'] and cas['checkpoint_outer0'] == trusted['root_outer0']
         and cas['ordinary_parent_preserved'] is True and cas['recoveries_preserved'] is True, 'EXACT_PUBLICATION_CAS')
    integer(cas['control_mutations'], 0, 'CAS_CONTROL_MUTATIONS')
    old = json.loads(o.archive(cas['old_current'], cas['backup']))
    need(old['latest_completed_receipt'] == leaf['previous_base']
         and old['actual_checkpoint_root_outer0'] == leaf['previous_base_outer0'], 'OLD_ORDINARY_PARENT_PRESERVED')
    pointer = o.document(trusted['current_pointer'])
    need(pointer['latest_completed_receipt'] == leaf_pin
         and pointer['actual_checkpoint_root_outer0'] == trusted['root_outer0'], 'CURRENT_LATEST_V2_LEAF')
    readback = o.document(cas['readback'])
    need(readback['schema'] == READBACK_SCHEMA and readback['new_current'] == trusted['current_pointer']
         and readback['checkpoint'] == leaf_pin and readback['checkpoint_native'] == trusted['native_completion']
         and readback['checkpoint_outer0'] == trusted['root_outer0'] and readback['readback_exact'] is True, 'EXACT_PUBLICATION_READBACK')
    return pointer


def _historical_base(leaf, o):
    ordinary = o.document(leaf['previous_base']); outer = o.document(leaf['previous_base_outer0'])
    need(ordinary['schema'] == 'STABLE_REVIEWED_IMAGE_BATCH_COMPACT_V1' and ordinary['result'] == 'PASS'
         and outer['receipt_version'] == leaf['previous_base'], 'ORDINARY_PARENT')
    integer(outer['actual_exit_code'], 0, 'ORDINARY_OUTER0')
    native = o.document(outer['actual_native_completion_receipt'])
    need(native['actual_checkpoint'] == leaf['previous_base'], 'ORDINARY_NATIVE_BINDING')
    integer(native['actual_exit_code'], 0, 'ORDINARY_NATIVE0')
    cumulative = copy.deepcopy(ordinary['cumulative_new_runtime_creation_versions']); recoveries = leaf['intervening_completed_recoveries']
    need(len({v['sha256'] for v in cumulative.values()}) == len(cumulative), 'ORDINARY_RUNTIME_DISTINCT')
    for path, pin in cumulative.items():
        need(path == pin['path'], 'RUNTIME_MAP_PATH'); o.pinned(pin)
    need(type(recoveries) is list and len(recoveries) <= 12
         and len({r['summary']['path'] for r in recoveries}) == len(recoveries), 'RECOVERY_LIST')
    def add(runtime):
        need(not set(cumulative).intersection(runtime) and
             not {v['sha256'] for v in cumulative.values()}.intersection(v['sha256'] for v in runtime.values()), 'RUNTIME_COUNTED_ONCE')
        for path, pin in runtime.items():
            need(path == pin['path'], 'RUNTIME_MAP_PATH'); o.pinned(pin)
        cumulative.update(runtime)
    for row in recoveries:
        bridge = o.document(row['root_bridge']); summary = o.document(row['summary'])
        need(bridge['schema'] == 'ROOT_COMPLETED_CANONICAL_TO_NORMAL_CANONICAL_BRIDGE_V1'
             and bridge['root_preservation_judgment'] is True and bridge['no_unlisted_or_future_change_admission'] is True
             and all(bridge[k] is False for k in ('enabled', 'operational', 'technical_approval', 'replay_authorized',
                 'future_changes_authorized', 'image_mutations_authorized'))
             and summary['schema'] in ('CLASSIFIRE_COMPLETED_CANONICAL_RECOVERY_COMPACT_V1', 'CLASSIFIRE_COMPLETED_CANONICAL_RECOVERY_COMPACT_V2')
             and bridge['recovered_compact'] == row['summary']
             and bridge['prior_ordinary_completed_base']['checkpoint'] == leaf['previous_base']
             and bridge['historical_failures_preserved'] is True and bridge['strict_historical_FAIL_preserved'] is True
             and summary['normal_STABLE_checkpoint_claimed'] is False and row['counted_once'] is True
             and row['operation_kind'] == 'readonly_recovered_canonical', 'RECOVERY_LITERAL_HISTORY')
        integer(row['historical_apply_exit_code'], 1, 'RECOVERY_APPLY1')
        integer(row['historical_PRIMARY_exit_code'], 0, 'RECOVERY_PRIMARY0')
        integer(row['readonly_reconciliation_exit_code'], 0, 'RECOVERY_READONLY0')
        integer(summary['original_apply_exit_code'], 1, 'RECOVERY_SUMMARY_APPLY1')
        integer(summary['original_PRIMARY_exit_code'], 0, 'RECOVERY_SUMMARY_PRIMARY0')
        for pinrole, role, key, value in (('actual_apply_completion','original_apply_completion','actual_exit_code',1),
             ('actual_primary_completion','original_PRIMARY_completion','exit_code',0),
             ('actual_readonly_native0','actual_readonly_native0','actual_exit_code',0)):
            need(bridge[pinrole] == summary[role], 'RECOVERY_PROCESS_BINDING')
            integer(o.document(bridge[pinrole])[key], value, 'RECOVERY_REAL_PROCESS_EXIT')
        need(summary['original_failure'] == bridge['original_failure'], 'RECOVERY_FAILURE_RETAINED')
        o.pinned(bridge['original_failure'])
        runtime = summary.get('runtime_creation_versions', summary.get('actual_four_runtime_creation_versions'))
        need(runtime == row['runtime_creation_versions'] and len(runtime) == summary['historical_canonical_delta_counted_once'], 'RECOVERY_RUNTIME')
        add(runtime)
    operation = leaf['actual_batch_delta']; live = o.document(operation['live'])
    completion = o.document(operation['strict_completion']); strict = o.document(operation['strict_manifest'])
    manifest = o.document(operation['manifest']); opouter = o.document(operation['root_outer0'])
    need(type(manifest['targets']) is list and 1 <= len(manifest['targets']) <= 12
         and all(type(v) is int for v in manifest['targets']) and len(set(manifest['targets'])) == len(manifest['targets']), 'OPERATION_TARGETS')
    need(operation['operation_kind'] == 'canonical' and live['result'] == 'PASS'
         and live['plan_version'] == operation['manifest'] and live['preflight_creation_version'] == operation['preflight']
         and completion['target_jobs'] == manifest['targets'] == live['actual_completed_jobs']
         and completion['actual_completion_observed'] is True and opouter['receipt_version'] == operation['live'], 'OPERATION_COMPLETED_LINEAGE')
    integer(completion['exit_code'], 0, 'OPERATION_PRIMARY0'); integer(opouter['actual_exit_code'], 0, 'OPERATION_OUTER0')
    apply = o.document(opouter['actual_native_result']); integer(apply['actual_exit_code'], 0, 'OPERATION_APPLY0')
    need(apply['actual_live'] == operation['live'] and apply['manifest'] == operation['manifest']
         and apply['actual_primary_completion'] == operation['strict_completion'], 'OPERATION_NATIVE_BINDING')
    runtime = live['actual_new_runtime_creation_versions']
    need(len(runtime) == len(strict['jobs']) == len(manifest['targets'])
         and {v['sha256'] for v in runtime.values()} == {j['output']['sha256'] for j in strict['jobs']}, 'OPERATION_RUNTIME')
    for role in ('preflight', 'before_backups'): o.pinned(operation[role])
    add(runtime)
    need(cumulative == leaf['cumulative_new_runtime_creation_versions']
         and leaf['all_actual_bounded_deltas'] == ordinary['all_actual_bounded_deltas'] + recoveries + [operation], 'WHOLE_HISTORY_NOT_MASQUERADE')
    return ordinary, recoveries, operation, cumulative


def _transition(before, after, rows, o, code):
    need(type(rows) is dict and set(rows) == {p for p in set(before) | set(after) if before.get(p) != after.get(p)}, code)
    for path, row in rows.items():
        need(set(row) == {'before', 'after', 'retained_before'} and row['before'] == before.get(path)
             and row['after'] == after.get(path), code)
        if row['before'] is None: need(row['retained_before'] is None, code)
        else: o.archive(row['before'], row['retained_before'])
        if row['after'] is not None: o.pinned(row['after'])


def _current_scope(leaf_pin, leaf, trusted, pointer, o, env):
    context = o.document(trusted['current_context']); facts = o.document(trusted['current_facts'])
    need(context['schema'] == CONTEXT_SCHEMA and context['completed_base'] == leaf_pin
         and context['publication_cas'] == trusted['publication_CAS'] and context['current_facts'] == trusted['current_facts']
         and context['current_owner'] == trusted['owner_pin'] and context['current_pointer'] == trusted['current_pointer']
         and context['baseline_snapshot'] == leaf['baseline_snapshot'], 'TRUSTED_CURRENT_CONTEXT')
    identity(context, trusted['root'], trusted['token']); _finite(context)
    need(env.get('CODEX_THREAD_ID') == trusted['root'] and trusted['owner_pin']['path'] == trusted['owner_path'], 'ACTUAL_CURRENT_PROCESS')
    owner = o.document(trusted['owner_pin'])
    for obj in (owner, pointer):
        identity(obj, trusted['root'], trusted['token'])
        need(obj['image_publication_hold_active'] is False and obj['live_image_installation_hold_active'] is False
             and obj['all_image_mutations_guarded_until_valid_claim_and_app_retarget'] is False, 'CURRENT_OWNER_RELEASED')
    need(owner['status'] in ('active', 'ACTIVE') and owner['automation_retarget_pending'] is False
         and context['actual_same_active_owner_claim_and_release_preserved'] is True, 'CURRENT_CLAIM_RELEASE')
    roles = context['claim_release_evidence']
    need(set(roles) == {'claim', 'receiving_authority', 'retarget', 'hold_release'}
         and owner['actual_claim_receipt'] == roles['claim'] and owner['actual_receiving_authority'] == roles['receiving_authority']
         and owner['actual_retarget_verification'] == roles['retarget'] and owner['image_publication_hold_release'] == roles['hold_release'], 'CLAIM_RELEASE_PIN_ROLES')
    for pin in roles.values(): o.pinned(pin)
    need(facts['schema'] == FACTS_SCHEMA and facts['current_owner'] == trusted['owner_pin']
         and facts['current_pointer'] == trusted['current_pointer']
         and all(facts[k] is False for k in ('source_or_protected_preservation_admitted', 'ROOT_preservation_judgment',
             'operational', 'enabled', 'future_changes_authorized', 'technical_approval')),
         'FRESH_FACTS_NOT_AUTHORITY')
    integer(facts['shared_mutations'], 0, 'FRESH_FACTS_MUTATIONS')
    baseline = leaf['baseline_snapshot']; old = o.document(baseline['facts']); judgment = o.document(baseline['root_judgment'])
    descriptor = o.document(baseline['descriptor'])
    need(descriptor['current_facts'] == baseline['facts'] and descriptor['current_judgment'] == baseline['root_judgment']
         and judgment['actual_fresh_current_facts'] == baseline['facts']
         and judgment['root_preservation_judgment'] is True and judgment['no_unlisted_or_future_change_admission'] is True,
         'DATED_BASELINE_SNAPSHOT')
    identity(judgment, leaf['owner_thread_id'], leaf['owner_execution_token'])
    need(descriptor['ordinary_parent'] == leaf['previous_base'] and descriptor['ordinary_parent_outer0'] == leaf['previous_base_outer0']
         and descriptor['operation_live'] == leaf['actual_batch_delta']['live']
         and descriptor['apply_outer0'] == leaf['actual_batch_delta']['root_outer0']
         and descriptor['intervening_recoveries'] == [{'root_bridge':r['root_bridge']} for r in leaf['intervening_completed_recoveries']]
         and old['current_pointer'] == leaf['before_publication_pointer'], 'BASELINE_EXACT_OPERATION')
    need(leaf['current_source_HEAD'] == old['actual_current_source']['head']
         and leaf['current_source_tree'] == old['actual_current_source']['tree']
         and leaf['current_critical_versions'] == old['current_six_controls']
         and leaf['current_typed_database_state'] == old['current_typed_database_state']
         and leaf['protected_file_count'] == old['existing_protected_count'], 'BASELINE_EXACT_CANDIDATE_SNAPSHOT')
    # Reusing the completed queue/registry counts is valid only while the whole
    # six-control snapshot stays exact. A later control change needs its own
    # reviewed whole-count consumer; finite source DATA cannot waive this gate.
    need(facts['current_six_controls'] == old['current_six_controls'], 'CONTROL_CHANGE_REQUIRES_SEPARATE_WHOLE_COUNTS_QUALIFICATION')
    need(context['declared_current_facts'] == facts, 'DECLARED_WHOLE_CURRENT_FACTS')
    transitions = context['declared_map_transitions']
    need(set(transitions) == {'source', 'protected', 'policies', 'controls'}, 'FINITE_TRANSITION_ROLES')
    for role, a, b in (('source', old['actual_current_source']['fullpins'], facts['actual_current_source']['fullpins']),
         ('protected', old['protected_fullpins'], facts['protected_fullpins']),
         ('policies', old['all63_policy_pins'], facts['all63_policy_pins']),
         ('controls', old['current_six_controls'], facts['current_six_controls'])):
        _transition(a, b, transitions[role], o, 'CLOSED_' + role.upper() + '_TRANSITION')
    source = facts['actual_current_source']; protected = facts['protected_fullpins']
    need(source['clean'] is True and type(source['tracked_count']) is int and source['tracked_count'] == len(source['fullpins'])
         and set(source['fullpins']) == set(source['native6']) == set(trusted['source_membership'])
         and len(trusted['source_membership']) == len(set(trusted['source_membership']))
         and set(o.io['source_membership']()) == set(trusted['source_membership']), 'CURRENT_SOURCE_MEMBERSHIP')
    expected_git = dict(head=source['head'], tree=source['tree'], clean=True)
    need(o.io['git']() == expected_git, 'CURRENT_GIT')
    for pins, natives in ((source['fullpins'], source['native6']), (protected, facts['protected_native6'])):
        need(set(pins) == set(natives), 'COMPLETE_NATIVE_MAP')
        for path, pin in pins.items():
            need(pin['path'] == path, 'FULLPIN_MAP_PATH'); o.native(path, pin, natives[path])
    categories, missing = facts['inventory_categories'], facts['missing_fixed_paths']
    original_admission = o.document(descriptor['original_admission'])
    need(facts['inventory_definition'] == original_admission['protected']['inventory_definition']
         and missing == old['missing_fixed_paths']
         and all(categories[p] == old['inventory_categories'][p] for p in set(categories).intersection(old['inventory_categories'])),
         'INVENTORY_RULE_AND_RETAINED_CATEGORIES')
    need(set(categories) == set(protected) | set(missing) and not set(protected).intersection(missing)
         and len(missing) == len(set(missing)) and facts['existing_protected_count'] == len(protected)
         and facts['membership_names'] == len(categories), 'CURRENT_INVENTORY_CLOSED')
    need(o.io['inventory'](facts['inventory_definition']) == (categories, missing), 'CURRENT_INVENTORY')
    need(len(facts['all63_policy_pins']) == 63 and len(facts['current_six_controls']) == 6, 'POLICY_CONTROL_COUNTS')
    for mapping in (facts['all63_policy_pins'], facts['current_six_controls']):
        for path, pin in mapping.items():
            need(path == pin['path'], 'POLICY_CONTROL_MAP_PATH'); o.pinned(pin)
    index = o.document(facts['active_policy_index'])
    fields = [k for k in owner if k == 'current_active_policy_index' or
              k.startswith('current_active_policy_index') and k[len('current_active_policy_index'):].isdigit()]
    if not fields: fields = ['active_policy_index']
    need(len(fields) == 1 and owner[fields[0]] == facts['active_policy_index'], 'OWNER_ACTIVE_POLICY_INDEX')
    need(index['policies'] == facts['all63_policy_pins'] and index['policy_count'] == 63
         and index['technical_approval'] is False, 'COMPLETE_POLICY_INDEX')
    automation = tomllib.loads(o.pinned(facts['current_automation']).decode('utf8'))
    need(automation['kind'] == 'heartbeat' and automation['status'] == 'ACTIVE'
         and automation['target_thread_id'] == trusted['root']
         and owner['existing_automation_target_thread_id'] == trusted['root']
         and owner['automation_remains_ACTIVE'] is True, 'CURRENT_AUTOMATION')
    need(trusted['approved_dependencies'] == o.io['approved_dependencies'] and set(trusted['approved_dependencies']) == {'typed_reader'}, 'APPROVED_READER_DEPENDENCIES')
    o.pinned(trusted['approved_dependencies']['typed_reader'])
    db = facts['current_DB']
    need(db == old['current_DB'], 'DATABASE_REQUIRES_SEPARATE_FINITE_CONSUMER')
    need(all(not o.io['exists'](db['path'] + suffix) for suffix in ('-wal', '-shm', '-journal')), 'DB_SIDECARS')
    state, unused_folder = o.io['typed_bytes'](o.pinned(db))
    need(state == facts['current_typed_database_state'] == old['current_typed_database_state']
         and len(state['tables']) == facts['current_typed_tables']
         and sum(row['rows'] for row in state['tables'].values()) == facts['current_typed_rows'], 'FULL_TYPED_DATABASE')
    def fence():
        need(o.io['git']() == expected_git, 'END_GIT')
        members = o.io['source_membership']()
        need(len(members) == len(set(members)) == len(trusted['source_membership'])
             and set(members) == set(trusted['source_membership']), 'END_SOURCE_MEMBERSHIP')
        need(o.io['inventory'](facts['inventory_definition']) == (categories, missing), 'END_INVENTORY')
        o.fence()
    return facts, state, fence


def read_completed_base_v2(leaf_pin, io, *, trusted, env=None):
    """Read one externally trusted, published V2 base; never replay prepare."""
    need(type(trusted) is dict and set(trusted) == TRUSTED_KEYS and trusted['leaf'] == leaf_pin, 'TRUSTED_CALLER_ENVELOPE')
    o = Observation(io); leaf = o.document(leaf_pin)
    need(leaf['schema'] == COMPACT_SCHEMA and leaf['result'] == 'PASS' and leaf['technical_approval'] is False
         and leaf['scope_complete'] is False and leaf['actual_checkpoint_native_completion'] is None
         and leaf['actual_checkpoint_root_outer0'] is None and leaf['ordinary_checkpoint_written'] is True
         and leaf['publication_completed'] is False and leaf['operational'] is False, 'REAL_V2_COMPLETED_LEAF')
    integer(leaf['pointer_mutations'], 0, 'LEAF_POINTER_MUTATIONS')
    _code_authority(leaf_pin, leaf, o)
    pointer = _publication(leaf_pin, leaf, trusted, o)
    ordinary, recoveries, operation, cumulative = _historical_base(leaf, o)
    facts, state, fence = _current_scope(leaf_pin, leaf, trusted, pointer, o, os.environ if env is None else env)
    need(all(facts['protected_fullpins'].get(path) == pin for path, pin in cumulative.items()), 'HISTORICAL_RUNTIME_STILL_PROTECTED')
    fence()
    return dict(schema='NORMALIZED_COMPLETED_IMAGE_BASE_V2', result='PASS_READ_ONLY_COMPLETED_BASE_V2',
        checkpoint=copy.deepcopy(leaf_pin), outer0=copy.deepcopy(trusted['root_outer0']),
        actual_native_completion=copy.deepcopy(trusted['native_completion']), pointer=copy.deepcopy(trusted['current_pointer']),
        historical_writer_identity=dict(owner_thread_id=leaf['owner_thread_id'], owner_execution_token=leaf['owner_execution_token']),
        current_owner_identity=dict(owner_thread_id=trusted['root'], owner_execution_token=trusted['token']),
        ordinary_parent=copy.deepcopy(leaf['previous_base']), ordinary_parent_snapshot=ordinary,
        historical_leaf_snapshot=copy.deepcopy(leaf),
        intervening_completed_recoveries=copy.deepcopy(recoveries), actual_batch_delta=copy.deepcopy(operation),
        cumulative_new_runtime_creation_versions=cumulative, current_critical_versions=copy.deepcopy(facts['current_six_controls']),
        current_source=copy.deepcopy(facts['actual_current_source']), current_protected_fullpins=copy.deepcopy(facts['protected_fullpins']),
        current_protected_categories=copy.deepcopy(facts['inventory_categories']), current_protected_native=copy.deepcopy(facts['protected_native6']),
        current_missing_fixed_paths=copy.deepcopy(facts['missing_fixed_paths']), current_inventory_definition=copy.deepcopy(facts['inventory_definition']),
        current_policy_members=copy.deepcopy(facts['all63_policy_pins']), current_active_policy_index=copy.deepcopy(facts['active_policy_index']),
        current_automation=copy.deepcopy(facts['current_automation']),
        current_database=copy.deepcopy(facts['current_DB']), current_facts=copy.deepcopy(trusted['current_facts']),
        current_controls_equal_leaf_snapshot=facts['current_six_controls'] == leaf['current_critical_versions'],
        status_counts=copy.deepcopy(leaf['status_counts']), registered_source_aliases=leaf['registered_source_aliases'],
        three_prior_runtime_creation_versions=copy.deepcopy(leaf['three_prior_runtime_creation_versions']),
        all_actual_bounded_deltas=copy.deepcopy(leaf['all_actual_bounded_deltas']),
        current_typed_database_state=state, current_context=copy.deepcopy(trusted['current_context']),
        historical_apply_failures_preserved=True, V1_masquerade=False, installer_invocation_authorized=False,
        image_mutations_authorized=False, future_changes_authorized=False, shared_mutations=0, technical_approval=False)


def read_completed_base(leaf_pin, io, *, trusted=None, legacy_reader=None, env=None):
    """Explicit V2 registration; V1 remains the supplied original callback."""
    o = Observation(io); leaf = o.document(leaf_pin)
    if leaf.get('schema') == COMPACT_SCHEMA:
        return read_completed_base_v2(leaf_pin, io, trusted=trusted, env=env)
    need(leaf.get('schema') == 'STABLE_REVIEWED_IMAGE_BATCH_COMPACT_V1' and callable(legacy_reader), 'UNREGISTERED_COMPLETED_SCHEMA')
    return legacy_reader(leaf_pin, io)
