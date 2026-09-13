param(
    [Parameter(Mandatory=$true)][string]$PlanPath,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$capturePlan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json -AsHashtable
$captureExcel = $null
$captureBook = $null
$captureErrors = @{
    '-2146826281'='#DIV/0!'; '-2146826246'='#N/A'; '-2146826259'='#NAME?';
    '-2146826288'='#NULL!'; '-2146826252'='#NUM!'; '-2146826265'='#REF!';
    '-2146826273'='#VALUE!'
}
[void][IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($OutputDirectory))
try {
    # Own instance and disposable local copies; never attach to a user's Excel.
    $captureExcel = New-Object -ComObject Excel.Application
    $captureExcel.Visible = $false
    $captureExcel.DisplayAlerts = $false
    $captureExcel.EnableEvents = $false
    $captureExcel.ScreenUpdating = $false
    $captureExcel.AskToUpdateLinks = $false
    $captureExcel.AutomationSecurity = 3
    foreach ($captureDefinition in $capturePlan.workbooks) {
        $captureBook = $captureExcel.Workbooks.Open($captureDefinition.copy_path, 0, $true)
        $captureExcel.Calculation = -4135
        $capturePrevious = @{}
        $capturePreviousBlocks = @()
        $captureResults = [System.Collections.Generic.List[object]]::new()
        foreach ($captureScenario in $captureDefinition.scenarios) {
            foreach ($captureBlock in $capturePreviousBlocks) {
                $captureBook.Worksheets.Item($captureBlock.sheet).Range($captureBlock.range).Value2 = $captureBlock.values
            }
            $capturePreviousBlocks = @()
            foreach ($captureSheet in $capturePrevious.Keys) {
                foreach ($captureAddress in $capturePrevious[$captureSheet].Keys) {
                    $captureBook.Worksheets.Item($captureSheet).Range($captureAddress).Formula2 = $capturePrevious[$captureSheet][$captureAddress]
                }
            }
            $capturePrevious = @{}
            foreach ($captureSheet in $captureScenario.inputs.Keys) {
                $capturePrevious[$captureSheet] = @{}
                foreach ($captureAddress in $captureScenario.inputs[$captureSheet].Keys) {
                    $captureRange = $captureBook.Worksheets.Item($captureSheet).Range($captureAddress)
                    $capturePrevious[$captureSheet][$captureAddress] = $captureRange.Formula2
                    $captureValue = $captureScenario.inputs[$captureSheet][$captureAddress]
                    if ($null -eq $captureValue) {
                        if ($captureRange.MergeCells) { $captureRange.MergeArea.ClearContents() }
                        else { $captureRange.ClearContents() }
                    }
                    elseif ($captureValue -is [bool]) { $captureRange.Value2 = $captureValue }
                    elseif ($captureValue -is [string]) { $captureRange.Value2 = $captureValue }
                    else { $captureRange.Value2 = [double]$captureValue }
                }
            }
            foreach ($captureBlock in $captureScenario.input_blocks) {
                $captureRange = $captureBook.Worksheets.Item($captureBlock.sheet).Range($captureBlock.range)
                # Bulk blocks contain only schedule inputs, never formulas.
                $capturePreviousBlocks += @{sheet=$captureBlock.sheet;range=$captureBlock.range;values=$captureRange.Value2}
                $captureMatrix = New-Object 'object[,]' $captureBlock.values.Count, $captureBlock.values[0].Count
                for ($captureR=0; $captureR -lt $captureBlock.values.Count; $captureR++) {
                    for ($captureC=0; $captureC -lt $captureBlock.values[0].Count; $captureC++) {
                        $captureMatrixValue = $captureBlock.values[$captureR][$captureC]
                        if ($captureMatrixValue -is [long] -or $captureMatrixValue -is [int] -or $captureMatrixValue -is [decimal]) { $captureMatrixValue = [double]$captureMatrixValue }
                        $captureMatrix[$captureR,$captureC] = $captureMatrixValue
                    }
                }
                $captureRange.Value2 = $captureMatrix
            }
            foreach ($captureSheet in $captureScenario.formula_overrides.Keys) {
                if (-not $capturePrevious.ContainsKey($captureSheet)) { $capturePrevious[$captureSheet] = @{} }
                foreach ($captureAddress in $captureScenario.formula_overrides[$captureSheet].Keys) {
                    $captureRange = $captureBook.Worksheets.Item($captureSheet).Range($captureAddress)
                    if (-not $capturePrevious[$captureSheet].ContainsKey($captureAddress)) { $capturePrevious[$captureSheet][$captureAddress] = $captureRange.Formula2 }
                    $captureRange.Formula2 = '=' + $captureScenario.formula_overrides[$captureSheet][$captureAddress]
                }
            }
            $captureExcel.CalculateFullRebuild()
            $captureExpected = @{}
            foreach ($captureSheet in $captureScenario.outputs.Keys) {
                $captureOutput = $captureScenario.outputs[$captureSheet]
                $captureValues = $captureBook.Worksheets.Item($captureSheet).Range($captureOutput.range).Value2
                $captureCells = @{}
                foreach ($captureCell in $captureOutput.cells) {
                    $captureValue = $captureValues[[int]$captureCell[0], [int]$captureCell[1]]
                    if ($captureValue -is [int] -and $captureErrors.ContainsKey([string]$captureValue)) { $captureValue = $captureErrors[[string]$captureValue] }
                    $captureCells[$captureCell[2]] = $captureValue
                }
                $captureExpected[$captureSheet] = $captureCells
            }
            $captureResults.Add(@{id=$captureScenario.id;inputs=$captureScenario.inputs;input_blocks=$captureScenario.input_blocks;coverage=$captureScenario.coverage;formula_overrides=$captureScenario.formula_overrides;expected=$captureExpected})
            Write-Output "$($captureDefinition.id): $($captureScenario.id) captured ($($captureResults.Count)/$($captureDefinition.scenarios.Count))."
        }
        $captureDocument = @{
            id=$captureDefinition.id;source_sha256=$captureDefinition.source_sha256;
            oracle=@{application='Microsoft Excel';version=$captureExcel.Version;build=$captureExcel.Build;mode='Original workbook disposable copy, links disabled, full rebuild, not saved';captured_utc=[DateTime]::UtcNow.ToString('o')};
            scenarios=$captureResults
        }
        $capturePath = Join-Path $OutputDirectory ($captureDefinition.id + '.json')
        $captureDocument | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $capturePath -Encoding utf8
        $captureBook.Close($false)
        $captureBook=$null
        Write-Output "Wrote $capturePath"
    }
} finally {
    if ($null -ne $captureBook) { $captureBook.Close($false) }
    if ($null -ne $captureExcel) {
        $captureExcel.Quit()
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($captureExcel)
    }
}
