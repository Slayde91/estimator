"""Native shell security/lifecycle checks, independent of an installed renderer."""
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from estimator.desktop import (CloseController, RUNNING_MUTEX, SETUP_MUTEX, _installer_guard,
                               abort_native_load, external_document, fitted_window_geometry,
                               install_navigation_guard, main_document)


class Event:
    def __init__(self): self.handlers = []
    def __iadd__(self, handler): self.handlers.append(handler); return self
    def __isub__(self, handler):
        if handler in self.handlers: self.handlers.remove(handler)
        return self
    def emit(self, *args):
        for handler in self.handlers: handler(*args)


class DesktopTests(unittest.TestCase):
    origin = 'http://127.0.0.1:54321'

    def test_native_frame_fits_high_dpi_work_area_without_a_second_scale(self):
        bounds, minimum = fitted_window_geometry((2880, 1920), (2000, 1400), (0, 0, 2880, 1824))
        self.assertEqual(bounds, (0, 0, 2880, 1824))
        self.assertEqual(minimum, (2000, 1400))

    def test_small_work_area_reduces_minimum_without_hiding_frame_controls(self):
        bounds, minimum = fitted_window_geometry((1440, 960), (1000, 700), (40, 24, 800, 576))
        self.assertEqual(bounds, (40, 24, 800, 576))
        self.assertEqual(minimum, (800, 576))

    def test_roomy_negative_coordinate_monitor_preserves_size_and_centers_within_work_area(self):
        bounds, minimum = fitted_window_geometry((1440, 960), (1000, 700), (-2560, -200, 2560, 1392))
        self.assertEqual(bounds, (-2000, 16, 1440, 960))
        self.assertEqual(minimum, (1000, 700))

    def test_unavailable_native_work_area_fails_before_show(self):
        with self.assertRaisesRegex(RuntimeError, 'working area'):
            fitted_window_geometry((1440, 960), (1000, 700), (0, 0, 0, 960))

    def test_only_exact_main_document_has_close_authority(self):
        for suffix in ('/', '/index.html', '/#home'):
            self.assertTrue(main_document(self.origin + suffix, self.origin))
        for url in ('http://localhost:54321/', 'http://127.0.0.1:8765/', self.origin + '/api/bootstrap',
                    self.origin + '/?other=1', 'https://127.0.0.1:54321/', 'file:///C:/project.json',
                    'http://user@127.0.0.1:54321/', 'http://127.0.0.1:invalid/'):
            self.assertFalse(main_document(url, self.origin), url)

    def test_external_links_are_http_reports_not_local_authority(self):
        for url in ('https://www.promat.com/report.pdf', self.origin + '/api/libraries/documents/report_1.pdf', self.origin + '/api/libraries/images/diagram_1'):
            self.assertTrue(external_document(url, self.origin), url)
        for url in ('file:///C:/x.pdf', 'javascript:alert(1)', 'data:text/html,test', 'https://user:pass@example.com/',
                    'http://localhost:1234/', 'http://x.localhost/', 'http://127.0.0.2/', 'http://[::1]/',
                    'http://192.168.1.2/', self.origin + '/api/project/open', self.origin + '/api/libraries/documents/x.pdf?download=1'):
            self.assertFalse(external_document(url, self.origin), url)

    def controller(self):
        controller = CloseController(self.origin)
        controller.bind(Mock(get_current_url=lambda: self.origin + '/'))
        controller._nonce = 'a' * 64
        self.addCleanup(controller.closed)
        return controller

    def test_close_reply_requires_matching_nonce_boolean_and_origin(self):
        controller = self.controller()
        self.assertFalse(controller.resolve_close('b' * 64, True))
        self.assertFalse(controller.resolve_close('a' * 64, 'true'))
        controller.window.get_current_url = lambda: 'https://example.com/'
        self.assertFalse(controller.resolve_close('a' * 64, True))
        controller.window.get_current_url = lambda: self.origin + '/'
        self.assertTrue(controller.resolve_close('a' * 64, False))
        controller.window.destroy.assert_not_called()
        self.assertFalse(controller.resolve_close('a' * 64, True))

    def test_approved_reply_grants_exactly_one_native_close(self):
        controller = self.controller()
        self.assertTrue(controller.resolve_close('a' * 64, True))
        controller.window.destroy.assert_called_once()
        self.assertTrue(controller.closing())
        with patch('estimator.desktop.threading.Thread'):
            self.assertFalse(controller.closing())
        self.assertIsNotNone(controller._nonce)

    def test_acknowledgement_retains_explicit_recovery_watchdog(self):
        controller = self.controller()
        with patch('estimator.desktop.threading.Timer') as timer:
            self.assertTrue(controller.acknowledge_close('a' * 64))
            timer.assert_called_once_with(180, controller._unavailable, args=('a' * 64,))
            timer.return_value.start.assert_called_once()
        self.assertTrue(controller._acknowledged)

    def test_native_fallback_never_overrides_completed_or_cancelled_review(self):
        controller = self.controller()
        def review(*args):
            self.assertTrue(controller._fallback_pending)
            self.assertTrue(controller.resolve_close('a' * 64, False))
            return True
        controller.window.create_confirmation_dialog.side_effect = review
        controller._unavailable('a' * 64)
        controller.window.destroy.assert_not_called()
        self.assertFalse(controller._approved)

    def test_guard_installs_without_calling_loaded_decorated_api(self):
        control = SimpleNamespace(NavigationStarting=Event(), WebMessageReceived=Event())
        window = SimpleNamespace(native=SimpleNamespace(webview=control, browser=SimpleNamespace(on_script_notify=Mock())), events=SimpleNamespace(loaded=Event()),
                                 get_current_url=Mock(side_effect=AssertionError('must not wait for loaded')), run_js=Mock())
        controller = Mock()
        install_navigation_guard(window, self.origin, controller)
        first = SimpleNamespace(Uri=self.origin + '/', Cancel=False)
        control.NavigationStarting.emit(None, first)
        self.assertFalse(first.Cancel)
        with patch('estimator.desktop.threading.Thread') as thread:
            reload = SimpleNamespace(Uri=self.origin + '/', Cancel=False)
            control.NavigationStarting.emit(None, reload)
            self.assertTrue(reload.Cancel)
            thread.assert_called_once()
        blocked = SimpleNamespace(Uri=self.origin + '/api/project/open', Cancel=False)
        control.NavigationStarting.emit(None, blocked)
        self.assertTrue(blocked.Cancel)
        with patch('estimator.desktop.threading.Thread') as thread:
            control.WebMessageReceived.emit(None, SimpleNamespace(Source='https://example.com/', WebMessageAsJson='{}'))
            control.WebMessageReceived.emit(None, SimpleNamespace(Source=self.origin + '/', WebMessageAsJson='{"type":"ceasefire.close","command":"delete"}'))
            thread.assert_not_called()
        window.get_current_url.assert_not_called()

    def test_installer_mutex_names_match_and_active_setup_refuses_launch(self):
        kernel = Mock()
        kernel.CreateMutexW.return_value = 123
        kernel.OpenMutexW.return_value = 456
        with self.assertRaisesRegex(RuntimeError, 'Finish Setup'):
            _installer_guard(kernel)
        kernel.CreateMutexW.assert_called_once_with(None, False, RUNNING_MUTEX)
        kernel.OpenMutexW.assert_called_once_with(0x00100000, False, SETUP_MUTEX)
        self.assertEqual(kernel.CloseHandle.call_count, 2)
        kernel.reset_mock()
        kernel.OpenMutexW.return_value = None
        with patch('estimator.desktop.ctypes.get_last_error', return_value=2, create=True):
            self.assertEqual(_installer_guard(kernel), 123)
        kernel.CloseHandle.assert_not_called()

    def test_guard_failure_disposes_pending_renderer_and_prevents_application_load(self):
        controller = self.controller()
        window = SimpleNamespace(real_url=self.origin + '/', native=SimpleNamespace(webview=Mock()), destroy=Mock())
        with patch('estimator.desktop.threading.Thread') as thread:
            abort_native_load(window, controller)
            thread.assert_called_once_with(target=window.destroy, daemon=True)
        self.assertEqual(window.real_url, 'about:blank')
        window.native.webview.Dispose.assert_called_once()
        self.assertTrue(controller._approved)


if __name__ == '__main__': unittest.main()
