"""Edit commercial documents in a linked project without activating its estimates."""
from hashlib import sha256
import json
from .commercial_sources import source_id
from .catalog import ValidationError
from .commercial_documents import KINDS, CommercialConflict, commercial_cards, project_document_details, apply_project_document_details
from .download_files import DownloadDestination
from .project_file import WORKSPACE_FIELDS, load_project_bytes
from .quote_details import QUOTE_DETAIL_LIMITS


def estimate_inputs(snapshot):
    active = snapshot.get('active_estimate_id', 'estimate-1')
    entries = snapshot.get('estimates', [{'id': active, 'name': 'Estimate 1', 'workspace': snapshot}])
    estimates = []
    for entry in entries:
        source = entry['workspace']
        workspace = {key: source[key] for key in WORKSPACE_FIELDS - {'takeoffs'} if key in source}
        if 'penetration' in workspace:
            workspace['penetration'] = {key: value for key, value in workspace['penetration'].items() if key in ('draft', 'composer')}
            workspace['penetration']['library_tracking_version'] = 1
        workspace['calculators'] = {key: {'inputs': value['inputs'], **({'schedule_rows': value['schedule_rows']} if 'schedule_rows' in value else {})}
                                    for key, value in source['calculators'].items()}
        estimates.append({'id': entry['id'], 'name': entry['name'], 'workspace': workspace})
    return {'estimates': estimates, 'active_estimate_id': active}


class SavedCommercial:
    def __init__(self, projects):
        self.projects = projects
        self.sessions = {}

    def _session(self, file_id, revision, snapshot, path):
        cached = self.sessions.get(file_id)
        if cached and cached['revision'] == revision:
            return cached
        # Use the same version, source-workbook and snapshot checks as Open
        # Project, without activating takeoffs or the user's current estimate.
        load_project_bytes(self.projects.store, json.dumps(snapshot, ensure_ascii=False).encode('utf-8'), edition=self.projects.edition)
        commercial = snapshot.get('commercial_documents')
        manifest = snapshot.get('certifications')
        if not commercial or not manifest or commercial['project_id'] != manifest['project_id']:
            raise ValidationError('This saved project has no linked commercial document workspace.')
        if cached:
            self.projects.certifications.discard(cached['workspace'])
            self.sessions.pop(file_id)
        workspace = self.projects.certifications.restore(manifest, path)['workspace_id']
        try:
            self.projects.commercial.files.transfer(commercial, path, restore=True)
            self.projects.commercial.restore(workspace, commercial, return_view=False)
            with self.projects.commercial._connect() as db:
                self.projects.commercial.unfiled.bind_file(db, workspace, path)
            self.projects.certifications.activate_created_project(workspace, snapshot['estimate'].get('project_no', ''), project_path=path)
        except Exception:
            self.projects.certifications.discard(workspace)
            raise
        session = {'workspace': workspace, 'revision': revision}
        self.sessions[file_id] = session
        return session

    def activity(self, file_id, revision, identity, *, follow_up=False):
        source = {'file_id':file_id, 'revision':revision}
        if file_id.startswith('local-'):
            return self.projects.commercial.unfiled.activity(source, identity, ignored=self.projects._commercial_sources.ignored_owners(), follow_up=follow_up)
        with self.projects.commercial_file(file_id, revision) as (path, snapshot, _, _):
            commercial = snapshot.get('commercial_documents')
            certificates = snapshot.get('certifications')
            owner = certificates.get('project_id') if isinstance(certificates, dict) else None
            if not commercial or commercial['project_id'] != owner or owner in self.projects._commercial_sources.ignored_owners():
                raise ValidationError('This commercial document is unavailable in the current project.')
            return self.projects.commercial.saved_activity(commercial, identity, source_id(str(path)), follow_up=follow_up)

    def perform(self, action, body, execute):
        source = body.get('source')
        if not isinstance(source, dict) or set(source) != {'file_id', 'revision'}:
            raise ValidationError('Choose the saved project owning this document.')
        file_id, revision = source['file_id'], source['revision']
        body = {key: value for key, value in body.items() if key != 'source'}
        if 'project_updates' in body:
            raise ValidationError('Reopen this document to edit its recipient. Change project details in Projects.')
        if not isinstance(revision, str) or len(revision) != 64 or set(body) & {'workspace_id', 'estimates', 'active_estimate_id', 'download', 'retain_unfiled', 'project_details'}:
            raise ValidationError('Saved document estimates and downloads come from their own project.')
        if isinstance(file_id, str) and file_id.startswith('local-'):
            self.projects.recover_commercial_publications()
            if action in {'activity','follow-up'}:
                return self.projects.commercial.unfiled.perform(action, source, body, execute, ignored=self.projects._commercial_sources.ignored_owners())
            return self.projects.commercial.unfiled.perform(action, source, body, execute)
        # The library holds its lock through the conditional file write. Other
        # open project tabs keep their original save fingerprints and cannot
        # accidentally overwrite a newer commercial document revision.
        with self.projects.commercial_file(file_id, revision, find_issued=action == 'issue') as (path, snapshot, actual_revision, commit):
            if action in {'activity','follow-up'} and (snapshot.get('commercial_documents') or {}).get('project_id') in self.projects._commercial_sources.ignored_owners():
                raise ValidationError('This commercial document is unavailable in the current project.')
            session = self._session(file_id, actual_revision, snapshot, path)
            workspace = session['workspace']
            if action == 'attachment' and set(body) == {'name', 'content'}:
                return self.projects.commercial.files.add(snapshot['commercial_documents']['project_id'], body['name'], body['content'])
            if action == 'read-attachment' and set(body) == {'id', 'file_id'}:
                import base64
                item, raw = self.projects.commercial.read_attachment(workspace, body['id'], body['file_id'])
                return {**item, 'content': base64.b64encode(raw).decode('ascii')}
            details = project_document_details(snapshot['estimate'])
            captured = estimate_inputs(snapshot)
            if action == 'open':
                if set(body) != {'id'}:
                    raise ValidationError('Select one linked document.')
                model = self.projects.commercial.view(workspace, include_quote_totals=True)
                document = next((d for d in model['documents'] if d['id'] == body['id']), None)
                if document is None:
                    raise CommercialConflict('This document is no longer available. Reopen its board.')
                bound_number = document['fields']['details']['project_no'] if document['kind']=='work_order' else None
                apply_project_document_details(document['fields'], details)
                if bound_number:
                    document['fields']['details']['project_no'] = bound_number
                quote_total = model['quote_totals'].get(document['id'], {}).get(document['last_number'], '')
                return {'document': document, 'details': details, 'project_details': {
                            key: snapshot['estimate'].get(key, '') for key in QUOTE_DETAIL_LIMITS}, 'quote_total': quote_total,
                        'created_project': self.projects.certifications.view(workspace)['created_project'],
                        'related': commercial_cards(model['snapshot'], include_quote_files=True), 'quote_totals': model['quote_totals'], 'quote_rows':model['quote_rows'],
                        'estimates': [{'id': item['id'], 'name': item['name']} for item in captured['estimates']]}
            if action == 'save':
                if body.get('kind') not in KINDS:
                    raise ValidationError('Choose a supported commercial document.')
                if not isinstance(body.get('fields'), dict) or not isinstance(body['fields'].get('details'), dict):
                    raise ValidationError('Include the document and its project details.')
                body['project_details'] = {key: snapshot['estimate'].get(key, '') for key in QUOTE_DETAIL_LIMITS}
            if action == 'defaults':
                body['details'] = {**body.get('details', {}), **details}
            if action == 'issue' and not session.get('documentation'):
                self.projects.documentation.restore(snapshot.get('documentation'), workspace, path)
                session['documentation'] = True
            if action == 'issue':
                fingerprint = sha256(json.dumps({'source': source, 'request': body}, sort_keys=True).encode()).hexdigest()
                retained = self.projects.documentation.replay(workspace, body.get('request_id'), fingerprint)
                if retained and revision != actual_revision:
                    # The project was committed before the response or visible
                    # file was delivered. Retry that exact published revision.
                    if session.get('last_download', {}).get('fingerprint') == fingerprint:
                        return session['last_download']['response']
                    saved_pdf = self.projects.documentation.read(workspace, retained['item']['id'])
                    _, document = self.projects.commercial.document_context(workspace, body['id'])
                    receipt = self.projects.write_download(DownloadDestination(path.parent, 'project'), saved_pdf['item']['filename'], saved_pdf['payload'])
                    response = {'result': {**receipt, 'document': document}, 'revision': actual_revision}
                    session['last_download'] = {'fingerprint': fingerprint, 'response': response}
                    return response
                if actual_revision != revision:
                    raise CommercialConflict('The saved project changed. Reopen its board and select the document again.')
            modified = action in {'save', 'status', 'delete', 'issue', 'notes','follow-up'}
            try:
                result = execute(action, {**body, **captured, 'workspace_id': workspace}, owner_key=file_id + ':' + revision)
                if action == 'issue':
                    receipt = self.projects.documentation.record(workspace, 'commercial.' + body['kind'], body['id'],
                        result['filename'], 'application/pdf', result['pdf'], body['request_id'], fingerprint)
                    history = self.projects.documentation.capture({'workspace_id': workspace, 'expected_revision': receipt['workspace_revision']})
                    self.projects.documentation.publish(history, path)
                    snapshot['documentation'] = history
                if modified:
                    snapshot['commercial_documents'], quote_stage = self.projects.commercial.capture_project(workspace)
                    if quote_stage:
                        snapshot['project_status'] = quote_stage
                    self.projects.commercial.files.transfer(snapshot['commercial_documents'], path)
                    with self.projects.commercial.publishing(workspace, snapshot['commercial_documents'], snapshot.get('project_status'), path=path):
                        session['revision'] = commit()
            except Exception:
                # An abandoned workspace cannot leak an uncommitted edit into
                # the next file operation after validation or an I/O failure.
                if modified:
                    self.sessions.pop(file_id, None)
                    self.projects.certifications.discard(workspace)
                raise
            if action == 'issue':
                # A failed physical write can now be retried against the durable
                # project history without producing another document number.
                result = {**self.projects.write_download(DownloadDestination(path.parent, 'project'), result['filename'], result['pdf']),
                          'document': result['document']}
                response = {'result': result, 'revision': session['revision']}
                session['last_download'] = {'fingerprint': fingerprint, 'response': response}
                return response
            return {'result': result, 'revision': session['revision']}
