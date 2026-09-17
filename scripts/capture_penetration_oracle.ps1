param(
    [Parameter(Mandatory=$true)][string]$SourcePath,
    [Parameter(Mandatory=$true)][string]$PlanPath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [Parameter(Mandatory=$true)][string]$WorkingDirectory
)
$ErrorActionPreference = 'Stop'
$captureSource = [IO.Path]::GetFullPath($SourcePath)
$captureDestination = [IO.Path]::GetFullPath($OutputPath)
$captureWork = [IO.Path]::GetFullPath($WorkingDirectory)
if ($captureDestination -eq $captureSource) { throw 'The oracle cannot overwrite its source workbook.' }
$capturePlan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json -AsHashtable
$captureSourceHash = (Get-FileHash -LiteralPath $captureSource -Algorithm SHA256).Hash.ToLowerInvariant()
if ($captureSourceHash -ne $capturePlan.source_sha256) { throw 'The source workbook hash does not match the capture plan.' }
[void][IO.Directory]::CreateDirectory($captureWork)
$captureHarness = Join-Path $captureWork ('Penetration-oracle-' + [guid]::NewGuid().ToString('N') + '.xlsx')
$captureNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
$captureFrozenAnchors = 0
$captureEmptyText = 0
$captureFormulaCells = @{}
$captureArchives = @()
$captureLookupMatrix = New-Object 'object[,]' 1000,45

function Get-ColumnNumber([string]$letters) {
    $number = 0
    foreach ($letter in $letters.ToCharArray()) { $number = $number * 26 + [int]$letter - [int][char]'A' + 1 }
    return $number
}

# Remove only LISTS editing protection in this disposable copy, so its cached
# lookups can be frozen in the unsaved native session. Keep financial XML exact.
try {
    $captureInputArchive = [IO.Compression.ZipFile]::OpenRead($captureSource)
    $captureArchives += $captureInputArchive
    $sharedStream = $captureInputArchive.GetEntry('xl/sharedStrings.xml').Open()
    try {
        $sharedXml = [xml]::new()
        $sharedXml.Load($sharedStream)
        $sharedNs = [Xml.XmlNamespaceManager]::new($sharedXml.NameTable)
        $sharedNs.AddNamespace('s', $captureNamespace)
        $sharedStrings = @($sharedXml.SelectNodes('//s:si', $sharedNs) | ForEach-Object {
            ($_.SelectNodes('.//s:t', $sharedNs) | ForEach-Object { $_.InnerText }) -join ''
        })
    } finally { $sharedStream.Dispose() }
    $captureOutputArchive = [IO.Compression.ZipFile]::Open($captureHarness, [IO.Compression.ZipArchiveMode]::Create)
    $captureArchives += $captureOutputArchive
    foreach ($entry in $captureInputArchive.Entries) {
        $created = $captureOutputArchive.CreateEntry($entry.FullName, [IO.Compression.CompressionLevel]::Optimal)
        $inputStream = $entry.Open()
        $outputStream = $created.Open()
        try {
            if ($entry.FullName -eq 'xl/worksheets/sheet1.xml') {
                $reader = [IO.StreamReader]::new($inputStream, [Text.Encoding]::UTF8)
                $originalText = $reader.ReadToEnd()
                $xml = [xml]$originalText
                $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
                $ns.AddNamespace('s', $captureNamespace)
                foreach ($cell in $xml.SelectNodes('//s:sheetData/s:row/s:c', $ns)) {
                    if ($cell.r -notmatch '^([A-Z]+)(\d+)$') { throw 'Invalid source lookup cell address.' }
                    $column = Get-ColumnNumber $Matches[1]
                    $row = [int]$Matches[2]
                    if ($column -gt 45) { continue }
                    if ($row -gt 1000) { throw 'Source lookup exceeds the approved A1:AS1000 region.' }
                    $formula = $cell.SelectSingleNode('s:f', $ns)
                    if ($null -ne $formula) {
                        $captureFrozenAnchors++
                    }
                    $cached = $cell.SelectSingleNode('s:v', $ns)
                    $cachedText = if ($null -ne $cached) { $cached.InnerText } else { '' }
                    $value = $null
                    if ($cell.GetAttribute('t') -eq 'str' -and ($null -eq $cached -or $cached.InnerText -eq '')) {
                        $captureEmptyText++
                        $value = '=""'
                    } elseif ($cell.GetAttribute('t') -eq 'str') {
                        $value = $cachedText
                    } elseif ($cell.GetAttribute('t') -eq 's') {
                        $value = $sharedStrings[[int]$cachedText]
                    } elseif ($cell.GetAttribute('t') -eq 'inlineStr') {
                        $value = ($cell.SelectNodes('.//s:t', $ns) | ForEach-Object { $_.InnerText }) -join ''
                    } elseif ($cell.GetAttribute('t') -eq 'b') {
                        $value = $cachedText -eq '1'
                    } elseif ($cell.GetAttribute('t') -eq 'e') {
                        throw 'The source lookup contains an Excel error.'
                    } elseif ($cachedText -ne '') {
                        $value = [double]::Parse($cachedText, [Globalization.CultureInfo]::InvariantCulture)
                    }
                    $captureLookupMatrix[($row-1),($column-1)] = $value
                }
                $unprotected = [regex]::Replace($originalText, '<sheetProtection\b[^>]*/>', '')
                $encoded = [Text.Encoding]::UTF8.GetBytes($unprotected)
                $outputStream.Write($encoded, 0, $encoded.Length)
            } else {
                $inputStream.CopyTo($outputStream)
            }
        } finally {
            $inputStream.Dispose()
            $outputStream.Dispose()
        }
    }
} finally {
    foreach ($archive in $captureArchives) { $archive.Dispose() }
}
if ($captureFrozenAnchors -ne 32) { throw "Expected 32 source LISTS lookup formulas; found $captureFrozenAnchors." }

# Verify the financial worksheet parts were copied byte for byte, and derive
# the expected addresses from the original XML rather than the app engine.
$captureOriginalZip = [IO.Compression.ZipFile]::OpenRead($captureSource)
$captureHarnessZip = [IO.Compression.ZipFile]::OpenRead($captureHarness)
try {
    foreach ($definition in @(@{name='CALC';part='xl/worksheets/sheet3.xml'}, @{name='BREAKDOWN';part='xl/worksheets/sheet4.xml'})) {
        $parts = @()
        foreach ($archive in @($captureOriginalZip, $captureHarnessZip)) {
            $stream = $archive.GetEntry($definition.part).Open()
            $memory = [IO.MemoryStream]::new()
            try { $stream.CopyTo($memory); $parts += ,$memory.ToArray() }
            finally { $stream.Dispose(); $memory.Dispose() }
        }
        if ([Convert]::ToBase64String($parts[0]) -ne [Convert]::ToBase64String($parts[1])) { throw 'Financial worksheet XML changed in the harness.' }
        $xml = [xml][Text.Encoding]::UTF8.GetString($parts[0])
        $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
        $ns.AddNamespace('s', $captureNamespace)
        $captureFormulaCells[$definition.name] = @($xml.SelectNodes('//s:c[s:f]', $ns) | ForEach-Object { $_.r })
    }
} finally {
    $captureOriginalZip.Dispose()
    $captureHarnessZip.Dispose()
}

$captureExcel = $null
$captureBook = $null
$captureWarmup = $null
$captureResults = [System.Collections.Generic.List[object]]::new()
$captureErrors = @{
    '-2146826281'='#DIV/0!'; '-2146826246'='#N/A'; '-2146826259'='#NAME?';
    '-2146826288'='#NULL!'; '-2146826252'='#NUM!'; '-2146826265'='#REF!'; '-2146826273'='#VALUE!'
}
try {
    # Own a new hidden instance. Never attach to or close the user's Excel.
    $captureExcel = New-Object -ComObject Excel.Application
    $captureExcel.Visible = $false
    $captureExcel.DisplayAlerts = $false
    $captureExcel.EnableEvents = $false
    $captureExcel.ScreenUpdating = $false
    $captureExcel.AskToUpdateLinks = $false
    $captureExcel.AutomationSecurity = 3
    $captureWarmup = $captureExcel.Workbooks.Add()
    $captureExcel.Calculation = -4135
    $captureBook = $captureExcel.Workbooks.Open($captureHarness, 0, $true)
    $captureWarmup.Close($false)
    $captureWarmup = $null
    $lookupRange = $captureBook.Worksheets.Item('LISTS').Range('A1:AS1000')
    $lookupRange.ClearContents()
    $lookupRange.Formula2 = $captureLookupMatrix
    $capturePrevious = @{}
    $captureExtended = $false
    $captureCalc = $captureBook.Worksheets.Item('CALC')
    foreach ($scenario in $capturePlan.scenarios) {
        if ($captureExtended) {
            $captureCalc.Range('B5:DS5').ClearContents()
            $captureExtended = $false
        }
        foreach ($sheet in $capturePrevious.Keys) {
            foreach ($address in $capturePrevious[$sheet].Keys) {
                $captureBook.Worksheets.Item($sheet).Range($address).Formula2 = $capturePrevious[$sheet][$address]
            }
        }
        $capturePrevious = @{}
        $rowCount = if ($scenario.ContainsKey('row_count')) { [int]$scenario.row_count } else { 1 }
        if ($rowCount -notin @(1, 2)) { throw 'This bounded oracle supports one or two item rows.' }
        if ($rowCount -eq 2) {
            $capturePrevious['CALC'] = @{}
            [void]$captureCalc.Range('B4:DS4').AutoFill($captureCalc.Range('B4:DS5'), 0)
            $captureExtended = $true
            foreach ($address in $captureFormulaCells['CALC']) {
                if ($address -notmatch '2$') { continue }
                $range = $captureCalc.Range($address)
                $capturePrevious['CALC'][$address] = $range.Formula2
                $range.Formula2 = [regex]::Replace($range.Formula2, '(?<=:)([A-Z]+)4\b', '${1}5')
            }
        }
        foreach ($sheet in $scenario.inputs.Keys) {
            if ($sheet -notin @('CALC', 'LISTS')) { throw 'Unexpected scenario input sheet.' }
            if (-not $capturePrevious.ContainsKey($sheet)) { $capturePrevious[$sheet] = @{} }
            foreach ($address in $scenario.inputs[$sheet].Keys) {
                if ($address -notmatch '^[A-Z]+[1-9]\d*$') { throw 'Invalid scenario input address.' }
                $sourceAddress = $address -replace '5$', '4'
                if ($sheet -eq 'CALC' -and ($sourceAddress -in $captureFormulaCells['CALC'] -or $sourceAddress -eq 'S4')) { throw 'Scenario cannot overwrite source financial formulas or the source image error.' }
                $range = $captureBook.Worksheets.Item($sheet).Range($address)
                if (-not $capturePrevious[$sheet].ContainsKey($address)) { $capturePrevious[$sheet][$address] = $range.Formula2 }
                $value = $scenario.inputs[$sheet][$address]
                if ($null -eq $value) { $range.ClearContents() }
                elseif ($value -is [string] -and $value -eq '') { $range.Formula2 = '=""' }
                elseif ($value -is [bool] -or $value -is [string]) { $range.Value2 = $value }
                else { $range.Value2 = [double]$value }
            }
        }
        $captureExcel.CalculateFullRebuild()
        $expected = [ordered]@{}
        foreach ($sheet in @('CALC', 'BREAKDOWN')) {
            $values = $captureBook.Worksheets.Item($sheet).Range($(if ($sheet -eq 'CALC') { 'A1:DS5' } else { 'A1:G4' })).Value2
            $addresses = @($captureFormulaCells[$sheet])
            if ($sheet -eq 'CALC' -and $rowCount -eq 2) { $addresses += @($addresses | Where-Object { $_ -match '4$' } | ForEach-Object { $_ -replace '4$', '5' }) }
            $cells = [ordered]@{}
            foreach ($address in $addresses) {
                if ($address -notmatch '^([A-Z]+)(\d+)$') { throw 'Invalid output address.' }
                $value = $values[[int]$Matches[2], (Get-ColumnNumber $Matches[1])]
                if ($value -is [int] -and $captureErrors.ContainsKey([string]$value)) { $value = $captureErrors[[string]$value] }
                $cells[$address] = $value
            }
            $expected[$sheet] = $cells
        }
        $captured = [ordered]@{}
        foreach ($key in $scenario.Keys) { $captured[$key] = $scenario[$key] }
        $captured['expected'] = $expected
        $captureResults.Add($captured)
        Write-Output "Captured $($scenario.id) ($($captureResults.Count)/$($capturePlan.scenarios.Count))."
    }
    $captureSourceAfter = (Get-FileHash -LiteralPath $captureSource -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($captureSourceAfter -ne $captureSourceHash) { throw 'Original source hash changed during capture.' }
    $document = [ordered]@{
        source_sha256=$captureSourceHash;
        oracle=[ordered]@{
            application='Microsoft Excel';version=$captureExcel.Version;build=$captureExcel.Build;
            mode='Original CALC/BREAKDOWN financial formulas; frozen cached LISTS in disposable read-only copy; explicit shared-pricing overrides; no external refresh or save';
            captured_utc=[DateTime]::UtcNow.ToString('o');frozen_lookup_anchors=$captureFrozenAnchors;
            preserved_empty_text_cells=$captureEmptyText;financial_xml_identical=$true;
            source_sha256_after=$captureSourceAfter;
            lookup_cache='Independently decoded original sharedStrings and LISTS cell caches, then frozen before first native recalculation';
            harness_change='Only LISTS editing protection removed in disposable copy; native changes never saved';
            excluded_source_errors=@(@{sheet='CALC';cell='S4';value='#VALUE!';reason='Pre-existing image cell; not a financial formula'});
            multi_item_extension='Copy original row4 formulas to row5 and extend only aggregate SUM range endpoints'
        };
        scenarios=$captureResults
    }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($captureDestination))
    $document | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $captureDestination -Encoding utf8
    Write-Output "Saved $($captureResults.Count) independent Excel scenarios."
} finally {
    if ($null -ne $captureBook) { $captureBook.Close($false) }
    if ($null -ne $captureWarmup) { $captureWarmup.Close($false) }
    if ($null -ne $captureExcel) {
        $captureExcel.Quit()
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($captureExcel)
    }
    if ((Get-FileHash -LiteralPath $captureSource -Algorithm SHA256).Hash.ToLowerInvariant() -ne $captureSourceHash) {
        throw 'Original source hash changed during capture.'
    }
}
