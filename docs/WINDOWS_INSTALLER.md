# Windows desktop installer

The standard desktop edition uses the existing loopback Python service and
JavaScript calculators in a pywebview window backed only by Microsoft WebView2.
It does not contain the TAKEOFFS modules, PDF.js assets or drawing workspace.
Projects containing takeoffs are rejected instead of silently losing their data.

## Build inputs

Build on x64 Windows in an isolated Python 3.12 environment. No compiler needs to
be installed on the end user's computer. Install the pinned build requirements:

```powershell
python -m venv C:\local-build\venv
C:\local-build\venv\Scripts\python.exe -m pip install -r requirements-desktop.txt
```

Use the official Inno Setup 7.1.0 x64 compiler. Its installer supports
`/PORTABLE=1 /CURRENTUSER /VERYSILENT /DIR=<local-tools-folder>`; verify its
Authenticode publisher is Pyrsys B.V. before running it. The official licence
permits commercial use; the project requests commercial users purchase a licence.
Use the official Microsoft **Evergreen Standalone Installer x64**, not the small
online bootstrapper. Verify its Authenticode publisher is Microsoft Corporation.
Record the download URL, version, bytes and SHA-256. Keep downloaded binaries and
build outputs outside the source repository.

For public CI, create a frozen application with empty library/default pricing:

```powershell
python scripts/build_windows.py --skip-installer --output C:\local-build\public-smoke
```

For a private deliverable, explicitly export the intended factory content:

```powershell
python scripts/prepare_desktop_seed.py --library C:\private\reference-library --database C:\private\estimator.sqlite3 --output C:\local-build\factory-seed
python scripts/build_windows.py --seed C:\local-build\factory-seed --output C:\local-build\release --iscc C:\local-tools\inno\ISCC.exe --webview2-installer C:\local-tools\MicrosoftEdgeWebView2RuntimeInstallerX64.exe --version 1.0.0
```

Use new output folders. Build scripts refuse to erase previous builds or write
private output inside the source checkout. An actual installer requires an
explicit factory seed; only the frozen CI mode allows the synthetic empty seed.

The application is a PyInstaller one-folder bundle under
`frozen/CEASEFIRE Estimator/CEASEFIRE Estimator.exe`. Inno Setup embeds that complete
folder plus the offline WebView2 installer in one `*-Setup-x64.exe` file. The build
inspects the executable's Python archive to reject TAKEOFFS modules, verifies
every frozen factory/resource/font/licence asset against its source, checks
vendor signatures and writes `BUILD_REPORT.json` with the source commit and hashes.
Both application and setup executable icon resources must retain every supplied
flame ICO size, encoded image byte and decoded pixel. Source changes during a
build cause failure, requiring a new build from stable source.
It does not sign the CEASEFIRE application or installer: code signing requires a
separately supplied publisher certificate. Do not describe an unsigned build as
signed or as free of Windows reputation warnings.

## Assets and private content

The explicit resource allowlist includes all calculator data, the penetration
engine data, UI scripts/styles, the CEASEFIRE logo and flame application icon,
both Montserrat fonts and their OFL notice. ReportLab's bundled fonts are included
for offline PDF output. Python, openpyxl, Pillow, ReportLab, pywebview, pythonnet and
their required native libraries are bundled, so users need neither Python nor
Excel installed. Build dependency versions and discovered licence texts accompany
the bundle in `THIRD_PARTY_LICENSES`.

`factory-seed/manifest.json` binds sorted relative file paths, byte lengths and
SHA-256 hashes. It contains only `pricing.json`, `library-edits.json`, the original
reference `library.json`, and its registered document/image assets. Live SQLite
files, quotes, calculator drafts, project paths, preferences, TAKEOFFS evidence,
unreferenced price snapshots, logs and credentials are excluded. Source reports,
private review metadata and pricing remain local build inputs and must never be
committed or uploaded with public CI artifacts.

The library edits use a fixed table allowlist for saved Firestopping items,
created items, their referenced frozen price snapshots, manual links/unlinks,
diagrams and deletion markers. Schema, IDs, fingerprints and references are
validated before initialization. User state is initialized under
`%LOCALAPPDATA%/CEASEFIRE/Estimator`; existing database/library contents are never
replaced by a later factory seed. Uninstall removes installed program files and
shortcuts, while retaining user data, project files and the shared WebView2 runtime.

## Installer behavior and release checks

The installer targets x64 Windows 10/11; ARM64 and 32-bit Windows are not covered
by this x64 offline runtime package. It installs per user without requiring an
administrator, creates Start-menu and optional desktop shortcuts, and does not
associate `.json` files or alter default apps. WebView2 is detected in both the
documented machine and user registry locations. The bundled offline installer
runs silently only when it is missing or older than the application's Chromium
minimum (105.0.0.0, including the [CSS `:has()` requirement](https://developer.chrome.com/blog/has-with-cq-m105/)). pywebview's own lower
runtime floor does not cover the application's JavaScript/CSS features.
A supported installed runtime is retained. Failure stops setup with an error; the app
never falls back to MSHTML. .NET Framework 4.6.2 or newer is checked before install.
Setup and uninstall wait for the desktop application to close; they never force
it to terminate. A shared setup mutex blocks new app starts during file changes.
After Finish, open the app using either shortcut; setup does not auto-launch it.

Release validation must exercise the actual frozen executable: all navigation,
native Save/Save As/load and close protection, pricing/library persistence,
calculator equivalence, PDF/XLSX exports, and reference PDF/image display. Inspect
the frozen asset/module inventory, then test installation, upgrade and uninstall
in an isolated directory while protecting normal AppData. A machine that already
has WebView2 does not prove its missing-runtime installation branch; that needs a
separate clean offline VM. Do not execute installer lifecycle tests against the
user's normal installation or data without explicit authorization.

Official references: [pywebview freezing](https://pywebview.flowrl.com/guide/freezing.html),
[WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution),
[Inno Setup](https://jrsoftware.org/isinfo.php),
[Inno licence](https://jrsoftware.org/files/is/license.txt),
[PyInstaller operating modes](https://pyinstaller.org/en/stable/operating-mode.html),
[PyInstaller licence](https://pyinstaller.org/en/stable/license.html).
