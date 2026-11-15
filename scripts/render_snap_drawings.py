"""Render the supplied SNAP drawing pages in full and record their provenance."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit
from urllib.request import urlopen

from PIL import Image
from pypdf import PdfReader


def publish_file(source, destination):
    # TemporaryDirectory is private on Windows. Create the published file in
    # its destination directory so it inherits that directory's read access.
    staged = destination.with_suffix(destination.suffix + '.partial')
    shutil.copyfile(source, staged)
    os.replace(staged, destination)


def render(ref, root):
    url = ref['url']
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.netloc not in {
            'docs.snapcollars.com.au', 'www.snapcollars.com.au', 'cdn.snapcollars.com.au'}
            or parsed.query or parsed.fragment or not parsed.path.lower().endswith('.pdf')):
        raise ValueError(f'Expected a public manufacturer PDF: {url}')
    basename = re.sub(r'[^A-Za-z0-9_-]+', '-', Path(parsed.path).stem).strip('-')[:65]
    stem = basename + '-' + hashlib.sha256(url.encode()).hexdigest()[:12]
    pdf = root / 'pdf' / (stem + '.pdf')
    with tempfile.TemporaryDirectory(dir=root) as temp:
        if not pdf.exists():
            captured = Path(temp) / 'captured.pdf'
            with urlopen(url, timeout=65) as response, captured.open('wb') as stream:
                shutil.copyfileobj(response, stream)
            if not captured.read_bytes().startswith(b'%PDF-'):
                raise ValueError(f'Unexpected content at {url}')
            publish_file(captured, pdf)
        reader = PdfReader(pdf)
        pages = len(reader.pages)
        selected = ref.get('pages') or list(range(1, pages + 1))
        if not selected or any(type(p) is not int or not 1 <= p <= pages for p in selected):
            raise ValueError(f'Invalid page selection for {url}')
        results = []
        with pdf.open('rb') as stream:
            pdf_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
        for page in selected:
            name = f'{stem}-p{page}.png'
            image = root / 'images' / name
            prefix = Path(temp) / 'render'
            subprocess.run(['pdftoppm', '-r', '160', '-f', str(page), '-l', str(page),
                            '-png', '-singlefile', str(pdf), str(prefix)], check=True, capture_output=True)
            candidate = prefix.with_suffix('.png')
            with Image.open(candidate) as source:
                width, height = source.size
                if min(width, height) < 500 or source.convert('L').getextrema()[0] >= 225:
                    raise ValueError(f'Empty or undersized drawing {url} page {page}')
            publish_file(candidate, image)
            results.append({'url': url, 'page': page, 'pages': pages,
                            'pdf_sha256': pdf_hash, 'path': 'images/' + name,
                            'sha256': hashlib.sha256(image.read_bytes()).hexdigest(),
                            'width': width, 'height': height})
        return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('references', type=Path, help='JSON array of {url, pages?}; one entry per PDF.')
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    references = json.loads(args.references.read_text(encoding='utf-8'))
    if len({r['url'] for r in references}) != len(references):
        raise ValueError('Group pages by PDF before rendering.')
    for folder in ('pdf', 'images'):
        (args.directory / folder).mkdir(exist_ok=True, parents=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = [page for pages in pool.map(lambda r: render(r, args.directory), references) for page in pages]
    (args.directory / 'renders.json').write_text(json.dumps(rows, indent=2) + '\n', encoding='utf-8')
    print(f'Rendered {len(rows)} drawing pages from {len(references)} PDFs.')


if __name__ == '__main__':
    main()
