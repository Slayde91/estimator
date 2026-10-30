"""Capability-gated generic checkpoint writer. No default or script execution.

Only an independently supplied ROOT permit can authorize three new private
files under the owner lock. This module cannot install, accept, publish CURRENT,
run PRIMARY, or overwrite a previous attempt. Process0 and publication evidence
are recorded separately by the actual caller after the process finishes.
"""
from contextlib import contextmanager
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import uuid

WRITER_ENABLED_BY_DEFAULT = False
PERMIT_SCHEMA = 'ROOT_FINITE_GENERIC_V2_CHECKPOINT_WRITER_PERMIT_V1'
REVIEW_SCHEMA = 'ROOT_GENERIC_V2_CHECKPOINT_CODE_REVIEW_V1'
CI_SCHEMA = 'ROOT_GENERIC_V2_MERGED_CODE_CI_PROOF_V1'
JOURNAL_SCHEMA = 'IMAGE_CHECKPOINT_V2_NEVER_REPLAY_WRITE_INTENT_V1'
PROPOSAL_SCHEMA = 'ROOT_IMAGE_CHECKPOINT_V2_PRIVATE_PUBLICATION_PROPOSAL_V1'


def need(ok, code):
    if not ok:
        raise ValueError(code)


def lexical(path):
    need(type(path) is str, 'OUTPUT_PATH_TYPE')
    p = PureWindowsPath(path) if PureWindowsPath(path).drive else PurePosixPath(path)
    need(p.is_absolute() and '..' not in p.parts, 'ABSOLUTE_NON_TRAVERSING_PATH')
    need(not p.drive.startswith(('\\\\?\\','\\\\.\\')), 'WINDOWS_DEVICE_NAMESPACE')
    reserved = {'CON','PRN','AUX','NUL','CONIN$','CONOUT$'} | {
        prefix+suffix for prefix in ('COM','LPT') for suffix in '123456789¹²³'}
    for part in p.parts[1:]:
        need(not part.endswith(('.', ' ')) and not any(ord(ch)<32 or ch in '<>:"|?*' for ch in part)
             and part.split('.')[0].upper() not in reserved, 'REGULAR_PORTABLE_OUTPUT_COMPONENT')
    return p


def _paths(trusted, owner_path):
    root = lexical(trusted['private_output_root']); audit = lexical(owner_path).parent
    need(root.is_relative_to(audit) and len(root.parts) >= len(audit.parts)+2,
         'PRIVATE_AUDIT_NAMESPACE')
    out = trusted['outputs']
    need(type(out) is dict and set(out) == {'journal','leaf','proposal'} and
         len({lexical(p) for p in out.values()}) == 3 and all(lexical(p).parent == root for p in out.values()),
         'CLOSED_THREE_PRIVATE_OUTPUTS')
    need(trusted['private_output_root'] == str(root) and all(p == str(lexical(p)) for p in out.values()),
         'CANONICAL_NATIVE_OUTPUT_PATHS')
    need(lexical(trusted['lock_path']) == lexical(owner_path).with_suffix('.lock'), 'FIXED_OWNER_LOCK')
    return out


def _permit(core, descriptor_pin, io, trusted, writer_trusted, env):
    need(type(writer_trusted) is dict and set(writer_trusted) == {'permit','writer_module','qualifier_module',
         'code_review','merged_code_CI','private_output_root','outputs','lock_path'}, 'EXTERNAL_WRITER_CAPABILITY_REQUIRED')
    expected = copy.deepcopy(writer_trusted)
    need(expected['writer_module']['path'] == str(Path(__file__).resolve()) and
         expected['qualifier_module']['path'] == str(Path(core.__file__).resolve()), 'ACTUAL_APPROVED_MODULE_PATHS')
    o = core.Observation(io); d = o.document(descriptor_pin)
    core._trusted_envelope(d,o,trusted,env)
    for role in ('writer_module','qualifier_module'): o.pinned(expected[role])
    permit = o.document(expected['permit']); review = o.document(expected['code_review']); ci = o.document(expected['merged_code_CI'])
    root, token = trusted['root'],trusted['token']
    for row in (permit,review): core._identity(row,root,token)
    outputs = _paths(expected,trusted['owner_path'])
    need(permit['schema'] == PERMIT_SCHEMA and permit['result'] == 'ROOT_EXPLICIT_FINITE_CHECKPOINT_WRITER_PERMIT' and
         permit['writer_enabled'] is True and permit['descriptor'] == descriptor_pin and
         permit['current_owner'] == trusted['owner_pin'] and permit['current_judgment'] == trusted['current_judgment'] and
         permit['current_facts'] == trusted['current_facts'] and
         permit['before_publication_pointer'] == o.document(trusted['current_judgment'])['current_pointer'] and
         all(permit[k] == expected[k] for k in ('writer_module','qualifier_module','code_review','merged_code_CI',
             'private_output_root','outputs','lock_path')) and permit['exclusive_owner_lock_required'] is True and
         permit['new_namespace_only'] is True and all(permit[k] is False for k in ('new_generation_authorized',
             'new_acceptance_authorized','new_installation_authorized','CURRENT_write_authorized',
             'overwrite_authorized','resume_authorized','future_changes_authorized','technical_approval')),
         'EXACT_FINITE_CHECKPOINT_ONLY_PERMIT')
    roles = ('writer_module','qualifier_module')
    need(review['schema'] == REVIEW_SCHEMA and review['result'] == 'PASS' and
         set(review['retained_source_archives']) == set(roles), 'EXACT_REVIEWED_SOURCE_ARCHIVES')
    for role in roles:
        archive = review['retained_source_archives'][role]
        raw = o.pinned(archive['retained_copy'])
        need(archive['observed'] == expected[role] and archive['retained_copy']['path'] != expected[role]['path'] and
             len(raw) == expected[role]['bytes'] and hashlib.sha256(raw).hexdigest() == expected[role]['sha256'],
             'HONEST_REVIEWED_CODE_ARCHIVE')
    need(ci['schema'] == CI_SCHEMA and ci['result'] == 'PASS' and ci['merged'] is True and
         ci['all_required_checks_passed'] is True and ci['head_is_ancestor_of_merge'] is True and
         all(type(ci[k]) is str and len(ci[k]) == 40 and all(c in '0123456789abcdef' for c in ci[k])
             for k in ('head_commit','merge_commit')) and
         ci['reviewed_source_sha256'] == {r:expected[r]['sha256'] for r in roles} and
         type(ci['required_check_conclusions']) is dict and bool(ci['required_check_conclusions']) and
         all(v == 'success' for v in ci['required_check_conclusions'].values()), 'MERGED_EXACT_CODE_AND_ALL_REQUIRED_CI')
    need(review['reviewed_commit'] == ci['head_commit'] and permit['merged_code_commit'] == ci['merge_commit'],
         'EXACT_REVIEWED_COMMIT')
    o.fence()
    return expected,permit,outputs,o


def write_checkpoint_v2(descriptor_pin, io, *, core, trusted, writer_trusted=None, store=None, env=None):
    """No side effects without a caller-trusted permit; no resume or publication.

    ``core``, IO, store, and both trust envelopes are caller-controlled dependencies,
    never loaded from a descriptor. Production callers omit ``env``. Tests use
    synthetic IO and a store with no filesystem authority.
    """
    env = os.environ if env is None else env
    trusted = copy.deepcopy(trusted)
    expected,permit,outputs,pre = _permit(core,descriptor_pin,io,trusted,writer_trusted,env)
    need(store is not None, 'EXPLICIT_CHECKPOINT_STORE_REQUIRED')
    payload = (json.dumps(dict(owner_thread_id=trusted['root'],owner_execution_token=trusted['token'],
        descriptor=descriptor_pin,writer_permit=expected['permit'],scope='Generic V2 checkpoint files only',
        pid=os.getpid(),local_lock_nonce=str(uuid.uuid4())),sort_keys=True)+'\n').encode('utf8')
    with store.owner_lock(expected['lock_path'],payload) as assert_lock:
        assert_lock()
        # Requalify every permission and every physical history/current guard under lock.
        expected,permit,outputs,permission = _permit(core,descriptor_pin,io,trusted,expected,env)
        q = core.prepare_v2(descriptor_pin,io,trusted=trusted,env=env)
        candidate = core.build_candidate_v2(q); qualified = q.data
        assert_lock(); pre.fence(); permission.fence()
        need(all(not io['exists'](p) for p in outputs.values()), 'NEVER_REPLAY_EXISTING_CHECKPOINT_ATTEMPT')
        need(qualified['all_gates_before_candidate'] is True and qualified['writer_authorized'] is False,
             'READONLY_QUALIFICATION_NOT_WRITER_AUTHORITY')
        authority = {k:expected[k] for k in ('permit','writer_module','qualifier_module','code_review','merged_code_CI')}
        created = core.Observation(io)
        def output(path,pin):
            need(pin['path'] == path, 'CREATED_OUTPUT_ROLE_PATH')
            created.pinned(pin); created.native(pin['path'],io['native'](pin['path']))
            created.fence()
            return pin
        intent = dict(schema=JOURNAL_SCHEMA,result='WRITE_INTENT_NEVER_REPLAY',descriptor=descriptor_pin,
            owner_thread_id=trusted['root'],owner_execution_token=trusted['token'],writer_authority=authority,
            outputs=outputs,before_publication_pointer=permit['before_publication_pointer'],resume_authorized=False,
            PRIMARY_invocations=0,application_mutations=0,CURRENT_mutations=0,technical_approval=False)
        # This immutable intent survives every partial failure. No future run can reuse
        # its namespace, even when no leaf was completed. Never erase or rewrite it.
        journal = output(outputs['journal'],store.create(outputs['journal'],_json_bytes(intent)))
        assert_lock(); created.fence(); core.build_candidate_v2(q); permission.fence()
        leaf = copy.deepcopy(candidate)
        leaf.pop('final_schema_requires_review',None)
        leaf.update(schema=core.COMPACT_SCHEMA,result='PASS',
            baseline_snapshot=dict(facts=qualified['descriptor']['current_facts'],
                root_judgment=qualified['descriptor']['current_judgment'],descriptor=descriptor_pin),
            writer_authority=authority,writer_journal=journal,before_publication_pointer=permit['before_publication_pointer'],
            ordinary_checkpoint_written=True,publication_completed=False,
            actual_checkpoint_native_completion=None,actual_checkpoint_root_outer0=None)
        leaf_pin = output(outputs['leaf'],store.create(outputs['leaf'],_json_bytes(leaf)))
        assert_lock(); created.fence(); core.build_candidate_v2(q); permission.fence()
        template = copy.deepcopy(qualified['current_pointer'])
        template.update(latest_completed_receipt=leaf_pin,actual_checkpoint_root_outer0=None)
        proposal = dict(schema=PROPOSAL_SCHEMA,result='PRIVATE_PROPOSAL_REQUIRES_ACTUAL_NATIVE0_ROOT_OUTER0_AND_EXCLUSIVE_CAS',
            owner_thread_id=trusted['root'],owner_execution_token=trusted['token'],old_current=permit['before_publication_pointer'],
            checkpoint=leaf_pin,writer_journal=journal,writer_authority=authority,current_pointer_template=template,
            actual_native_completion_required=True,actual_ROOT_outer0_required=True,current_pointer_written=False,
            application_mutations=0,technical_approval=False)
        proposal_pin = output(outputs['proposal'],store.create(outputs['proposal'],_json_bytes(proposal)))
        assert_lock(); created.fence(); permission.fence(); core.build_candidate_v2(q)
        assert_lock(); created.fence(); permission.fence()
        return dict(result='PASS_PRIVATE_V2_LEAF_AND_PROPOSAL_WRITTEN_PENDING_ACTUAL_NATIVE0_ROOT_OUTER0_AND_CAS',
            receipt_version=leaf_pin,writer_journal=journal,publication_proposal=proposal_pin,writer_authority=authority,
            owner_thread_id=trusted['root'],owner_execution_token=trusted['token'],no_primary_invoked=True,
            no_application_mutations=True,CURRENT_mutations=0,actual_exit_code_not_claimed=True,
            publication_completed=False,technical_approval=False)


def _json_bytes(value):
    return (json.dumps(value,sort_keys=True,indent=2)+'\n').encode('utf8')


class PhysicalCheckpointStore:
    """Explicit native backend; creating an instance does not acquire authority."""
    def __init__(self, *, version, native):
        self.version,self.native = version,native

    @staticmethod
    def _safe(path):
        lexical(str(path))
        p = Path(path)
        need(p.is_absolute() and '..' not in p.parts, 'NATIVE_ABSOLUTE_PATH')
        need(str(p) == str(path), 'CANONICAL_NATIVE_OUTPUT_PATHS')
        need(all(not a.is_symlink() and not (hasattr(a,'is_junction') and a.is_junction())
             for a in (p,*p.parents)), 'NATIVE_REPARSE_PATH')
        need(p.parent.is_dir(), 'NATIVE_PARENT_REQUIRED')
        return p

    def create(self,path,raw):
        p = self._safe(path)
        with p.open('xb') as stream:
            need(stream.write(raw) == len(raw), 'COMPLETE_EXCLUSIVE_WRITE')
            stream.flush(); os.fsync(stream.fileno())
        pin = self.version(str(p))
        need(pin['bytes'] == len(raw) and pin['sha256'] == hashlib.sha256(raw).hexdigest(), 'EXACT_CREATED_BYTES')
        return pin

    @contextmanager
    def owner_lock(self,path,payload):
        p = self._safe(path); created = False; identity = None; record = None
        try:
            with p.open('xb') as stream:
                created = True; st = os.fstat(stream.fileno()); identity = (st.st_dev,st.st_ino)
                need(stream.write(payload) == len(payload), 'COMPLETE_EXCLUSIVE_LOCK_WRITE')
                stream.flush(); os.fsync(stream.fileno())
            native = self.native(str(p)); pin = self.version(str(p))
            need(tuple(native[2:4]) == identity and native[5] is True and p.read_bytes() == payload,
                 'EXCLUSIVE_LOCK_IDENTITY')
            record = native,pin
            def assert_owned():
                need(self.native(str(p)) == record[0] and self.version(str(p)) == record[1] and
                     p.read_bytes() == payload, 'EXACT_OWNED_CHECKPOINT_LOCK')
            assert_owned(); yield assert_owned; assert_owned()
        finally:
            if created and identity is not None and p.is_file():
                native = self.native(str(p))
                if tuple(native[2:4]) == identity and native[5] is True and p.read_bytes() == payload and (
                     record is None or native == record[0] and self.version(str(p)) == record[1]):
                    p.unlink()


if __name__ == '__main__':
    raise SystemExit('NO_DEFAULT_V2_WRITER_REQUIRES_REVIEWED_MERGED_CODE_AND_EXTERNAL_ROOT_CAPABILITY')
