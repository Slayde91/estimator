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
RUN17_FAMILY = 'RUN17_LITERAL_SINGLE_V1'
RUN19_FAMILY = 'RUN19_LITERAL_GROUP_RESERVATION_V1'


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



def _private_disposition(document):
    _need('provider_operation_UUID' not in document, 'unobserved provider operation UUID')
    _need(document.get('technical_approval') is False and all(
        key not in document or document[key] is False for key in
        ('accepted', 'selected', 'installed', 'acceptance', 'selection', 'installation',
         'acceptance_authorized', 'installation_authorized', 'checkpoint_authorized',
         'future_generation_authorized', 'operational')),
        'literal document is not private illustration evidence')


def _literal_events(binding, family, context, read_pinned):
    evidence = _document(binding['native_evidence'], read_pinned)
    _need(evidence.get('schema') == EVIDENCE_SCHEMA and evidence.get('literal_family') == family
          and evidence.get('technical_approval') is False, 'literal native evidence family required')
    root_order = ['session', 'preparation', 'generation']
    if family == RUN19_FAMILY:
        root_order = ['session', 'preparation_store', 'preparation', 'dispatch', 'generation', 'dispatch_return']
    else:
        root_order += ['whole_view', 'whole_view_pixels']
    peer_order = ['peer_session', 'peer_whole_view', 'peer_whole_view_pixels', 'peer_review_write']
    _need(set(evidence['events']) == set(root_order + peer_order), 'complete literal presentation roles required')
    events = {role: _native(role, evidence, read_pinned) for role in evidence['events']}
    for order in (root_order, peer_order):
        for position in ('line_number', 'byte_offset'):
            values = [evidence['events'][role][position] for role in order]
            _need(values == sorted(set(values)), 'literal native event positions crossed')
    root, peer = events['session'], events['peer_session']
    _need(root.get('type') == peer.get('type') == 'session_meta'
          and root['payload'].get('id') == context['root'], 'literal generation session mismatch')
    reviewer = peer['payload'].get('id')
    _need(type(reviewer) is str and reviewer != context['root']
          and peer['payload']['source']['subagent']['thread_spawn']['parent_thread_id'] == context['root'],
          'separate independent reviewer session required')
    for role in ('preparation', 'generation') + (() if family == RUN19_FAMILY else ('whole_view',)):
        _need(events[role]['payload'].get('thread_id') == context['root'], 'native generation actor crossed')
    for role in ('peer_whole_view', 'peer_review_write'):
        _need(events[role]['payload'].get('thread_id') == reviewer, 'native reviewer actor crossed')
    return evidence, events


def _literal_presentation(view, pixels, provider, private, image):
    item = _item(view, 'ImageView')
    _need(any(_same_path(_image_path(item['path']), v['path']) for v in (provider, private)),
          'literal whole view must show the exact provider or private file')
    _need(pixels.get('type') == 'response_item' and
          pixels['payload'].get('type') == 'custom_tool_call_output' and
          _pngs(pixels['payload'].get('output')).count(image) == 1,
          'literal whole-view pixels not uniquely present')
    _need(_time(view['timestamp']) <= _time(pixels['timestamp']), 'literal presentation chronology crossed')



def _javascript_tokens(code):
    """Keep quoted data separate from executable tokens; no retained code runs."""
    pattern = r"""\s+|//[^\r\n]*|/\*.*?\*/|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+|."""
    tokens = []
    for match in re.finditer(pattern, code, re.DOTALL):
        value = match.group()
        if value.isspace() or value.startswith(('//', '/*')):
            continue
        _need(value not in ('`', '"', "'"), 'unsupported JavaScript literal')
        tokens.append(('literal', value[1:-1]) if value[0] in ('"', "'") else value)
    return tokens


def _group_dispatch(code, prefix, jobs):
    tokens = _javascript_tokens(code)
    head = ['const', 'started', '=', 'Date', '.', 'now', '(', ')', ';', 'const', 'calls', '=', '[']
    _need(tokens[:len(head)] == head, 'executable grouped calls array required')
    stack, elements, current, end = ['['], [], [], None
    pairs = {')':'(', ']':'[', '}':'{'}
    for position in range(len(head), len(tokens)):
        token = tokens[position]
        if token == ']' and stack == ['[']:
            elements.append(current); end = position + 1; break
        if token == ',' and stack == ['[']:
            elements.append(current); current = []; continue
        if isinstance(token, str) and token in ('(', '[', '{'):
            stack.append(token)
        elif isinstance(token, str) and token in pairs:
            _need(stack and stack.pop() == pairs[token], 'grouped call syntax crossed')
        current.append(token)
    _need(end is not None and len(elements) == len(jobs), 'exact grouped call elements required')
    names = []
    for element in elements:
        _need(len(element) > 14 and element[:6] == ['tools', '.', 'image_gen__imagegen', '(', 'load', '(']
              and type(element[6]) is tuple and element[6][0] == 'literal'
              and element[7:14] == [')', '.', 'args', ')', '.', 'then', '('],
              'immediate per-job grouped image call required')
        names.append(element[6][1])
        render = ['generatedImage', '(', 'result', ')']
        _need(sum(element[i:i+4] == render for i in range(len(element)-3)) == 1,
              'grouped result must be presented once')
    _need(sorted(names) == sorted(prefix + str(job) for job in jobs), 'grouped load key crossed')
    invoke = ['tools', '.', 'image_gen__imagegen', '(']
    _need(sum(tokens[i:i+4] == invoke for i in range(len(tokens)-3)) == len(jobs), 'unlisted grouped image call')
    tail = tokens[end:]
    _need(len(tail) >= 17 and tail[:3] == [';', 'store', '('] and type(tail[3]) is tuple
          and tail[4:17] == [',', 'started', ')', ';', 'await', 'Promise', '.', 'allSettled', '(', 'calls', ')', '.', 'then']
          and tail[-1] == ';', 'awaited grouped calls and recorded dispatch required')


def _group_calls(events, jobs, reservations, n, args, dispatch, read_pinned):
    prepared = _item(events['preparation'], 'CommandExecution')
    _need(prepared.get('status') == 'completed' and type(prepared.get('exit_code')) is int
          and prepared['exit_code'] == 0, 'successful grouped preparation required')
    rows = json.loads(prepared['aggregated_output'])
    _need(type(rows) is list and len(rows) == len(jobs) and all(
        type(r) is dict and set(r) == {'job', 'args', 'dispatch'} and type(r['job']) is int for r in rows)
        and sorted(r['job'] for r in rows) == sorted(jobs), 'exact grouped preparation rows required')
    for row in rows:
        reservation = reservations[str(row['job'])]
        literal = _document(reservation['exact_arguments'], read_pinned)
        prompt = _pin_bytes(reservation['exact_prompt'], read_pinned)
        refs = reservation['ALL_ordered_references']
        _need(row['args'] == literal and type(literal['prompt']) is str
              and literal['prompt'].encode('utf8') == prompt
              and literal['transparent_background'] is False
              and literal['referenced_image_paths'] == [v['path'] for v in refs],
              'prepared row differs from its own literal reservation arguments')
        for version in refs:
            _pin_bytes(version, read_pinned)
    chosen = next(r for r in rows if r['job'] == n)
    _need(chosen['args'] == args and chosen['dispatch'] == dispatch, 'grouped preparation job crossed')
    store = events['preparation_store']['payload']
    call = events['dispatch']['payload']
    _need(store.get('type') == call.get('type') == 'custom_tool_call'
          and store.get('name') == call.get('name') == 'exec', 'literal grouped calls required')
    code = store['input']
    # Decode only the command's JSON string, then inspect the outer store recipe.
    # A recipe quoted inside the shell command cannot substitute for this call.
    command_call = re.match(r'\bconst\s+r\s*=\s*await\s+tools\.exec_command\(\{\s*cmd\s*:', code)
    _need(command_call is not None, 'literal grouped preparation call required')
    tail = code[command_call.end():].lstrip()
    command, end = json.JSONDecoder().raw_decode(tail)
    _need(type(command) is str and prepared['command'][-1] == command,
          'grouped command and native preparation differ')
    code = tail[end:]
    # Inspect the actual JSON.parse/store recipe; never execute retained code.
    recipe = r"""
        \s*(?:,\s*(?:"max_output_tokens"|'max_output_tokens'|max_output_tokens)\s*:\s*[0-9]+)?\s*\}\)\s*;
        \s*if\s*\(\s*r\.exit_code\s*!==\s*0\s*\)\s*\{\s*text\(r\)\s*;\s*exit\(\)\s*;\s*\}
        \s*const\s+rows\s*=\s*JSON\.parse\(r\.output\)\s*;
        \s*for\s*\(const\s+row\s+of\s+rows\)\s*store\(\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\1\s*\+\s*row\.job\s*,\s*row\s*\)\s*;
        \s*text\(rows\.map\(x=>\(\{job:x\.job,dispatch:x\.dispatch\}\)\)\)\s*;\s*
    """
    match = re.fullmatch(recipe, code, re.VERBOSE)
    _need(match is not None, 'complete executable grouped JSON-to-store recipe required')
    _group_dispatch(events['dispatch']['payload']['input'], match.group(2), jobs)
    returned = events['dispatch_return']
    _need(returned.get('type') == 'response_item' and returned['payload'].get('type') == 'custom_tool_call_output'
          and returned['payload'].get('call_id') == call.get('call_id'), 'grouped enclosing return crossed')


def _literal_reviews(binding, family, context, before, returned, source, refs, provider, private, events, image, read_pinned):
    n, attempt = context['job'], context['attempt']
    root = _document(binding['root_review'], read_pinned)
    peer = _document(binding['independent_review'], read_pinned)
    for review in (root, peer):
        _private_disposition(review)
        _need(_identity(review, n, attempt), 'literal review job or attempt crossed')
    _literal_presentation(events['peer_whole_view'], events['peer_whole_view_pixels'], provider, private, image)
    write = _item(events['peer_review_write'], 'CommandExecution')
    _need(write.get('status') == 'completed' and type(write.get('exit_code')) is int and write['exit_code'] == 0,
          'successful independent review recording required')
    written = json.loads(write['aggregated_output'])
    if family == RUN19_FAMILY:
        written = written['job' + str(n)]
    _need(written == binding['independent_review'], 'native independent review write does not bind this document')
    _need(_time(events['generation']['timestamp']) <= _time(events['peer_whole_view']['timestamp'])
          and _time(events['peer_whole_view_pixels']['timestamp']) <= _time(peer['recorded_utc'])
          <= _time(events['peer_review_write']['timestamp']), 'independent review presentation chronology crossed')
    if family == RUN17_FAMILY:
        initial = _document(root['dated_initial_root_review'], read_pinned)
        _private_disposition(initial)
        _need(root.get('result') == 'PROVISIONAL_ILLUSTRATION_PASS_WITH_NATURAL_OCCLUSION_LIMITS_NOT_ACCEPTANCE'
              and root['candidate'] == private and root['independent_review'] == binding['independent_review']
              and _identity(initial, n, attempt) and initial['candidate'] == private
              and initial['whole_image_viewed'] is True and initial['source_original_whole_viewed'] is True,
              'literal initial and supplementary ROOT reviews required')
        _need(peer.get('schema') == 'INDEPENDENT_WHOLE_RETURN_ASSESSMENT_NOT_ACCEPTANCE'
              and peer['candidate'] == provider and peer['qualification'] == binding['qualification']
              and peer['actual_dispatch'] == binding['dispatch'] and peer['exact_arguments'] == before['exact_arguments']
              and peer['exact_prompt'] == before['exact_prompt'] and peer['ALL_ordered_references'] == refs
              and peer['complete_original_whole_viewed'] is True and peer['candidate_whole_viewed'] is True
              and peer['complete_Q_matches_current'] is True and peer['full_Q'] == context['current_job']
              and peer['full_RAW'] == source, 'literal RUN17 independent scope differs')
        _literal_presentation(events['whole_view'], events['whole_view_pixels'], provider, private, image)
        _need(_time(events['generation']['timestamp']) <= _time(events['whole_view']['timestamp']),
              'ROOT whole view predates native generation')
        _need(_time(events['generation']['timestamp']) <= _time(initial['recorded_utc'])
              <= _time(root['recorded_utc']) and
              _time(events['whole_view_pixels']['timestamp']) <= _time(root['recorded_utc']),
              'supplementary ROOT review predates actual whole view')
        return root, peer, initial
    _need(root.get('whole_return_personally_viewed') is True and root['exact_return'] == private
          and root['owner_thread_id'] == context['root'] and root['owner_execution_token'] == context['token'],
          'literal RUN19 ROOT review differs')
    _need(peer.get('schema') == 'INDEPENDENT_WHOLE_RETURN_ASSESSMENT_ONLY_V1'
          and peer['root_owner_thread_id'] == context['root'] and peer['root_owner_execution_token'] == context['token']
          and peer['candidate'] == peer['private_copy'] == private
          and peer['qualification'] == binding['qualification'] and peer['return_lineage'] == binding['returned']
          and peer['source'] == refs[0] and peer['ordered_ALL_references'] == refs
          and peer['historical_return_verbatim'] == returned
          and peer['whole_original_and_every_reference_and_return_viewed'] is True
          and peer['complete_current_Q_and_RAW_equal_qualification'] is True, 'literal RUN19 independent scope differs')
    _need(_time(events['dispatch_return']['timestamp']) <= _time(root['recorded_utc']),
          'ROOT review predates inline whole-image presentation')
    return root, peer, None


def _read_literal_attempt(binding, context, read_pinned):
    family = binding['literal_family']
    _need(family in (RUN17_FAMILY, RUN19_FAMILY), 'unknown literal receipt family')
    n, attempt = context['job'], context['attempt']
    _need(type(n) is int and n >= 0 and type(attempt) is int and attempt == 1
          and n not in context['held_jobs'], 'held or unsupported literal target')
    original = _document(binding['qualification'], read_pinned)
    _private_disposition(original)
    _need(original['owner_thread_id'] == context['root'] and original['owner_execution_token'] == context['token'],
          'literal qualification owner mismatch')
    if family == RUN17_FAMILY:
        before = original
        _need(before.get('result') == QUALIFICATION and _identity(before, n, attempt)
              and type(before['max_calls_this_job']) is int and before['max_calls_this_job'] == 2
              and type(before['max_unique_new_canonicals']) is int and before['max_unique_new_canonicals'] in (1, 2),
              'literal RUN17 qualification and budget required')
        source, refs = before['complete_RAW'], before['ordered_ALL_references']
    else:
        _need(original.get('result') == 'ROOT_FINITE_SOURCE_ONLY_TWO_PRIVATE_CALL_QUALIFICATION_NOT_ACCEPTANCE_OR_INSTALL'
              and type(original['maximum_new_canonical']) is int and original['maximum_new_canonical'] == 12,
              'literal grouped qualification required')
        jobs, reserved = original['targets'], original['reserved_distinct_jobs_after_dispatch']
        prior = original['continuing_ten_distinct_jobs']
        _need(type(jobs) is list and len(jobs) == 2 and jobs == sorted(set(jobs)) and n in jobs
              and type(prior) is list and len(prior) == len(set(prior)) == 10
              and not set(jobs).intersection(prior)
              and all(type(j) is int and j >= 0 for j in jobs + reserved + prior)
              and type(original['reserved_distinct_count']) is int and
              original['reserved_distinct_count'] == len(reserved) == len(set(reserved)) == 12
              and set(jobs) | set(prior) == set(reserved)
              and set(original['reservations']) == set(map(str, jobs)), 'literal grouped budget or reservation keys differ')
        _need(not set(jobs).intersection(context['held_jobs']), 'held grouped target')
        for job in jobs:
            reservation = original['reservations'][str(job)]
            _private_disposition(reservation)
            _need(_identity(reservation, job, 1) and reservation['one_builtin_call_reserved'] is True
                  and reservation['call_dispatched'] is False, 'grouped reservation identity/private scope differs')
        before = original['reservations'][str(n)]; _private_disposition(before)
        _need(_identity(before, n, attempt) and before['one_builtin_call_reserved'] is True
              and before['call_dispatched'] is False, 'literal before-call reservation required')
        source, refs = before['complete_direct_RAW'], before['ALL_ordered_references']
    _need(before['complete_Q'] == context['current_job'] and context['current_job'].get('status') == 'pending_generation'
          and context['current_job'].get('output') is None and context['current_job'].get('review') is None,
          'literal current complete pending job changed')
    if family == RUN17_FAMILY:
        raw_view = {source['id']: source}
    else:
        kinds = {ref['record_id']: ref['kind'] for ref in context['current_job']['references']}
        _need(type(source) is dict and bool(source) and all(type(value) is dict
              and set(value) == {'kind', 'raw'} and value['kind'] == kinds.get(key)
              for key,value in source.items()), 'literal current complete RAW changed')
        raw_view = {key:value['raw'] for key,value in source.items()}

    _need(type(raw_view) is dict and bool(raw_view) and raw_view == context['current_records']
          and all(type(v) is dict and k == v['id'] for k,v in raw_view.items()), 'literal current complete RAW changed')
    args = _document(before['exact_arguments'], read_pinned); prompt = _pin_bytes(before['exact_prompt'], read_pinned)
    _need(set(args) == {'prompt', 'referenced_image_paths', 'transparent_background'} and type(args['prompt']) is str
          and args['prompt'].encode('utf8') == prompt and args['transparent_background'] is False
          and type(refs) is list and len(refs) == 1 and args['referenced_image_paths'] == [v['path'] for v in refs],
          'literal exact prompt and original reference required')
    for v in refs: _pin_bytes(v, read_pinned)
    _need(refs[0]['path'] == context['current_job']['source_path'] and refs[0]['sha256'] == context['current_job']['source_sha256'],
          'literal original reference changed')
    dispatch = _document(binding['dispatch'], read_pinned); returned = _document(binding['returned'], read_pinned)
    for document in (dispatch, returned):
        _private_disposition(document); _need(_identity(document, n, attempt), 'literal dispatch/return identity differs')
    _need(dispatch['exact_arguments'] == returned['exact_arguments'] == before['exact_arguments'], 'literal argument binding differs')
    if family == RUN17_FAMILY:
        _need(dispatch.get('actual_tool_requested_next') == 'image_gen.imagegen' and dispatch['dispatch_request_reserved'] is True
              and dispatch['qualification_sha256'] == binding['qualification']['sha256']
              and returned['qualification'] == binding['qualification']
              and type(returned['returned_candidates']) is int and returned['returned_candidates'] == 1,
              'literal RUN17 dispatch or return differs')
        provider, private = returned['provider_original'], returned['retained_private_copy']
    else:
        _need(dispatch['qualification'] == binding['qualification'] and returned['actual_dispatch'] == binding['dispatch']
              and dispatch['exact_prompt'] == returned['exact_prompt'] == before['exact_prompt']
              and dispatch['ALL_ordered_references'] == refs and type(returned['return_index']) is int and returned['return_index'] == 0,
              'literal grouped dispatch or return differs')
        provider, private = returned['provider_original'], returned['private_copy']
    for key, value in (('provider', provider), ('provider_saved_file', provider), ('provider_original', provider),
                       ('private_copy', private), ('retained_private_copy', private), ('private_candidate', private), ('candidate', private),
                       ('exact_prompt', before['exact_prompt']), ('arguments', before['exact_arguments']),
                       ('actual_dispatch', binding['dispatch']), ('dispatch', binding['dispatch']),
                       ('qualification', binding['qualification']), ('before_call_qualification', binding['qualification']),
                       ('owner_thread_id', context['root']), ('owner_execution_token', context['token'])):
        _need(key not in returned or returned[key] == value, 'contradictory literal return alias')
    for key, value in (('actual_return_count', 1), ('return_index', 0)):
        _need(key not in returned or type(returned[key]) is int and returned[key] == value,
              'contradictory literal count or index')
    for key, value in (('qualification', binding['qualification']), ('before_call_qualification', binding['qualification']),
                       ('qualification_sha256', binding['qualification']['sha256']), ('owner_thread_id', context['root']),
                       ('owner_execution_token', context['token']), ('owner', original.get('owner'))):
        _need(key not in dispatch or dispatch[key] == value, 'contradictory literal dispatch alias')
    for document in (dispatch, returned):
        for key, value in (('exact_prompt', before['exact_prompt']), ('request_args', before['exact_arguments']),
                           ('arguments', before['exact_arguments']), ('ordered_ALL_references', refs),
                           ('ALL_ordered_references', refs), ('source_path', context['current_job']['source_path']),
                           ('source_sha256', context['current_job']['source_sha256'])):
            _need(key not in document or document[key] == value, 'contradictory literal argument/reference alias')
        for key in ('tool', 'actual_tool', 'actual_tool_requested_next'):
            _need(key not in document or document[key] in ('built-in image_gen', 'image_gen.imagegen'),
                  'literal tool alias is not built-in image generation')
    _need('provider_operation_UUID' not in returned and
          _contained(provider['path'], PureWindowsPath(context['provider_root']) / context['root'])
          and _contained(private['path'], context['session_directory']), 'literal provider/private scope differs')
    image = _pin_bytes(provider, read_pinned)
    _need(image == _pin_bytes(private, read_pinned) and image.startswith(b'\x89PNG\r\n\x1a\n'), 'literal provider/private PNG differs')
    evidence, events = _literal_events(binding, family, context, read_pinned)
    if family == RUN17_FAMILY:
        prepared, wrapper = _prepared_arguments(_item(events['preparation'], 'CommandExecution'), n)
        _need(prepared == args and wrapper is None, 'literal singleton preparation differs')
    else:
        _group_calls(events, jobs, original['reservations'], n, args, binding['dispatch'], read_pinned)
        _need(_pngs(events['dispatch_return']['payload'].get('output')).count(image) == 1,
              'literal inline candidate not uniquely present')
    generation = _item(events['generation'], 'Extension')
    _need(generation.get('kind') == 'image_gen.generation' and generation.get('status') == 'completed'
          and 'failure' in generation and generation['failure'] is None and generation.get('transparentBackground') is False
          and generation.get('revisedPrompt') == args['prompt']
          and generation.get('inputImages') == [{'path': v['path'], 'sha256': v['sha256']} for v in refs]
          and generation.get('savedPath') == provider['path'] and generation.get('id') == PureWindowsPath(provider['path']).stem,
          'literal native generation arguments or identity differ')
    UUID(generation['id'].removeprefix('exec-'))
    _need(generation['id'].startswith('exec-') and base64.b64decode(generation['result'], validate=True) == image,
          'literal native generated PNG differs')
    finished = _time(events['generation']['timestamp'])
    _need(_time(original['recorded_utc']) <= _time(dispatch['recorded_utc'])
          <= _time(events['preparation']['timestamp']) <= finished <= _time(returned['recorded_utc']),
          'literal native/receipt chronology differs')
    if family == RUN19_FAMILY:
        order = ('preparation_store', 'preparation', 'dispatch', 'generation', 'dispatch_return')
        times = [_time(events[role]['timestamp']) for role in order]
        _need(times == sorted(times) and times[-1] <= _time(returned['recorded_utc']),
              'grouped native call/result chronology differs')
    if family == RUN17_FAMILY:
        clocks = []
        for key in ('tool_observed_start_UTC', 'tool_observed_return_UTC'):
            value = returned[key]
            _need(type(value) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC', value),
                  'literal UTC second clock required')
            clocks.append(_clock_interval(value.replace(' ', 'T', 1).replace(' UTC', 'Z')))
        _need(type(returned['clock_precision_seconds']) is int and returned['clock_precision_seconds'] == 1
              and _time(dispatch['recorded_utc']) < clocks[0][1] and _time(events['preparation']['timestamp']) < clocks[0][1]
              and clocks[0][0] <= finished and clocks[1][0] <= finished < clocks[1][1], 'literal observed clock contradicts native completion')
    root, peer, initial = _literal_reviews(binding, family, context, before, returned, source, refs, provider, private, events, image, read_pinned)
    return dict(family=FAMILY, literal_family=family, job=n, attempt=attempt, literal_qualification=original,
        literal_reservation=before if family == RUN19_FAMILY else None, literal_dispatch=dispatch, literal_return=returned,
        arguments=args, complete_RAW_view=copy.deepcopy(raw_view), provider=provider, private_candidate=private,
        actual_native_item_id=generation['id'], native_completed_utc=events['generation']['timestamp'],
        derived_return_count=1, derived_return_index=0, derived_values_are_not_historical_fields=True,
        root_presentation='native_inline_tool_result' if family == RUN19_FAMILY else 'native_image_view',
        timing_scope=('literal second-precision client observations and native item completion; no provider-internal execution claim'
            if family == RUN17_FAMILY else 'native event and recorded receipt chronology only; no client/provider execution interval claim'),
        absent_return_fields=sorted(set(('provider','private_copy','exact_prompt','owner_thread_id','owner_execution_token',
            'actual_return_count','return_index','provider_operation_UUID')) - set(returned)),
        ROOT_review=root, independent_review=peer, initial_ROOT_review=initial,
        accepted=False, installed=False, technical_approval=False)


def read_native_attempt(binding, context, read_pinned):
    """Fail closed on malformed evidence; return no acceptance or write action.

    See the internal reader for the full caller contract. Errors deliberately
    have one public type, including malformed nested documents and native data.
    """
    try:
        if 'literal_family' in binding:
            return _read_literal_attempt(binding, context, read_pinned)
        return _read_native_attempt(binding, context, read_pinned)
    except ReceiptError:
        raise
    except (KeyError, TypeError, ValueError, AttributeError, IndexError) as exc:
        raise ReceiptError('malformed or incomplete receipt evidence') from exc
