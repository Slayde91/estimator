[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8765,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$applicationRoot = $PSScriptRoot
$applicationUrl = "http://127.0.0.1:$Port"
$packagePins = @(Get-Content -LiteralPath (Join-Path $applicationRoot 'requirements.txt') | Select-String -Pattern '^([A-Za-z0-9_.-]+)==([0-9][A-Za-z0-9.+-]*)\s*$')
if ($packagePins.Count -eq 0) {
    [Console]::Error.WriteLine('Cannot determine the required packages from requirements.txt.')
    exit 1
}
$requiredPackages = ($packagePins | ForEach-Object { $_.Matches[0].Value.Trim() }) -join ','

function Get-EndpointState {
    # Check TCP first so a different service cannot be mistaken for a free port.
    $client = New-Object System.Net.Sockets.TcpClient
    $connection = $null
    try {
        $connection = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $connection.AsyncWaitHandle.WaitOne(500)) { return 'unavailable' }
        $client.EndConnect($connection)
    }
    catch { return 'unavailable' }
    finally {
        if ($null -ne $connection) { $connection.AsyncWaitHandle.Dispose() }
        $client.Dispose()
    }

    try {
        $response = Invoke-WebRequest -Uri "$applicationUrl/api/bootstrap" -UseBasicParsing -TimeoutSec 2
        $serverName = [string]$response.Headers['Server']
        $payload = $response.Content | ConvertFrom-Json
        $keys = @($payload.PSObject.Properties.Name)
        if ($serverName.StartsWith('CeasefireEstimator') -and
            $keys -contains 'fields' -and $keys -contains 'catalog' -and
            $keys -contains 'configuration' -and $keys -contains 'workflows') {
            return 'estimator'
        }
    }
    catch { }
    return 'other'
}

function Test-PythonRuntime {
    param([string]$Executable, [string[]]$PrefixArguments = @())
    if (-not $Executable -or $Executable -match '[\\/]WindowsApps[\\/]') { return $null }
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $null }
    try {
        $probe = 'import sys; from importlib.metadata import version; import reportlab, openpyxl; assert sys.version_info >= (3, 11); assert all(version(name)==pin for name,pin in (entry.split(''=='') for entry in sys.argv[1].split('',''))); print(sys.executable)'
        $arguments = @($PrefixArguments) + @('-c', $probe, $requiredPackages)
        $output = @(& $Executable @arguments 2>$null)
        if ($LASTEXITCODE -eq 0 -and $output.Count -gt 0) {
            $resolved = [string]$output[-1]
            if (Test-Path -LiteralPath $resolved -PathType Leaf) { return $resolved }
        }
    }
    catch { }
    return $null
}

function Find-PythonRuntime {
    # Prefer an installed Python with the required packages before the optional
    # runtime already supplied by Codex on this computer. Never install packages.
    foreach ($command in @(Get-Command python.exe, python3.exe -All -ErrorAction SilentlyContinue)) {
        $runtime = Test-PythonRuntime -Executable $command.Source
        if ($runtime) { return $runtime }
    }
    foreach ($command in @(Get-Command py.exe -All -ErrorAction SilentlyContinue)) {
        $runtime = Test-PythonRuntime -Executable $command.Source -PrefixArguments @('-3')
        if ($runtime) { return $runtime }
    }
    if ($env:LOCALAPPDATA) {
        $installRoot = Join-Path $env:LOCALAPPDATA 'Programs\Python'
        if (Test-Path -LiteralPath $installRoot -PathType Container) {
            foreach ($directory in @(Get-ChildItem -LiteralPath $installRoot -Directory | Sort-Object Name -Descending)) {
                $runtime = Test-PythonRuntime -Executable (Join-Path $directory.FullName 'python.exe')
                if ($runtime) { return $runtime }
            }
        }
    }
    if ($env:USERPROFILE) {
        $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
        $runtime = Test-PythonRuntime -Executable $bundled
        if ($runtime) { return $runtime }
    }
    throw "Python 3.11 or newer with the packages in requirements.txt is required. Install Python, then run this command in '$applicationRoot': python -m pip install -r requirements.txt"
}

try {
    $state = Get-EndpointState
    if ($state -eq 'other') {
        throw "Port $Port is already occupied by another service, or ESTIMATOR is not responding correctly. Nothing was stopped. Use Start-Estimator.cmd -Port 8766 to choose another port."
    }
    if ($state -eq 'unavailable') {
        $pythonRuntime = Find-PythonRuntime
        $runtimeDirectory = Join-Path $applicationRoot '.runtime'
        [void](New-Item -ItemType Directory -Path $runtimeDirectory -Force)
        $launchId = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        $stdoutPath = Join-Path $runtimeDirectory "startup-$launchId.stdout.log"
        $stderrPath = Join-Path $runtimeDirectory "startup-$launchId.stderr.log"
        $process = Start-Process -FilePath $pythonRuntime -ArgumentList @('-u', '-m', 'estimator', '--port', [string]$Port) -WorkingDirectory $applicationRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            if ($process.HasExited) {
                $details = (Get-Content -LiteralPath $stderrPath -Tail 12 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
                throw "ESTIMATOR exited during startup. Log: $stderrPath$([Environment]::NewLine)$details"
            }
            $state = Get-EndpointState
            if ($state -eq 'estimator') { break }
            if ($state -eq 'other') {
                throw "Port $Port responded unexpectedly during startup. Nothing was stopped. Check $stderrPath"
            }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($state -ne 'estimator') {
            throw "ESTIMATOR has not become ready. Check the startup log: $stderrPath"
        }
    }
    Write-Host "Ceasefire ESTIMATOR is ready: $applicationUrl"
    if (-not $NoBrowser) { Start-Process -FilePath $applicationUrl }
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
