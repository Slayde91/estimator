"""Reproduce pinned local drawing-label OCR assets; never downloads at runtime."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import tarfile

TARGET = Path(__file__).resolve().parents[1] / 'static/vendor/ocr'
PACKAGES = {
    'tesseract.js-7.0.0.tgz': {
        'package': 'tesseract.js', 'version': '7.0.0',
        'source_url': 'https://registry.npmjs.org/tesseract.js/-/tesseract.js-7.0.0.tgz',
        'integrity': 'sha512-exPBkd+z+wM1BuMkx/Bjv43OeLBxhL5kKWsz/9JY+DXcXdiBjiAch0V49QR3oAJqCaL5qURE0vx9Eo+G5YE7mA==',
        'files': {'dist/worker.min.js': 'worker.min.js',
                  'dist/worker.min.js.LICENSE.txt': 'WORKER-NOTICES.txt',
                  'LICENSE.md': 'TESSERACT-JS-LICENSE.md', 'package.json': 'TESSERACT-JS-PACKAGE.json'},
    },
    'tesseract.js-core-7.0.0.tgz': {
        'package': 'tesseract.js-core', 'version': '7.0.0',
        'source_url': 'https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-7.0.0.tgz',
        'integrity': 'sha512-WnNH518NzmbSq9zgTPeoF8c+xmilS8rFIl1YKbk/ptuuc7p6cLNELNuPAzcmsYw450ca6bLa8j3t0VAtq435Vw==',
        'files': {**{f'tesseract-core{variant}-lstm.wasm.js': f'core/tesseract-core{variant}-lstm.wasm.js'
                     for variant in ('', '-simd', '-relaxedsimd')},
                  'LICENSE': 'CORE-LICENSE.txt', 'package.json': 'CORE-PACKAGE.json'},
    },
    'tesseract.js-data-eng-1.0.0.tgz': {
        'package': '@tesseract.js-data/eng', 'version': '1.0.0',
        'source_url': 'https://registry.npmjs.org/@tesseract.js-data/eng/-/eng-1.0.0.tgz',
        'integrity': 'sha512-mbTumm6KQPUHyzTPQaF3ObXYnx0SqqfV2nabqFVQBwD6Kl7PhGSLSzOlfFTWy0P3BjghaSKA2W9GB19Jk+ZcTg==',
        'files': {'4.0.0_best_int/eng.traineddata.gz': 'lang/eng.traineddata.gz',
                  'README.md': 'ENGLISH-MODEL-README.md', 'package.json': 'ENGLISH-MODEL-PACKAGE.json'},
    },
}


def vendor(directory):
    manifest = {'version': 1, 'engine': 'Tesseract.js', 'engine_version': '7.0.0',
                'core_version': '7.0.0', 'language': 'eng', 'model': '4.0.0_best_int',
                'runtime': 'local-only', 'authority': 'approximate-search-only', 'packages': [], 'files': {}}
    for filename, entry in PACKAGES.items():
        archive = Path(directory) / filename
        payload = archive.read_bytes()
        integrity = 'sha512-' + base64.b64encode(hashlib.sha512(payload).digest()).decode('ascii')
        if integrity != entry['integrity']:
            raise ValueError('OCR package does not match the pinned official npm integrity: ' + filename)
        manifest['packages'].append({key: entry[key] for key in ('package', 'version', 'source_url', 'integrity')} |
                                    {'archive_sha256': hashlib.sha256(payload).hexdigest()})
        with tarfile.open(archive) as source:
            metadata = json.loads(source.extractfile('package/package.json').read())
            if metadata['name'] != entry['package'] or metadata['version'] != entry['version']:
                raise ValueError('OCR package metadata does not match its pinned identity.')
            for name, relative in entry['files'].items():
                data = source.extractfile('package/' + name).read()
                target = TARGET / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                manifest['files'][relative] = {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
    notices = ('Local drawing-label OCR uses unmodified Tesseract.js 7.0.0 worker and Tesseract.js-core 7.0.0 LSTM builds.\n'
               'Their exact upstream Apache-2.0 licenses and bundled worker dependency notices are retained alongside these assets.\n'
               'The official @tesseract.js-data/eng 1.0.0 package supplies the 4.0.0_best_int full English model.\n'
               'Its npm package declares MIT; its underlying Tesseract trained data is Apache-2.0.\n'
               'Package metadata, upstream model license and hashes are retained.\n'
               'Recognition stays on this computer and is only an approximate search aid; no physical or calculator authority.\n'
               'The pinned worker message adapter follows upstream src/createWorker.js at v7.0.0.\n'
               'https://github.com/naptha/tesseract.js/tree/v7.0.0\n'
               'https://github.com/naptha/tesseract.js-core\n'
               'https://github.com/naptha/tessdata\n'
               'https://github.com/tesseract-ocr/tessdata\n').encode('utf8')
    (TARGET / 'NOTICE.txt').write_bytes(notices)
    manifest['files']['NOTICE.txt'] = {'sha256': hashlib.sha256(notices).hexdigest(), 'size': len(notices)}
    # The model package omits its upstream license file. Supply the separately
    # reviewed exact upstream license input, never resolve a moving URL here.
    license_path = Path(directory) / 'TESSDATA-LICENSE.txt'
    model_license = license_path.read_bytes()
    expected = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
    if hashlib.sha256(model_license).hexdigest() != expected:
        raise ValueError('Supply the reviewed exact Tesseract trained-data Apache-2.0 license.')
    (TARGET / 'MODEL-LICENSE.txt').write_bytes(model_license)
    manifest['model_license_source'] = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/LICENSE'
    manifest['files']['MODEL-LICENSE.txt'] = {'sha256': hashlib.sha256(model_license).hexdigest(), 'size': len(model_license)}
    (TARGET / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8', newline='\n')
    print('Bundled local OCR: ' + str(len(manifest['files'])) + ' verified assets')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', help='Directory containing the three pinned official npm tarballs and reviewed model license.')
    vendor(parser.parse_args().directory)
