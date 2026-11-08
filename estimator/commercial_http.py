"""Project commercial routes and explicitly versioned future-document rate defaults."""
from copy import deepcopy
from hashlib import sha256
import json
from urllib.parse import parse_qs, urlsplit

from .catalog import ValidationError, effective_catalog
from .commercial_documents import CommercialConflict, default_fields, linked_estimate_ids
from .unfiled_commercial import quote_context


class CommercialHTTP:
    def __init__(self, service, derive=None, company=None, saved=None, pricing=None, rate_defaults=None):
        self.service = service
        self.saved = saved
        self.derive = derive
        self.company = company
        self.pricing = pricing
        self.rate_defaults = rate_defaults

    def _company(self):
        return self.company() if callable(self.company) else self.company

    def _derive(self, body, include_pdfs=False):
        if self.derive is None:
            raise ValidationError('Linked estimate calculations are unavailable.')
        return self.derive(body, include_pdfs=include_pdfs)

    def dispatch(self, handler, route):
        prefix = '/api/commercial/'
        if not route.startswith(prefix):
            return False
        action = route[len(prefix):]
        try:
            query = parse_qs(urlsplit(handler.path).query, keep_blank_values=True)
            if any(len(values) != 1 for values in query.values()):
                raise ValidationError('Use one value for each commercial document filter.')
            if action == 'rate-defaults' and self.rate_defaults is not None:
                if query:
                    raise ValidationError('Rate defaults do not accept document or project filters.')
                if handler.command == 'GET':
                    result = self.rate_defaults.read()
                elif handler.command == 'POST':
                    if handler.headers.get('Sec-Fetch-Site') == 'cross-site':
                        raise ValidationError('Open rate defaults in the CLASSIFIRE application.')
                    result = self.rate_defaults.save(handler.read_json())
                else:
                    handler.send_payload(405, {'error': 'Use GET or POST for rate defaults.'})
                    return True
                handler.send_payload(200, result)
                return True
            if handler.command == 'GET':
                if action.startswith('attachment/') and set(query) == {'workspace', 'document'}:
                    from urllib.parse import quote
                    item, data = self.service.read_attachment(query['workspace'][0], query['document'][0], action[11:])
                    handler.send_payload(200, data, 'application/octet-stream',
                                         {'Content-Disposition': "attachment; filename*=UTF-8''" + quote(item['name'], safe='')})
                    return True
                if set(query) != {'workspace'} and not (action == 'register' and set(query) == {'workspace', 'refresh'} and query['refresh'] == ['1']):
                    raise ValidationError('Choose the current project document workspace.')
                workspace = query['workspace'][0]
                if action == 'register' and self.saved:
                    self.service.certifications.project_id(workspace)
                    result = self.saved.projects.commercial_register(refresh='refresh' in query, active_workspace=workspace)
                elif action == 'source-metadata' and self.saved:
                    self.service.certifications.project_id(workspace)
                    result = self.saved.projects.commercial_source_metadata()
                elif action == 'state':
                    result = self.service.view(workspace, include_quote_totals=True)
                elif action == 'supplier-products' and self.pricing:
                    self.service.certifications.project_id(workspace)
                    catalog = effective_catalog(self.pricing())
                    items = [*catalog['inventory'], *(row for rows in catalog['rate_groups'].values() for row in rows if not row.get('inventory_id'))]
                    result = {'products': [{'label': item.get('product_service') or item.get('display_name') or item['name'],
                                            'code': item.get('item_code') or item['id'],
                                            'supplier_price': item.get('supplier_price')} for item in items]}
                elif action.startswith('pdf/'):
                    filename, pdf = self.service.read_pdf(workspace, action[4:])
                    handler.send_payload(200, pdf, 'application/pdf', {'Content-Disposition': f'attachment; filename="{filename}"'})
                    return True
                else:
                    raise ValidationError('Commercial document endpoint not found.')
            elif handler.command == 'POST':
                if query or handler.headers.get('Sec-Fetch-Site') == 'cross-site':
                    raise ValidationError('Open commercial documents in the CLASSIFIRE application.')
                body = handler.read_json()
                destination = None
                workspace = body.get('workspace_id')
                if action == 'issue' and 'download' in body:
                    body = dict(body)
                    destination = handler.capture_commercial_download(body.pop('download'), workspace)
                expected_workspace = handler.headers.get('X-Estimator-Documentation-Workspace')
                if expected_workspace and expected_workspace != workspace:
                    raise CommercialConflict('The export belongs to a different project workspace.')
                if action in {'ignore-source', 'restore-source'} and self.saved and set(body) == {'workspace_id', 'id'} and not expected_workspace:
                    self.service.certifications.project_id(workspace)
                    result = self.saved.projects.ignore_commercial_source(body['id'], ignored=action == 'ignore-source')
                elif action == 'attachment' and set(body) == {'workspace_id', 'name', 'content'} and not expected_workspace:
                    project = self.service.certifications.project_id(workspace)
                    result = self.service.files.add(project, body['name'], body['content'])
                elif action.startswith('saved-') and self.saved and not expected_workspace:
                    result = self.saved.perform(action[6:], body, self.execute)
                else:
                    result = self.execute(action, body)
                    if action == 'issue':
                        handler.send_download(result['pdf'], 'application/pdf', result['filename'], destination, frozen_pdf=True)
                        return True
            else:
                handler.send_payload(405, {'error': 'Use GET or POST for commercial documents.'})
                return True
            handler.send_payload(200, result)
        except CommercialConflict as error:
            handler.send_payload(409, {'error': str(error)})
        except (ValidationError, KeyError, TypeError) as error:
            message = str(error) if isinstance(error, ValidationError) else 'Commercial document input is incomplete.'
            handler.send_payload(400, {'error': message})
        return True

    def execute(self, action, body, *, owner_key=None):
        common = {'workspace_id', 'estimates', 'active_estimate_id'}
        fields_by_action = {
            'defaults': {'kind', 'details'}, 'derive': {'fields', 'selected_ids', 'include_scope_tables'},
            'purchase-order-defaults': {'work_order_id', 'work_order_version'},
            'save': {'id', 'version', 'kind', 'status', 'fields', 'retain_unfiled'},
            'delete': {'id', 'version'}, 'status': {'id', 'version', 'status'},
            'notes': {'id', 'version', 'notes'},
            'issue': {'id', 'kind', 'version', 'request_id'},
        }
        if action not in fields_by_action or set(body) - common - fields_by_action[action]:
            raise ValidationError('Commercial document request contains unsupported fields.')
        workspace = body.get('workspace_id')
        model = self.service.view(workspace)
        if action == 'defaults':
            self.service.certifications.require_created_project(workspace)
            profile = self.rate_defaults.read() if self.rate_defaults is not None else None
            result = {'fields': default_fields(body.get('kind'), body.get('details'), self._company(),
                                               rates=profile['rates'] if profile else None)}
            if profile is not None:
                result['rate_defaults'] = profile
        elif action == 'purchase-order-defaults':
            self.service.certifications.require_created_project(workspace)
            profile = self.rate_defaults.read() if self.rate_defaults is not None else None
            result = {'fields': self.service.purchase_order_defaults(workspace, body.get('work_order_id'),
                body.get('work_order_version'), company=self._company(), rates=profile['rates'] if profile else None)}
        elif action == 'derive':
            if type(body.get('include_scope_tables', True)) is not bool:
                raise ValidationError('Choose whether to include the complete scope tables.')
            result = self._derive(body)
            result = {key: value for key, value in result.items() if key != 'scope_documents'}
        elif action == 'notes':
            doc = next((d for d in model['documents'] if d['id'] == body.get('id') and d['kind'] == 'work_order'), None)
            if doc is None:
                raise ValidationError('Open the Work Order before adding a note.')
            result = self.service.save(workspace, {'id': doc['id'], 'version': body.get('version'), 'kind': doc['kind'],
                'status': doc['status'], 'fields': {**doc['fields'], 'notes': body.get('notes')}})
        elif action == 'save':
            if not any(document['id'] == body.get('id') for document in model['documents']):
                self.service.certifications.require_created_project(workspace)
            fields = deepcopy(body.get('fields'))
            if body.get('kind') == 'quote':
                if not isinstance(fields, dict) or not isinstance(fields.get('details'), dict):
                    raise ValidationError('Include the Quote project details.')
                estimates = body.get('estimates', [])
                if not isinstance(estimates, list) or any(not isinstance(item, dict) for item in estimates):
                    raise ValidationError('Include the captured project estimates.')
                active = next((item['workspace']['estimate'] for item in estimates
                               if item.get('id') == body.get('active_estimate_id')), None)
                if active is not None:
                    if not isinstance(active, dict):
                        raise ValidationError('Include valid estimate details.')
                    fields['details'].update({key: active.get(key, '') for key in ('project_no', 'client', 'site_address')})
                derived = self._derive({**body, 'selected_ids': linked_estimate_ids(fields['lines'])})
                prices = {line['estimate_id']: line['unit_price'] for line in derived['lines']}
                seen = set()
                for line in fields['lines']:
                    identity = line.get('estimate_id')
                    if not identity:
                        continue
                    if identity in seen or identity not in prices:
                        raise ValidationError('Choose each linked estimate once in the quote summary.')
                    seen.add(identity)
                    line['unit_price'] = prices[identity]
                fields['scope_tables'] = derived['scope_tables']
                fields['sources'] = derived['sources']
            allowed = {key: body[key] for key in ('id', 'version', 'kind', 'status') if key in body}
            if 'retain_unfiled' in body and body['retain_unfiled'] is not True:
                raise ValidationError('Invalid local document save.')
            captured = None
            if body.get('retain_unfiled'):
                captured = quote_context(body) if body.get('kind') == 'quote' else {}
            result = self.service.save(workspace, {**allowed, 'fields': fields}, unfiled_context=captured)
        elif action == 'delete':
            result = self.service.delete(workspace, body.get('id'), body.get('version'))
        elif action == 'status':
            result = self.service.status(workspace, body.get('id'), body.get('version'), body.get('status'))
        elif action == 'issue':
            fingerprint = sha256(json.dumps({key: body.get(key) for key in ('kind', 'estimates', 'active_estimate_id')}, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()
            replay = self.service.replay(workspace, body.get('request_id'), body.get('id'), body.get('version'), self._company(), fingerprint, owner_key=owner_key)
            if replay:
                return replay
            documents = self.service.view(workspace)['documents']
            document = next((item for item in documents if item['id'] == body.get('id')), None)
            if document is None:
                raise ValidationError('This document is unavailable in the current project.')
            if body.get('kind') != document['kind']:
                raise ValidationError('The download kind must match its commercial document.')
            scopes = []
            if document['kind'] == 'quote':
                derived = self._derive({**body, 'fields': document['fields'], 'selected_ids': linked_estimate_ids(document['fields']['lines'])}, include_pdfs=True)
                if derived['sources'] != document['fields']['sources']:
                    raise CommercialConflict('Linked estimates changed. Save the quote again before downloading.')
                scopes = [item['pdf'] for item in derived.get('scope_documents', [])]
            result = self.service.issue(workspace, body.get('id'), body.get('version'), body.get('request_id'), self._company(), scopes, fingerprint, owner_key=owner_key)
            return result
        else:
            raise ValidationError('Commercial document endpoint not found.')
        return result
