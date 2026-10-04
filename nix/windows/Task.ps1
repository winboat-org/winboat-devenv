param([Parameter(Mandatory)][string]$JobRoot, [Parameter(Mandatory)][string]$RequestSha256)
. (Join-Path $PSScriptRoot 'Control.ps1') -JobRoot $JobRoot -RequestSha256 $RequestSha256
$receiptPath = Join-Path $JobRoot 'receipt.json'
$receipt = [ordered]@{schemaVersion=1;operationId=(Split-Path $JobRoot -Leaf);state='failed';exitCode=1;observed=[DateTime]::UtcNow.ToString('o')}
try {
    $request = Read-ControlRequest $JobRoot $RequestSha256
    $receipt.purpose = $request.purpose
    $receipt.guestIdentity = $request.guestIdentity
    $receipt.sessionId = (Get-Process -Id $PID).SessionId
    $receipt.principal = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $receipt.bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
    if ($request.purpose -eq 'desktop' -and ($receipt.sessionId -eq 0 -or $receipt.principal -ne "$env:COMPUTERNAME\wbdev")) {
        $receipt.exitCode = 87
        throw 'Refusing purpose=desktop outside the wbdev interactive session (session 0)'
    }
    if ($request.purpose -in @('build','install','system') -and [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-18') {
        $receipt.exitCode = 87
        throw 'Elevated work requires the durable SYSTEM principal'
    }
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine')
    $env:PATH = 'C:\WinBoatDev\tools\Git\cmd;' + (($env:PATH -split ';' | Where-Object { $_ -and $_ -notmatch '(?i)msys[^;]*[\\/]usr[\\/]bin' }) -join ';')
    $env:CARGO_TARGET_DIR = 'C:\WinBoatDev\build\cargo\' + $request.operationId
    $env:WINBOAT_JOB_ROOT = $JobRoot
    $env:WINBOAT_CONTROL_ROOT = $PSScriptRoot
    $env:WINBOAT_PURPOSE = $request.purpose
    $env:WINBOAT_REQUEST_SHA256 = $RequestSha256
    $receipt.state = 'running'; $receipt.exitCode = 0
    Write-ControlJson $receipt $receiptPath
    # Read and verify the retained JSON inside the child. Package manifests and
    # literal arguments can exceed the Windows command-line limit; only this
    # fixed launcher becomes code, regardless of the request's size/content.
    $call = '$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"; . (Join-Path $env:WINBOAT_CONTROL_ROOT "Control.ps1"); $global:LASTEXITCODE=0; try { $r=Read-ControlRequest $env:WINBOAT_JOB_ROOT $env:WINBOAT_REQUEST_SHA256; Invoke-ControlPayload $r.script @($r.arguments); $ok=$?; if($LASTEXITCODE) {exit $LASTEXITCODE}; if(-not $ok) {exit 1} } catch { [Console]::Error.WriteLine(($_ | Out-String) + $_.ScriptStackTrace); exit 1 }'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($call))
    $process = Start-Process (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded) -PassThru -RedirectStandardOutput (Join-Path $JobRoot 'stdout.log') -RedirectStandardError (Join-Path $JobRoot 'stderr.log')
    [void]$process.Handle
    $receipt.childProcessId = $process.Id
    $receipt.childStartTime = $process.StartTime.ToUniversalTime().ToString('o')
    Write-ControlJson $receipt $receiptPath
    $process.WaitForExit()
    $receipt.exitCode = $process.ExitCode
    $receipt.state = if ($process.ExitCode -eq 0) {'succeeded'} elseif ($process.ExitCode -in @(3010,1641)) {'reboot-required'} else {'failed'}
} catch {
    $receipt.state = 'failed'
    if ($receipt.exitCode -eq 0) { $receipt.exitCode = 1 }
    $receipt.error = $_.ToString()
    $receipt.errorTrace = $_.ScriptStackTrace
} finally {
    $receipt.observed = [DateTime]::UtcNow.ToString('o')
    Write-ControlJson $receipt $receiptPath
}
exit $receipt.exitCode
