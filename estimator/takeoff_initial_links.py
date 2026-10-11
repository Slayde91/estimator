"""Server-owned Initial Pages links; only visual settings can cross pages."""
from copy import deepcopy
from dataclasses import dataclass
import math
from pathlib import Path

from .catalog import ValidationError
from .takeoff_model import audit_state_digest, identity, object_fields, page_metadata

ROLES = {'graphics': 'text', 'signatures': 'signature'}
SHARED = {'graphics': {'text', 'text_content', 'appearance'},
          'signatures': {'strokes', 'appearance'}}
LOCAL = {'graphics': 'geometry', 'signatures': 'quad_pdf'}


@dataclass(frozen=True)
class OriginSummary:
    """Only the repository's fully validated semantic cache constructs this."""
    project_id: str
    revision: int
    previous: str | None
    before: str
    after: str
    size: int
    op: str
    born: tuple


class _Members(list):
    """Transient proof marker; never serialized into project or audit state."""
    def __init__(self, records):
        super().__init__(records)


def validate_link(record, collection):
    if 'initial_pages' not in record:
        return None
    link = object_fields(record['initial_pages'], {'version', 'group_id', 'role'},
                         'Initial Pages link', {'version', 'group_id', 'role'})
    if type(link['version']) is not int or link['version'] != 1 or link['role'] != ROLES[collection]:
        raise ValidationError('An Initial Pages link must retain its supported version and visual role.')
    identity(link['group_id'], 'Initial Pages group ID')
    if collection == 'graphics' and record['kind'] != 'textbox':
        raise ValidationError('Only an Initial Pages Textbox can retain a text link.')
    return link


def link_binding(record):
    link = record.get('initial_pages')
    return None if link is None else (link['version'], link['group_id'], link['role'])


def remember_group_identity(identifier, binding, groups):
    """Deleted role/page slots remain reserved to their original persistent IDs."""
    link = binding[-1]
    if link is None:
        return
    source, page = binding[:3], binding[3]
    _, group_id, role = link
    group = groups.setdefault(group_id, {'source': source, 'slots': {}})
    slot = (role, page)
    if group['source'] != source or group['slots'].get(slot, identifier) != identifier:
        raise ValidationError('An Initial Pages group source or original role/page identity cannot be reused in retained history.')
    group['slots'][slot] = identifier


def validate_text_fit(record, snapshot):
    """Use the marked-PDF renderer's exact font, wrapping and inner padding."""
    import reportlab
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from .takeoff_markup_pdf_worker import _annotation_lines, _graphic_text_lines
    for name, filename in (('ExportVera', 'Vera.ttf'), ('ExportVeraBold', 'VeraBd.ttf')):
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, str(Path(reportlab.__file__).parent / 'fonts' / filename)))
    _, page = page_metadata(snapshot, record['document_id'], record['page'])
    q0, q1, _, q3 = record['geometry']['quad_pdf']
    width, height = math.dist(q0, q1)*page['user_unit'], math.dist(q0, q3)*page['user_unit']
    padding = min(6, width/8, height/8)
    from .takeoff_graphics import graphic_font_size
    size = graphic_font_size(record)
    try:
        lines = (_annotation_lines(record['text_content'], width-2*padding, size, 'linked Initial Pages Textbox')
                 if 'text_content' in record else _graphic_text_lines(record['text'], 'ExportVera', size, width-2*padding))
    except ValueError as error:
        raise ValidationError(str(error)) from error
    if lines is None or len(lines)*size*1.25 > height-2*padding:
        raise ValidationError('The linked Initial Pages text must fit every retained Textbox. Enlarge the box, shorten the text or reduce the font size.')


def validate_links(snapshot):
    groups = {}
    for collection, role in ROLES.items():
        for record in snapshot.get(collection, {}).get('records', []):
            link = validate_link(record, collection)
            if link is None:
                continue
            binding = (record['mode'], record['document_id'], record['source_sha256'])
            group = groups.setdefault(link['group_id'], {'binding': binding, 'members': {}})
            if group['binding'] != binding:
                raise ValidationError('An Initial Pages group must identify one workspace and exact retained source PDF.')
            slot = (role, record['page'])
            if slot in group['members']:
                raise ValidationError('An Initial Pages group has at most one mark of each role on a source page.')
            group['members'][slot] = record
            if collection == 'graphics':
                validate_text_fit(record, snapshot)
    for group in groups.values():
        for role in ROLES.values():
            members = [record for (member_role, _), record in group['members'].items() if member_role == role]
            if not members:
                continue
            # Birth auto-fit can choose different font sizes on differently sized pages.
            def content(record):
                style = {key: value for key, value in record['appearance'].items() if role != 'text' or key != 'font_size'}
                return (record.get('text'), record.get('text_content'), record.get('strokes'), style)
            if any(content(record) != content(members[0]) for record in members[1:]):
                raise ValidationError('Linked Initial Pages marks must retain consistent content and shared appearance.')


def _legacy_members(snapshot, record, collection, load_event):
    """Find exact original IDs through hash-verified, joined, bounded birth history.

    The repository loader verifies immutable bytes and the surrounding audit graph
    validates every event. This scan never creates or migrates stored metadata.
    """
    if load_event is None or snapshot.get('audit_head') is None:
        return [record]
    from .takeoff_documents import MAX_AUDIT_EVENTS, MAX_AUDIT_BYTES, MAX_AUDIT_BLOB, _canonical
    from .takeoff_initial_pages import validate_initial_pages_history
    head, revision, expected = snapshot['audit_head'], snapshot['revision'], audit_state_digest(snapshot)
    seen, total = set(), 0
    while head is not None:
        if head in seen or len(seen) >= MAX_AUDIT_EVENTS:
            raise ValidationError('Initial Pages origin history is cyclic or exceeds its review limit.')
        seen.add(head)
        event = load_event(head)
        if isinstance(event, OriginSummary):
            total += event.size
            if event.size > MAX_AUDIT_BLOB or total > MAX_AUDIT_BYTES:
                raise ValidationError('Initial Pages origin history exceeds its retained audit read budget.')
            if event.project_id != snapshot['project_id'] or event.revision != revision or event.after != expected:
                raise ValidationError('Initial Pages origin requires a complete joined history for this exact project.')
            born = dict(event.born)[collection]
            if record['id'] in born and event.op != 'undo':
                if event.op != 'initial_pages':
                    return [record]
                from .takeoff_graphics import graphic_binding
                from .takeoff_signatures import signature_binding
                binding = graphic_binding if collection == 'graphics' else signature_binding
                members = [row for row in snapshot.get(collection, {}).get('records', []) if row['id'] in born]
                if any(binding(row) != born[row['id']] or 'initial_pages' in row for row in members):
                    raise ValidationError('An Initial Pages origin identity cannot rewrite its source, page, role or membership.')
                return _Members(members)
            expected, revision, head = event.before, revision-1, event.previous
            continue
        size = len(_canonical(event))
        total += size
        if size > MAX_AUDIT_BLOB or total > MAX_AUDIT_BYTES:
            raise ValidationError('Initial Pages origin history exceeds its retained audit read budget.')
        if (not isinstance(event, dict) or not isinstance(event.get('before'), dict)
                or not isinstance(event.get('after'), dict) or event.get('project_id') != snapshot['project_id'] or event.get('revision') != revision
                or audit_state_digest(event['after']) != expected):
            raise ValidationError('Initial Pages origin requires a complete joined history for this exact project.')
        old = {row['id']: row for row in event['before'].get(collection, {}).get('records', [])}
        born = {row['id']: row for row in event['after'].get(collection, {}).get('records', []) if row['id'] not in old}
        if record['id'] in born and event['op'] != 'undo':
            if event['op'] != 'initial_pages':
                return [record]
            from .takeoff_graphics import validate_graphics
            from .takeoff_signatures import validate_signatures
            for side in ('before', 'after'):
                validate_graphics(event[side]); validate_signatures(event[side]); validate_links(event[side])
            validate_initial_pages_history(event)
            # Birth validation proves every source page and both role-specific batches.
            members = [row for row in snapshot.get(collection, {}).get('records', []) if row['id'] in born]
            for member in members:
                source = born[member['id']]
                if any(member[key] != source[key] for key in ('mode', 'document_id', 'source_sha256', 'page')):
                    raise ValidationError('An Initial Pages origin identity cannot move to another source or page.')
                if 'initial_pages' in source or 'initial_pages' in member:
                    raise ValidationError('Legacy Initial Pages origin cannot replace stored group membership.')
            return _Members(members)
        expected, revision, head = audit_state_digest(event['before']), revision-1, event['previous']
    if revision != 0:
        raise ValidationError('Initial Pages origin history is incomplete.')
    return [record]


def linked_members(snapshot, record, collection, load_event=None):
    link = validate_link(record, collection)
    if link is None:
        return _legacy_members(snapshot, record, collection, load_event)
    return _Members(row for row in snapshot.get(collection, {}).get('records', [])
                    if row.get('initial_pages') == link)


def apply_linked_edit(snapshot, record, collection, changes, validator, load_event=None):
    shared = {key: value for key, value in changes.items() if key in SHARED[collection]}
    members = linked_members(snapshot, record, collection, load_event) if shared else [record]
    staged = []
    for member in members:
        candidate = deepcopy(member)
        patch = changes if member['id'] == record['id'] else shared
        for key, value in patch.items():
            if key == 'stamp_image' and value is None:
                candidate.pop(key, None)
                continue
            candidate[key] = ({**candidate['appearance'], **deepcopy(value)}
                              if key == 'appearance' and isinstance(value, dict) else deepcopy(value))
        candidate['version'] += 1
        validator(candidate, snapshot)
        if collection == 'graphics' and (isinstance(members, _Members) or 'initial_pages' in candidate):
            validate_text_fit(candidate, snapshot)
        staged.append((member, candidate))
    for member, candidate in staged:
        member.clear(); member.update(candidate)


def validate_linked_history(event, collection, changed, load_event=None):
    old = {row['id']: row for row in event['before'].get(collection, {}).get('records', [])}
    new = {row['id']: row for row in event['after'].get(collection, {}).get('records', [])}
    if not changed:
        raise ValidationError('A visual edit must update a retained identity.')
    first = old[next(iter(changed))]
    # Historical unlinked single-row edits remain valid, including old initial batches.
    if len(changed) == 1 and 'initial_pages' not in first:
        return
    before = {**event['before'], 'audit_head': event['previous']}
    members = linked_members(before, first, collection, load_event)
    identifiers = {row['id'] for row in members}
    if len(changed) > 1 and identifiers == {first['id']}:
        raise ValidationError('A multi-page settings edit requires verified Initial Pages origin.')
    shared_changes = {}
    local_changes = 0
    for identifier in changed:
        a, b = old[identifier], new[identifier]
        allowed = SHARED[collection] | {LOCAL[collection], 'version'}
        if any(a.get(key) != b.get(key) for key in a.keys() | b.keys() if key not in allowed):
            raise ValidationError('A linked edit cannot change visual identity or group membership.')
        if a.get('initial_pages') != b.get('initial_pages'):
            raise ValidationError('Initial Pages membership is immutable after creation.')
        for key in SHARED[collection]:
            if key == 'appearance':
                for field in a[key].keys() | b[key].keys():
                    if a[key].get(field) != b[key].get(field):
                        token = (key, field)
                        if token in shared_changes and shared_changes[token] != b[key].get(field):
                            raise ValidationError('A linked appearance edit must apply the same supplied settings to every member.')
                        shared_changes[token] = b[key].get(field)
            elif a.get(key) != b.get(key):
                token = (key, None)
                if token in shared_changes and shared_changes[token] != b.get(key):
                    raise ValidationError('A linked content edit must apply the same supplied content to every member.')
                shared_changes[token] = b.get(key)
        local_changes += a[LOCAL[collection]] != b[LOCAL[collection]]
    if local_changes > 1 or (shared_changes or len(changed) > 1) and changed != identifiers:
        raise ValidationError('A linked settings edit must update exactly its surviving role members; geometry stays local.')
    for identifier in changed:
        for (key, field), value in shared_changes.items():
            actual = new[identifier][key].get(field) if field else new[identifier].get(key)
            if actual != value:
                raise ValidationError('A linked settings edit cannot omit a surviving member setting.')
        if collection == 'graphics':
            validate_text_fit(new[identifier], event['after'])


def validate_link_creation(event):
    """Membership enters history only in one full Initial Pages birth batch."""
    for collection in ROLES:
        old = {row['id']: row for row in event['before'].get(collection, {}).get('records', [])}
        new = {row['id']: row for row in event['after'].get(collection, {}).get('records', [])}
        for identifier in old.keys() & new.keys():
            if old[identifier].get('initial_pages') != new[identifier].get('initial_pages'):
                raise ValidationError('Initial Pages membership is immutable after creation.')
        if event['op'] not in ('initial_pages', 'undo') and any('initial_pages' in new[i] for i in new.keys()-old.keys()):
            raise ValidationError('Only Initial Pages can create linked visual membership.')
