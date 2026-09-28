# Windows-only, one-folder bundle. The installer embeds this complete directory.
import json
import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files

config = json.loads(Path(os.environ['CEASEFIRE_BUILD_CONFIG']).read_text(encoding='utf-8'))
root = Path(config['root'])
datas = [(str(root / path), str(Path(path).parent)) for path in config['resources']]
datas += [(config['seed'], 'factory-seed'), (config['notices'], 'THIRD_PARTY_LICENSES')]
datas += collect_data_files('reportlab', includes=['fonts/*'])
excluded = config['excluded_modules'] + [
    'PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'cefpython3', 'gi', 'gtk',
    'webview.platforms.cef', 'webview.platforms.qt', 'webview.platforms.gtk',
    'webview.platforms.cocoa', 'webview.platforms.android', 'tkinter',
    'pypdf', 'fitz', 'pymupdf', 'pypdfium2', 'numpy', 'pandas', 'matplotlib',
]
a = Analysis(
    [str(root / 'scripts' / 'desktop_entry.py')], pathex=[str(root)],
    binaries=[], datas=datas,
    hiddenimports=['webview.platforms.winforms', 'webview.platforms.edgechromium'],
    hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=excluded,
    noarchive=False, optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='CEASEFIRE Estimator',
    debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
    console=False, disable_windowed_traceback=False,
    icon=str(root / 'static' / 'ceasefire-app.ico'), version=config['version_file'])
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='CEASEFIRE Estimator')
