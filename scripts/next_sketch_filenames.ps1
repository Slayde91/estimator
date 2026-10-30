# Run once for each attachment batch. Only the quoted picker text is written to stdout.
[CmdletBinding()]
param(
    [string]$Source = 'C:\ESTIMATOR\app\.runtime\reference-library\images',
    [string]$StateDirectory = 'C:\ESTIMATOR\output\sketch-filename-batches',
    [string]$StartFrom,
    [switch]$Repeat,
    [switch]$Preview,
    [switch]$FullPaths,
    [switch]$NoClipboard
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Repeat -and $StartFrom) { throw '-Repeat and -StartFrom cannot be combined.' }
$sourcePath = (Get-Item -LiteralPath $Source).FullName
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { throw 'Source must be a folder.' }
[void](New-Item -ItemType Directory -Path $StateDirectory -Force)
$statePath = Join-Path $StateDirectory 'state.json'
$lock = $null
$temporaryPath = $null
try {
    # Prevent two launches from handing out the same next batch.
    $lock = [IO.File]::Open((Join-Path $StateDirectory 'batch.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    if ($StartFrom -or -not (Test-Path -LiteralPath $statePath)) {
        if ($Repeat) { throw 'No previous batch exists to repeat.' }
        $anchor = if ($StartFrom) { [IO.Path]::GetFileName($StartFrom) } else { 'fas190234-p57-t0-c17' }
        # Natural numeric order: page 59 before 100, component 9 before 10.
        $files = @(Get-ChildItem -LiteralPath $sourcePath -File |
            Where-Object { $_.Extension.ToLowerInvariant() -in @('.png', '.jpg', '.jpeg', '.webp') } |
            Sort-Object @{ Expression = {
                [regex]::Replace($_.Name.ToLowerInvariant(), '\d+', { param($m) $m.Value.PadLeft(20, '0') })
            } }, Name | ForEach-Object { $_.Name })
        $matches = @($files | Where-Object { $_ -ieq $anchor -or [IO.Path]::GetFileNameWithoutExtension($_) -ieq $anchor })
        if ($matches.Count -ne 1) { throw "Start filename must match exactly one existing image: $anchor" }
        $startIndex = [Array]::IndexOf($files, $matches[0])
        $files = @($files | Select-Object -Skip $startIndex)
        $state = [pscustomobject]@{
            version = 1
            source = $sourcePath
            files = $files
            nextIndex = 0
            lastStart = -1
        }
    } else {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    }
    $files = @($state.files)
    if ($state.version -ne 1 -or $state.source -ine $sourcePath -or
        $state.nextIndex -isnot [ValueType] -or $state.lastStart -isnot [ValueType] -or
        $state.nextIndex -lt 0 -or $state.nextIndex -gt $files.Count -or
        $state.lastStart -lt -1 -or $state.lastStart -ge $files.Count -or
        ($state.lastStart -ge 0 -and $state.nextIndex -ne [Math]::Min($state.lastStart + 10, $files.Count))) {
        throw 'Invalid state or different source folder. Use a separate -StateDirectory or explicit -StartFrom to restart.'
    }
    $index = if ($Repeat) { [int]$state.lastStart } else { [int]$state.nextIndex }
    if ($index -lt 0) { throw 'No previous batch exists to repeat.' }
    if ($index -ge $files.Count) {
        Write-Verbose 'All filenames have been handed out. No upload or generation completion is implied.'
        return
    }
    $batch = @($files | Select-Object -Skip $index -First 10)
    $paths = foreach ($name in $batch) {
        if ($name -isnot [string] -or [IO.Path]::GetFileName($name) -cne $name -or $name.Contains('"')) {
            throw 'Invalid filename in saved state.'
        }
        $path = Join-Path $sourcePath $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Source image missing; progress has not advanced: $path"
        }
        $path
    }
    $selected = if ($FullPaths) { @($paths) } else { $batch }
    $pickerText = ($selected | ForEach-Object { '"' + ($_ -replace '\.[^\\/.]+$', '') + '"' }) -join ' '
    if (-not $Preview) {
        # A clipboard failure must not silently consume a batch. -NoClipboard is for terminals/headless runs.
        if (-not $NoClipboard) { Set-Clipboard -Value $pickerText }
        $pickerText | Set-Content -LiteralPath (Join-Path $StateDirectory 'last-batch.txt') -Encoding UTF8
        if (-not $Repeat) {
            $state.lastStart = $index
            $state.nextIndex = [Math]::Min($index + 10, $files.Count)
            $temporaryPath = Join-Path $StateDirectory ('state-' + [Guid]::NewGuid().ToString('N') + '.tmp')
            $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
            if (Test-Path -LiteralPath $statePath) {
                [IO.File]::Replace($temporaryPath, $statePath, ($statePath + '.bak'))
            } else {
                [IO.File]::Move($temporaryPath, $statePath)
            }
        }
    }
    Write-Output $pickerText
} finally {
    if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) {
        Remove-Item -LiteralPath $temporaryPath
    }
    if ($lock) { $lock.Dispose() }
}
