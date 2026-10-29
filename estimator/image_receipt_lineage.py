"""Read one literal private image attempt from pinned native evidence.

This is a pure, additional receipt reader, not acceptance or installation.
The caller must still enforce ownership, holds, complete source/graph equality,
closed batch budgets, protected-state admission and the existing installer gates.
No historical document is rewritten and no recorded absence is filled in.
"""
import base64
import copy
from datetime import datetime, timedelta
import hashlib
import json
import re
from pathlib import PureWindowsPath
from urllib.parse import unquote, urlsplit
from uuid import UUID


FAMILY = 'SOURCE_ONLY_NATIVE_GENERATION_V1'
QUALIFICATION = 'FINITE_PRIVATE_CANDIDATE_ONLY_NOT_ACCEPTANCE_OR_INSTALL'
EVIDENCE_SCHEMA = 'RECORDED_NATIVE_IMAGE_GENERATION_EVIDENCE_V1'


class ReceiptError(ValueError):
    """Pinned evidence is incomplete, inconsistent or outside this family."""


def _need(condition, reason):
    if not condition:
        raise ReceiptError(reason)


def _time(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        _need(result.utcoffset() is not None, 'timestamp needs a timezone')
        return result
    except (AttributeError, TypeError, ValueError) as exc:
        raise ReceiptError('invalid timestamp') from exc


def _same_path(left, right):
    return PureWindowsPath(left) == PureWindowsPath(right)


def _contained(path, directory):
    value, root = PureWindowsPath(path), PureWindowsPath(directory)
    return (value.is_absolute() and root.is_absolute()
            and '..' not in value.parts and '..' not in root.parts
            and value.is_relative_to(root))


def _review_image(review, candidate):
    keys = [key for key in ('candidate', 'private_copy') if key in review]
    return bool(keys) and all(review[key] == candidate for key in keys)


def _identity(document, job, attempt):
    return (type(document.get('job')) is int and document['job'] == job
            and type(document.get('attempt')) is int and document['attempt'] == attempt)


def _clock_interval(value):
    """Recorded clock observations have second precision, not provider timing."""
    _need(type(value) is str and re.fullmatch(
        r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})', value),
        'recorded second-precision clock required')
    start = _time(value)
    return start, start + timedelta(seconds=1)


def _image_path(value):
    if value.startswith('file:'):
        uri = urlsplit(value)
        _need(uri.scheme == 'file' and not uri.netloc and not uri.query
              and not uri.fragment, 'local image view required')
        value = unquote(uri.path)
        if len(value) > 3 and value[0] == '/' and value[2] == ':':
            value = value[1:]
    return value


def _pin_bytes(pin, read_pinned):
    _need(type(pin) is dict and set(pin) == {'path', 'bytes', 'mtime_ns', 'sha256'},
          'exact four-field pin required')
    _need(type(pin['path']) is str and pin['path'] and type(pin['bytes']) is int
          and pin['bytes'] > 0 and type(pin['mtime_ns']) is int
          and pin['mtime_ns'] >= 0 and type(pin['sha256']) is str
          and len(pin['sha256']) == 64, 'invalid pin')
    # read_pinned is the existing trusted, full-version-checking I/O hook.
    # Recheck content here as well; it must not be a JSON-supplied assertion.
    raw = read_pinned(copy.deepcopy(pin))
    _need(type(raw) is bytes and len(raw) == pin['bytes']
          and hashlib.sha256(raw).hexdigest() == pin['sha256'], 'pinned bytes changed')
    return raw


def _document(pin, read_pinned):
    try:
        result = json.loads(_pin_bytes(pin, read_pinned))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ReceiptError('invalid pinned JSON') from exc
    _need(type(result) is dict, 'object document required')
    return result


def _native(role, evidence, read_pinned):
    binding = evidence['events'][role]
    _need(type(binding) is dict and set(binding) == {'raw_line', 'byte_offset', 'line_number'},
          'native event binding required')
    _need(type(binding['byte_offset']) is int and binding['byte_offset'] >= 0
          and type(binding['line_number']) is int and binding['line_number'] >= 1,
          'invalid native event position')
    raw = _pin_bytes(binding['raw_line'], read_pinned)
    _need(raw.endswith(b'\n') and b'\n' not in raw[:-1], 'one exact native line required')
    event = json.loads(raw)
    _need(type(event) is dict and type(event.get('payload')) is dict,
          'native event object required')
    return event


def _item(event, kind):
    _need(event.get('type') == 'event_msg'
          and event['payload'].get('type') == 'item_completed', 'completed native item required')
    item = event['payload'].get('item')
    _need(type(item) is dict and item.get('type') == kind, 'wrong native item kind')
    return item


def _prepared_arguments(item, job):
    _need(item.get('status') == 'completed' and type(item.get('exit_code')) is int
          and item['exit_code'] == 0,
          'successful preparation required')
    _need(type(item.get('command')) is list and item['command']
          and all(type(x) is str for x in item['command']), 'native command missing')
    try:
        value = json.loads(item['aggregated_output'])
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ReceiptError('complete preparation JSON required') from exc
    _need(type(value) is dict, 'preparation result must be an object')
    if 'prompt' in value:
        return value, None
    _need(str(job) in value and type(value[str(job)]) is dict,
          'job absent from preparation')
    value = value[str(job)]
    return (value['args'], value) if 'args' in value else (value, None)


def _pngs(value):
    """Only collect actual image content blocks, not quoted filenames or hints."""
    found = []
    if isinstance(value, str) and value.startswith('[{'):
        try:
            return _pngs(json.loads(value))
        except json.JSONDecodeError:
            return []
    if isinstance(value, list):
        for child in value:
            found.extend(_pngs(child))
    elif isinstance(value, dict):
        if value.get('type') == 'input_image':
            url = value.get('image_url', '')
            _need(url.startswith('data:image/png;base64,'), 'PNG whole-view pixels required')
            try:
                found.append(base64.b64decode(url.split(',', 1)[1], validate=True))
            except (ValueError, TypeError) as exc:
                raise ReceiptError('invalid whole-view pixels') from exc
        for child in value.values():
            if isinstance(child, (dict, list)):
                found.extend(_pngs(child))
    return found


def _read_native_attempt(binding, context, read_pinned):
    """Return a lossless derived view; never grant illustration acceptance.

    context supplies trusted root/token/job/attempt, current_job/current_records,
    held_jobs, provider_root and session_directory. read_pinned must enforce the
    complete declared version (including mtime), as the existing scope does.
    binding supplies pinned literal documents and a pinned native-event bundle.
    A2 additionally supplies its exact prior literal return, root review and args.
    """
    _need(callable(read_pinned), 'trusted pinned reader required')
    n, attempt = context['job'], context['attempt']
    _need(type(n) is int and n >= 0 and type(attempt) is int and attempt in (1, 2)
          and n not in context['held_jobs'], 'held or invalid target')
    before = _document(binding['qualification'], read_pinned)
    returned = _document(binding['returned'], read_pinned)
    dispatch = _document(binding['dispatch'], read_pinned)
    args = _document(before['exact_arguments'], read_pinned)
    prompt = _pin_bytes(before['exact_prompt'], read_pinned)
    _need(before.get('result') == QUALIFICATION and _identity(before, n, attempt)
          and before.get('technical_approval') is False
          and before.get('accepted') is False and before.get('installed') is False,
          'literal private qualification required')
    _need(before.get('owner_thread_id') == context['root']
          and before.get('owner_execution_token') == context['token'], 'qualification owner mismatch')
    _need(type(before.get('max_calls_this_job')) is int and before['max_calls_this_job'] == 2
          and type(before.get('max_unique_new_canonicals')) is int
          and before['max_unique_new_canonicals'] in (1, 2),
          'literal finite budget required')
    _need(before['complete_Q'] == context['current_job'], 'current complete job changed')
    _need(context['current_job'].get('status') == 'pending_generation'
          and context['current_job'].get('output') is None
          and context['current_job'].get('review') is None, 'pending unaccepted job required')
    raw = before['complete_RAW']
    _need(type(raw) is dict and raw.get('id') in context['current_records']
          and {raw['id']: raw} == context['current_records'], 'current complete RAW changed')
    _need(set(args) == {'prompt', 'referenced_image_paths', 'transparent_background'}
          and type(args['prompt']) is str and args['prompt'].encode('utf-8') == prompt
          and args['transparent_background'] is False, 'exact prompt arguments required')
    refs = before['ordered_ALL_references']
    _need(type(refs) is list and len(refs) == attempt
          and args['referenced_image_paths'] == [x['path'] for x in refs], 'ALL reference order changed')
    for ref in refs:
        _pin_bytes(ref, read_pinned)
    _need(refs[0]['path'] == context['current_job']['source_path']
          and refs[0]['sha256'] == context['current_job']['source_sha256'], 'original reference mismatch')
    _need(_identity(returned, n, attempt)
          and returned.get('technical_approval') is False
          and returned.get('exact_prompt') == before['exact_prompt']
          and returned.get('exact_arguments') == before['exact_arguments'], 'literal return mismatch')
    for disposition in ('accepted', 'installed', 'selected'):
        _need(disposition not in returned or returned[disposition] is False,
              'private return already disposed')
    for key, expected in (('actual_dispatch', binding['dispatch']),
                          ('dispatch', binding['dispatch']),
                          ('before_call_qualification', binding['qualification']),
                          ('qualification', binding['qualification']),
                          ('arguments', before['exact_arguments']),
                          ('owner_thread_id', context['root']),
                          ('owner_execution_token', context['token'])):
        _need(key not in returned or returned[key] == expected, 'present return binding differs')
    for key, expected in (('actual_return_count', 1), ('return_index', 0)):
        _need(key not in returned or type(returned[key]) is int and returned[key] == expected,
              'present native count/index differs')
    _need('provider_operation_UUID' not in returned,
          'native item identifier is not a provider operation UUID')
    _need(_identity(dispatch, n, attempt)
          and dispatch.get('tool') == 'built-in image_gen'
          and dispatch.get('request_args') == before['exact_arguments']
          and dispatch.get('technical_approval') is False, 'literal dispatch mismatch')
    for key in ('qualification', 'before_call_qualification'):
        if key in dispatch:
            _need(dispatch[key] == binding['qualification'], 'dispatch qualification crossed')
    _need(sum(k in dispatch for k in ('qualification', 'before_call_qualification')) == 1,
          'one dispatch qualification binding required')
    for key, expected in (('owner_thread_id', context['root']),
                          ('owner_execution_token', context['token']), ('owner', before.get('owner'))):
        _need(key not in dispatch or dispatch[key] == expected, 'present dispatch owner differs')
    provider, private = returned['provider'], returned['private_copy']
    for key, expected in (('provider_original', provider), ('provider_saved_file', provider),
                          ('candidate', private), ('private_candidate', private)):
        _need(key not in returned or returned[key] == expected, 'present image alias differs')
    _need(_contained(provider['path'], PureWindowsPath(context['provider_root']) / context['root'])
          and _contained(private['path'], context['session_directory']),
          'provider/private path outside owner scope')
    image = _pin_bytes(provider, read_pinned)
    _need(image == _pin_bytes(private, read_pinned) and image.startswith(b'\x89PNG\r\n\x1a\n'),
          'provider/private PNG mismatch')
    evidence = _document(binding['native_evidence'], read_pinned)
    _need(evidence.get('schema') == EVIDENCE_SCHEMA and evidence.get('technical_approval') is False,
          'native evidence schema required')
    _need(set(evidence['events']) == {'session', 'preparation', 'generation', 'whole_view', 'whole_view_pixels'},
          'complete native event roles required')
    events = {role: _native(role, evidence, read_pinned) for role in evidence['events']}
    order = ('session', 'preparation', 'generation', 'whole_view', 'whole_view_pixels')
    for position in ('line_number', 'byte_offset'):
        values = [evidence['events'][role][position] for role in order]
        _need(values == sorted(set(values)), 'native event positions crossed or repeated')
    meta = events['session']
    _need(meta.get('type') == 'session_meta' and meta['payload'].get('id') == context['root'],
          'native root session mismatch')
    prepared, wrapper = _prepared_arguments(_item(events['preparation'], 'CommandExecution'), n)
    _need(prepared == args, 'native preparation arguments differ')
    if wrapper is not None:
        _need(wrapper.get('qualification') == binding['qualification']
              and wrapper.get('dispatch') == binding['dispatch'], 'native preparation pins crossed')
    generation = _item(events['generation'], 'Extension')
    _need(generation.get('kind') == 'image_gen.generation' and generation.get('status') == 'completed'
          and 'failure' in generation and generation['failure'] is None
          and generation.get('transparentBackground') is False,
          'successful native image generation required')
    _need(generation.get('revisedPrompt') == args['prompt']
          and generation.get('inputImages') == [{'path': x['path'], 'sha256': x['sha256']} for x in refs],
          'native prompt or ordered references differ')
    _need(generation.get('savedPath') == provider['path']
          and generation.get('id') == PureWindowsPath(provider['path']).stem,
          'native saved image identity differs')
    try:
        UUID(generation['id'].removeprefix('exec-'))
        native_image = base64.b64decode(generation['result'], validate=True)
    except (ValueError, TypeError, KeyError) as exc:
        raise ReceiptError('invalid native image item') from exc
    _need(generation['id'].startswith('exec-') and native_image == image,
          'native generated PNG differs')
    viewed = _item(events['whole_view'], 'ImageView')
    _need(_same_path(_image_path(viewed['path']), provider['path']), 'wrong whole-image view')
    pixels = events['whole_view_pixels']
    _need(pixels.get('type') == 'response_item'
          and pixels['payload'].get('type') == 'custom_tool_call_output', 'native whole-view output required')
    _need(_pngs(pixels['payload'].get('output')).count(image) == 1, 'whole-view PNG not uniquely present')
    native_finished = _time(events['generation']['timestamp'])
    starts = [key for key in ('actual_client_start_utc', 'actual_client_call_start_utc') if key in returned]
    _need(len(starts) == 1, 'one literal client-start variant required')
    start, start_upper = _clock_interval(returned[starts[0]])
    observed, observed_upper = _clock_interval(returned['actual_client_return_observed_utc'])
    _need(_time(dispatch['recorded_utc']) < start_upper
          and _time(events['preparation']['timestamp']) < start_upper and start <= native_finished
          < observed_upper and observed <= _time(returned['recorded_utc']),
          'recorded client-clock interval contradicts native completion')
    _need(_time(before['recorded_utc']) <= _time(dispatch['recorded_utc'])
          <= _time(events['preparation']['timestamp']) <= native_finished
          <= _time(events['whole_view']['timestamp']) <= _time(pixels['timestamp']),
          'native preparation/generation/view chronology differs')
    _need(_time(returned['recorded_utc']) >= native_finished, 'return receipt predates native completion')
    if attempt == 2:
        _need(before.get('previous_attempt_return') == binding['prior_return']
              and before.get('previous_attempt_ROOT_review') == binding['prior_root_review'],
              'correction ancestry crossed')
        prior = _document(binding['prior_return'], read_pinned)
        prior_review = _document(binding['prior_root_review'], read_pinned)
        prior_args = _document(binding['prior_arguments'], read_pinned)
        _need(_identity(prior, n, 1) and prior['private_copy'] == refs[1]
              and prior['exact_arguments'] == binding['prior_arguments']
              and prior_args['referenced_image_paths'] == [refs[0]['path']]
              and _identity(prior_review, n, 1)
              and prior.get('technical_approval') is False
              and prior_review.get('technical_approval') is False
              and prior_review.get('whole_return_personally_viewed') is True
              and _review_image(prior_review, prior['private_copy'])
              and _time(prior['recorded_utc']) <= _time(prior_review['recorded_utc'])
              <= _time(before['recorded_utc']), 'correction parent or chronology differs')
    root_review = _document(binding['root_review'], read_pinned)
    peer = _document(binding['independent_review'], read_pinned)
    matches = [x for x in peer.get('reviews', []) if x.get('job') == n and x.get('attempt') == attempt]
    _need(_identity(root_review, n, attempt)
          and root_review.get('whole_return_personally_viewed') is True
          and _review_image(root_review, private)
          and root_review.get('technical_approval') is False, 'whole ROOT review required')
    _need(peer.get('schema') == 'INDEPENDENT_WHOLE_RETURN_ASSESSMENT_ONLY_V1'
          and peer.get('root_owner_thread_id') == context['root']
          and peer.get('root_owner_execution_token') == context['token']
          and peer.get('technical_approval') is False and len(matches) == 1
          and _identity(matches[0], n, attempt) and _review_image(matches[0], private)
          and matches[0].get('technical_approval') is False
          and matches[0].get('whole_original_and_every_reference_and_return_viewed') is True
          and matches[0].get('complete_current_Q_and_RAW_equal_qualification') is True
          and matches[0].get('qualification') == binding['qualification']
          and matches[0].get('return_lineage') == binding['returned']
          and matches[0].get('source') == refs[0]
          and matches[0].get('ordered_ALL_references') == refs
          and matches[0].get('historical_return_verbatim') == returned
          and matches[0].get('assessment') in ('DOES_NOT_PASS_ILLUSTRATION_REVIEW',
                                             'PASSES_ILLUSTRATION_REVIEW_WITH_LIMITS'),
          'one genuine independent assessment required')
    _need(_time(pixels['timestamp']) <= _time(root_review['recorded_utc'])
          and _time(pixels['timestamp']) <= _time(matches[0]['recorded_utc'])
          <= _time(peer['recorded_utc']), 'review predates whole-image view')
    return dict(family=FAMILY, job=n, attempt=attempt, literal_qualification=before,
                literal_dispatch=dispatch, literal_return=returned, arguments=args,
                complete_RAW_view={raw['id']: copy.deepcopy(raw)}, provider=provider,
                private_candidate=private, actual_native_item_id=generation['id'],
                native_completed_utc=events['generation']['timestamp'],
                derived_return_count=1, derived_return_index=0,
                derived_values_are_not_historical_fields=True,
                absent_return_fields=sorted(set(('accepted', 'installed', 'selected',
                    'owner_thread_id', 'owner_execution_token', 'actual_return_count',
                    'return_index', 'provider_operation_UUID')) - set(returned)),
                ROOT_review=root_review, independent_review=matches[0],
                accepted=False, installed=False, technical_approval=False)


def read_native_attempt(binding, context, read_pinned):
    """Fail closed on malformed evidence; return no acceptance or write action.

    See the internal reader for the full caller contract. Errors deliberately
    have one public type, including malformed nested documents and native data.
    """
    try:
        return _read_native_attempt(binding, context, read_pinned)
    except ReceiptError:
        raise
    except (KeyError, TypeError, ValueError, AttributeError, IndexError) as exc:
        raise ReceiptError('malformed or incomplete receipt evidence') from exc
