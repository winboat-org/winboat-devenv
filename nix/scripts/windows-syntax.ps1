param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$ProvisionLock)
$ErrorActionPreference = 'Stop'
$failed = $false
Get-ChildItem -LiteralPath $Directory -Filter '*.ps1' | ForEach-Object {
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
    } finally { Remove-Item -LiteralPath $fixture -Force }
}

$lock = Get-Content -Raw -LiteralPath $ProvisionLock | ConvertFrom-Json
foreach ($tool in $lock.tools) {
    if ($tool.status -ne 'locked') { continue }
    foreach ($field in @('install', 'probe')) {
        [void][ScriptBlock]::Create($tool.$field)
    }
    Write-Output "Parsed locked install/probe: $($tool.id)"
}
