"""Private native-dialog targets for portable Documentation browser checks."""
import argparse
import json
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    from estimator.server import create_server
    from estimator.native_dialogs import SaveSelection
    from estimator.project_library import file_fingerprint
    folder = args.directory.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    control = folder / 'dialog-mode.json'
    control.write_text('{}', encoding='utf-8')

    class Dialogs:
        def target(self):
            mode = json.loads(control.read_text(encoding='utf-8'))
            target = (folder / mode.get('file', 'project-a.cf.json')).resolve()
            if not target.is_relative_to(folder):
                raise ValueError('Fixture dialog target must remain inside its private folder.')
            target.parent.mkdir(parents=True, exist_ok=True)
            return target

        def choose_save(self, initial_directory, filename):
            target = self.target()
            return SaveSelection(str(target), file_fingerprint(target))

        def choose_open(self, initial_directory):
            return str(self.target())

        def choose_folder(self, initial_directory):
            return str(folder)

    server = create_server(0, folder / 'qa.sqlite3', project_dialogs=Dialogs())
    print(json.dumps({'port': server.server_port, 'directory': str(folder),
                      'project': str(folder / 'project-a.cf.json')}), flush=True)
    try:
        with patch('estimator.download_files.standard_downloads_directory', return_value=folder / 'native-downloads'):
            server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
