param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$ProvisionLock)
$ErrorActionPreference = 'Stop'
$failed = $false
Get-ChildItem -LiteralPath $Directory -Filter '*.ps1' | ForEach-Object {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { $errors | Format-List; $failed = $true } else { Write-Host "Parsed $($_.Name)" }
}
if ($failed) { exit 1 }

$lock = Get-Content -Raw -LiteralPath $ProvisionLock | ConvertFrom-Json
foreach ($tool in $lock.tools) {
    if ($tool.status -ne 'locked') { continue }
    foreach ($field in @('install', 'probe')) {
        [void][ScriptBlock]::Create($tool.$field)
    }
    Write-Output "Parsed locked install/probe: $($tool.id)"
}
