"""Owned graphical repeats and native dialog targets, on an ephemeral port."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def make_pdf(path):
    from reportlab.pdfgen import canvas
    drawing = canvas.Canvas(str(path), pagesize=(600, 500), invariant=1)
    drawing.setFont('Helvetica', 12)
    drawing.drawString(30, 465, 'SYNTHETIC VISUAL SEARCH - THREE SYMBOLS, NOT A FIRE ASSESSMENT')
    for x, y, rotation in ((80, 300, 0), (240, 300, 0), (420, 300, 90)):
        drawing.saveState(); drawing.translate(x, y); drawing.rotate(rotation)
        drawing.setFillColorRGB(0, 0, 0)
        drawing.rect(0, 0, 4, 24, stroke=0, fill=1)
        drawing.rect(0, 20, 28, 4, stroke=0, fill=1)
        drawing.rect(20, 0, 8, 8, stroke=0, fill=1)
        drawing.restoreState()
    drawing.setLineWidth(2); drawing.circle(110, 120, 14)
    drawing.rect(220, 100, 22, 22); drawing.line(410, 110, 450, 140)
    drawing.setFont('Helvetica', 10)
    drawing.drawString(30, 35, 'Selection and confirmation are explicit; graphical similarity is only a source proposal.')
    drawing.save()


if __name__ == '__main__':
    from estimator.server import create_server
    from estimator.native_dialogs import SaveSelection
    from estimator.project_library import file_fingerprint
    from unittest.mock import patch
    parser = argparse.ArgumentParser(); parser.add_argument('--directory', required=True)
    folder = Path(parser.parse_args().directory).resolve(); folder.mkdir(parents=True, exist_ok=True)
    fixture = folder / 'visual-symbols.pdf'; make_pdf(fixture)
    project = folder / 'visual-search-project.cf.json'
    class Dialogs:
        def choose_save(self, initial_directory, filename):
            return SaveSelection(str(project), file_fingerprint(project))
        def choose_open(self, initial_directory):
            return str(project) if project.exists() else None
        def choose_folder(self, initial_directory):
            return str(folder)
    server = create_server(0, folder / 'qa.sqlite3', project_dialogs=Dialogs())
    print(json.dumps({'port': server.server_port, 'fixture': str(fixture), 'source_sha256': sha256(fixture.read_bytes()).hexdigest(), 'project': str(project)}), flush=True)
    try:
        with patch('estimator.download_files.standard_downloads_directory', return_value=folder / 'native-downloads'):
            server.serve_forever()
    finally:
        server.server_close()
