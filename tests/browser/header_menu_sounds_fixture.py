"""A random-port app with private disposable data for header audio checks."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from estimator.server import create_server

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    server = create_server(0, directory / 'audio-fixture.sqlite3')
    print(json.dumps({'port': server.server_port, 'directory': str(directory)}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
