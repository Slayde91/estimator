"""Explicit disposable native WebView2 acceptance; no debugging listener or JS API."""

import hashlib
import json
from pathlib import Path
import threading
import time
import traceback
import zipfile

from .catalog import ROOT
from .desktop_seed import safe_directory


def synthetic_seed(directory):
    """Source-checkout diagnostics use empty public content, never live data."""
    from .desktop_seed_content import empty_library_edits, encoded
    from .firestopping_library import empty_library
    directory.mkdir()
    (directory / 'reference-library').mkdir()
    values = {'pricing.json': {'inventory': {}, 'rates': {}},
              'library-edits.json': empty_library_edits(), 'reference-library/library.json': empty_library()}
    files = []
    for name in sorted(values):
        content = encoded(values[name]).encode('utf-8')
        (directory / name).write_bytes(content)
        files.append({'path': name, 'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
    manifest = {'schema_version': 1, 'files': files, 'pricing': {'path': 'pricing.json'},
                'library': {'path': 'reference-library/library.json'}, 'library_edits': {'path': 'library-edits.json'}}
    manifest['id'] = hashlib.sha256(encoded(manifest).encode('utf-8')).hexdigest()
    (directory / 'manifest.json').write_text(encoded(manifest), encoding='utf-8')


class NativeProbe:
    def __init__(self, window):
        from System import Func, Object
        self.window, self.control, self.callback = window, window.native.webview, Func[Object]

    def script(self, source):
        # ExecuteScriptAsync evaluates source directly. pywebview.evaluate_js
        # wraps eval(), which is deliberately prohibited by the application's CSP.
        task = self.control.Invoke(self.callback(lambda: self.control.ExecuteScriptAsync(source)))
        if not task.Wait(15000):
            raise TimeoutError('Native WebView2 script timed out.')
        return json.loads(str(task.Result))

    def wait(self, source, seconds=40):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            result = self.script(source)
            if result:
                return result
            time.sleep(.15)
        raise TimeoutError('Native acceptance condition timed out: ' + source[:200])

    def click(self, selector):
        self.script(f'document.querySelector({json.dumps(selector)}).click();')

    def fill(self, selector, value):
        self.script(f'(() => {{ const element=document.querySelector({json.dumps(selector)}); element.value={json.dumps(value)}; element.dispatchEvent(new Event("input",{{bubbles:true}})); }})();')

    def window_geometry(self):
        from System.Windows.Forms import Screen

        def inspect():
            form = self.window.native
            area = Screen.FromControl(form).WorkingArea
            return json.dumps({'bounds': [form.Left, form.Top, form.Width, form.Height],
                               'minimum': [form.MinimumSize.Width, form.MinimumSize.Height],
                               'working_area': [area.X, area.Y, area.Width, area.Height]})

        return json.loads(str(self.control.Invoke(self.callback(inspect))))

    def screenshot(self, path):
        from System.IO import MemoryStream
        from Microsoft.Web.WebView2.Core import CoreWebView2CapturePreviewImageFormat
        stream = MemoryStream()
        try:
            task = self.control.Invoke(self.callback(lambda: self.control.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream)))
            if not task.Wait(15000):
                raise TimeoutError('Native WebView2 capture timed out.')
            path.write_bytes(bytes(stream.ToArray()))
        finally:
            stream.Dispose()


def self_test(data_directory, output_report):
    """Only new directories are accepted; production user state is never reused."""
    from .desktop import run
    from .native_dialogs import SaveSelection
    from .project_library import file_fingerprint
    directory, report_path = Path(data_directory).absolute(), Path(output_report).absolute()
    safe_directory(directory)
    safe_directory(report_path.parent)
    if directory.exists() or directory.is_relative_to(ROOT) or any(path.exists() or path.is_symlink() for path in (report_path, report_path.with_suffix('.png'), report_path.with_suffix('.failure.png'))):
        raise ValueError('Desktop self-test requires a new disposable directory outside the program and a new report file.')
    directory.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    seed = ROOT / 'factory-seed'
    if not seed.is_dir():
        seed = directory.with_name(directory.name + '-synthetic-seed')
        if seed.exists():
            raise ValueError('The synthetic seed diagnostic path already exists.')
        synthetic_seed(seed)
    project = directory / 'native-project.json'
    report = {'completed': False, 'renderer': 'edgechromium', 'edition': 'standard', 'checks': [], 'errors': []}
    done = threading.Event()
    def checkpoint(stage):
        report['stage'] = stage
        report_path.write_text(json.dumps(report, indent=2), encoding='utf-8')

    class Dialogs:
        def choose_save(self, initial_directory, filename):
            return SaveSelection(str(project), file_fingerprint(project))
        def choose_open(self, initial_directory):
            return str(project)
        def choose_folder(self, initial_directory):
            return str(directory)

    def mounted(window, controller, origin):
        cold_started = time.monotonic()
        phase_lock = threading.Lock()
        phase = {'generation': 0, 'timer': None}

        def arm_deadline(name):
            with phase_lock:
                if phase['timer']:
                    phase['timer'].cancel()
                phase['generation'] += 1
                generation = phase['generation']

                def deadline():
                    with phase_lock:
                        if done.is_set() or generation != phase['generation']:
                            return
                        report['errors'].append('Native ' + name + ' exceeded its 180 second deadline.')
                        checkpoint('timeout')
                    with controller._lock:
                        controller._approved = True
                    window.destroy()

                timer = threading.Timer(180, deadline)
                timer.daemon = True
                phase['timer'] = timer
                timer.start()

        def cancel_deadline():
            with phase_lock:
                phase['generation'] += 1
                if phase['timer']:
                    phase['timer'].cancel()

        def cold_remaining():
            remaining = 180 - (time.monotonic() - cold_started)
            if remaining <= 0:
                raise TimeoutError('Native first-launch readiness exceeded 180 seconds.')
            return remaining

        arm_deadline('first-launch readiness')
        window.events.closed += cancel_deadline
        checkpoint('native window configured')
        report['requests'], report['responses'] = [], []
        def requested(request):
            report['requests'].append(request.url)
            checkpoint('native request')
        def responded(response):
            report['responses'].append({'url': response.url, 'status': response.status_code})
            checkpoint('native response')
        window.events.request_sent += requested
        window.events.response_received += responded
        window.events.before_show += lambda: checkpoint('native before show completed')
        window.events.before_load += lambda: checkpoint('native document before load')
        window.events.shown += lambda: checkpoint('native form shown')
        def native_events():
            control = window.native.webview
            def initialized(sender, event):
                report['native'] = {'source': str(control.Source), 'requested': str(window.real_url), 'visible': bool(window.native.Visible)}
                checkpoint('WebView2 initialized ' + str(event.IsSuccess))
            control.CoreWebView2InitializationCompleted += initialized
            control.NavigationStarting += lambda sender, event: checkpoint('native navigating ' + str(event.Uri))
            control.NavigationCompleted += lambda sender, event: checkpoint('native navigation complete ' + str(event.IsSuccess))
        window.events.before_show += native_events
        def check():
            try:
                checkpoint('native document loaded')
                probe = NativeProbe(window)
                checkpoint('native script probe starting')
                probe.wait('window.CeasefireDesktop?.status().ready === true && !!window.chrome?.webview', seconds=cold_remaining())
                frame = probe.window_geometry()
                report['native_frame'] = frame
                left, top, width, height = frame['bounds']
                area_left, area_top, area_width, area_height = frame['working_area']
                assert area_left <= left and area_top <= top
                assert left + width <= area_left + area_width and top + height <= area_top + area_height
                assert 0 < frame['minimum'][0] <= width and 0 < frame['minimum'][1] <= height
                report['checks'].append('Native frame and minimum size fit within the monitor working area')
                assert probe.script('window.CeasefireDesktop.status().takeoffs') is False
                assert probe.script('!!document.querySelector("[data-view=takeoffs]") || typeof window.CeasefireTakeoffs !== "undefined"') is False
                assert probe.script('document.querySelector("#view-home").hidden') is False
                report['checks'].append('Native standard UI rendered without TAKEOFFS')
                navigation_images = probe.wait('(() => { const images=[...document.querySelectorAll(".app-header nav img")]; return images.length === 2 && images.every(image=>image.complete) && images.map(image=>({src:image.getAttribute("src"),width:image.naturalWidth})); })()')
                assert {image['src'] for image in navigation_images} == {'/icons/navigation-home.png', '/icons/navigation-help.png'}
                assert all(image['width'] > 0 for image in navigation_images), 'Packaged navigation icons must load successfully'
                report['navigation_images'] = navigation_images
                report['checks'].append('Packaged Home and Help icons loaded in native WebView2')
                probe.script('window.nativeQaCsp=[]; document.addEventListener("securitypolicyviolation",event=>window.nativeQaCsp.push(event.effectiveDirective));')
                probe.click('[data-view="estimate"]')
                # The complete private catalogue performs its deterministic cold
                # validation here. Give first-launch readiness a separate bound;
                # do not spend the edit/save/export/close journey's time budget.
                probe.wait('document.querySelector("#calculation-status").textContent === "Calculated" && window.CeasefireDesktop.status().busy === false && document.querySelector("#sum-total").textContent !== "—"', seconds=cold_remaining())
                report['cold_readiness_seconds'] = round(time.monotonic() - cold_started, 3)
                checkpoint('native first-launch ready')
                arm_deadline('acceptance journey')
                probe.fill('#project-no', 'NATIVE-WEBVIEW2')
                probe.fill('#client', 'Disposable desktop acceptance')
                probe.wait('document.querySelector("#calculation-status").textContent === "Calculated" && window.CeasefireDesktop.status().busy === false && document.querySelector("#sum-total").textContent !== "—"')
                baseline = probe.script('document.querySelector("#sum-total").textContent')
                probe.click('#save-project')
                probe.wait('document.querySelector("#project-save-state").textContent === "Saved project"')
                saved = json.loads(project.read_text(encoding='utf-8'))
                assert saved['version'] == 1 and 'takeoffs' not in saved
                assert saved['estimate']['project_no'] == 'NATIVE-WEBVIEW2'
                report['checks'].append('Save As used the native project API and wrote version 1')
                probe.fill('#project-no', 'UNSAVED LATER EDIT')
                probe.click('#load-project')
                probe.wait('document.querySelector("#discard-dialog").open')
                probe.click('#discard-dialog [value="confirm"]')
                probe.wait('document.querySelector("#project-no").value === "NATIVE-WEBVIEW2" && document.querySelector("#project-save-state").textContent === "Saved project"')
                probe.wait('document.querySelector("#calculation-status").textContent === "Calculated" && window.CeasefireDesktop.status().busy === false && document.querySelector("#sum-total").textContent !== "—"')
                assert probe.script('document.querySelector("#sum-total").textContent') == baseline
                report['checks'].append('Reopen preserved saved details, prices and calculated quote output')
                probe.click('#download-quote-pdf')
                probe.wait('document.querySelector("#app-message").textContent.startsWith("PDF saved to ")')
                pdfs = list(directory.glob('*.pdf'))
                assert pdfs and all(file.read_bytes().startswith(b'%PDF') for file in pdfs)
                for calculator_id, label in (('steel_vermiculite', 'Steel spray'), ('steel_board', 'Steel board'), ('ductwork', 'Ductwork')):
                    before = set(directory.glob('*.xlsx'))
                    # Use the public disclosure for every destination; a prior
                    # choice closes it. IDs keep exports independent of order.
                    probe.click('#calculator-navigation-toggle')
                    selector = f'#calculator-navigation-menu button[data-calculator-id="{calculator_id}"]'
                    probe.wait(f'!document.querySelector("#calculator-navigation-menu").hidden && !!document.querySelector({json.dumps(selector)})')
                    probe.click(selector)
                    probe.wait(f'document.querySelector({json.dumps(selector)}).getAttribute("aria-pressed") === "true"')
                    # Export availability alone can precede the first worksheet
                    # response. Require calculated, rendered content as well.
                    probe.wait('!document.querySelector("#calculator-workspace").hidden && !document.querySelector("#calculator-excel").disabled && document.querySelector("#calculator-grid").getAttribute("aria-busy") === "false" && !!document.querySelector("#calculator-grid table") && !document.querySelector("#calculator-grid").textContent.includes("Loading this worksheet")')
                    probe.script('document.querySelector("#calculator-message").textContent="";')
                    probe.click('#calculator-excel')
                    probe.wait('document.querySelector("#calculator-message").textContent.includes("saved to")')
                    outputs = set(directory.glob('*.xlsx')) - before
                    assert len(outputs) == 1
                    with zipfile.ZipFile(outputs.pop()) as archive:
                        assert 'xl/workbook.xml' in archive.namelist()
                    report['checks'].append(label + ' native XLSX export wrote a verified workbook')
                report['checks'].append('PDF export wrote verified bytes through controlled download API')
                probe.click('[data-view="estimate"]')
                probe.wait('window.CeasefireDesktop.status().busy === false')
                probe.screenshot(report_path.with_suffix('.png'))
                assert probe.script('window.nativeQaCsp') == []
                probe.fill('#client', 'UNSAVED CLOSE GUARD')
                window.destroy()
                probe.wait('document.querySelector("#discard-dialog").open')
                probe.click('#discard-dialog [value="cancel"]')
                probe.wait('!document.querySelector("#discard-dialog").open')
                assert probe.script('document.querySelector("#client").value') == 'UNSAVED CLOSE GUARD'
                report['checks'].append('Native close was cancelled and preserved the unsaved draft')
                for _ in range(100):
                    if controller._nonce is None:
                        break
                    time.sleep(.05)
                assert controller._nonce is None
                window.destroy()
                probe.wait('document.querySelector("#discard-dialog").open')
                probe.click('#discard-dialog [value="confirm"]')
                report['checks'].append('Explicit close-without-saving completed native lifecycle')
                report['completed'] = True
            except Exception:
                report['errors'].append(traceback.format_exc())
                checkpoint('failed')
                try:
                    probe.screenshot(report_path.with_suffix('.failure.png'))
                except Exception:
                    pass
                # This diagnostic owns exclusively the newly created disposable
                # window. It cannot approve closing a normal production session.
                with controller._lock:
                    controller._approved = True
                window.destroy()
            finally:
                done.set()
                cancel_deadline()
        window.events.loaded += lambda: threading.Thread(target=check, name='NativeAcceptance', daemon=True).start()
    try:
        run(data_directory=directory, seed_directory=seed, project_dialogs=Dialogs(), hidden=True, on_window=mounted)
        if not done.wait(1):
            report['errors'].append('Native window closed before acceptance completed.')
        report['completed'] = report['completed'] and not report['errors']
    except Exception:
        report['errors'].append(traceback.format_exc())
    report_path.write_text(json.dumps(report, indent=2), encoding='utf-8')
    return 0 if report['completed'] else 1
