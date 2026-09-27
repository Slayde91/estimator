"""Explicit, fingerprint-bound consolidation; never infer equivalence from titles."""

from copy import deepcopy
import hashlib
import json
import re


def review_fingerprint(source, projected, assets):
    """Bind review to the complete source, display and referenced asset metadata."""
    references = set()

    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in ('id', 'document_id') and isinstance(child, str) and child in assets:
                    references.add(child)
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(source)
    visit(projected)
    payload = [source, projected, {key: assets[key] for key in sorted(references)}]
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode()).hexdigest()


def reviewed_groups(data, records, assets):
    reviews = data.get('technical_duplicate_reviews', [])
    if not isinstance(reviews, list) or len(reviews) > 25000:
        raise ValueError('Invalid duplicate reviews')
    sources = {item['id']: item for item in data['libraries']['technical']['items']}
    aliases, groups, seen = {}, {}, set()
    for review in reviews:
        if not isinstance(review, dict) or set(review) != {'canonical_id', 'members'}:
            raise ValueError('Invalid duplicate review')
        members = review['members']
        if not isinstance(members, list) or not 2 <= len(members) <= 100:
            raise ValueError('Invalid duplicate review members')
        ids = []
        for member in members:
            if not isinstance(member, dict) or set(member) != {'id', 'sha256'}:
                raise ValueError('Invalid duplicate review member')
            key, digest = member['id'], member['sha256']
            if not isinstance(key, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,119}', key):
                raise ValueError('Invalid duplicate review ID')
            if key in seen or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
                raise ValueError('Overlapping or invalid duplicate reviews')
            seen.add(key)
            ids.append(key)
        canonical = review['canonical_id']
        if not isinstance(canonical, str) or canonical not in ids:
            raise ValueError('Missing canonical duplicate member')
        # A changed or missing record invalidates the whole group. Show all
        # remaining records separately until the new evidence is reviewed.
        if any(key not in records or review_fingerprint(sources[key], records[key], assets) != member['sha256']
               for key, member in zip(ids, members)):
            continue
        groups[canonical] = ids
        aliases.update({key: canonical for key in ids})
    return aliases, groups


def consolidate_links(links, aliases, groups):
    """Project reciprocal links once per group without rewriting stored edges."""
    def combine(entries, canonicalize=False):
        combined, relationships = {}, {}
        for entry in entries:
            target = aliases.get(entry['id'], entry['id']) if canonicalize else entry['id']
            value = combined.setdefault(target, {**entry, 'id': target})
            parts = relationships.setdefault(target, [])
            if entry['relationship'] and entry['relationship'] not in parts:
                parts.append(entry['relationship'])
            if entry.get('origin') == 'user':
                value['origin'] = 'user'
        for target, value in combined.items():
            value['relationship'] = '\n'.join(relationships[target])
        return list(combined.values())

    for left, entries in links['penetration'].items():
        links['penetration'][left] = combine(entries, canonicalize=True)
    for canonical, members in groups.items():
        combined = combine(entry for member in members for entry in links['technical'][member])
        for member in members:
            links['technical'][member] = deepcopy(combined)
