"""Reproduce the pinned, local PDF.js display distribution (no CDN at runtime)."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

VERSION = '6.3.289'
ARCHIVE_SHA256 = '51683fac4aff7dd31ed91e9ab735a2098a78d50899d1ec529aed6dc8aa19400d'
SOURCE = f'https://github.com/mozilla/pdf.js/releases/download/v{VERSION}/pdfjs-{VERSION}-legacy-dist.zip'
TARGET = Path(__file__).resolve().parents[1] / 'static' / 'vendor' / 'pdfjs'


def vendor(archive):
    data = Path(archive).read_bytes()
    if hashlib.sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise ValueError('The PDF.js archive does not match the reviewed release.')
    manifest = {'version': VERSION, 'build': 'legacy', 'source_url': SOURCE,
                'archive_sha256': ARCHIVE_SHA256, 'files': {}}
    with zipfile.ZipFile(archive) as source:
        for name in sorted(source.namelist()):
            if name.endswith('/'):
                continue
            if name not in {'LICENSE', 'build/pdf.mjs', 'build/pdf.worker.mjs'} and not name.startswith(
                    ('web/cmaps/', 'web/standard_fonts/', 'web/wasm/', 'web/iccs/')):
                continue
            relative = name.removeprefix('web/')
            if '..' in Path(relative).parts or Path(relative).is_absolute():
                raise ValueError('Unsafe upstream asset path.')
            content = source.read(name)
            target = TARGET / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            manifest['files'][relative] = {'sha256': hashlib.sha256(content).hexdigest(), 'size': len(content)}
    (TARGET / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(f'Bundled PDF.js {VERSION}: {len(manifest["files"])} verified local assets')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', help=f'Official legacy archive from {SOURCE}')
    vendor(parser.parse_args().archive)
