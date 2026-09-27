"""Deterministic, lightweight PDFs for the complete takeoff capacity boundary."""
import argparse
import hashlib
import json
from pathlib import Path

from reportlab.pdfgen import canvas


DOCUMENT_COUNT = 100
PAGES_PER_DOCUMENT = 20
SENTINEL = "CAPACITY-END-100-020"


def make_capacity_documents(directory):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    files, hashes = [], set()
    for document in range(1, DOCUMENT_COUNT + 1):
        target = directory / f"capacity-{document:03d}.pdf"
        drawing = canvas.Canvas(str(target), pagesize=(420, 297),
                                pageCompression=1, invariant=1)
        drawing.setTitle(f"Synthetic capacity drawing {document:03d}")
        for page in range(1, PAGES_PER_DOCUMENT + 1):
            # Visible vector geometry needs no OCR, images, or external fonts.
            # The position encodes the document/page, making every PDF distinct.
            drawing.setStrokeColorRGB(0.1, 0.25, 0.6)
            drawing.setLineWidth(2)
            drawing.rect(20, 20, 380, 257)
            drawing.line(30 + document, 40, 30 + document, 230)
            drawing.line(40, 40 + page * 8, 370, 40 + page * 8)
            if document == DOCUMENT_COUNT and page == PAGES_PER_DOCUMENT:
                drawing.setFont("Helvetica", 14)
                drawing.drawString(45, 250, SENTINEL)
            drawing.showPage()
        drawing.save()
        files.append(str(target))
        hashes.add(hashlib.sha256(target.read_bytes()).hexdigest())
    assert len(hashes) == DOCUMENT_COUNT
    return {"files": files, "documents": DOCUMENT_COUNT,
            "pages": DOCUMENT_COUNT * PAGES_PER_DOCUMENT,
            "sentinel": SENTINEL,
            "bytes": sum(Path(file).stat().st_size for file in files)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    args = parser.parse_args()
    print(json.dumps(make_capacity_documents(args.directory)), flush=True)
