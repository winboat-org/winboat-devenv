param([Parameter(Mandatory)][ValidatePattern('^op-[a-f0-9]{32}$')][string]$TransactionId)
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$transaction=Assert-ControlPath ('C:\ProgramData\WinBoatDev\transactions\' + $TransactionId) 'C:\ProgramData\WinBoatDev\transactions'
$statePath=Join-Path $transaction 'transaction.json'
$state=Get-Content -Raw $statePath | ConvertFrom-Json
if(-not $state.requestedManifest.PSObject.Properties['fixtureId']) {
    throw 'Helios rollback requires the original package and legacy restore protocol; retained snapshots alone cannot promise a complete prior stack'
}
foreach($prior in $state.prior) {
    [void](Assert-ControlPath $prior.path 'C:\WinBoatDev\fixtures')
    if($prior.existed) {
        $backup=Join-Path $transaction 'fixture.dll.prior'
        if((Get-FileHash $backup -Algorithm SHA256).Hash.ToLower() -ne $prior.sha256) {throw 'Prior fixture snapshot changed'}
        Copy-Item -LiteralPath $backup -Destination $prior.path -Force
    } elseif(Test-Path $prior.path) {Remove-Item -LiteralPath $prior.path}
}
$key='HKLM:\SOFTWARE\WinBoatDev\Fixtures\' + $state.requestedManifest.fixtureId
if($null -ne $state.priorRegistration) {Set-ItemProperty -LiteralPath $key -Name Path -Value $state.priorRegistration}
elseif($state.priorRegistrationKeyExisted) {Remove-ItemProperty -LiteralPath $key -Name Path -ErrorAction SilentlyContinue}
elseif(Test-Path $key) {Remove-Item -LiteralPath $key}
$state.state='rolled-back';$state.exitCode=0;$state.observed=[DateTime]::UtcNow.ToString('o')
Write-ControlJson $state $statePath
