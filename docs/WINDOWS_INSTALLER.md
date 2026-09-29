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
Use both official Microsoft **Evergreen Standalone Installers, x64 and ARM64**,
not the small online bootstrapper. Verify each Authenticode publisher is Microsoft Corporation.
Record the download URL, version, bytes and SHA-256. Keep downloaded binaries and
build outputs outside the source repository.

For public CI, create a frozen application with empty library/default pricing:

```powershell
python scripts/build_windows.py --skip-installer --output C:\local-build\public-smoke
```

For a private deliverable, explicitly export the intended factory content:

```powershell
python scripts/prepare_desktop_seed.py --library C:\private\reference-library --database C:\private\estimator.sqlite3 --output C:\local-build\factory-seed
python scripts/build_windows.py --seed C:\local-build\factory-seed --output C:\local-build\release --iscc C:\local-tools\inno\ISCC.exe --webview2-installer C:\local-tools\MicrosoftEdgeWebView2RuntimeInstallerX64.exe --webview2-arm64-installer C:\local-tools\MicrosoftEdgeWebView2RuntimeInstallerARM64.exe --version 1.0.0
```

Use new output folders. Build scripts refuse to erase previous builds or write
private output inside the source checkout. An actual installer requires an
explicit factory seed; only the frozen CI mode allows the synthetic empty seed.

The application is a PyInstaller one-folder bundle under
`frozen/CEASEFIRE Estimator/CEASEFIRE Estimator.exe`. Inno Setup embeds that complete
folder plus both offline WebView2 installers in one `*-Setup-x64.exe` file. The x64
application also runs under supported Windows 11 ARM64 emulation. The build
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

First visits still prepare calculator models and validate the local reference
index. Workbook loaders cache immutable JSON text and decode independent models;
formula translators reuse their master tokens while producing the same row
formulas. Repeated navigation shares pending definition requests and retains the
existing bounded worksheet caches. Failed requests remain retryable.

Firestopping service choices use the validated Technical Library directly.
Saved Firestopping overlays reuse its projection only when the same instance owns
the validated source and all technical dependencies remain identical. Changed
source files undergo full validation; edited penetration records and reciprocal
links are always rebuilt and validated. These optimizations do not persist a
second library index or change source evidence, prices or calculation formulas.

Measure a fresh disposable service separately from repeat navigation. A visible
workspace or enabled export button is not sufficient: wait for a rendered
worksheet and its cleared busy/loading state. Do not benchmark by refreshing a
user's open project. Native acceptance also waits for actual worksheet content
before testing export.

The installer targets x64 Windows 10/11 and Windows 11 ARM64 (build 22000 or later)
using Windows' x64 application emulation. It rejects 32-bit Windows and Windows
10 ARM64. It selects the native ARM64 or x64 offline WebView2 prerequisite using
the operating system architecture, not the emulated Python process architecture.
Both packages have separate signature, size and hash evidence. It installs per user without requiring an
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

First launch verifies and copies the offline content into the user's data folder.
Large libraries can take a minute or more to prepare; their first use in a new
session also builds the search/filter index. Later requests reuse that index.
Allow preparation to finish before saving or closing the application.

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

ARM64 references: [Microsoft Windows emulation](https://learn.microsoft.com/en-us/windows/arm/apps-on-arm-x86-emulation)
and [Inno native architecture detection](https://jrsoftware.org/ishelp/topic_isxfunc_isarm64.htm).
