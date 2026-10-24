"""Owned Win32 startup artwork; no application data or generic native bridge."""

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import threading


TITLE = 'CLASSIFIRE | Passive Fire Intelligence'


def boot_message(raw):
    """The cosmetic protocol can only release this process's startup artwork."""
    if not isinstance(raw, str) or len(raw) > 128:
        return False
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return False
    return (isinstance(value, dict) and set(value) == {'type', 'state'}
            and value['type'] == 'classifire.boot' and value['state'] in ('ready', 'error'))


def install_boot_listener(window, origin, main_document, splash):
    control = window.native.webview

    def received(sender, event):
        if main_document(str(event.Source), origin) and boot_message(str(event.WebMessageAsJson)):
            splash.close()

    control.WebMessageReceived += received
    return control, received


def logo_pixels(path, maximum):
    """Decode existing artwork to the premultiplied BGRA required by Win32."""
    from PIL import Image, ImageChops, ImageOps
    with Image.open(path) as original:
        image = ImageOps.contain(original.convert('RGBA'), maximum, Image.Resampling.LANCZOS)
        red, green, blue, alpha = image.split()
        premultiplied = Image.merge('RGBA', (ImageChops.multiply(red, alpha),
            ImageChops.multiply(green, alpha), ImageChops.multiply(blue, alpha), alpha))
        return image.size, premultiplied.tobytes('raw', 'BGRA')


class NativeBrandSplash:
    """One separate Win32 message-loop thread owns and disposes every handle."""

    def __init__(self, logo, *, hidden=False):
        self.logo, self.hidden = Path(logo), hidden
        self._ready, self._stop = threading.Event(), threading.Event()
        self._lock = threading.Lock()
        self._thread, self._window, self._error = None, None, None

    def start(self):
        if os.name != 'nt':
            raise RuntimeError('The native startup logo requires Windows.')
        if self._thread is not None:
            raise RuntimeError('The startup logo has already been started.')
        self._thread = threading.Thread(target=self._run, name='ClassifireStartupLogo', daemon=True)
        self._thread.start()
        if not self._ready.wait(10):
            self.close()
            raise RuntimeError('The native startup logo could not initialize.')
        if self._error:
            self.close()
            raise RuntimeError('The native startup logo could not initialize.') from self._error
        return self

    def close(self):
        self._stop.set()
        with self._lock:
            if self._window:
                user = ctypes.WinDLL('user32', use_last_error=True)
                user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
                user.PostMessageW.restype = wintypes.BOOL
                user.PostMessageW(self._window, 0x0010, 0, 0)  # WM_CLOSE; only our HWND.
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(5)
            if self._thread.is_alive():
                raise RuntimeError('The native startup logo did not close.')

    def _run(self):
        try:
            self._native_run()
        except Exception as error:
            self._error = error
        finally:
            self._ready.set()

    def _native_run(self):
        user = ctypes.WinDLL('user32', use_last_error=True)
        gdi = ctypes.WinDLL('gdi32', use_last_error=True)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        result = ctypes.c_ssize_t
        callback = ctypes.WINFUNCTYPE(result, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

        class WindowClass(ctypes.Structure):
            _fields_ = [('style', wintypes.UINT), ('procedure', callback), ('class_extra', ctypes.c_int),
                ('window_extra', ctypes.c_int), ('instance', wintypes.HINSTANCE), ('icon', wintypes.HICON),
                ('cursor', wintypes.HANDLE), ('background', wintypes.HBRUSH), ('menu', wintypes.LPCWSTR),
                ('name', wintypes.LPCWSTR)]

        class BitmapInfo(ctypes.Structure):
            _fields_ = [('size', wintypes.DWORD), ('width', wintypes.LONG), ('height', wintypes.LONG),
                ('planes', wintypes.WORD), ('bits', wintypes.WORD), ('compression', wintypes.DWORD),
                ('image_size', wintypes.DWORD), ('x_resolution', wintypes.LONG), ('y_resolution', wintypes.LONG),
                ('colors', wintypes.DWORD), ('important', wintypes.DWORD)]

        class Blend(ctypes.Structure):
            _fields_ = [('operation', ctypes.c_ubyte), ('flags', ctypes.c_ubyte),
                ('alpha', ctypes.c_ubyte), ('format', ctypes.c_ubyte)]

        signatures = [
            (kernel, 'GetModuleHandleW', [wintypes.LPCWSTR], wintypes.HMODULE),
            (user, 'RegisterClassW', [ctypes.POINTER(WindowClass)], wintypes.WORD),
            (user, 'UnregisterClassW', [wintypes.LPCWSTR, wintypes.HINSTANCE], wintypes.BOOL),
            (user, 'CreateWindowExW', [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.HMENU,
                wintypes.HINSTANCE, ctypes.c_void_p], wintypes.HWND),
            (user, 'DefWindowProcW', [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM], result),
            (user, 'DestroyWindow', [wintypes.HWND], wintypes.BOOL),
            (user, 'PostQuitMessage', [ctypes.c_int], None),
            (user, 'ShowWindow', [wintypes.HWND, ctypes.c_int], wintypes.BOOL),
            (user, 'GetMessageW', [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT], ctypes.c_int),
            (user, 'TranslateMessage', [ctypes.POINTER(wintypes.MSG)], wintypes.BOOL),
            (user, 'DispatchMessageW', [ctypes.POINTER(wintypes.MSG)], result),
            (user, 'GetDC', [wintypes.HWND], wintypes.HDC),
            (user, 'ReleaseDC', [wintypes.HWND, wintypes.HDC], ctypes.c_int),
            (user, 'SystemParametersInfoW', [wintypes.UINT, wintypes.UINT, ctypes.c_void_p, wintypes.UINT], wintypes.BOOL),
            (gdi, 'CreateCompatibleDC', [wintypes.HDC], wintypes.HDC),
            (gdi, 'DeleteDC', [wintypes.HDC], wintypes.BOOL),
            (gdi, 'CreateDIBSection', [wintypes.HDC, ctypes.POINTER(BitmapInfo), wintypes.UINT,
                ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD], wintypes.HBITMAP),
            (gdi, 'SelectObject', [wintypes.HDC, wintypes.HANDLE], wintypes.HANDLE),
            (gdi, 'DeleteObject', [wintypes.HANDLE], wintypes.BOOL),
            (user, 'UpdateLayeredWindow', [wintypes.HWND, wintypes.HDC, ctypes.POINTER(wintypes.POINT),
                ctypes.POINTER(wintypes.SIZE), wintypes.HDC, ctypes.POINTER(wintypes.POINT),
                wintypes.COLORREF, ctypes.POINTER(Blend), wintypes.DWORD], wintypes.BOOL),
        ]
        for library, name, arguments, returns in signatures:
            function = getattr(library, name)
            function.argtypes, function.restype = arguments, returns
        instance = kernel.GetModuleHandleW(None)
        name = f'ClassifireStartup-{os.getpid()}-{id(self)}'
        registered = False
        screen = memory = bitmap = previous = None

        @callback
        def procedure(window, message, first, second):
            if message == 0x0010:
                with self._lock:
                    self._window = None
                user.DestroyWindow(window)
                return 0
            if message == 0x0002:
                with self._lock:
                    self._window = None
                user.PostQuitMessage(0)
                return 0
            if message == 0x0084:  # HTTRANSPARENT: artwork is never an input UI.
                return -1
            return user.DefWindowProcW(window, message, first, second)

        try:
            area = wintypes.RECT()
            if not user.SystemParametersInfoW(0x0030, 0, ctypes.byref(area), 0):
                raise ctypes.WinError(ctypes.get_last_error())
            available = (area.right - area.left, area.bottom - area.top)
            maximum = (max(1, min(850, int(available[0] * .8))), max(1, min(300, int(available[1] * .5))))
            (width, height), pixels = logo_pixels(self.logo, maximum)
            declaration = WindowClass(instance=instance, procedure=procedure, name=name)
            if not user.RegisterClassW(ctypes.byref(declaration)):
                raise ctypes.WinError(ctypes.get_last_error())
            registered = True
            self._window = user.CreateWindowExW(0x08080088, name, TITLE, 0x80000000,
                0, 0, width, height, None, None, instance, None)
            if not self._window:
                raise ctypes.WinError(ctypes.get_last_error())
            screen = user.GetDC(None)
            memory = gdi.CreateCompatibleDC(screen)
            info = BitmapInfo(size=ctypes.sizeof(BitmapInfo), width=width, height=-height, planes=1, bits=32)
            bits = ctypes.c_void_p()
            bitmap = gdi.CreateDIBSection(screen, ctypes.byref(info), 0, ctypes.byref(bits), None, 0)
            if not screen or not memory or not bitmap or not bits.value:
                raise ctypes.WinError(ctypes.get_last_error())
            previous = gdi.SelectObject(memory, bitmap)
            ctypes.memmove(bits, pixels, len(pixels))
            destination = wintypes.POINT(area.left + (available[0] - width) // 2, area.top + (available[1] - height) // 2)
            size, source, blend = wintypes.SIZE(width, height), wintypes.POINT(0, 0), Blend(0, 0, 255, 1)
            if not user.UpdateLayeredWindow(self._window, screen, ctypes.byref(destination), ctypes.byref(size),
                    memory, ctypes.byref(source), 0, ctypes.byref(blend), 2):
                raise ctypes.WinError(ctypes.get_last_error())
            if not self.hidden and not self._stop.is_set():
                user.ShowWindow(self._window, 4)  # Show without stealing focus.
            self._ready.set()
            if self._stop.is_set():
                user.DestroyWindow(self._window)
            else:
                message = wintypes.MSG()
                while True:
                    status = user.GetMessageW(ctypes.byref(message), None, 0, 0)
                    if status == 0:
                        break
                    if status == -1:
                        raise ctypes.WinError(ctypes.get_last_error())
                    user.TranslateMessage(ctypes.byref(message))
                    user.DispatchMessageW(ctypes.byref(message))
        except Exception as error:
            self._error = error
        finally:
            with self._lock:
                remaining = self._window
                self._window = None
            if remaining:
                user.DestroyWindow(remaining)
            if previous and memory:
                gdi.SelectObject(memory, previous)
            if bitmap:
                gdi.DeleteObject(bitmap)
            if memory:
                gdi.DeleteDC(memory)
            if screen:
                user.ReleaseDC(None, screen)
            if registered:
                user.UnregisterClassW(name, instance)
            self._ready.set()
