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

DFT = {PRODUCT: 1234.56789012345, FX5090: 789.1234567890123, FX6010: 2012.345678901234}


def synthetic_result(product, factor):
    return {'dft': DFT[product], 'factor': factor, 'status': 'PUBLISHED - ASSESSMENT TABLE',
            'source': 'SYNTHETIC TRANSFER FIXTURE - no assessed design',
            'note': 'Synthetic native output for bridge precision and unit checks only.'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    folder = Path(parser.parse_args().directory).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    fixture = folder / 'synthetic-intumescent-members.pdf'
    make_pdf(fixture)
    project = folder / 'intumescent-browser-project.cf.json'

    class Dialogs:
        def choose_save(self, initial_directory, filename):
            return SaveSelection(str(project), file_fingerprint(project))

        def choose_open(self, initial_directory):
            return str(project) if project.exists() else None

        def choose_folder(self, initial_directory):
            return str(folder)

    with ExitStack() as stack:
        stack.enter_context(patch('estimator.sc902_assessment.lookup',
            side_effect=lambda assessment, factor, temperature, period, **kwargs: synthetic_result(PRODUCT, factor)))
        stack.enter_context(patch('estimator.firetex_assessment.lookup',
            side_effect=lambda assessment, factor, temperature, period, **kwargs: synthetic_result(assessment.product, factor)))
        stack.enter_context(patch('estimator.download_files.standard_downloads_directory', return_value=folder / 'native-downloads'))
        server = create_server(0, folder / 'qa.sqlite3', project_dialogs=Dialogs())
        print(json.dumps({'port': server.server_port, 'fixture': str(fixture), 'project': str(project),
                          'dft_um': DFT, 'synthetic': True}), flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()


if __name__ == '__main__':
    main()
