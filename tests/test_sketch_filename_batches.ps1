# Standalone integration check: pwsh -File tests/test_sketch_filename_batches.ps1
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot '../scripts/next_sketch_filenames.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('sketch-batches-' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $fixture 'images with spaces'
$state = Join-Path $fixture 'state'
[void](New-Item -ItemType Directory -Path $source -Force)
function Assert-Equal($actual, $expected, $label) {
    if ($actual -cne $expected) { throw "$label failed: expected [$expected], received [$actual]" }
}
function Expected($numbers) {
    ($numbers | ForEach-Object { '"fas190234-p' + $_ + '-t0-c9"' }) -join ' '
}
function Run-Batch {
    & $script -Source $source -StateDirectory $state -NoClipboard @args
}
try {
    foreach ($number in @(1..25) + @(100)) {
        [IO.File]::WriteAllText((Join-Path $source "fas190234-p$number-t0-c9.png"), 'fixture')
    }
    [IO.File]::WriteAllText((Join-Path $source 'ignore.txt'), 'ignored')
    Assert-Equal (Run-Batch -StartFrom fas190234-p2-t0-c9 -Preview) (Expected (2..11)) 'numeric first batch'
    Assert-Equal (Test-Path (Join-Path $state 'state.json')) $false 'preview does not save progress'
    Assert-Equal (Run-Batch -StartFrom fas190234-p2-t0-c9) (Expected (2..11)) 'inclusive start'
    $before = Get-Content (Join-Path $state 'state.json') -Raw
    Assert-Equal (Run-Batch -Repeat) (Expected (2..11)) 'repeat'
    Assert-Equal (Get-Content (Join-Path $state 'state.json') -Raw) $before 'repeat preserves cursor'
    Assert-Equal (Run-Batch -Preview) (Expected (12..21)) 'preview next'
    Assert-Equal (Get-Content (Join-Path $state 'state.json') -Raw) $before 'preview preserves cursor'
    Remove-Item -LiteralPath (Join-Path $source 'fas190234-p2-t0-c9.png')
    Remove-Item -LiteralPath (Join-Path $source 'fas190234-p12-t0-c9.png')
    $failed = $false
    try { Run-Batch | Out-Null } catch { $failed = $_.Exception.Message -like '*Source image missing*' }
    Assert-Equal $failed $true 'missing upcoming file fails'
    Assert-Equal (Get-Content (Join-Path $state 'state.json') -Raw) $before 'failure preserves cursor'
    [IO.File]::WriteAllText((Join-Path $source 'fas190234-p12-t0-c9.png'), 'fixture')
    function Set-Clipboard { param($Value) throw 'Simulated clipboard failure' }
    $failed = $false
    try { & $script -Source $source -StateDirectory $state | Out-Null } catch {
        $failed = $_.Exception.Message -eq 'Simulated clipboard failure'
    }
    Assert-Equal $failed $true 'clipboard failure reported'
    Assert-Equal (Get-Content (Join-Path $state 'state.json') -Raw) $before 'clipboard failure preserves cursor'
    Remove-Item Function:\Set-Clipboard
    Assert-Equal (Run-Batch) (Expected (12..21)) 'removed processed file does not skip next'
    $expectedPaths = (22..25 + @(100) | ForEach-Object { '"' + (Join-Path $source "fas190234-p$($_)-t0-c9") + '"' }) -join ' '
    Assert-Equal (Run-Batch -FullPaths) $expectedPaths 'final partial batch and paths with spaces'
    Assert-Equal (Run-Batch) $null 'exhaustion'
    Assert-Equal (Run-Batch -Repeat) (Expected (22..25 + @(100))) 'repeat after exhaustion'
    $failed = $false
    try { Run-Batch -StartFrom nonexistent | Out-Null } catch { $failed = $true }
    Assert-Equal $failed $true 'invalid anchor fails'
    Assert-Equal (Run-Batch) $null 'invalid anchor leaves exhausted state intact'
    $heldLock = [IO.File]::Open((Join-Path $state 'batch.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $failed = $false
    try { Run-Batch | Out-Null } catch { $failed = $true } finally { $heldLock.Dispose() }
    Assert-Equal $failed $true 'concurrent launch rejected'
    Assert-Equal (Run-Batch -StartFrom (Join-Path $source 'fas190234-p12-t0-c9.png')) (Expected (12..21)) 'restart with full path'
    Write-Output 'PASS: numeric order, inclusive start, persistence, repeat, preview, missing files, clipboard failure, partial batch, full paths, exhaustion, invalid anchor, lock, restart.'
} finally {
    if (Test-Path Function:\Set-Clipboard) { Remove-Item Function:\Set-Clipboard }
    # Only delete the verified unique fixture folder created by this test.
    $resolvedFixture = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedFixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path.' }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
