"""Exact directory and address relationships; never infer identity from a name."""
import unicodedata
from uuid import NAMESPACE_URL, UUID, uuid5


def address_key(value):
    # Unit numbers, punctuation and street abbreviations remain significant.
    return ' '.join(unicodedata.normalize('NFKC', value or '').casefold().split())


def address_site(address):
    key = address_key(address)
    return {'id': str(uuid5(NAMESPACE_URL, 'classifire:site-address:' + key)),
            'name': address.strip(), 'address': address.strip(), 'automatic': True} if key else None


def project_link_id(source):
    return str(uuid5(NAMESPACE_URL, 'classifire:account-project-file:' + source))


def project_parties(snapshot, details, owner):
    """Read only explicit IDs in this saved file and its own commercial owner."""
    rows, seen = [], set()

    def add(kind, identifier, role, label=''):
        try:
            if not isinstance(identifier, str) or str(UUID(identifier)) != identifier:
                return
        except ValueError:
            return
        key = kind, identifier, role
        if key not in seen:
            seen.add(key)
            rows.append({'kind': kind, 'id': identifier, 'role': role, 'label': label if isinstance(label, str) else ''})

    add('accounts', details.get('account_id'), 'Client', details.get('client', ''))
    add('contacts', details.get('contact_id'), 'Project contact', details.get('contact_name', ''))
    for estimate in snapshot.get('estimates', []):
        identity = estimate.get('workspace', {}).get('estimate', {})
        add('accounts', identity.get('account_id'), 'Client', identity.get('client', ''))
        add('contacts', identity.get('contact_id'), 'Client contact', identity.get('contact_name', ''))
    commercial = snapshot.get('commercial_documents') or {}
    if not owner or commercial.get('project_id') != owner:
        return rows
    for document in commercial.get('documents', []):
        fields = document.get('fields', {})
        identity, order, billing = fields.get('details', {}), fields.get('order', {}), fields.get('billing', {})
        add('accounts', identity.get('account_id'), 'Client', identity.get('client', ''))
        add('contacts', identity.get('contact_id'), 'Client contact', identity.get('contact', ''))
        add('accounts', billing.get('account_id'), 'Billing company')
        from .work_order_billing import contact_id
        add('contacts', contact_id(billing), 'Billing contact', billing.get('name', ''))
        if document.get('kind') == 'purchase_order':
            add('accounts', order.get('supplier_account_id'), 'Supplier', order.get('supplier', ''))
            add('contacts', order.get('supplier_contact_id'), 'Supplier contact', order.get('supplier_contact', ''))
            add('contacts', order.get('site_contact_id'), 'Site contact', order.get('ship_to_name', ''))
    return rows
