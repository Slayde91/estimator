"""User-initiated native dialogs, isolated from the HTTP worker and test runner."""

import base64
from dataclasses import dataclass
import json
import os
import subprocess
import sys

from .catalog import ValidationError


@dataclass(frozen=True)
class SaveSelection:
    path: str
    # Snapshot taken immediately after native overwrite confirmation.
    fingerprint: dict | None


_WINDOWS_DIALOG = r'''
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
try {
    if ($request.kind -eq 'folder') {
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = 'Choose the folder containing your estimate project files'
        $dialog.ShowNewFolderButton = $true
        if ($request.directory) { $dialog.SelectedPath = $request.directory }
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            @{path=$dialog.SelectedPath} | ConvertTo-Json -Compress
        } else { 'null' }
    } else {
        $dialog = New-Object System.Windows.Forms.SaveFileDialog
        $dialog.Title = 'Save Project'
        $dialog.Filter = 'Ceasefire project (*.ceasefire-project.json)|*.ceasefire-project.json|JSON files (*.json)|*.json'
        $dialog.DefaultExt = 'ceasefire-project.json'
        $dialog.AddExtension = $true
        $dialog.CheckPathExists = $true
        $dialog.OverwritePrompt = $true
        $dialog.FileName = $request.filename
        if ($request.directory) { $dialog.InitialDirectory = $request.directory }
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            $path = $dialog.FileName
            $fingerprint = $null
            if ([System.IO.File]::Exists($path)) {
                $info = New-Object System.IO.FileInfo($path)
                if (($info.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked files cannot be overwritten.' }
                if ($info.Length -gt 16777216) { throw 'The existing file exceeds the 16 MB project limit.' }
                $stream = [System.IO.File]::OpenRead($path)
                $sha = [System.Security.Cryptography.SHA256]::Create()
                try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
                finally { $sha.Dispose(); $stream.Dispose() }
                $fingerprint = @{size=$info.Length; mtime_ns=($info.LastWriteTimeUtc.Ticks - 621355968000000000) * 100; sha256=$hash}
            }
            @{path=$path; fingerprint=$fingerprint} | ConvertTo-Json -Compress
        } else { 'null' }
    }
} finally {
    if ($dialog) { $dialog.Dispose() }
    $owner.Dispose()
}
'''


_TK_DIALOG = r'''
import hashlib, json, os, sys
from pathlib import Path
import tkinter as tk
from tkinter import filedialog
request = json.load(sys.stdin)
root = tk.Tk()
root.withdraw()
root.attributes('-topmost', True)
try:
    if request['kind'] == 'folder':
        path = filedialog.askdirectory(parent=root, title='Choose your estimates folder', initialdir=request.get('directory') or None)
        result = {'path': path} if path else None
    else:
        path = filedialog.asksaveasfilename(parent=root, title='Save Project', initialdir=request.get('directory') or None,
            initialfile=request['filename'], defaultextension='.ceasefire-project.json',
            filetypes=[('Ceasefire project', '*.ceasefire-project.json'), ('JSON files', '*.json')])
        result = None
        if path:
            fingerprint = None
            target = Path(path)
            if target.exists() or target.is_symlink():
                if target.is_symlink() or not target.is_file():
                    raise ValueError('Linked or nonregular files cannot be overwritten.')
                info = target.stat()
                if info.st_size > 16777216:
                    raise ValueError('The existing file exceeds the 16 MB project limit.')
                with target.open('rb') as stream:
                    payload = stream.read(16777217)
                if len(payload) > 16777216:
                    raise ValueError('The existing file exceeds the 16 MB project limit.')
                fingerprint = dict(size=info.st_size, mtime_ns=info.st_mtime_ns, sha256=hashlib.sha256(payload).hexdigest())
            result = dict(path=path, fingerprint=fingerprint)
    print(json.dumps(result))
finally:
    root.destroy()
'''


class NativeDialogs:
    """No shell interpolation: dialog configuration is passed as JSON on stdin."""

    def _run(self, request):
        if os.name == "nt":
            encoded = base64.b64encode(_WINDOWS_DIALOG.encode("utf-16-le")).decode("ascii")
            command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded]
            options = {"creationflags": subprocess.CREATE_NO_WINDOW}
        else:
            command = [sys.executable, "-c", _TK_DIALOG]
            options = {}
        try:
            completed = subprocess.run(command, input=json.dumps(request), capture_output=True,
                                       encoding="utf-8", timeout=600, check=True, **options)
            response = json.loads(completed.stdout.lstrip("\ufeff"))
        except (OSError, subprocess.SubprocessError, ValueError) as error:
            raise ValidationError("The native file dialog could not finish. Close any open dialog and try again on this computer.") from error
        if response is not None and (not isinstance(response, dict) or not isinstance(response.get("path"), str)):
            raise ValidationError("The native file dialog returned an invalid selection.")
        return response

    def choose_folder(self, initial_directory=None):
        response = self._run({"kind": "folder", "directory": initial_directory})
        return response["path"] if response else None

    def choose_save(self, initial_directory, filename):
        response = self._run({"kind": "save", "directory": initial_directory, "filename": filename})
        return SaveSelection(response["path"], response.get("fingerprint")) if response else None
