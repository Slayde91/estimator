"""Startup artwork, strict native notification, and packaging identity contracts."""

import ctypes
from ctypes import wintypes
from hashlib import sha256
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from estimator import desktop
from estimator.brand_boot import TITLE, NativeBrandSplash, boot_message, install_boot_listener, logo_pixels
from estimator.catalog import ROOT
from estimator.edition import render_index
from scripts.make_classifire_icon import MARK_BOUNDS, SOURCE_SHA256, SIZES
from tests.test_desktop import Event


class BrandBootTests(unittest.TestCase):
    def test_original_full_logo_and_legacy_assets_are_unchanged(self):
        expected = {'classifire-logo.png': SOURCE_SHA256,
            'ceasefire-logo.png': 'b390a843144556546558d166207f476d7e2197070ec35a1a23064fbbb7da9ac7',
            'ceasefire-app.ico': '4d8f4656d01f13dc6f0365fc0871c74c96e5efca597cd4e62d243674075bae1c',
            'ceasefire-app-icon.png': '7a383cfe5b84662b71e5bd11c56613352644fe5fcf7dbf0741607d15db3c2da8'}
        for name, digest in expected.items():
            self.assertEqual(sha256((ROOT / 'static' / name).read_bytes()).hexdigest(), digest)

    def test_icon_is_exact_original_mark_pixels_and_retains_alpha(self):
        with Image.open(ROOT / 'static/classifire-logo.png') as source, Image.open(ROOT / 'static/classifire-app-icon.png') as icon:
            self.assertEqual(icon.mode, 'RGBA')
            self.assertEqual(icon.tobytes(), source.crop(MARK_BOUNDS).tobytes())
            self.assertEqual(icon.getpixel((0, 0))[3], 0)
            self.assertGreater(icon.getchannel('A').histogram()[0], 1000)

    def test_ico_contains_all_windows_sizes_with_transparent_padding(self):
        with Image.open(ROOT / 'static/classifire-app.ico') as icon:
            self.assertEqual(icon.ico.sizes(), {(size, size) for size in SIZES})
            for size in SIZES:
                image = icon.ico.getimage((size, size))
                self.assertEqual(image.size, (size, size))
                self.assertEqual(image.getpixel((0, 0))[3], 0)

    def test_full_transparent_logo_decodes_to_bounded_premultiplied_native_pixels(self):
        size, pixels = logo_pixels(ROOT / 'static/classifire-logo.png', (850, 300))
        self.assertEqual(size, (850, 283))
        self.assertEqual(len(pixels), size[0] * size[1] * 4)
        self.assertEqual(pixels[:4], b'\0\0\0\0')
        self.assertTrue(all(channel <= pixels[i + 3] for i in range(0, len(pixels), 4) for channel in pixels[i:i + 3]))

    def test_web_native_and_packaging_display_title_match_without_renaming_installation(self):
        self.assertEqual(TITLE, 'CLASSIFIRE | Passive Fire Intelligence')
        self.assertEqual(desktop.TITLE, TITLE)
        html = (ROOT / 'static/index.html').read_text(encoding='utf-8')
        self.assertIn('<title>' + TITLE + '</title>', html)
        installer = (ROOT / 'packaging/windows/installer.iss').read_text(encoding='utf-8')
        for field in ('AppName', 'UninstallDisplayName', 'VersionInfoDescription', 'VersionInfoProductName'):
            self.assertIn(field + '=' + TITLE, installer)
        for unchanged in ('AppId={{8D5B7B2D-0153-4C48-A140-CE479A972D19}',
                'DefaultDirName={localappdata}\\Programs\\CEASEFIRE Estimator',
                'AppMutex=Local\\CEASEFIRE.Estimator.Desktop.Running',
                'UninstallDisplayIcon={app}\\CEASEFIRE Estimator.exe'):
            self.assertIn(unchanged, installer)

    def test_shared_boot_and_icon_assets_are_in_both_editions(self):
        with patch('sys.path', [str(ROOT / 'scripts'), *sys.path]):
            from scripts.build_windows import STATIC_FILES
        for asset in ('brand-boot.js', 'brand-boot.css', 'classifire-app.ico', 'classifire-app-icon.png'):
            self.assertIn(asset, STATIC_FILES)
        for edition in ('full', 'standard'):
            html = render_index((ROOT / 'static/index.html').read_bytes(), edition).decode('utf-8')
            self.assertIn('id="classifire-boot"', html)
            self.assertIn('href="/classifire-app.ico"', html)
            self.assertLess(html.index('src="/brand-boot.js"'), html.index('src="/app.js"'))

    def test_only_exact_bounded_cosmetic_packets_are_accepted(self):
        for state in ('ready', 'error'):
            self.assertTrue(boot_message(json.dumps({'type': 'classifire.boot', 'state': state})))
        for raw in ('', '[]', '{}', 'null', '{', 'x' * 129,
                '{"type":"ceasefire.close","state":"ready"}',
                '{"type":"classifire.boot","state":"reload"}',
                '{"type":"classifire.boot","state":"ready","path":"x"}'):
            self.assertFalse(boot_message(raw))

    def test_native_listener_checks_exact_main_document_before_releasing_only_splash(self):
        event = Event()
        control = SimpleNamespace(WebMessageReceived=event)
        window = SimpleNamespace(native=SimpleNamespace(webview=control))
        splash = Mock()
        origin = 'http://127.0.0.1:54321'
        returned, handler = install_boot_listener(window, origin, desktop.main_document, splash)
        self.assertIs(returned, control)
        for source in ('https://example.com/', origin + '/api/bootstrap', origin + '/?x=1'):
            event.emit(None, SimpleNamespace(Source=source, WebMessageAsJson='{"type":"classifire.boot","state":"ready"}'))
        splash.close.assert_not_called()
        event.emit(None, SimpleNamespace(Source=origin + '/', WebMessageAsJson='{"type":"classifire.boot","state":"ready"}'))
        splash.close.assert_called_once_with()
        event.__isub__(handler)
        self.assertEqual(event.handlers, [])

    def test_worker_initialization_failure_is_reported_and_thread_is_joined(self):
        splash = NativeBrandSplash(ROOT / 'static/classifire-logo.png', hidden=True)
        with patch.object(splash, '_native_run', side_effect=ValueError('native failed')), patch('estimator.brand_boot.os.name', 'nt'):
            with self.assertRaisesRegex(RuntimeError, 'could not initialize'):
                splash.start()
        self.assertFalse(splash._thread.is_alive())
        splash.close()

    def test_pre_server_failure_closes_started_splash_and_preserves_cleanup(self):
        order = []
        splash, kernel = Mock(), Mock()
        splash.start.side_effect = lambda: order.append('splash')
        def fail_seed(*args):
            order.append('seed')
            raise ValueError('isolated initialization failure')
        fake_webview = SimpleNamespace()
        with patch.dict('sys.modules', {'webview': fake_webview}), patch.object(desktop.os, 'name', 'nt'), \
                patch.object(desktop, 'NativeBrandSplash', return_value=splash), \
                patch.object(desktop, '_single_instance', return_value=(kernel, 1)), \
                patch.object(desktop, '_installer_guard', return_value=2), \
                patch.object(desktop.ctypes, 'windll', Mock(), create=True), \
                patch('estimator.desktop_seed.initialize_data', side_effect=fail_seed), \
                patch('estimator.server.create_server') as server:
            with self.assertRaisesRegex(ValueError, 'isolated initialization failure'):
                desktop.run(data_directory=ROOT / 'unused-readonly-test-location')
        self.assertEqual(order, ['splash', 'seed'])
        splash.close.assert_called_once_with()
        server.assert_not_called()
        self.assertEqual(kernel.CloseHandle.call_count, 2)

    @unittest.skipUnless(os.name == 'nt', 'Owned native Win32 window requires Windows')
    def test_actual_windows_layered_window_closes_without_gdi_leaks(self):
        user = ctypes.WinDLL('user32', use_last_error=True)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        user.GetGuiResources.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        user.GetGuiResources.restype = wintypes.DWORD
        process = kernel.GetCurrentProcess()
        before = user.GetGuiResources(process, 0)
        for _ in range(3):
            splash = NativeBrandSplash(ROOT / 'static/classifire-logo.png', hidden=True)
            try:
                splash.start()
                self.assertIsNotNone(splash._window)
                self.assertTrue(splash._thread.is_alive())
            finally:
                splash.close()
            splash.close()
            self.assertIsNone(splash._window)
            self.assertFalse(splash._thread.is_alive())
        self.assertLessEqual(user.GetGuiResources(process, 0), before)


if __name__ == '__main__':
    unittest.main()
