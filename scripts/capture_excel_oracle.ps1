param(
    [Parameter(Mandatory = $true)][string]$PlanPath,
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$oraclePlan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json -AsHashtable
$oracleExcel = $null
$oracleBook = $null
$oracleResults = [System.Collections.Generic.List[object]]::new()
$oracleErrors = @{
    '-2146826281' = '#DIV/0!'; '-2146826246' = '#N/A'; '-2146826259' = '#NAME?'
    '-2146826288' = '#NULL!'; '-2146826252' = '#NUM!'; '-2146826265' = '#REF!'
    '-2146826273' = '#VALUE!'
}
try {
    # Create our own instance. Do not attach to or close a user's Excel session.
    $oracleExcel = New-Object -ComObject Excel.Application
    $oracleExcel.Visible = $false
    $oracleExcel.DisplayAlerts = $false
    $oracleExcel.EnableEvents = $false
    $oracleExcel.AskToUpdateLinks = $false
    $oracleExcel.AutomationSecurity = 3
    $oracleBook = $oracleExcel.Workbooks.Open($oraclePlan.harnessPath, 0, $true)
    $oracleExcel.Calculation = -4135
    $oracleCalc = $oracleBook.Worksheets.Item('Calculator')
    $oracleLists = $oracleBook.Worksheets.Item('Lists')
    $oraclePreviousOverrides = @{}
    foreach ($oracleScenario in $oraclePlan.scenarios) {
        foreach ($oracleCell in $oraclePreviousOverrides.Keys) {
            $oracleLists.Range($oracleCell).Formula2 = $oraclePreviousOverrides[$oracleCell]
        }
        $oraclePreviousOverrides = @{}
        foreach ($oracleCell in $oracleScenario.inputs.Keys) {
            $oracleValue = $oracleScenario.inputs[$oracleCell]
            if ($null -eq $oracleValue) {
                $oracleCalc.Range($oracleCell).ClearContents()
            } elseif ($oracleValue -is [string]) {
                $oracleCalc.Range($oracleCell).Value2 = $oracleValue
            } else {
                $oracleCalc.Range($oracleCell).Value2 = [double]$oracleValue
            }
        }
        foreach ($oracleCell in $oracleScenario.lookupOverrides.Keys) {
            $oraclePreviousOverrides[$oracleCell] = $oracleLists.Range($oracleCell).Formula2
            $oracleValue = $oracleScenario.lookupOverrides[$oracleCell]
            if ($null -eq $oracleValue) {
                $oracleLists.Range($oracleCell).ClearContents()
            } elseif ($oracleValue -is [string] -and $oracleValue -eq '') {
                $oracleLists.Range($oracleCell).Formula2 = '=""'
            } else {
                $oracleLists.Range($oracleCell).Value2 = [double]$oracleValue
            }
        }
        $oracleExcel.CalculateFullRebuild()
        $oracleValues = $oracleCalc.Range('A1:F120').Value2
        $oracleExpected = [ordered]@{}
        foreach ($oracleCell in $oraclePlan.expectedCells) {
            if ($oracleCell -notmatch '^([A-F])(\d+)$') { throw "Unexpected formula cell: $oracleCell" }
            $oracleColumn = [int][char]$Matches[1] - [int][char]'A' + 1
            $oracleRow = [int]$Matches[2]
            $oracleValue = $oracleValues[$oracleRow, $oracleColumn]
            if ($oracleValue -is [int] -and $oracleErrors.ContainsKey([string]$oracleValue)) {
                $oracleValue = $oracleErrors[[string]$oracleValue]
            }
            $oracleExpected[$oracleCell] = $oracleValue
        }
        $oracleResults.Add([ordered]@{
            id = $oracleScenario.id
            inputs = $oracleScenario.inputs
            lookupOverrides = $oracleScenario.lookupOverrides
            expected = $oracleExpected
        })
        if (($oracleResults.Count % 25) -eq 0) { Write-Host "Captured $($oracleResults.Count)/$($oraclePlan.scenarios.Count) Excel scenarios." }
    }
    $oracleDocument = [ordered]@{
        source = $oraclePlan.source
        sourceSha256 = $oraclePlan.sourceSha256
        oracle = [ordered]@{
            application = 'Microsoft Excel'
            version = $oracleExcel.Version
            build = $oracleExcel.Build
            mode = $oraclePlan.oracleMode
            capturedUtc = [DateTime]::UtcNow.ToString('o')
        }
        defaultInputs = $oraclePlan.defaultInputs
        scenarios = $oracleResults
    }
    $oracleDestination = [IO.Path]::GetFullPath($OutputPath)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($oracleDestination)) | Out-Null
    $oracleDocument | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $oracleDestination -Encoding utf8
    Write-Host "Saved $($oracleResults.Count) Excel scenarios to $oracleDestination"
} finally {
    if ($null -ne $oracleBook) { $oracleBook.Close($false) }
    if ($null -ne $oracleExcel) {
        $oracleExcel.Quit()
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($oracleExcel)
    }
}
