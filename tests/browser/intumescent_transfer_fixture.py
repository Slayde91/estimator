"""Disposable browser server with explicit synthetic DFT outputs.

This tests the transfer/result bridge only. Assessment-table selection has its
own integrity-bound tests; no private report data is copied into this fixture.
"""
import argparse
from contextlib import ExitStack
import json
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from fixtures import make_pdf
from estimator.server import create_server
from estimator.native_dialogs import SaveSelection
from estimator.project_library import file_fingerprint
from estimator.intumescent import PRODUCT, FX5090, FX6010
from estimator import takeoff_presentation

DFT = {PRODUCT: 1234.56789012345, FX5090: 789.1234567890123, FX6010: 2012.345678901234}
COLUMN_DFT = {product: value + 111.111111111111 for product, value in DFT.items()}


def synthetic_result(product, factor, case):
    return {'dft': (COLUMN_DFT if case == 'R4' else DFT)[product], 'factor': factor, 'status': 'PUBLISHED - ASSESSMENT TABLE',
            'source': f'SYNTHETIC TRANSFER FIXTURE - case {case}; no assessed design',
            'note': 'Synthetic native output for bridge precision and unit checks only.'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    folder = Path(parser.parse_args().directory).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    fixture = folder / 'synthetic-intumescent-members.pdf'
    make_pdf(fixture)
    project = folder / 'intumescent-browser-project.cf.json'
    legacy_flag = folder / 'emulate-legacy-palette-writer'
    apply_presentation = takeoff_presentation.apply_presentation

    def legacy_writer(snapshot, request, linked=None):
        # Produce an authentic audited pre-v2 snapshot for Save/Open coverage.
        # The opt-in marker exists only inside this disposable fixture folder.
        if legacy_flag.exists() and request['op'] == 'toggle_thickness_colours':
            assert not any(mode['document_id'] == request['document_id'] for mode in snapshot.get('drawing_presentation', {}).get('colour_modes', []))
            with patch.object(takeoff_presentation, 'CURRENT_PALETTE_VERSION', 1):
                apply_presentation(snapshot, request, linked)
            mode = next(mode for mode in snapshot['drawing_presentation']['colour_modes'] if mode['document_id'] == request['document_id'])
            mode.pop('palette_version')
        else:
            apply_presentation(snapshot, request, linked)

    class Dialogs:
        def choose_save(self, initial_directory, filename):
            return SaveSelection(str(project), file_fingerprint(project))

        def choose_open(self, initial_directory):
            return str(project) if project.exists() else None

        def choose_folder(self, initial_directory):
            return str(folder)

    with ExitStack() as stack:
        stack.enter_context(patch('estimator.takeoff_presentation.apply_presentation', side_effect=legacy_writer))
        stack.enter_context(patch('estimator.sc902_assessment.lookup',
            side_effect=lambda assessment, factor, temperature, period, **kwargs: synthetic_result(PRODUCT, factor, kwargs.get('case'))))
        stack.enter_context(patch('estimator.firetex_assessment.lookup',
            side_effect=lambda assessment, factor, temperature, period, **kwargs: synthetic_result(assessment.product, factor, kwargs.get('case'))))
        stack.enter_context(patch('estimator.download_files.standard_downloads_directory', return_value=folder / 'native-downloads'))
        server = create_server(0, folder / 'qa.sqlite3', project_dialogs=Dialogs())
        print(json.dumps({'port': server.server_port, 'fixture': str(fixture), 'project': str(project),
                          'dft_um': DFT, 'column_dft_um': COLUMN_DFT, 'legacy_palette_flag': str(legacy_flag), 'synthetic': True}), flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()


if __name__ == '__main__':
    main()
