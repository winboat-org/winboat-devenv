param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{0,31}$')][string]$Name,
    [Parameter(Mandatory)][string]$RelativePath,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$SnapshotSha256,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$DiffSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$share = 'Z:\'
$mirrorRoot = 'C:\WinBoatDev\src'
$buildRoot = 'C:\WinBoatDev\build'
# SYSTEM's DOS drive link may be visible after a reboot while its SMB credentials
# are absent in an SSH logon. Authenticate the UNC in the caller's session first.
if (-not (Get-SmbMapping -RemotePath '\\10.0.2.2\workspace' -ErrorAction SilentlyContinue)) {
    $password = (Get-Content -Raw -LiteralPath 'C:\ProgramData\WinBoatDev\share-password').Trim()
    New-SmbMapping -RemotePath '\\10.0.2.2\workspace' -UserName 'WORKGROUP\wbdev' -Password $password -Persistent $false | Out-Null
}
if (-not (Test-Path -LiteralPath $share -ErrorAction SilentlyContinue)) {
    New-SmbMapping -LocalPath 'Z:' -RemotePath '\\10.0.2.2\workspace' -Persistent $false | Out-Null
}
# Copy from the authenticated workspace UNC, never an unrelated caller's Z:.
$workspace = '\\10.0.2.2\workspace\'
if ([IO.Path]::IsPathRooted($RelativePath) -or (($RelativePath -split '[\\/]') -contains '..')) { throw 'Source must be relative to Z:\' }
$source = [IO.Path]::GetFullPath((Join-Path $workspace $RelativePath))
if (-not $source.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source escaped the workspace share' }
$destination = [IO.Path]::GetFullPath((Join-Path $mirrorRoot $Name))
if (-not $destination.StartsWith($mirrorRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or $destination -eq $buildRoot) { throw 'Unsafe mirror destination' }
foreach ($parent in @('C:\WinBoatDev', $mirrorRoot, $destination)) {
    if (Test-Path -LiteralPath $parent) {
        if ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point in destination: $parent" }
    }
}
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Source share path does not exist' }
New-Item -ItemType Directory -Path $destination, $buildRoot -Force | Out-Null
$marker = Join-Path $destination '.winboat-mirror.json'
if (Test-Path -LiteralPath $marker) {
    $previous = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
    if ($previous.schemaVersion -ne 1 -or $previous.name -ne $Name) { throw 'Destination marker does not match this mirror' }
} elseif (@(Get-ChildItem -LiteralPath $destination -Force).Count -ne 0) { throw 'Refusing /MIR into an existing unowned directory' }
$excluded = @('.git', '.state', '.devenv', '.direnv', '.codex', '.agents', '.aws', '.claude',
              'out', 'build', 'target', 'node_modules', (Join-Path $source 'docs\user'))
$excludeFiles = @('.env', '.env.*', 'local*.json', '*.key', '*.pfx', '*.p12', '*.iso', '*.qcow2', '*.vhd', '*.vhdx', '.winboat-mirror.json')
& robocopy.exe $source $destination /MIR /XJ /R:2 /W:2 /NP /XD $excluded /XF $excludeFiles
$copyCode = $LASTEXITCODE
if ($copyCode -ge 8) { throw "Robocopy failed with status $copyCode" }
$files = @(Get-ChildItem -LiteralPath $destination -Recurse -File -Force | Where-Object Name -ne '.winboat-mirror.json' | Sort-Object FullName | ForEach-Object {
    if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source mirror contains a reparse point' }
    $relative = $_.FullName.Substring($destination.Length + 1)
    $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()
    $original = Join-Path $source $relative
    if (-not (Test-Path -LiteralPath $original -PathType Leaf) -or (Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash.ToLower() -ne $hash) {
        throw "Source changed or copied output differs: $relative"
    }
    @{ path = $relative; sha256 = $hash; size = $_.Length }
})
$receipt = @{ schemaVersion = 1; name = $Name; source = $source; destination = $destination; buildRoot = $buildRoot;
    cargoTargetDirectory = (Join-Path $buildRoot "cargo\$Name"); sourceSnapshotSha256 = $SnapshotSha256;
    sourceDiffSha256 = $DiffSha256; robocopyExitCode = $copyCode; files = $files; observed = (Get-Date).ToUniversalTime().ToString('o') }
$receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $marker -Encoding UTF8
$receipt | ConvertTo-Json -Depth 12
