# Repository and machine launchers dot-source these read-only loopback probes.
function Test-LocalEstimatorPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    $connection = $null
    try {
        $connection = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $connection.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($connection)
        return $true
    }
    catch { return $false }
    finally {
        if ($null -ne $connection) { $connection.AsyncWaitHandle.Dispose() }
        $client.Dispose()
    }
}

function Get-LocalEstimatorEndpoint([int]$Port, [string[]]$ExpectedPolicy) {
    if (-not (Test-LocalEstimatorPort $Port)) { return 'unavailable' }
    foreach ($route in '/api/access/session', '/api/bootstrap') {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port$route" -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 2 -ErrorAction Stop
        }
        catch {
            $failure = $_.Exception
            if ($route -eq '/api/access/session' -and $failure.PSObject.Properties['Response'] -and
                $null -ne $failure.Response -and [int]$failure.Response.StatusCode -in 404, 405) {
                # Older installations have no public session endpoint.
                continue
            }
            return 'other'
        }
        if ($response.StatusCode -ne 200 -or -not ([string]$response.Headers['Server']).StartsWith('CeasefireEstimator')) {
            return 'other'
        }
        try {
            $content = [string]$response.Content
            if (-not $content.TrimStart().StartsWith('{')) { return 'other' }
            $payload = ConvertFrom-Json -InputObject $content -ErrorAction Stop
            $keys = @($payload.PSObject.Properties.Name)
            if ($route -eq '/api/access/session') {
                if ($keys.Count -ne 3 -or $keys -cnotcontains 'enabled' -or $keys -cnotcontains 'version' -or
                    $keys -cnotcontains 'user' -or $payload.enabled -isnot [bool] -or
                    ($payload.version -isnot [int] -and $payload.version -isnot [long]) -or
                    $payload.version -lt 1 -or $null -ne $payload.user) { return 'other' }
            }
            elseif ($keys -cnotcontains 'fields' -or $keys -cnotcontains 'catalog' -or
                    $keys -cnotcontains 'configuration' -or $keys -cnotcontains 'workflows') { return 'other' }
        }
        catch { return 'other' }
        if ($ExpectedPolicy -cnotcontains [string]$response.Headers['Content-Security-Policy']) { return 'policy-mismatch' }
        return 'estimator'
    }
    return 'other'
}
