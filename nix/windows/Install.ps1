param([Parameter(Mandatory)][string]$Specification)
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$spec = Get-Content -Raw -LiteralPath $Specification | ConvertFrom-Json
$transaction = Assert-ControlPath ('C:\ProgramData\WinBoatDev\transactions\' + $spec.operationId) 'C:\ProgramData\WinBoatDev\transactions'
$statePath = Join-Path $transaction 'transaction.json'
$bundle = Join-Path $transaction 'bundle'
$state = if(Test-Path $statePath) {Read-ControlJson $statePath} else {
    [pscustomobject]@{schemaVersion=1;operationId=$spec.operationId;manifestSha256=$spec.manifestSha256;state='preflight';exitCode=0;changed=@();prior=@();observed=[DateTime]::UtcNow.ToString('o')}
}
if($state.manifestSha256 -ne $spec.manifestSha256) {throw 'Resume manifest differs from the original transaction'}
New-Item -ItemType Directory -Path $transaction -Force | Out-Null
Write-ControlJson $state $statePath
try {
    Assert-ControlFile $spec.archive $spec.archiveSha256 $spec.archiveSize
    # Before any installation side effect preserve actual inventory and legacy
    # rollback snapshots. Resume never replaces the original restore point.
    foreach($path in @('C:\ProgramData\WinBoatDev\stack-registry.json','C:\ProgramData\Helios\install-state.json')) {
        $backup=Join-Path $transaction ([IO.Path]::GetFileName($path)+'.prior')
        if((Test-Path $path) -and -not (Test-Path $backup)) {Copy-Item -LiteralPath $path -Destination $backup}
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if(-not (Test-Path $bundle)) {[IO.Compression.ZipFile]::ExtractToDirectory($spec.archive,$bundle)}
    $manifestPath=Join-Path $bundle 'manifest.json'
    if((Get-FileHash $manifestPath -Algorithm SHA256).Hash.ToLower() -ne $spec.manifestSha256) {throw 'Staged manifest hash mismatch'}
    $manifest=Get-Content -Raw $manifestPath | ConvertFrom-Json
    $state | Add-Member -Force NoteProperty requestedManifest $manifest
    foreach($file in $manifest.files) {
        $path=Assert-ControlPath (Join-Path $bundle $file.path) $bundle
        Assert-ControlFile $path $file.sha256 $file.size
    }
    $state.state='staged';Write-ControlJson $state $statePath
    if($spec.kind -eq 'fixture') {
        $destination=Assert-ControlPath ('C:\WinBoatDev\fixtures\' + $manifest.fixtureId + '\fixture.dll') 'C:\WinBoatDev\fixtures'
        $file=@($manifest.files | Where-Object path -eq 'fixture.dll')
        if($file.Count -ne 1) {throw 'Fixture requires exactly one manifested fixture.dll'}
        $backup=Join-Path $transaction 'fixture.dll.prior'
        if(-not @($state.prior).Count) {
            if(Test-Path $destination) {Copy-Item $destination $backup; $state.prior=@(@{path=$destination;existed=$true;sha256=(Get-FileHash $backup -Algorithm SHA256).Hash.ToLower()})}
            else {$state.prior=@(@{path=$destination;existed=$false;sha256=$null})}
            $key='HKLM:\SOFTWARE\WinBoatDev\Fixtures\' + $manifest.fixtureId
            $state | Add-Member -Force NoteProperty priorRegistrationKeyExisted (Test-Path $key)
            $previous=if(Test-Path $key) {(Get-Item $key).GetValue('Path',$null)} else {$null}
            $state | Add-Member -Force NoteProperty priorRegistration $previous
            Write-ControlJson $state $statePath
        }
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $bundle 'fixture.dll') -Destination $destination -Force
        $state.changed=@(@{path=$destination;sha256=$file[0].sha256;size=$file[0].size});$state.state='partial';Write-ControlJson $state $statePath
        $failureMarker=Join-Path $transaction 'failure-injected'
        if($spec.failureAfterCopy -and -not (Test-Path $failureMarker)) {
            [IO.File]::WriteAllText($failureMarker,'after-copy')
            throw 'Injected fixture install failure after file copy'
        }
        $key='HKLM:\SOFTWARE\WinBoatDev\Fixtures\' + $manifest.fixtureId
        New-Item -Path $key -Force | Out-Null
        Set-ItemProperty -LiteralPath $key -Name Path -Value $destination
        $state | Add-Member -Force NoteProperty expectedRegistration @{key=$key;name='Path';value=$destination}
        Assert-ControlFile $destination $file[0].sha256 $file[0].size
        if($manifest.PSObject.Properties['rebootRequired'] -and $manifest.rebootRequired) {
            $currentBoot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
            if(-not $state.PSObject.Properties['requiredBootChange']) {$state | Add-Member NoteProperty requiredBootChange $currentBoot}
            if($state.requiredBootChange -eq $currentBoot) {$state.state='reboot-required';$state.exitCode=3010;Write-ControlJson $state $statePath;exit 3010}
        }
        $state.state='installed';$state.exitCode=0
    } elseif($spec.kind -eq 'helios') {
        if($manifest.architecture -ne 'x64' -or @($manifest.applicationArchitectures).Count -ne 2 -or $manifest.signing.mode -ne 'test') {throw 'Package architecture/signing contract differs from the selected devbox'}
        $provision=Get-Content -Raw 'C:\ProgramData\WinBoatDev\provisioning.json' | ConvertFrom-Json
        if($provision.phase -ne 'verified' -or -not $provision.signedDriverLoaded) {throw 'Verified signing/toolchain baseline required'}
        # Invoke the exact manifested legacy package script through this shared
        # operation, preserving its SYSTEM task, rollback snapshots and 3010
        # status contract. No root CI compiler or second MCP binary is used.
        $installer=Join-Path $bundle 'payload\Install-Helios.ps1'
        $state.state='installing';Write-ControlJson $state $statePath
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer -Automatic -ReplaceViogpudo
        $state.exitCode=$LASTEXITCODE
        $state.state=if($LASTEXITCODE -in @(3010,1641)) {'reboot-required'} elseif($LASTEXITCODE) {'partial'} else {'installed'}
        Write-ControlJson $state $statePath
        if($state.exitCode) {exit $state.exitCode}
    } else {throw 'Unsupported installation kind'}
    Write-ControlJson $state $statePath
    Write-ControlJson $state (Join-Path $env:WINBOAT_JOB_ROOT 'install-result.json')
} catch {
    $state.state='partial';$state.exitCode=1
    $state | Add-Member -Force NoteProperty error $_.ToString()
    Write-ControlJson $state $statePath
    throw
}
