; Compiler inputs are supplied by scripts/build_windows.py; no private paths here.
#ifndef BundleDir
  #error BundleDir is required
#endif
#ifndef WebViewInstaller
  #error The verified Microsoft offline WebView2 installer is required
#endif
#ifndef WebViewArm64Installer
  #error The verified Microsoft offline ARM64 WebView2 installer is required
#endif
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
[Setup]
AppId={{8D5B7B2D-0153-4C48-A140-CE479A972D19}
AppName=CEASEFIRE Estimator
AppVersion={#AppVersion}
AppPublisher=CEASEFIRE
DefaultDirName={localappdata}\Programs\CEASEFIRE Estimator
DefaultGroupName=CEASEFIRE
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputBaseFilename=CEASEFIRE-Estimator-{#AppVersion}-Setup-x64
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#SourceRoot}\static\ceasefire-app.ico
UninstallDisplayIcon={app}\CEASEFIRE Estimator.exe
CloseApplications=no
AppMutex=Local\CEASEFIRE.Estimator.Desktop.Running
SetupMutex=Local\CEASEFIRE.Estimator.Desktop.Setup
RestartApplications=no
AllowNoIcons=yes
DisableProgramGroupPage=yes
UninstallDisplayName=CEASEFIRE Estimator
VersionInfoDescription=CEASEFIRE Estimator Setup
VersionInfoProductName=CEASEFIRE Estimator
VersionInfoVersion={#AppVersion}

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#WebViewInstaller}"; DestName: "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Flags: dontcopy
Source: "{#WebViewArm64Installer}"; DestName: "MicrosoftEdgeWebView2RuntimeInstallerARM64.exe"; Flags: dontcopy

[Icons]
Name: "{group}\CEASEFIRE Estimator"; Filename: "{app}\CEASEFIRE Estimator.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\CEASEFIRE Estimator"; Filename: "{app}\CEASEFIRE Estimator.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Code]
var
  UninstallUpdateMutex: THandle;

function CreateUpdateMutex(Attributes: NativeUInt; InitialOwner: Integer; Name: String): THandle;
  external 'CreateMutexW@kernel32.dll stdcall';
function MutexLastError: LongWord;
  external 'GetLastError@kernel32.dll stdcall';

function ValidRuntimeVersion(Value: String; RequireSupported: Boolean): Boolean;
var
  Packed: Int64;
begin
  Result := StrToVersion(Value, Packed);
  if Result then begin
    if RequireSupported then
      Result := ComparePackedVersion(Packed, PackVersionComponents(105, 0, 0, 0)) >= 0
    else
      Result := ComparePackedVersion(Packed, PackVersionComponents(0, 0, 0, 0)) > 0;
  end;
end;

function WebView2Installed(RequireSupported: Boolean): Boolean;
var
  Version: String;
begin
  Result := (RegQueryStringValue(HKLM32,
    'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version)
    and ValidRuntimeVersion(Version, RequireSupported));
  if not Result then
    Result := RegQueryStringValue(HKCU,
      'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version)
      and ValidRuntimeVersion(Version, RequireSupported);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
  WindowsVersion: TWindowsVersion;
  RuntimeInstaller: String;
begin
  Result := '';
  GetWindowsVersionEx(WindowsVersion);
  if IsArm64 and (WindowsVersion.Major = 10) and (WindowsVersion.Build < 22000) then begin
    Result := 'Windows 11 or later is required to run this x64 application on ARM64.';
    Exit;
  end;
  if IsArm64 then
    RuntimeInstaller := 'MicrosoftEdgeWebView2RuntimeInstallerARM64.exe'
  else
    RuntimeInstaller := 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe';
  Log('Native WebView2 prerequisite: ' + RuntimeInstaller);
  if CheckForMutexes('Local\CEASEFIRE.Estimator.Desktop.Running') then begin
    Result := 'CEASEFIRE Estimator is open. Save your work and close it before installing or updating.';
    Exit;
  end;
  if not IsDotNetInstalled(net462, 0) then begin
    Result := 'Microsoft .NET Framework 4.6.2 or later is required. Install it before running this setup.';
    Exit;
  end;
  if not WebView2Installed(True) then begin
    ExtractTemporaryFile(RuntimeInstaller);
    if not Exec(ExpandConstant('{tmp}\') + RuntimeInstaller,
        '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then begin
      Result := 'Microsoft WebView2 could not be installed. No application files have been changed.';
      Exit;
    end;
    if (ExitCode <> 0) and (ExitCode <> 3010) then begin
      Result := 'Microsoft WebView2 installation failed (code ' + IntToStr(ExitCode) + ').';
      Exit;
    end;
    NeedsRestart := ExitCode = 3010;
    if not WebView2Installed(True) then
      Result := 'Microsoft WebView2 is still unavailable. Restart Windows if requested, then run setup again.';
  end else
    Log('Supported WebView2 runtime already installed; no prerequisite installer executed.');
end;

function InitializeUninstall: Boolean;
begin
  UninstallUpdateMutex := CreateUpdateMutex(0, 0, 'Local\CEASEFIRE.Estimator.Desktop.Setup');
  Result := (UninstallUpdateMutex <> 0) and (MutexLastError <> 183);
  if not Result then begin
    MsgBox('CEASEFIRE Estimator setup or uninstall is already running. Wait for it to finish.', mbError, MB_OK);
    Exit;
  end;
  Result := not CheckForMutexes('Local\CEASEFIRE.Estimator.Desktop.Running');
  if not Result then
    MsgBox('CEASEFIRE Estimator is open. Save your work and close it before uninstalling.', mbError, MB_OK);
end;

// No UninstallDelete entries: user pricing, libraries, projects and WebView2 survive uninstall.
