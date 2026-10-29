"""Synthetic native receipts exercise rejection boundaries without private data."""
import base64
import copy
import hashlib
import json
import unittest

from estimator.image_receipt_lineage import (
    EVIDENCE_SCHEMA, FAMILY, QUALIFICATION, RUN17_FAMILY, RUN19_FAMILY, ReceiptError, read_native_attempt,
)


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=')
ROOT = '11111111-1111-4111-8111-111111111111'
ITEM = 'exec-22222222-2222-4222-8222-222222222222'


class Fixture:
    def __init__(self, attempt=1, preparation='wrapped'):
        self.files = {}
        self.documents = {}
        self.attempt = attempt
        self.base = 'C:/audit/session'
        self.source = self.put('C:/library/source.png', PNG)
        self.provider = self.put(f'C:/generated/{ROOT}/{ITEM}.png', PNG)
        self.private = self.put(f'{self.base}/candidate.png', PNG)
        self.refs = [self.source]
        self.args = dict(prompt='Exact original prompt.', referenced_image_paths=[self.source['path']],
                         transparent_background=False)
        self.job = dict(source_path=self.source['path'], source_sha256=self.source['sha256'],
                        status='pending_generation', output=None, review=None)
        self.raw = dict(id='record-a', fields=[dict(label='Layers', value='Two')])
        self.context = dict(job=7, attempt=attempt, root=ROOT, token='token', held_jobs=[],
                            provider_root='C:/generated', session_directory=self.base,
                            current_job=self.job, current_records={'record-a': self.raw})
        self.binding = {}
        if attempt == 2:
            prior_args = self.doc('prior-args', self.args)
            prior = self.doc('prior-return', dict(job=7, attempt=1, private_copy=self.private,
                             exact_arguments=prior_args, recorded_utc=self.time(0), technical_approval=False))
            prior_review = self.doc('prior-root', dict(job=7, attempt=1, recorded_utc=self.time(0),
                candidate=self.private, whole_return_personally_viewed=True, technical_approval=False))
            self.binding.update(prior_return=prior, prior_root_review=prior_review,
                                prior_arguments=prior_args)
            self.refs.append(self.private)
            self.args = dict(self.args, prompt='Exact original prompt. Correction.',
                             referenced_image_paths=[x['path'] for x in self.refs])
        self.args_pin = self.doc('args', self.args)
        self.prompt_pin = self.put(self.base + '/prompt.txt', self.args['prompt'].encode())
        before = dict(result=QUALIFICATION, job=7, attempt=attempt, recorded_utc=self.time(1),
                      owner_thread_id=ROOT, owner_execution_token='token', technical_approval=False,
                      accepted=False, installed=False, max_calls_this_job=2,
                      max_unique_new_canonicals=2, complete_Q=self.job, complete_RAW=self.raw,
                      exact_arguments=self.args_pin, exact_prompt=self.prompt_pin,
                      ordered_ALL_references=self.refs)
        if attempt == 2:
            before.update(previous_attempt_return=self.binding['prior_return'],
                          previous_attempt_ROOT_review=self.binding['prior_root_review'])
        self.binding['qualification'] = self.doc('qualification', before)
        self.binding['dispatch'] = self.doc('dispatch', dict(job=7, attempt=attempt,
            tool='built-in image_gen', recorded_utc=self.time(2), technical_approval=False,
            request_args=self.args_pin, qualification=self.binding['qualification']))
        returned = dict(job=7, attempt=attempt, technical_approval=False, recorded_utc=self.time(7),
                        exact_arguments=self.args_pin, exact_prompt=self.prompt_pin,
                        provider=self.provider, private_copy=self.private,
                        actual_client_start_utc=self.time(3),
                        actual_client_return_observed_utc=self.time(4))
        self.binding['returned'] = self.doc('returned', returned)
        self.binding['root_review'] = self.doc('root-review', dict(job=7, attempt=attempt,
            whole_return_personally_viewed=True, recorded_utc=self.time(8), candidate=self.private,
            technical_approval=False))
        self.peer_row = dict(job=7, attempt=attempt, candidate=self.private,
                             recorded_utc=self.time(9), technical_approval=False,
                             assessment='PASSES_ILLUSTRATION_REVIEW_WITH_LIMITS',
                             whole_original_and_every_reference_and_return_viewed=True,
                             complete_current_Q_and_RAW_equal_qualification=True,
                             qualification=self.binding['qualification'],
                             return_lineage=self.binding['returned'], source=self.source,
                             ordered_ALL_references=self.refs, historical_return_verbatim=returned)
        self.binding['independent_review'] = self.doc('peer-review', dict(
            schema='INDEPENDENT_WHOLE_RETURN_ASSESSMENT_ONLY_V1', root_owner_thread_id=ROOT,
            root_owner_execution_token='token', recorded_utc=self.time(9),
            technical_approval=False, reviews=[self.peer_row]))
        prepared = self.args
        if preparation == 'wrapped':
            prepared = {'7': dict(args=self.args, qualification=self.binding['qualification'],
                                 dispatch=self.binding['dispatch'])}
        elif preparation == 'paired':
            prepared = {'7': self.args}
        self.events = {
            'session': dict(type='session_meta', payload=dict(id=ROOT)),
            'preparation': self.event('CommandExecution', 3, dict(status='completed', exit_code=0,
                command=['shell', '-Command', 'retained command; never executed by reader'],
                aggregated_output=json.dumps(prepared))),
            'generation': self.event('Extension', 4, dict(kind='image_gen.generation', id=ITEM,
                status='completed', failure=None, revisedPrompt=self.args['prompt'],
                transparentBackground=False, savedPath=self.provider['path'],
                inputImages=[dict(path=x['path'], sha256=x['sha256']) for x in self.refs],
                result=base64.b64encode(PNG).decode())),
            'whole_view': self.event('ImageView', 5, dict(path=self.provider['path'])),
            'whole_view_pixels': dict(type='response_item', timestamp=self.time(6), payload=dict(
                type='custom_tool_call_output', output=json.dumps([dict(type='input_image',
                image_url='data:image/png;base64,' + base64.b64encode(PNG).decode())]))),
        }
        self.rebuild_events()

    @staticmethod
    def time(second):
        return f'2026-01-01T00:00:{second:02d}+00:00'

    def event(self, kind, second, item):
        return dict(type='event_msg', timestamp=self.time(second),
                    payload=dict(type='item_completed', item=dict(type=kind, **item)))

    def put(self, path, raw):
        pin = dict(path=path, bytes=len(raw), mtime_ns=1, sha256=hashlib.sha256(raw).hexdigest())
        self.files[path] = raw
        return pin

    def doc(self, name, value):
        path = self.base + '/' + name + '.json'
        self.documents[name] = copy.deepcopy(value)
        return self.put(path, json.dumps(value).encode())

    def replace_doc(self, role, value):
        self.binding[role] = self.doc(role, value)

    def rebuild_events(self):
        roles = {}
        for number, (name, event) in enumerate(self.events.items(), 1):
            raw = (json.dumps(event) + '\n').encode()
            roles[name] = dict(raw_line=self.put(self.base + '/' + name + '.jsonl', raw),
                               byte_offset=number * 100, line_number=number)
        self.binding['native_evidence'] = self.doc('native', dict(
            schema=EVIDENCE_SCHEMA, technical_approval=False, events=roles))

    def read(self, pin):
        return self.files[pin['path']]

    def run(self):
        return read_native_attempt(self.binding, self.context, self.read)

    def rebind_after_literal_change(self):
        """Keep all other evidence consistent to reach the intended deep gate."""
        dispatch = json.loads(self.read(self.binding['dispatch']))
        dispatch['qualification'] = self.binding['qualification']
        self.replace_doc('dispatch', dispatch)
        peer = json.loads(self.read(self.binding['independent_review']))
        peer['reviews'][0].update(qualification=self.binding['qualification'],
            return_lineage=self.binding['returned'],
            historical_return_verbatim=json.loads(self.read(self.binding['returned'])))
        self.replace_doc('independent_review', peer)
        item = self.events['preparation']['payload']['item']
        value = json.loads(item['aggregated_output'])
        if '7' in value and 'args' in value['7']:
            value['7']['qualification'] = self.binding['qualification']
            value['7']['dispatch'] = self.binding['dispatch']
            item['aggregated_output'] = json.dumps(value)
        self.rebuild_events()


class NativeReceiptTests(unittest.TestCase):
    def test_all_three_actual_preparation_shapes_and_both_attempt_shapes(self):
        for attempt, shape in [(1, 'wrapped'), (2, 'paired'), (2, 'singleton')]:
            with self.subTest(attempt=attempt, shape=shape):
                f = Fixture(attempt, shape)
                original = copy.deepcopy(f.documents['qualification'])
                result = f.run()
                self.assertEqual(result['family'], FAMILY)
                self.assertEqual(result['derived_return_count'], 1)
                self.assertEqual(result['literal_qualification'], original)
                self.assertEqual(result['complete_RAW_view'], {'record-a': f.raw})
                self.assertIn('provider_operation_UUID', result['absent_return_fields'])
                self.assertNotIn('provider_operation_UUID', result['literal_return'])
                self.assertFalse(result['accepted'])
                self.assertFalse(result['installed'])
                self.assertFalse(result['technical_approval'])

    def test_native_mutations_fail_closed(self):
        changes = [
            ('generation', 'revisedPrompt', 'Changed prompt'),
            ('generation', 'inputImages', []),
            ('generation', 'transparentBackground', True),
            ('generation', 'status', 'failed'),
            ('generation', 'failure', 'provider refusal'),
            ('generation', 'savedPath', 'C:/generated/other/wrong.png'),
            ('generation', 'id', 'not-a-native-id'),
            ('generation', 'result', base64.b64encode(PNG + b'changed').decode()),
            ('preparation', 'exit_code', 1),
            ('preparation', 'status', 'in_progress'),
            ('preparation', 'aggregated_output', '{}'),
            ('whole_view', 'path', 'file://remote/image.png'),
            ('whole_view', 'path', 'C:/wrong.png'),
        ]
        for role, key, value in changes:
            with self.subTest(role=role, key=key):
                f = Fixture()
                f.events[role]['payload']['item'][key] = value
                f.rebuild_events()
                with self.assertRaises(ReceiptError):
                    f.run()

    def test_missing_native_failure_field_is_not_success(self):
        f = Fixture()
        del f.events['generation']['payload']['item']['failure']
        f.rebuild_events()
        with self.assertRaises(ReceiptError):
            f.run()

    def test_crossed_job_attempt_owner_source_and_held_jobs_rejected(self):
        changes = [('job', 8), ('attempt', 2), ('root', 'other'), ('token', 'other'),
                   ('held_jobs', [7]), ('provider_root', 'C:/elsewhere'),
                   ('session_directory', 'C:/elsewhere')]
        for key, value in changes:
            with self.subTest(key=key):
                f = Fixture()
                f.context[key] = value
                with self.assertRaises(ReceiptError):
                    f.run()
        for key in ['current_job', 'current_records']:
            f = Fixture()
            f.context[key] = {}
            with self.assertRaises(ReceiptError):
                f.run()

    def test_changed_prompt_bytes_and_png_bytes_rejected(self):
        for path in ['C:/audit/session/prompt.txt', 'C:/audit/session/candidate.png']:
            f = Fixture()
            f.files[path] += b'changed'
            with self.assertRaises(ReceiptError):
                f.run()

    def test_reference_order_and_crossed_correction_parent_rejected(self):
        f = Fixture(2, 'paired')
        f.events['generation']['payload']['item']['inputImages'].reverse()
        f.rebuild_events()
        with self.assertRaises(ReceiptError):
            f.run()
        f = Fixture(2, 'paired')
        prior = copy.deepcopy(f.documents['prior-return'])
        prior['job'] = 9
        f.binding['prior_return'] = f.doc('wrong-prior', prior)
        with self.assertRaises(ReceiptError):
            f.run()

    def test_native_and_review_chronology_cannot_be_backdated(self):
        for role in ['preparation', 'generation', 'whole_view', 'whole_view_pixels']:
            f = Fixture()
            f.events[role]['timestamp'] = f.time(0)
            f.rebuild_events()
            with self.assertRaises(ReceiptError):
                f.run()
        f = Fixture()
        review = copy.deepcopy(f.documents['root-review'])
        review['recorded_utc'] = f.time(0)
        f.replace_doc('root_review', review)
        with self.assertRaises(ReceiptError):
            f.run()

    def test_independent_review_missing_duplicated_or_crossed_rejected(self):
        for rows in [[], [{**Fixture().peer_row, 'job': 9}],
                     [Fixture().peer_row, Fixture().peer_row]]:
            f = Fixture()
            peer = copy.deepcopy(f.documents['peer-review'])
            peer['reviews'] = rows
            f.replace_doc('independent_review', peer)
            with self.assertRaises(ReceiptError):
                f.run()

    def test_missing_whole_view_pixels_and_wrong_root_session_rejected(self):
        f = Fixture()
        f.events['whole_view_pixels']['payload']['output'] = '[]'
        f.rebuild_events()
        with self.assertRaises(ReceiptError):
            f.run()
        f = Fixture()
        f.events['session']['payload']['id'] = 'other'
        f.rebuild_events()
        with self.assertRaises(ReceiptError):
            f.run()

    def test_pin_and_native_evidence_are_not_unchecked_assertions(self):
        f = Fixture()
        evidence = copy.deepcopy(f.documents['native'])
        del evidence['events']['generation']
        f.binding['native_evidence'] = f.doc('incomplete-native', evidence)
        with self.assertRaises(ReceiptError):
            f.run()
        f = Fixture()
        evidence = copy.deepcopy(f.documents['native'])
        evidence['events']['generation']['raw_line']['sha256'] = '0' * 64
        f.binding['native_evidence'] = f.doc('wrong-native-hash', evidence)
        with self.assertRaises(ReceiptError):
            f.run()

    def test_new_family_never_retags_or_accepts_historical_records(self):
        f = Fixture()
        before = copy.deepcopy(f.documents['qualification'])
        before['result'] = 'ROOT_FINITE_SOURCE_ONLY_PRIVATE_QUALIFICATION_NOT_INSTALL_ADMISSION'
        f.replace_doc('qualification', before)
        with self.assertRaises(ReceiptError):
            f.run()
        for key in ['accepted', 'installed', 'selected']:
            f = Fixture()
            returned = copy.deepcopy(f.documents['returned'])
            returned[key] = True
            f.replace_doc('returned', returned)
            with self.assertRaises(ReceiptError):
                f.run()

    def test_every_present_return_binding_is_checked(self):
        for key, value in [('actual_dispatch', {}), ('dispatch', {}),
                           ('before_call_qualification', {}), ('qualification', {}), ('arguments', {}),
                           ('owner_thread_id', 'wrong'), ('owner_execution_token', 'wrong'),
                           ('actual_return_count', 2), ('actual_return_count', True),
                           ('return_index', 1), ('return_index', False),
                           ('provider_operation_UUID', ITEM)]:
            with self.subTest(key=key, value=value):
                f = Fixture()
                returned = copy.deepcopy(f.documents['returned'])
                returned[key] = value
                f.replace_doc('returned', returned)
                f.rebind_after_literal_change()
                with self.assertRaises(ReceiptError):
                    f.run()

    def test_correction_prior_review_must_review_that_exact_image_without_technical_approval(self):
        for key, value in [('candidate', {}), ('technical_approval', True),
                           ('whole_return_personally_viewed', False)]:
            f = Fixture(2, 'paired')
            prior_review = copy.deepcopy(f.documents['prior-root'])
            prior_review[key] = value
            # Bind the changed prior review consistently, so ancestry equality
            # alone cannot reject it and conceal a missing image/approval check.
            new_pin = f.doc('bad-prior-root', prior_review)
            f.binding['prior_root_review'] = new_pin
            before = copy.deepcopy(f.documents['qualification'])
            before['previous_attempt_ROOT_review'] = new_pin
            f.replace_doc('qualification', before)
            dispatch = copy.deepcopy(f.documents['dispatch'])
            dispatch['qualification'] = f.binding['qualification']
            f.replace_doc('dispatch', dispatch)
            f.rebind_after_literal_change()
            with self.assertRaises(ReceiptError):
                f.run()

    def test_independent_review_actual_scope_and_all_present_bindings_required(self):
        for key, value in [('assessment', ''), ('assessment', 'accepted'),
                           ('whole_original_and_every_reference_and_return_viewed', False),
                           ('complete_current_Q_and_RAW_equal_qualification', False),
                           ('qualification', {}), ('return_lineage', {}),
                           ('source', {}), ('ordered_ALL_references', []),
                           ('historical_return_verbatim', {})]:
            f = Fixture()
            peer = copy.deepcopy(f.documents['peer-review'])
            peer['reviews'][0][key] = value
            f.replace_doc('independent_review', peer)
            with self.assertRaises(ReceiptError):
                f.run()

    def test_peer_image_alias_may_not_contradict_its_candidate(self):
        f = Fixture()
        peer = copy.deepcopy(f.documents['peer-review'])
        peer['reviews'][0]['private_copy'] = {}
        f.replace_doc('independent_review', peer)
        with self.assertRaises(ReceiptError):
            f.run()

    def test_booleans_are_not_recorded_integer_identities_or_exit_codes(self):
        for role in ['qualification', 'dispatch', 'returned']:
            f = Fixture()
            doc = json.loads(f.read(f.binding[role]))
            doc['attempt'] = True
            f.replace_doc(role, doc)
            f.rebind_after_literal_change()
            with self.assertRaises(ReceiptError):
                f.run()
        f = Fixture()
        f.events['preparation']['payload']['item']['exit_code'] = False
        f.rebuild_events()
        with self.assertRaises(ReceiptError):
            f.run()

    def test_present_client_observation_times_cannot_contradict_native_completion(self):
        for key, value in [('actual_client_start_utc', Fixture.time(9)),
                           ('actual_client_start_utc', Fixture.time(2)),
                           ('actual_client_return_observed_utc', Fixture.time(0)),
                           ('actual_client_return_observed_utc', Fixture.time(9))]:
            f = Fixture()
            returned = copy.deepcopy(f.documents['returned'])
            returned[key] = value
            f.replace_doc('returned', returned)
            f.rebind_after_literal_change()
            with self.assertRaises(ReceiptError):
                f.run()
        # A completion later within the observer's recorded second is valid;
        # claiming that the clock proved millisecond precision would be false.
        f = Fixture()
        f.events['generation']['timestamp'] = '2026-01-01T00:00:04.900+00:00'
        f.rebuild_events()
        self.assertEqual(f.run()['derived_return_count'], 1)

    def test_traversal_cannot_hide_inside_lexically_relative_paths(self):
        f = Fixture()
        returned = copy.deepcopy(f.documents['returned'])
        returned['private_copy']['path'] = f.base + '/nested/../../outside.png'
        f.files[returned['private_copy']['path']] = PNG
        f.replace_doc('returned', returned)
        with self.assertRaises(ReceiptError):
            f.run()

    def test_native_offsets_and_line_numbers_are_not_unchecked_claims(self):
        for key in ['byte_offset', 'line_number']:
            f = Fixture()
            evidence = copy.deepcopy(f.documents['native'])
            evidence['events']['generation'][key] = evidence['events']['preparation'][key]
            f.binding['native_evidence'] = f.doc('duplicate-position', evidence)
            with self.assertRaises(ReceiptError):
                f.run()






PEER = '33333333-3333-4333-8333-333333333333'


class LiteralFixture(Fixture):
    def __init__(self, family=RUN17_FAMILY):
        super().__init__(preparation='singleton')
        self.family = family
        self.binding['literal_family'] = family
        self.job['references'] = [dict(kind='technical',record_id='record-a')]
        before = self.documents['qualification']
        before['complete_Q'] = self.job
        self.replace_doc('qualification',before)
        if family == RUN19_FAMILY:
            reservation = dict(job=7, attempt=1, technical_approval=False, accepted=False, installed=False,
                complete_Q=self.job, complete_direct_RAW={'record-a':dict(kind='technical',raw=self.raw)}, exact_arguments=self.args_pin,
                exact_prompt=self.prompt_pin, ALL_ordered_references=self.refs,
                one_builtin_call_reserved=True, call_dispatched=False)
            other_args = dict(self.args, prompt='Other job prompt.')
            self.other_args = other_args
            other = dict(reservation, job=8, exact_arguments=self.doc('other-args',other_args),
                         exact_prompt=self.put(self.base+'/other-prompt.txt',other_args['prompt'].encode()))
            before = dict(result='ROOT_FINITE_SOURCE_ONLY_TWO_PRIVATE_CALL_QUALIFICATION_NOT_ACCEPTANCE_OR_INSTALL',
                recorded_utc=self.time(1), owner_thread_id=ROOT, owner_execution_token='token', technical_approval=False,
                targets=[7,8], maximum_new_canonical=12, reserved_distinct_jobs_after_dispatch=list(range(12)),
                reserved_distinct_count=12, continuing_ten_distinct_jobs=[0,1,2,3,4,5,6,9,10,11],
                reservations={'7':reservation,'8':other})
            self.replace_doc('qualification',before)
        dispatch = dict(job=7, attempt=1, recorded_utc=self.time(2), technical_approval=False,
                        exact_arguments=self.args_pin)
        if family == RUN17_FAMILY:
            dispatch.update(actual_tool_requested_next='image_gen.imagegen',dispatch_request_reserved=True,
                            qualification_sha256=self.binding['qualification']['sha256'])
        else:
            dispatch.update(qualification=self.binding['qualification'],exact_prompt=self.prompt_pin,
                            ALL_ordered_references=self.refs)
        self.replace_doc('dispatch',dispatch)
        returned = dict(job=7,attempt=1,recorded_utc=self.time(7),technical_approval=False,
                        accepted=False,selected=False,installed=False,exact_arguments=self.args_pin,
                        provider_original=self.provider)
        if family == RUN17_FAMILY:
            returned.update(retained_private_copy=self.private,qualification=self.binding['qualification'],
                returned_candidates=1,tool_observed_start_UTC='2026-01-01 00:00:03 UTC',
                tool_observed_return_UTC='2026-01-01 00:00:04 UTC',clock_precision_seconds=1)
        else:
            returned.update(private_copy=self.private,actual_dispatch=self.binding['dispatch'],
                            exact_prompt=self.prompt_pin,return_index=0)
        self.replace_doc('returned',returned)
        self.events['preparation']['payload']['item']['aggregated_output']=json.dumps(self.args)
        self.events['session']['payload']['id']=ROOT
        for role in ('preparation','generation','whole_view'):
            self.events[role]['payload']['thread_id']=ROOT
        self.events['whole_view']['payload']['item']['path']=self.private['path']
        if family == RUN17_FAMILY:
            initial=self.doc('initial-root',dict(job=7,attempt=1,candidate=self.private,
                result='ORDINARY_QUALITY_PENDING_TWO_LAYER_VISIBILITY_AND_INDEPENDENT_REVIEW',
                whole_image_viewed=True,source_original_whole_viewed=True,technical_approval=False,
                recorded_utc=self.time(7)))
            peer=dict(schema='INDEPENDENT_WHOLE_RETURN_ASSESSMENT_NOT_ACCEPTANCE',job=7,attempt=1,
                recorded_utc=self.time(9),technical_approval=False,acceptance=False,selection=False,installation=False,
                candidate=self.provider,qualification=self.binding['qualification'],actual_dispatch=self.binding['dispatch'],
                exact_prompt=self.prompt_pin,exact_arguments=self.args_pin,ALL_ordered_references=self.refs,
                complete_original_whole_viewed=True,candidate_whole_viewed=True,complete_Q_matches_current=True,
                full_Q=self.job,full_RAW=self.raw)
            self.replace_doc('independent_review',peer)
            root=dict(job=7,attempt=1,candidate=self.private,recorded_utc=self.time(10),technical_approval=False,
                result='PROVISIONAL_ILLUSTRATION_PASS_WITH_NATURAL_OCCLUSION_LIMITS_NOT_ACCEPTANCE',
                dated_initial_root_review=initial,independent_review=self.binding['independent_review'])
        else:
            peer=dict(self.peer_row,recorded_utc=self.time(9),schema='INDEPENDENT_WHOLE_RETURN_ASSESSMENT_ONLY_V1',
                root_owner_thread_id=ROOT,root_owner_execution_token='token',private_copy=self.private,
                qualification=self.binding['qualification'],return_lineage=self.binding['returned'],historical_return_verbatim=returned)
            self.replace_doc('independent_review',peer)
            root=dict(job=7,attempt=1,recorded_utc=self.time(8),technical_approval=False,
                whole_return_personally_viewed=True,exact_return=self.private,
                owner_thread_id=ROOT,owner_execution_token='token')
            self.events['preparation']['payload']['item']['aggregated_output']=json.dumps([
                dict(job=7,args=self.args,dispatch=self.binding['dispatch']),
                dict(job=8,args=self.other_args,dispatch=dict(self.binding['dispatch'],path=self.base+'/other.json'))])
            self.events['preparation_store']=dict(type='response_item',timestamp=self.time(2),payload=dict(
                type='custom_tool_call',name='exec',input='const r=await tools.exec_command({cmd:'+json.dumps(self.events['preparation']['payload']['item']['command'][-1])+'});if(r.exit_code!==0){text(r);exit();}const rows=JSON.parse(r.output);for(const row of rows)store("jobs"+row.job,row);text(rows.map(x=>({job:x.job,dispatch:x.dispatch})));'))
            self.events['dispatch']=dict(type='response_item',timestamp=self.time(3),payload=dict(
                type='custom_tool_call',name='exec',call_id='call-group',input='const started=Date.now();const calls=[tools.image_gen__imagegen(load("jobs7").args).then(result=>generatedImage(result)),tools.image_gen__imagegen(load("jobs8").args).then(result=>generatedImage(result))];store("client_dispatch_ms",started);await Promise.allSettled(calls).then(results=>text(results));'))
            self.events['dispatch_return']=copy.deepcopy(self.events['whole_view_pixels'])
            self.events['dispatch_return'].update(timestamp=self.time(5))
            self.events['dispatch_return']['payload']['call_id']='call-group'
        self.replace_doc('root_review',root)
        self.events['peer_session']=dict(type='session_meta',payload=dict(id=PEER,
            source=dict(subagent=dict(thread_spawn=dict(parent_thread_id=ROOT)))))
        self.events['peer_whole_view']=self.event('ImageView',5,dict(path=self.provider['path']))
        self.events['peer_whole_view']['payload']['thread_id']=PEER
        self.events['peer_whole_view_pixels']=copy.deepcopy(self.events['whole_view_pixels'])
        written=self.binding['independent_review'] if family==RUN17_FAMILY else {'job7':self.binding['independent_review']}
        self.events['peer_review_write']=self.event('CommandExecution',10,dict(status='completed',exit_code=0,
            aggregated_output=json.dumps(written)))
        self.events['peer_review_write']['payload']['thread_id']=PEER
        order=['session','preparation','generation','whole_view','whole_view_pixels'] if family==RUN17_FAMILY else [
            'session','preparation_store','preparation','dispatch','generation','dispatch_return']
        order+=['peer_session','peer_whole_view','peer_whole_view_pixels','peer_review_write']
        self.events={k:self.events[k] for k in order}
        self.rebuild_events()

    def rebuild_events(self):
        super().rebuild_events()
        if hasattr(self,'family'):
            native=self.documents['native'];native['literal_family']=self.family
            self.binding['native_evidence']=self.doc('native',native)


class LiteralFamilyTests(unittest.TestCase):
    def test_both_actual_literal_shapes_preserve_every_RAW_object_and_absence(self):
        for family in (RUN17_FAMILY,RUN19_FAMILY):
            with self.subTest(family=family):
                f=LiteralFixture(family);snapshot=copy.deepcopy(f.documents);result=f.run()
                self.assertEqual(result['literal_family'],family)
                self.assertEqual(result['literal_qualification'],snapshot['qualification'])
                self.assertEqual(result['literal_dispatch'],snapshot['dispatch'])
                self.assertEqual(result['literal_return'],snapshot['returned'])
                self.assertEqual(result['complete_RAW_view'],{'record-a':f.raw})
                self.assertEqual(f.documents,snapshot)
                self.assertIs(result['accepted'],False);self.assertIs(result['installed'],False)
                self.assertIs(result['technical_approval'],False)
                if family==RUN17_FAMILY:
                    self.assertNotIn('exact_prompt',result['literal_return'])
                    self.assertEqual(result['initial_ROOT_review']['result'],'ORDINARY_QUALITY_PENDING_TWO_LAYER_VISIBILITY_AND_INDEPENDENT_REVIEW')
                else:
                    self.assertNotIn('job',result['literal_qualification'])
                    self.assertEqual(result['literal_reservation'],snapshot['qualification']['reservations']['7'])
                    self.assertEqual(result['root_presentation'],'native_inline_tool_result')

    def test_unknown_selector_does_not_fall_back_to_default(self):
        f=Fixture();f.binding['literal_family']='unknown'
        with self.assertRaisesRegex(ReceiptError,'unknown literal'):f.run()

    def test_each_generation_and_peer_scope_change_fails(self):
        changes=[('root','other'),('token','other'),('job',8),('attempt',2),('held_jobs',[7]),
                 ('current_records',{}),('current_job',{}),('provider_root','C:/other'),('session_directory','C:/other')]
        for family in (RUN17_FAMILY,RUN19_FAMILY):
            for key,value in changes:
                with self.subTest(family=family,key=key):
                    f=LiteralFixture(family);f.context[key]=value
                    with self.assertRaises(ReceiptError):f.run()

    def test_native_pixels_refs_prompt_and_presentation_cannot_be_crossed(self):
        mutations=[('generation','result',base64.b64encode(PNG+b'wrong').decode()),
            ('generation','revisedPrompt','wrong'),('generation','inputImages',[]),
            ('generation','failure','failed'),('generation','savedPath','C:/wrong.png'),
            ('peer_whole_view','path','C:/wrong.png'),('peer_review_write','exit_code',True)]
        for family in (RUN17_FAMILY,RUN19_FAMILY):
            for role,key,value in mutations:
                with self.subTest(family=family,role=role,key=key):
                    f=LiteralFixture(family);f.events[role]['payload']['item'][key]=value;f.rebuild_events()
                    with self.assertRaises(ReceiptError):f.run()

    def test_peer_own_session_pixels_and_write_are_not_replaceable_assertions(self):
        for family in (RUN17_FAMILY,RUN19_FAMILY):
            for role in ('peer_session','peer_whole_view_pixels','peer_review_write'):
                with self.subTest(family=family,role=role):
                    f=LiteralFixture(family)
                    if role=='peer_session':f.events[role]['payload']['source']['subagent']['thread_spawn']['parent_thread_id']='other'
                    elif role=='peer_whole_view_pixels':f.events[role]['payload']['output']='[]'
                    else:f.events[role]['payload']['item']['aggregated_output']='{}'
                    f.rebuild_events()
                    with self.assertRaises(ReceiptError):f.run()

    def test_clock_precision_and_observations_stay_literal(self):
        for key,value in [('tool_observed_return_UTC','2026-01-01 00:00:03 UTC'),
                          ('tool_observed_start_UTC','invented'),('clock_precision_seconds',True)]:
            f=LiteralFixture();r=copy.deepcopy(f.documents['returned']);r[key]=value;f.replace_doc('returned',r)
            with self.assertRaises(ReceiptError):f.run()

    def test_grouped_job_store_call_and_return_mapping_is_exact(self):
        changes=[('dispatch','input','tools.image_gen__imagegen(load("jobs8").args).then(result=>generatedImage(result))'),
                 ('dispatch_return','call_id','other'),('preparation_store','input','store("jobs7", {});')]
        for role,key,value in changes:
            f=LiteralFixture(RUN19_FAMILY);f.events[role]['payload'][key]=value;f.rebuild_events()
            with self.assertRaises(ReceiptError):f.run()
        f=LiteralFixture(RUN19_FAMILY);f.events['dispatch_return']['payload']['output']='[]';f.rebuild_events()
        with self.assertRaises(ReceiptError):f.run()

    def test_duplicate_group_reservations_cannot_hide_budget_or_job_changes(self):
        for key,value in [('reserved_distinct_count',True),('reserved_distinct_jobs_after_dispatch',[7,7]),
                          ('targets',[7,7]),('maximum_new_canonical',13)]:
            f=LiteralFixture(RUN19_FAMILY);q=copy.deepcopy(f.documents['qualification']);q[key]=value;f.replace_doc('qualification',q)
            with self.assertRaises(ReceiptError):f.run()

    def test_supplementary_review_never_retimes_initial_pending_review(self):
        f=LiteralFixture();root=copy.deepcopy(f.documents['root_review']);root['recorded_utc']=f.time(5);f.replace_doc('root_review',root)
        with self.assertRaises(ReceiptError):f.run()

    def test_every_present_return_alias_and_disposition_is_checked(self):
        for family in (RUN17_FAMILY,RUN19_FAMILY):
            for key,value in [('provider',{'bad':True}),('private_copy',{'bad':True}),('retained_private_copy',{'bad':True}),('exact_prompt',{'bad':True}),('owner_execution_token','other'),('actual_return_count',True),('provider_operation_UUID','invented'),('accepted',True)]:
                f=LiteralFixture(family);r=copy.deepcopy(f.documents['returned']);r[key]=value;f.replace_doc('returned',r)
                with self.assertRaises(ReceiptError):f.run()


    def test_all_present_argument_reference_tool_and_authority_aliases_checked(self):
        changes=[('request_args',{'bad':True}),('arguments',{'bad':True}),('ALL_ordered_references',[]),
                 ('ordered_ALL_references',[]),('actual_tool','other'),('actual_tool_requested_next','other'),
                 ('acceptance_authorized',True),('installation_authorized',True)]
        for family in (RUN17_FAMILY,RUN19_FAMILY):
            for role in ('dispatch','returned'):
                for key,value in changes:
                    with self.subTest(family=family,role=role,key=key):
                        f=LiteralFixture(family);d=copy.deepcopy(f.documents[role]);d[key]=value;f.replace_doc(role,d)
                        with self.assertRaises(ReceiptError):f.run()

    def test_grouped_RAW_is_exact_keyed_map_not_a_synthesized_singleton(self):
        for value in [{},{'other':{'id':'other'}},{'record-a':{'id':'record-a','fields':[]}}]:
            f=LiteralFixture(RUN19_FAMILY);q=copy.deepcopy(f.documents['qualification'])
            q['reservations']['7']['complete_direct_RAW']=value;f.replace_doc('qualification',q)
            with self.assertRaisesRegex(ReceiptError,'complete RAW changed'):f.run()

    def test_every_group_native_phase_timestamp_and_root_view_chronology_checked(self):
        for role,second in [('preparation_store',4),('dispatch',6),('dispatch_return',3)]:
            f=LiteralFixture(RUN19_FAMILY);f.events[role]['timestamp']=f.time(second);f.rebuild_events()
            with self.assertRaisesRegex(ReceiptError,'chronology'):f.run()
        f=LiteralFixture();f.events['whole_view']['timestamp']=f.time(3);f.rebuild_events()
        with self.assertRaisesRegex(ReceiptError,'predates native generation'):f.run()

    def test_quoted_fake_store_recipe_does_not_replace_executed_outer_recipe(self):
        f=LiteralFixture(RUN19_FAMILY)
        f.events['preparation_store']['payload']['input']='const r=await tools.exec_command({cmd:'+json.dumps('const rows=JSON.parse(r.output);for(const row of rows)store("jobs"+row.job,row);text(rows.map(x=>({job:x.job,dispatch:x.dispatch})));')+'});'
        f.rebuild_events()
        with self.assertRaises(ReceiptError):f.run()



    def test_all_group_reservation_identities_and_holds_are_checked(self):
        f=LiteralFixture(RUN19_FAMILY);f.context['held_jobs']=[8]
        with self.assertRaisesRegex(ReceiptError,'held grouped target'):f.run()
        for key,value in [('job',7),('attempt',True),('accepted',True)]:
            f=LiteralFixture(RUN19_FAMILY);q=copy.deepcopy(f.documents['qualification'])
            q['reservations']['8'][key]=value;f.replace_doc('qualification',q)
            with self.assertRaises(ReceiptError):f.run()

    def test_other_prepared_row_must_bind_its_own_literal_args_without_source_admission(self):
        f=LiteralFixture(RUN19_FAMILY)
        item=f.events['preparation']['payload']['item'];rows=json.loads(item['aggregated_output'])
        rows[1]['args']=copy.deepcopy(rows[0]['args']);item['aggregated_output']=json.dumps(rows);f.rebuild_events()
        with self.assertRaisesRegex(ReceiptError,'own literal reservation arguments'):f.run()



    def test_quoted_whole_preparation_tail_and_dispatch_are_inert_data(self):
        f=LiteralFixture(RUN19_FAMILY)
        for role in ('preparation_store','dispatch'):
            bad=copy.deepcopy(f.events);code=f.events[role]['payload']['input']
            f.events[role]['payload']['input']='const quotedOnly = '+json.dumps(code)+';';f.rebuild_events()
            with self.assertRaises(ReceiptError):f.run()
            f.events=bad;f.rebuild_events()
        code=f.events['preparation_store']['payload']['input'];marker=code.index('if(r.exit_code')
        f.events['preparation_store']['payload']['input']=code[:marker]+'const fake='+json.dumps(code[marker:])+';';f.rebuild_events()
        with self.assertRaises(ReceiptError):f.run()

    def test_unobserved_provider_UUID_cannot_be_in_before_or_dispatch(self):
        for family in (RUN17_FAMILY,RUN19_FAMILY):
            for role in ('qualification','dispatch'):
                f=LiteralFixture(family);d=copy.deepcopy(f.documents[role]);d['provider_operation_UUID']='invented';f.replace_doc(role,d)
                with self.assertRaisesRegex(ReceiptError,'unobserved provider'):f.run()



    def test_grouped_literal_kind_wrapper_is_preserved_and_kind_must_match_job(self):
        f=LiteralFixture(RUN19_FAMILY);result=f.run()
        self.assertEqual(result['literal_reservation']['complete_direct_RAW'],{'record-a':{'kind':'technical','raw':f.raw}})
        self.assertEqual(result['complete_RAW_view'],{'record-a':f.raw})
        q=copy.deepcopy(f.documents['qualification']);q['reservations']['7']['complete_direct_RAW']['record-a']['kind']='wrong'
        f.replace_doc('qualification',q)
        with self.assertRaisesRegex(ReceiptError,'complete RAW changed'):f.run()


if __name__ == '__main__':
    unittest.main()
