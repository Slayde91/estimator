"""A random-port app with private disposable data for header audio checks."""
import argparse
import json
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from estimator.server import create_server
from estimator.native_dialogs import SaveSelection

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    class Dialogs:
        attempts = 0
        def choose_save(self, initial_directory, filename):
            self.attempts += 1
            return None if self.attempts == 1 else SaveSelection(str(directory / 'audio-project.cf.json'), None)

    with patch('estimator.download_files.standard_downloads_directory', return_value=directory / 'native-downloads'):
        server = create_server(0, directory / 'audio-fixture.sqlite3', project_dialogs=Dialogs())
        print(json.dumps({'port': server.server_port, 'directory': str(directory)}), flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()
