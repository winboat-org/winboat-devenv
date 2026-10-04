. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$root=Join-Path ('C:\WinBoatDev\build\'+(Split-Path $env:WINBOAT_JOB_ROOT -Leaf)) 'inventory'
$transaction=Join-Path $root 'transaction'
New-Item -ItemType Directory -Path $transaction -Force | Out-Null
$present=Join-Path $root 'present.json';$absent=Join-Path $root 'absent.json'
[IO.File]::WriteAllText($present,'original inventory')
$statePath=Join-Path $transaction 'transaction.json'
$state=[pscustomobject]@{schemaVersion=1;state='preflight'}
Save-ControlPriorInventory $state $transaction $statePath @($present,$absent)
$state=Read-ControlJson $statePath
if($state.priorInventory.Count -ne 2 -or -not $state.priorInventory[0].existed -or $state.priorInventory[1].existed) {throw 'Original existence was not retained'}
[IO.File]::WriteAllText($present,'installed inventory')
[IO.File]::WriteAllText($absent,'created by first installation')
Save-ControlPriorInventory $state $transaction $statePath @($present,$absent)
$state=Read-ControlJson $statePath
if((Get-Content $state.priorInventory[0].backup -Raw) -ne 'original inventory' -or
    $state.priorInventory[1].existed -or (Test-Path $state.priorInventory[1].backup)) {throw 'Resume replaced the original restore point'}
[IO.File]::WriteAllText($state.priorInventory[0].backup,'corrupted backup')
$refused=$false
try {Save-ControlPriorInventory $state $transaction $statePath @($present,$absent)} catch {$refused=$true}
if(-not $refused) {throw 'Resume accepted a changed prior inventory'}
[IO.File]::WriteAllText($state.priorInventory[0].backup,'original inventory')
$pathsRefused=$false
try {Save-ControlPriorInventory $state $transaction $statePath @($present)} catch {$pathsRefused=$true}
if(-not $pathsRefused) {throw 'Resume accepted different inventory paths'}
$value=@{schemaVersion=1;state='passed';originalBytesRetained=$true;originalAbsenceRetained=$true;changedBackupRefused=$refused;changedPathsRefused=$pathsRefused}
Write-ControlJson $value (Join-Path $env:WINBOAT_JOB_ROOT 'prior-inventory-fixture.json')
$value | ConvertTo-Json -Compress
