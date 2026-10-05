"""Build the standard Windows desktop bundle and a complete offline installer.

Private seed content and all outputs must remain outside the source repository.
Use --skip-installer without --seed for a synthetic CI bundle.
"""
import argparse
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import struct
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from prepare_desktop_seed import prepare

DATA_FILES = (
    'baseline.json', 'calculator.json', 'calculator_documents.json', 'penetration.json.gz',
    'vermiculite_yield_defaults.json', 'calculators/index.json', 'calculators/ductwork.json.gz',
    'calculators/steel_board.json.gz', 'calculators/steel_vermiculite.json.gz',
)
STATIC_FILES = (
    'app.js', 'calculators.css', 'calculators.js', 'ceasefire-logo.png', 'downloads.js',
    'index.html', 'libraries.css', 'libraries.js', 'library-detail-text.js', 'library-editor.css',
    'library-editor.js', 'penetration-breakdown.js', 'penetration.css', 'penetration.js', 'styles.css',
    'fonts/Montserrat-Italic-Variable.ttf', 'fonts/Montserrat-Variable.ttf', 'fonts/OFL.txt',
    'ceasefire-app.ico', 'ceasefire-app-icon.png',
    'icons/navigation-home.png', 'icons/navigation-help.png',
)


def checksum(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk := stream.read(1024 * 1024): value.update(chunk)
    return value.hexdigest()


def check_output(path):
    value = Path(path).resolve()
    if value.is_relative_to(ROOT) or value == value.parent:
        raise ValueError('Build output must be a separate folder outside the repository.')
    if value.exists() and any(value.iterdir()):
        raise ValueError('Choose a new or empty output folder; existing output is never deleted.')
    value.mkdir(parents=True, exist_ok=True)
    return value


def verify_seed(seed):
    from estimator.desktop_seed import verified_manifest, safe_directory
    manifest = verified_manifest(seed)
    ident = manifest['id']
    actual = set()
    for current, folders, filenames in os.walk(seed, followlinks=False):
        safe_directory(Path(current))
        for folder in folders:
            safe_directory(Path(current) / folder)
        actual.update((Path(current) / filename).relative_to(seed).as_posix() for filename in filenames)
    expected = {'manifest.json'}
    for entry in manifest['files']:
        relative = entry['path']
        if relative in expected or Path(relative).is_absolute() or '..' in Path(relative).parts:
            raise ValueError('Unsafe or duplicate factory seed path.')
        expected.add(relative)
        path = seed / relative
        safe_directory(path.parent)
        if path.is_symlink() or getattr(path.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('Factory files must be regular files.')
        if path.stat().st_size != entry['size'] or checksum(path) != entry['sha256']:
            raise ValueError('Factory seed asset fingerprint mismatch.')
    if actual != expected:
        raise ValueError('Factory seed contains unexpected or missing files.')
    return {'id': ident, 'files': len(manifest['files']), 'bytes': sum(x['size'] for x in manifest['files'])}


def _read_calculator_evidence(directory, *, private_input=False):
    """Read only the fixed, bounded assessment file through its runtime authority gate."""
    from estimator.desktop_seed import safe_directory
    from estimator.monokote_hollow import (DATASET_FILENAME, DATASET_ID,
        MAX_DATASET_BYTES, validate_assessment_payload)
    directory = safe_directory(Path(directory).absolute()).resolve(strict=True)
    if private_input and directory.is_relative_to(ROOT.resolve()):
        raise ValueError('Private calculator evidence must remain outside the repository.')
    path = directory / DATASET_FILENAME
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError('Calculator evidence cannot be a linked or nonregular file.')
    with path.open('rb') as stream:
        payload = stream.read(MAX_DATASET_BYTES + 1)
    assessment = validate_assessment_payload(payload)
    return payload, {'id':DATASET_ID, 'filename':DATASET_FILENAME,
        'sha256':assessment.digest, 'bytes':len(payload), 'report_sha256':assessment.report_sha256}


def verify_calculator_evidence(directory, expected, *, private_input=False):
    """A build cannot substitute another valid revision after recording its input."""
    _, actual = _read_calculator_evidence(directory, private_input=private_input)
    if actual != expected:
        raise ValueError('Reviewed calculator evidence changed during the build.')
    return actual


def stage_calculator_evidence(directory, destination, *, required=False):
    """Stage one reviewed JSON snapshot, never neighboring private reports or files."""
    if directory is None:
        if required:
            raise ValueError('A deliverable installer requires explicit --calculator-evidence.')
        return None
    payload, receipt = _read_calculator_evidence(directory, private_input=True)
    from estimator.desktop_seed import safe_directory
    destination = safe_directory(Path(destination).absolute())
    if destination.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError('Private calculator evidence staging must remain outside the repository.')
    destination.mkdir()
    with (destination / receipt['filename']).open('xb') as stream:
        stream.write(payload)
    verify_calculator_evidence(directory, receipt, private_input=True)
    verify_calculator_evidence(destination, receipt)
    return receipt


def verify_packaged_calculator_evidence(bundle, expected):
    """The frozen application must contain exactly the reviewed optional snapshot."""
    from estimator.desktop_seed import safe_directory
    directory = bundle / '_internal/calculator-evidence'
    if expected is None:
        if directory.exists() or directory.is_symlink():
            raise ValueError('Unexpected calculator evidence was included in the frozen bundle.')
        return None
    safe_directory(directory)
    if {path.name for path in directory.iterdir()} != {expected['filename']}:
        raise ValueError('Frozen calculator evidence contains missing or unexpected files.')
    return verify_calculator_evidence(directory, expected)


def collect_notices(destination):
    destination.mkdir()
    packages = []
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata['Name']
        if name.lower() in {'pip', 'wheel'}:
            continue
        found = []
        for item in distribution.files or []:
            relative = Path(str(item))
            if ('licen' in relative.name.lower() or relative.name.lower().startswith(('copying', 'notice', 'authors'))
                    and '..' not in relative.parts and distribution.locate_file(item).is_file()):
                target = destination / name / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(distribution.locate_file(item), target)
                found.append(target.relative_to(destination).as_posix())
        packages.append({'name': name, 'version': distribution.version,
            'license_expression': distribution.metadata.get('License-Expression') or distribution.metadata.get('License'), 'files': found})
    python_license = Path(sys.base_prefix) / 'LICENSE.txt'
    if not python_license.exists():
        raise ValueError('Python redistribution licence is missing.')
    shutil.copyfile(python_license, destination / 'PYTHON-LICENSE.txt')
    for path in (ROOT/'packaging/windows/licenses').iterdir():
        if path.is_file():
            shutil.copyfile(path, destination/path.name)
    (destination / 'DEPENDENCIES.json').write_text(json.dumps(packages, indent=2), encoding='utf-8')
    (destination / 'README.txt').write_text('CEASEFIRE Estimator third-party notices\n'
        'Python, pywebview, pythonnet, ReportLab, Pillow, openpyxl and their dependencies are bundled.\n'
        'Their licence texts are retained in this directory. Montserrat OFL is also in static/fonts.\n'
        'PyInstaller includes its commercial-application bootloader exception.\n'
        'The separate Microsoft WebView2 Evergreen Runtime is redistributed unmodified under Microsoft terms.\n'
        'Installer built with Inno Setup: https://jrsoftware.org/\n', encoding='utf-8')


def vendor_signature(path, publisher):
    # Only a fixed script and JSON arguments are supplied; paths are not shell code.
    script = "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $p = [Console]::In.ReadToEnd() | ConvertFrom-Json; $s = Get-AuthenticodeSignature -LiteralPath $p.path; @{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject} | ConvertTo-Json -Compress"
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
        input=json.dumps({'path':str(path)}),capture_output=True,text=True,check=True,timeout=60,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    value = json.loads(result.stdout)
    if value['status'] != 'Valid' or publisher not in value['subject']:
        raise ValueError('Required vendor signature is invalid.')
    return value


def verify_bundle(bundle):
    from PyInstaller.archive.readers import CArchiveReader
    archive = CArchiveReader(str(bundle / 'CEASEFIRE Estimator.exe'))
    pyz = archive.open_embedded_archive('PYZ.pyz')
    names = sorted(pyz.toc)
    if any(name.startswith('estimator.takeoff') for name in names):
        raise ValueError('TAKEOFFS modules were included in the standard desktop executable.')
    files = [path for path in bundle.rglob('*') if path.is_file()]
    for path in files:
        relative = path.relative_to(bundle).as_posix().lower()
        if '/factory-seed/' not in relative and (path.name.lower().startswith('takeoff') or '/vendor/pdfjs/' in relative):
            raise ValueError('TAKEOFFS assets were included in the standard desktop bundle.')
    return {'files':len(files),'bytes':sum(path.stat().st_size for path in files),
        'takeoff_modules':0,'takeoff_assets':0,'module_count':len(names)}


def runtime_provenance(paths):
    if set(paths) != {'x64', 'arm64'}:
        raise ValueError('Both native runtime installers are required.')
    result = {}
    for architecture, path in paths.items():
        result[architecture] = {'architecture':architecture,
            'signature':vendor_signature(path, 'Microsoft Corporation'),
            'sha256':checksum(path),'bytes':path.stat().st_size}
    if result['x64']['sha256'] == result['arm64']['sha256']:
        raise ValueError('The x64 and ARM64 runtime inputs must be distinct vendor packages.')
    return result


def verify_runtime_fingerprints(paths, provenance):
    for architecture, path in paths.items():
        recorded = provenance[architecture]
        if path.stat().st_size != recorded['bytes'] or checksum(path) != recorded['sha256']:
            raise ValueError('A verified native runtime installer changed during the build: ' + architecture)


def verify_packaged_content(bundle, resources, seed_info, notices):
    """Check actual frozen files, including export fonts and the complete private seed."""
    import reportlab
    internal = bundle / '_internal'
    checked = 0
    pairs = [(ROOT / relative, internal / relative) for relative in resources]
    pairs += [(path, internal / 'THIRD_PARTY_LICENSES' / path.relative_to(notices))
        for path in notices.rglob('*') if path.is_file()]
    fonts = Path(reportlab.__file__).parent / 'fonts'
    font_files = [path for path in fonts.iterdir() if path.is_file()]
    if not font_files:
        raise ValueError('ReportLab export fonts are unavailable in the build environment.')
    pairs += [(path, internal / 'reportlab' / 'fonts' / path.name) for path in font_files]
    for source, target in pairs:
        if not target.is_file() or target.stat().st_size != source.stat().st_size or checksum(target) != checksum(source):
            raise ValueError('Frozen asset is missing or changed: ' + str(target.relative_to(bundle)))
        checked += 1
    packaged_seed = verify_seed(internal / 'factory-seed')
    if packaged_seed != seed_info:
        raise ValueError('Frozen factory seed differs from the reviewed input seed.')
    return {'matched_assets':checked, 'export_fonts':len(font_files), 'verified_seed':packaged_seed}


def verify_icon(executable, source_icon):
    """Prove a PE icon group retains every supplied ICO image byte and decoded pixel."""
    import pefile
    from PIL import Image
    original = source_icon.read_bytes()
    reserved, kind, count = struct.unpack_from('<HHH', original)
    if reserved != 0 or kind != 1 or not 1 <= count <= 32:
        raise ValueError('Application icon is not a bounded ICO file.')
    entries = [struct.unpack_from('<BBBBHHII', original, 6 + 16 * index) for index in range(count)]
    expected = [original[entry[7]:entry[7] + entry[6]] for entry in entries]
    with pefile.PE(str(executable), fast_load=True) as pe:
        pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']])
        resources = {}
        for resource_type in pe.DIRECTORY_ENTRY_RESOURCE.entries:
            if resource_type.id not in (3, 14):
                continue
            for resource in resource_type.directory.entries:
                variants = []
                for language in resource.directory.entries:
                    data = language.data.struct
                    variants.append(pe.get_data(data.OffsetToData, data.Size))
                resources[(resource_type.id, resource.id if resource.name is None else str(resource.name))] = variants
        for (resource_type, name), variants in resources.items():
            if resource_type != 14:
                continue
            for group in variants:
                if len(group) != 6 + count * 14 or struct.unpack_from('<HHH', group) != (0, 1, count):
                    continue
                payloads = []
                for index, expected_entry in enumerate(entries):
                    entry = struct.unpack_from('<BBBBHHIH', group, 6 + index * 14)
                    candidates = resources.get((3, entry[7]), [])
                    if entry[:7] != expected_entry[:7] or expected[index] not in candidates:
                        break
                    payloads.append(expected[index])
                if len(payloads) != count:
                    continue
                rebuilt = bytearray(struct.pack('<HHH', 0, 1, count))
                offset = 6 + count * 16
                for entry, payload in zip(entries, payloads):
                    rebuilt.extend(struct.pack('<BBBBHHII', *entry[:6], len(payload), offset))
                    offset += len(payload)
                for payload in payloads:
                    rebuilt.extend(payload)
                with Image.open(io.BytesIO(original)) as source, Image.open(io.BytesIO(rebuilt)) as actual:
                    sizes = sorted(source.ico.sizes())
                    if sizes != sorted(actual.ico.sizes()) or any(source.ico.getimage(size).convert('RGBA').tobytes()
                            != actual.ico.getimage(size).convert('RGBA').tobytes() for size in sizes):
                        raise ValueError('Executable icon decoded pixels differ from the supplied icon.')
                return {'group': name, 'images': count, 'sizes': sizes, 'source_sha256':checksum(source_icon),
                    'encoded_bytes_match': True, 'decoded_pixels_match': True}
    raise ValueError('Executable does not contain the complete supplied icon group.')


def source_fingerprints(resources):
    paths = [ROOT / relative for relative in resources]
    paths += [path for path in (ROOT/'estimator').glob('*.py') if not path.name.startswith('takeoff')]
    paths += list((ROOT/'packaging/windows').rglob('*'))
    paths += [ROOT/'scripts'/name for name in ('desktop_entry.py','build_windows.py','prepare_desktop_seed.py')]
    paths += [ROOT/'requirements.txt',ROOT/'requirements-desktop.txt']
    return {path.relative_to(ROOT).as_posix():checksum(path) for path in sorted(paths) if path.is_file()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seed', type=Path)
    parser.add_argument('--calculator-evidence', type=Path,
        help='External directory containing the reviewed private calculator assessment JSON.')
    parser.add_argument('--iscc', type=Path)
    parser.add_argument('--webview2-installer', type=Path)
    parser.add_argument('--webview2-arm64-installer', type=Path)
    parser.add_argument('--skip-installer', action='store_true')
    parser.add_argument('--version', default='1.0.0')
    args = parser.parse_args()
    if os.name != 'nt': parser.error('Build Windows binaries on Windows.')
    if not args.skip_installer and not (args.seed and args.calculator_evidence and args.iscc and args.webview2_installer and args.webview2_arm64_installer):
        parser.error('A deliverable installer requires explicit --seed, --calculator-evidence, --iscc, --webview2-installer and --webview2-arm64-installer inputs.')
    if not all(part.isdigit() and 0 <= int(part) <= 65535 for part in args.version.split('.')) or len(args.version.split('.')) != 3:
        parser.error('Version must contain three integer components.')
    runtime_paths = {'x64':args.webview2_installer,'arm64':args.webview2_arm64_installer}
    runtimes = runtime_provenance(runtime_paths) if not args.skip_installer else None
    output = check_output(args.output)
    evidence_stage = output / 'calculator-evidence'
    evidence = stage_calculator_evidence(args.calculator_evidence, evidence_stage, required=not args.skip_installer)
    from estimator.desktop_seed import safe_directory
    seed = safe_directory(args.seed.absolute()).resolve(strict=True) if args.seed else output / 'synthetic-seed'
    if args.seed and seed.is_relative_to(ROOT): parser.error('Private factory seed content must remain outside the repository.')
    if not args.seed: prepare(seed)
    seed_info = verify_seed(seed)
    resources = ['data/' + name for name in DATA_FILES] + ['static/' + name for name in STATIC_FILES]
    for relative in resources:
        if not (ROOT / relative).is_file(): raise ValueError('Required bundled asset is missing: ' + relative)
    fingerprints = source_fingerprints(resources)
    revision = subprocess.run(['git', '-c', 'safe.directory=' + str(ROOT), '-C', str(ROOT), 'rev-parse', 'HEAD'],
        capture_output=True, text=True, check=True).stdout.strip()
    notices = output / 'notices'
    collect_notices(notices)
    version_file = output / 'version_info.txt'
    numbers = tuple(int(n) for n in args.version.split('.')) + (0,)
    version_file.write_text("VSVersionInfo(ffi=FixedFileInfo(filevers=" + repr(numbers) + ",prodvers=" + repr(numbers)
        + ",mask=0x3f,flags=0,OS=0x40004,fileType=1,subtype=0,date=(0,0)),kids=[StringFileInfo([StringTable('040904B0',"
        + "[StringStruct('CompanyName','CEASEFIRE'),StringStruct('FileDescription','CEASEFIRE Estimator'),StringStruct('ProductName','CEASEFIRE Estimator'),StringStruct('FileVersion','"
        + args.version + "'),StringStruct('ProductVersion','" + args.version + "')])]),VarFileInfo([VarStruct('Translation',[1033,1200])])])", encoding='utf-8')
    config = {'root':str(ROOT),'resources':resources,'seed':str(seed),'notices':str(notices),'version_file':str(version_file),
        'calculator_evidence':str(evidence_stage / evidence['filename']) if evidence else None,
        'excluded_modules':['estimator.' + path.stem for path in (ROOT/'estimator').glob('takeoff*.py')]}
    config_path = output / 'build-config.json'
    config_path.write_text(json.dumps(config, indent=2), encoding='utf-8')
    environment = dict(os.environ, CEASEFIRE_BUILD_CONFIG=str(config_path))
    # Source QA overrides must never become an implicit private packaging input.
    environment.pop('CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY', None)
    command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--distpath', str(output/'frozen'),
        '--workpath', str(output/'work'), str(ROOT/'packaging/windows/estimator.spec')]
    with (output/'pyinstaller.log').open('w', encoding='utf-8') as log:
        subprocess.run(command,env=environment,stdout=log,stderr=subprocess.STDOUT,check=True)
    bundle = output/'frozen/CEASEFIRE Estimator'
    report = {'version':args.version,'seed':seed_info,'private_seed':bool(args.seed),'bundle':verify_bundle(bundle),
        'packaged_content':verify_packaged_content(bundle, resources, seed_info, notices),
        'calculator_evidence':verify_packaged_calculator_evidence(bundle, evidence),
        'executable_icon':verify_icon(bundle/'CEASEFIRE Estimator.exe', ROOT/'static/ceasefire-app.ico'),
        'executable_sha256':checksum(bundle/'CEASEFIRE Estimator.exe'),'signed_by_ceasefire':False,
        'source_files':fingerprints,'python_version':sys.version,
        'source_revision':revision,
        'dependencies':json.loads((notices/'DEPENDENCIES.json').read_text(encoding='utf-8'))}
    if evidence:
        verify_calculator_evidence(args.calculator_evidence, evidence, private_input=True)
        verify_calculator_evidence(evidence_stage, evidence)
    if not args.skip_installer:
        report['webview2'] = runtimes['x64']
        report['webview2_arm64'] = runtimes['arm64']
        vendor_signature(args.iscc, 'Pyrsys')
        verify_runtime_fingerprints(runtime_paths, runtimes)
        command = [str(args.iscc), '--no-ide-signtools', '--output-dir=' + str(output/'installer'),
            '--define=BundleDir=' + str(bundle),'--define=WebViewInstaller=' + str(args.webview2_installer),
            '--define=WebViewArm64Installer=' + str(args.webview2_arm64_installer),
            '--define=SourceRoot=' + str(ROOT),'--define=AppVersion=' + args.version,str(ROOT/'packaging/windows/installer.iss')]
        with (output/'inno.log').open('w',encoding='utf-8') as log:
            subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,check=True)
        verify_runtime_fingerprints(runtime_paths, runtimes)
        installer=next((output/'installer').glob('*.exe'))
        report['installer']={'filename':installer.name,'bytes':installer.stat().st_size,'sha256':checksum(installer),
            'icon':verify_icon(installer, ROOT/'static/ceasefire-app.ico')}
    if evidence:
        verify_calculator_evidence(args.calculator_evidence, evidence, private_input=True)
        verify_calculator_evidence(evidence_stage, evidence)
    verify_packaged_calculator_evidence(bundle, evidence)
    if source_fingerprints(resources) != fingerprints:
        raise ValueError('Source files changed during the build. Keep this diagnostic output and rebuild from stable source.')
    (output/'BUILD_REPORT.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({key:value for key,value in report.items() if key not in {'source_files','dependencies','python_version'}},indent=2))


if __name__ == '__main__': main()
