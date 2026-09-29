"""Windows desktop edition. The shell owns one private loopback server/window."""

import ctypes
import hashlib
import ipaddress
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import secrets
import threading
import time
from urllib.parse import urlsplit
import webbrowser

from .catalog import ROOT

TITLE = 'CEASEFIRE ESTIMATOR'
LOGGER = logging.getLogger(__name__)
REFERENCE = re.compile(r'/api/libraries/(?:documents/[a-z0-9][a-z0-9_-]{0,119}\.pdf|images/[a-z0-9][a-z0-9_-]{0,119})\Z')
RUNNING_MUTEX = r'Local\CEASEFIRE.Estimator.Desktop.Running'
SETUP_MUTEX = r'Local\CEASEFIRE.Estimator.Desktop.Setup'


def application_data_directory():
    """Use Windows' per-user writable location, never the executable directory."""
    value = os.environ.get('LOCALAPPDATA')
    if not value or not Path(value).is_absolute():
        raise RuntimeError('Windows Local AppData is unavailable. ESTIMATOR cannot select a safe data folder.')
    return Path(value) / 'CEASEFIRE' / 'Estimator'


def main_document(url, origin):
    try:
        parsed, expected = urlsplit(url), urlsplit(origin)
        return (parsed.scheme == expected.scheme == 'http' and parsed.hostname == expected.hostname == '127.0.0.1'
                and parsed.port == expected.port and not parsed.username and not parsed.password
                and parsed.path in ('/', '/index.html') and not parsed.query)
    except (ValueError, TypeError):
        return False


def external_document(url, origin):
    """Only user-selected HTTP(S) reports may leave the dedicated window."""
    try:
        parsed, expected = urlsplit(url), urlsplit(origin)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password
                or any(ord(char) < 32 for char in url) or len(url) > 8192):
            return False
        port = parsed.port  # Validate malformed ports before opening the browser.
        if parsed.hostname == expected.hostname and port == expected.port and parsed.scheme == expected.scheme:
            return bool(REFERENCE.fullmatch(parsed.path)) and not parsed.query
        host = parsed.hostname.lower().rstrip('.')
        if host == 'localhost' or host.endswith('.localhost'):
            return False
        try:
            address = ipaddress.ip_address(host)
            if not address.is_global:
                return False
        except ValueError:
            pass
        return True
    except (ValueError, TypeError):
        return False


class CloseController:
    """One nonce-bound answer grants one pending window close, never a write."""

    def __init__(self, origin):
        self.origin, self.window = origin, None
        self._lock = threading.Lock()
        self._nonce = None
        self._approved = False
        self._acknowledged = False
        self._timer = None
        self._requested_at = 0
        self._fallback_pending = False

    def bind(self, window):
        self.window = window

    def closing(self):
        with self._lock:
            if self._approved:
                self._approved = False
                return True
            if self._nonce:
                if time.monotonic() - self._requested_at > 30 and not self._fallback_pending:
                    threading.Thread(target=self._unavailable, args=(self._nonce,), daemon=True).start()
                return False
            self._nonce = secrets.token_hex(32)
            self._acknowledged = False
            self._requested_at = time.monotonic()
            nonce = self._nonce
        # The native closing callback must return before WebView2 executes JS.
        threading.Thread(target=self._request, args=(nonce,), daemon=True).start()
        return False

    def _request(self, nonce):
        try:
            if not main_document(self.window.get_current_url(), self.origin):
                raise RuntimeError('The application page is not ready.')
            self.window.run_js(f'window.CeasefireDesktop?.requestClose({json.dumps(nonce)});')
            with self._lock:
                if self._nonce == nonce and not self._acknowledged:
                    self._timer = threading.Timer(15, self._unavailable, args=(nonce,))
                    self._timer.daemon = True
                    self._timer.start()
        except Exception:
            LOGGER.exception('The desktop close check could not start')
            self._unavailable(nonce)

    def _unavailable(self, nonce):
        with self._lock:
            if self._nonce != nonce or self._fallback_pending:
                return
            self._fallback_pending = True
        # A broken renderer must not trap the user, or silently discard work.
        allowed = self.window.create_confirmation_dialog(TITLE, 'The application has not finished checking its unsaved work. Close anyway? Unsaved changes may be lost.')
        with self._lock:
            self._fallback_pending = False
            if self._nonce != nonce:
                return
            self._nonce = None
            self._approved = bool(allowed)
            if self._timer:
                self._timer.cancel()
                self._timer = None
        if allowed:
            self.window.destroy()

    def resolve_close(self, nonce, allowed):
        """The only exposed method: no paths, URLs, commands or project contents."""
        if type(allowed) is not bool or not isinstance(nonce, str):
            return False
        with self._lock:
            if not self._nonce or not secrets.compare_digest(self._nonce, nonce):
                return False
            if not main_document(self.window.get_current_url(), self.origin):
                return False
            self._nonce = None
            if self._timer:
                self._timer.cancel()
                self._timer = None
            self._approved = allowed
        if allowed:
            self.window.destroy()
        return True

    def acknowledge_close(self, nonce):
        with self._lock:
            if not isinstance(nonce, str) or not self._nonce or not secrets.compare_digest(nonce, self._nonce) or not main_document(self.window.get_current_url(), self.origin):
                return False
            self._acknowledged = True
            if self._timer:
                self._timer.cancel()
            # Acknowledgement allows time to review, but cannot trap a user
            # after a renderer crash. Recovery always asks before closing.
            self._timer = threading.Timer(180, self._unavailable, args=(nonce,))
            self._timer.daemon = True
            self._timer.start()
            return True

    def closed(self):
        with self._lock:
            self._nonce = None
            if self._timer:
                self._timer.cancel()


def install_navigation_guard(window, origin, controller):
    """Runs on before_show, before the first user navigation can take place."""
    control = window.native.webview
    # This edition exposes no pywebview Python API. Its default generic message
    # dispatcher is unnecessary; only the bounded close protocol below is used.
    control.WebMessageReceived -= window.native.browser.on_script_notify
    first_navigation = True
    def loaded():
        nonlocal first_navigation
        first_navigation = False
    window.events.loaded += loaded

    def navigating(sender, event):
        nonlocal first_navigation
        url = str(event.Uri)
        if main_document(url, origin):
            if first_navigation:
                first_navigation = False
                return
            # Home is an application view. A second top-level document load
            # would discard the in-memory project and is never needed here.
            event.Cancel = True
            threading.Thread(target=window.run_js, args=('window.CeasefireDesktop?.showHome();',), daemon=True).start()
            return
        event.Cancel = True
        if external_document(url, origin):
            threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
        else:
            LOGGER.warning('Blocked non-application desktop navigation')

    control.NavigationStarting += navigating
    def close_message(sender, event):
        # Ignore pywebview's own messages and every message from other origins.
        if not main_document(str(event.Source), origin):
            return
        raw = str(event.WebMessageAsJson)
        if len(raw) > 512:
            return
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            return
        if not isinstance(value, dict) or set(value) != {'type', 'action', 'nonce', 'allowed'} or value['type'] != 'ceasefire.close':
            return
        # Never block the native GUI event while it queries the current URL.
        if value['action'] == 'ack' and type(value['allowed']) is bool:
            threading.Thread(target=controller.acknowledge_close, args=(value['nonce'],), daemon=True).start()
        elif value['action'] == 'resolve':
            threading.Thread(target=controller.resolve_close, args=(value['nonce'], value['allowed']), daemon=True).start()
    control.WebMessageReceived += close_message
    # OPEN_EXTERNAL_LINKS_IN_BROWSER=False sends target=_blank through this
    # same navigation gate rather than pywebview's unrestricted URL opener.
    window._ceasefire_navigation_handler = navigating
    window._ceasefire_close_handler = close_message


def _single_instance(directory):
    key = hashlib.sha256(str(directory).casefold().encode('utf-8')).hexdigest()[:24]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    handle = kernel.CreateMutexW(None, False, f'Local\\CEASEFIRE-Estimator-{key}')
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        kernel.CloseHandle(ctypes.c_void_p(handle))
        raise RuntimeError('ESTIMATOR is already running for this Windows user. Return to its open window.')
    return kernel, handle


def _installer_guard(kernel):
    """Installer and application each announce themselves, then recheck peer."""
    running = kernel.CreateMutexW(None, False, RUNNING_MUTEX)
    if not running:
        raise ctypes.WinError(ctypes.get_last_error())
    kernel.OpenMutexW.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_wchar_p]
    kernel.OpenMutexW.restype = ctypes.c_void_p
    setup = kernel.OpenMutexW(0x00100000, False, SETUP_MUTEX)
    if setup:
        kernel.CloseHandle(ctypes.c_void_p(setup))
        kernel.CloseHandle(ctypes.c_void_p(running))
        raise RuntimeError('ESTIMATOR is being installed or removed. Finish Setup before opening the application.')
    if ctypes.get_last_error() not in (0, 2):
        kernel.CloseHandle(ctypes.c_void_p(running))
        raise RuntimeError('ESTIMATOR could not verify whether Setup is running. Finish Setup and try again.')
    return running


def abort_native_load(window, controller):
    # pywebview logs and swallows before_show errors; explicitly remove the
    # pending URL and dispose the renderer before returning to its event loop.
    window.real_url = 'about:blank'
    window.native.webview.Dispose()
    with controller._lock:
        controller._approved = True
    threading.Thread(target=window.destroy, daemon=True).start()


def fitted_window_geometry(size, minimum, work_area):
    """Fit native pixel dimensions without mixing logical and physical DPI units."""
    left, top, available_width, available_height = work_area
    if available_width <= 0 or available_height <= 0:
        raise RuntimeError('The desktop monitor has no usable working area.')
    width = max(1, min(size[0], available_width))
    height = max(1, min(size[1], available_height))
    bounds = (left + (available_width - width) // 2,
              top + (available_height - height) // 2, width, height)
    minimum = (max(1, min(minimum[0], width)), max(1, min(minimum[1], height)))
    return bounds, minimum


def fit_native_window(window):
    """Run on the native GUI thread before the window becomes visible."""
    from System.Drawing import Rectangle, Size
    from System.Windows.Forms import FormStartPosition, Screen
    form = window.native
    area = Screen.FromControl(form).WorkingArea
    bounds, minimum = fitted_window_geometry(
        (form.Width, form.Height), (form.MinimumSize.Width, form.MinimumSize.Height),
        (area.X, area.Y, area.Width, area.Height))
    # WinForms has already scaled these dimensions. Use native pixels for both
    # the frame and the work area; do not apply the monitor DPI a second time.
    form.StartPosition = FormStartPosition.Manual
    form.MinimumSize = Size(*minimum)
    form.Bounds = Rectangle(*bounds)


def run(*, data_directory=None, seed_directory=None, project_dialogs=None, hidden=False, on_window=None):
    if os.name != 'nt':
        raise RuntimeError('The desktop installer requires Windows and the Microsoft Edge WebView2 Runtime.')
    from .desktop_seed import initialize_data, safe_directory, safe_file_if_present
    import webview
    from .server import create_server
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('CEASEFIRE.Estimator.Standard')
    directory = data_directory or application_data_directory()
    kernel, handle = _single_instance(directory)
    server, running = None, None
    try:
        running = _installer_guard(kernel)
        initialize_data(seed_directory or ROOT / 'factory-seed', directory)
        logs, profile = safe_directory(directory / 'logs'), safe_directory(directory / 'webview')
        logs.mkdir(exist_ok=True); profile.mkdir(exist_ok=True)
        safe_directory(logs); safe_directory(profile)
        for suffix in ('', '.1', '.2', '.3'):
            safe_file_if_present(logs / ('desktop.log' + suffix))
        log = RotatingFileHandler(logs / 'desktop.log', maxBytes=2 * 1024 * 1024, backupCount=3, encoding='utf-8')
        logging.basicConfig(level=logging.INFO, handlers=[log], format='%(asctime)s %(levelname)s %(name)s: %(message)s')
        server = create_server(0, directory / 'estimator.sqlite3', project_dialogs=project_dialogs, library_directory=directory / 'reference-library', edition='standard')
        origin = f'http://127.0.0.1:{server.server_port}'
        thread = threading.Thread(target=server.serve_forever, name='EstimatorLoopback', daemon=True)
        thread.start()
        controller = CloseController(origin)
        webview.settings.update({'ALLOW_DOWNLOADS': False, 'ALLOW_FILE_URLS': False, 'OPEN_EXTERNAL_LINKS_IN_BROWSER': False,
                                 'OPEN_DEVTOOLS_IN_DEBUG': False, 'REMOTE_DEBUGGING_PORT': None, 'IGNORE_SSL_ERRORS': False})
        window = webview.create_window(TITLE + (' — disposable acceptance test' if on_window else ''), origin + '/', width=1440, height=960,
                                       min_size=(1000, 700), text_select=True, confirm_close=False)
        controller.bind(window)
        startup_errors = []
        def initialized(renderer):
            if renderer != 'edgechromium':
                startup_errors.append('Microsoft Edge WebView2 is required. Legacy browser fallback is not allowed.')
                return False
        window.events.initialized += initialized
        def install_guards():
            try:
                from System.Drawing import Icon
                fit_native_window(window)
                window.native.Icon = Icon(str(ROOT / 'static' / 'ceasefire-app.ico'))
                if hidden:
                    # Hiding a WinForms WebView before first navigation can
                    # suspend its renderer. An invisible shown diagnostic form
                    # still exercises the actual native document lifecycle.
                    window.native.Opacity = 0
                install_navigation_guard(window, origin, controller)
                def initialized_native(sender, event):
                    if not event.IsSuccess:
                        startup_errors.append('Microsoft Edge WebView2 could not initialize. Repair or reinstall its Runtime and try again.')
                        abort_native_load(window, controller)
                window.native.webview.CoreWebView2InitializationCompleted += initialized_native
            except Exception:
                startup_errors.append('The desktop navigation security guard could not be installed.')
                # before_show exceptions are logged and swallowed by pywebview.
                # Prevent a later CoreWebView2 callback from loading the app.
                abort_native_load(window, controller)
                LOGGER.exception('Desktop navigation guard failed; application load cancelled')
        window.events.before_show += install_guards
        window.events.closing += controller.closing
        window.events.closed += controller.closed
        if on_window:
            on_window(window, controller, origin)
        try:
            webview.start(gui='edgechromium', debug=False, private_mode=False, storage_path=str(directory / 'webview'), icon=str(ROOT / 'static' / 'ceasefire-app.ico'))
            if startup_errors:
                raise RuntimeError(startup_errors[0])
        finally:
            controller.closed()
    finally:
        if server:
            server.shutdown()
            server.server_close()
        if running:
            kernel.CloseHandle(ctypes.c_void_p(running))
        kernel.CloseHandle(ctypes.c_void_p(handle))


def main():
    import argparse
    parser = argparse.ArgumentParser(description='CEASEFIRE ESTIMATOR Windows desktop')
    parser.add_argument('--self-test', action='store_true', help='Run native diagnostics in a new disposable data directory.')
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--output-report', type=Path)
    args = parser.parse_args()
    if args.self_test:
        if not args.data_dir or not args.output_report:
            parser.error('--self-test requires --data-dir and --output-report.')
        from .desktop_selftest import self_test
        return self_test(args.data_dir, args.output_report)
    if args.data_dir or args.output_report:
        parser.error('Data directory and report options are restricted to the disposable self-test.')
    try:
        run()
        return 0
    except Exception as error:
        LOGGER.exception('Desktop startup failed')
        if os.name == 'nt':
            ctypes.windll.user32.MessageBoxW(None, str(error), f'{TITLE} could not start', 0x10)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
