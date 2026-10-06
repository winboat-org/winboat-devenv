param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$ProvisionLock)
$ErrorActionPreference = 'Stop'
$failed = $false
Get-ChildItem -LiteralPath $Directory -Filter '*.ps1' -Recurse | ForEach-Object {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { $errors | Format-List; $failed = $true } else { Write-Host "Parsed $($_.Name)" }
}
if ($failed) { exit 1 }
if (Test-Path (Join-Path $Directory 'LoadedIdentity.cs')) {
    Add-Type -Path (Join-Path $Directory 'LoadedIdentity.cs')
    Write-Host 'Compiled mapped-image verifier'
}
if (Test-Path (Join-Path $Directory 'Control.ps1')) {
    . (Join-Path $Directory 'Control.ps1')
    $fixture = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N') + '.ps1')
    try {
        [IO.File]::WriteAllText($fixture, 'param([string]$Value,[int]$Seconds,[switch]$Flag) @{value=$Value;seconds=$Seconds;flag=$Flag.IsPresent}|ConvertTo-Json -Compress')
        $value = "literal ' quotes & `$dollar`nsecond line"
        $actual = Invoke-ControlPayload $fixture @('-Value',$value,'-Seconds','480','-Flag') | ConvertFrom-Json
        if ($actual.value -cne $value -or $actual.seconds -ne 480 -or -not $actual.flag) { throw 'Encoded payload argument binding changed data' }
        Write-Host 'Verified literal script argument binding'
        Write-ControlJson @() $fixture
        if (([IO.File]::ReadAllText($fixture)).Trim() -ne '[]') { throw 'Empty JSON array lost its shape' }
        Write-ControlJson @(@{path='one'}) $fixture
        if (([IO.File]::ReadAllText($fixture)).TrimStart()[0] -ne '[') { throw 'Single JSON array lost its shape' }
        Write-Host 'Verified empty and single-element JSON arrays'
    } finally { Remove-Item -LiteralPath $fixture -Force }
}

if(Test-Path (Join-Path $Directory 'RegistryProjection.ps1')) {
    . (Join-Path $Directory 'RegistryProjection.ps1')
    $large='evidence' * 300000
    $provenance=@{operationId='operation';manifestSha256='hash';sources=@{helios='commit'};artifacts=$large}
    $row=Get-RegistryProvenanceSummary $provenance
    $serialized=$row | ConvertTo-Json -Depth 10 -Compress
    if($serialized.Length -gt 1000 -or $row.sources.helios -ne 'commit' -or $provenance.artifacts.Length -ne $large.Length) {throw 'Inventory provenance repeated or changed artifact evidence'}
    $transaction=[pscustomobject]@{operationId='operation';state='installed';receipt=@{path='receipt';sha256='hash';size=100};changed=@();previousRegistry=$large;requestedManifest=[pscustomobject]@{packageId='package';source=@{helios='commit'};files=$large}}
    $summary=Get-RegistryTransactionSummary $transaction
    if(($summary | ConvertTo-Json -Depth 10 -Compress).Length -gt 1000 -or $summary.requestedManifest.packageId -ne 'package' -or $summary.receipt.sha256 -ne 'hash') {throw 'Inventory transaction lost identity or repeated rollback evidence'}
    Write-Host 'Verified compact inventory provenance and retained transaction evidence'
}
$lock = Get-Content -Raw -LiteralPath $ProvisionLock | ConvertFrom-Json
foreach ($tool in $lock.tools) {
    if ($tool.status -ne 'locked') { continue }
    foreach ($field in @('install', 'probe')) {
        [void][ScriptBlock]::Create($tool.$field)
    }
    Write-Output "Parsed locked install/probe: $($tool.id)"
}
