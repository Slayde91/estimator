"""Capability-bound HTTP routes for project commercial documents."""
from copy import deepcopy
from hashlib import sha256
import json
from urllib.parse import parse_qs, urlsplit

from .catalog import ValidationError
from .commercial_documents import CommercialConflict, default_fields


class CommercialHTTP:
    def __init__(self, service, derive=None, company=None):
        self.service = service
        self.derive = derive
        self.company = company

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
            if handler.command == 'GET':
                if set(query) != {'workspace'}:
                    raise ValidationError('Choose the current project document workspace.')
                workspace = query['workspace'][0]
                if action == 'state':
                    result = self.service.view(workspace)
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
                common = {'workspace_id', 'estimates', 'active_estimate_id'}
                fields_by_action = {
                    'defaults': {'kind', 'details'}, 'derive': {'fields', 'selected_ids'},
                    'save': {'id', 'version', 'kind', 'status', 'fields'},
                    'delete': {'id', 'version'}, 'status': {'id', 'version', 'status'},
                    'issue': {'id', 'kind', 'version', 'request_id'},
                }
                if action not in fields_by_action or set(body) - common - fields_by_action[action]:
                    raise ValidationError('Commercial document request contains unsupported fields.')
                workspace = body.get('workspace_id')
                expected_workspace = handler.headers.get('X-Estimator-Documentation-Workspace')
                if expected_workspace and expected_workspace != workspace:
                    raise CommercialConflict('The export belongs to a different project workspace.')
                self.service.view(workspace)
                if action == 'defaults':
                    result = {'fields': default_fields(body.get('kind'), body.get('details'), self._company())}
                elif action == 'derive':
                    result = self._derive(body)
                    result = {key: value for key, value in result.items() if key != 'scope_documents'}
                elif action == 'save':
                    fields = deepcopy(body.get('fields'))
                    if body.get('kind') == 'quote':
                        derived = self._derive({**body, 'selected_ids': [line['estimate_id'] for line in fields['lines']]})
                        prices = {line['estimate_id']: line['unit_price'] for line in derived['lines']}
                        seen = set()
                        for line in fields['lines']:
                            identity = line.get('estimate_id')
                            if identity in seen or identity not in prices:
                                raise ValidationError('Choose each linked estimate once in the quote summary.')
                            seen.add(identity)
                            line['unit_price'] = prices[identity]
                        fields['scope_tables'] = derived['scope_tables']
                        fields['sources'] = derived['sources']
                    allowed = {key: body[key] for key in ('id', 'version', 'kind', 'status') if key in body}
                    result = self.service.save(workspace, {**allowed, 'fields': fields})
                elif action == 'delete':
                    result = self.service.delete(workspace, body.get('id'), body.get('version'))
                elif action == 'status':
                    result = self.service.status(workspace, body.get('id'), body.get('version'), body.get('status'))
                elif action == 'issue':
                    fingerprint = sha256(json.dumps({key: body.get(key) for key in ('kind', 'estimates', 'active_estimate_id')}, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()
                    replay = self.service.replay(workspace, body.get('request_id'), body.get('id'), body.get('version'), self._company(), fingerprint)
                    if replay:
                        handler.send_download(replay['pdf'], 'application/pdf', replay['filename'], destination, frozen_pdf=True)
                        return True
                    documents = self.service.view(workspace)['documents']
                    document = next((item for item in documents if item['id'] == body.get('id')), None)
                    if document is None:
                        raise ValidationError('This document is unavailable in the current project.')
                    if body.get('kind') != document['kind']:
                        raise ValidationError('The download kind must match its commercial document.')
                    scopes = []
                    if document['kind'] == 'quote':
                        derived = self._derive({**body, 'fields': document['fields'], 'selected_ids': [line['estimate_id'] for line in document['fields']['lines']]}, include_pdfs=True)
                        if derived['sources'] != document['fields']['sources']:
                            raise CommercialConflict('Linked estimates changed. Save the quote again before downloading.')
                        scopes = [item['pdf'] for item in derived.get('scope_documents', [])]
                    result = self.service.issue(workspace, body.get('id'), body.get('version'), body.get('request_id'), self._company(), scopes, fingerprint)
                    handler.send_download(result['pdf'], 'application/pdf', result['filename'], destination, frozen_pdf=True)
                    return True
                else:
                    raise ValidationError('Commercial document endpoint not found.')
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
