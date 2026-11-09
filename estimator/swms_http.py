"""SWMS endpoints use the current project's certificate capability."""
from urllib.parse import parse_qs, urlsplit

from .catalog import ValidationError
from .swms import SwmsConflict, default_fields, template_options, issue_requirements


class SwmsHTTP:
    def __init__(self, service, company=None):
        self.service, self.company = service, company

    def dispatch(self, handler, route):
        if not route.startswith('/api/swms/'):
            return False
        action = route[len('/api/swms/'):]
        try:
            query = parse_qs(urlsplit(handler.path).query, keep_blank_values=True)
            if any(len(values) != 1 for values in query.values()):
                raise ValidationError('Use one value per SWMS filter.')
            if handler.command == 'GET':
                if set(query) != {'workspace'}:
                    raise ValidationError('Choose the current project workspace.')
                workspace = query['workspace'][0]
                if action == 'state':
                    result = self.service.view(workspace)
                elif action.startswith('pdf/'):
                    filename, pdf = self.service.read_pdf(workspace, action[4:])
                    handler.send_payload(200, pdf, 'application/pdf', {'Content-Disposition': f'attachment; filename="{filename}"'})
                    return True
                else:
                    raise ValidationError('SWMS endpoint not found.')
            elif handler.command == 'POST':
                if query or handler.headers.get('Sec-Fetch-Site') == 'cross-site':
                    raise ValidationError('Open SWMS in the CLASSIFIRE application.')
                body = handler.read_json()
                if not isinstance(body, dict):
                    raise ValidationError('Include SWMS input as an object.')
                fields = {'defaults': {'details'}, 'people-defaults': {'section', 'rows', 'expected_version'}, 'save': {'id', 'version', 'status', 'fields'},
                          'delete': {'id', 'version'}, 'issue': {'id', 'version', 'request_id', 'download'}}
                if action not in fields or set(body) - {'workspace_id'} - fields[action]:
                    raise ValidationError('SWMS request contains unsupported fields.')
                workspace = body.get('workspace_id')
                expected = handler.headers.get('X-Estimator-Documentation-Workspace')
                if expected and expected != workspace:
                    raise SwmsConflict('The SWMS export belongs to a different project workspace.')
                self.service.view(workspace)
                company = self.company() if callable(self.company) else self.company
                if action == 'defaults':
                    details = body.get('details', {})
                    if not isinstance(details, dict) or set(details) - {'project_no', 'client', 'site_address'}:
                        raise ValidationError('Choose valid SWMS project details.')
                    people_defaults = self.service.people_defaults()
                    result = {'fields': default_fields(details, company, people_defaults), 'options': template_options(), 'people_defaults': people_defaults,
                              'requirements': issue_requirements()}
                elif action == 'people-defaults':
                    result = self.service.save_people_defaults(workspace, body.get('section'), body.get('rows'), body.get('expected_version'))
                elif action == 'save':
                    result = self.service.save(workspace, {key: body.get(key) for key in fields['save']})
                elif action == 'delete':
                    result = self.service.delete(workspace, body.get('id'), body.get('version'))
                else:
                    destination = handler.capture_commercial_download(body['download'], workspace) if 'download' in body else None
                    owner_id = (getattr(handler, 'crm_actor', None) or {}).get('id')
                    result = self.service.issue(workspace, body.get('id'), body.get('version'), body.get('request_id'),
                                                company, owner_id=owner_id)
                    handler.send_download(result['pdf'], 'application/pdf', result['filename'], destination, frozen_pdf=True)
                    return True
            else:
                handler.send_payload(405, {'error': 'Use GET or POST for SWMS.'})
                return True
            handler.send_payload(200, result)
        except SwmsConflict as error:
            handler.send_payload(409, {'error': str(error)})
        except (ValidationError, KeyError, TypeError) as error:
            handler.send_payload(400, {'error': str(error) if isinstance(error, ValidationError) else 'SWMS input is incomplete.'})
        return True
