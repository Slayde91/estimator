"""Scheduler-safe projections of saved Work Orders, including exact file provenance."""
import re
from uuid import UUID

from .catalog import ValidationError
from .commercial_documents import commercial_cards, project_document_details


def choice(card):
    details = card['fields']['details']
    reference = card.get('reference') or card['fields']['order'].get('work_order_reference') or card.get('last_number') or 'Work Order'
    return {'id': ':'.join((card['source_file'], card['project_id'], card['id'])), 'revision':card['source_revision'],
            'project_id':card['project_id'], 'document_id':card['id'], 'source_id':card['source_file'],
            'version':card['version'], 'reference':reference, 'status':card['status'],
            'project_no':details.get('project_no',''), 'client':details.get('client',''), 'site_address':details.get('site_address','')}


def listing(projects, offset):
    register = projects.commercial_register()
    orders = [choice(card) for card in register['documents'] if card['kind'] == 'work_order']
    orders.sort(key=lambda row: (row['client'].casefold(), row['project_no'], row['reference'], row['id']))
    return {'orders':orders[offset:offset+200], 'matched':len(orders), 'scan_pending':register['scan_pending'],
            'error_count':register.get('error_count',0) + len(register.get('unavailable_sources',[]))}


def resolve(projects, identity, revision):
    """Recheck the selected source on assignment; a similarly numbered copy never qualifies."""
    try:
        source, owner, document_id = identity.split(':')
        if (not re.fullmatch(r'(?:local-)?[a-f0-9]{64}', source) or not re.fullmatch(r'[a-f0-9]{64}', revision)
                or str(UUID(owner)) != owner or str(UUID(document_id)) != document_id):
            raise ValueError
    except (ValueError, TypeError):
        raise ValidationError('Choose a saved Work Order from the list.') from None
    with projects._lock:
        if owner in projects._commercial_sources.ignored_owners():
            raise ValidationError('This Work Order is unavailable. Refresh the list.')
        if source.startswith('local-'):
            projects.recover_commercial_publications()
            item = projects.commercial.unfiled.scheduler_order(source,revision,owner,document_id)
        else:
            with projects.commercial_file(source, revision) as (_, snapshot, _, _):
                commercial = snapshot.get('commercial_documents') or {}
                if commercial.get('project_id') != owner or (snapshot.get('certifications') or {}).get('project_id') != owner:
                    raise ValidationError('The selected Work Order no longer belongs to this project.')
                item = next((card for card in commercial_cards(commercial) if card['id']==document_id and card['kind']=='work_order'), None)
                if item:
                    item.update(source_file=source, source_revision=revision)
                    item['fields']['details'].update(project_document_details(snapshot['estimate']))
        if item is None:
            raise ValidationError('This Work Order changed or is unavailable. Refresh the list.')
        projects.commercial.apply_register_numbers([item])
        return choice(item)
