param([Parameter(Mandatory)][string]$Specification)
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$spec = Get-Content -Raw -LiteralPath $Specification | ConvertFrom-Json
if ($spec.schemaVersion -ne 1 -or $spec.operationId -notmatch '^op-[a-f0-9]{32}$') { throw 'Unsupported source snapshot' }
$destination = Assert-ControlPath ('C:\WinBoatDev\src\' + $spec.operationId) 'C:\WinBoatDev\src'
if (Test-Path -LiteralPath $destination) {
    $ownerPath = Join-Path $destination '.winboat-owner.json'
    if (-not (Test-Path -LiteralPath $ownerPath)) { throw 'Snapshot destination is not owned by this operation' }
    $owner = Get-Content -Raw -LiteralPath $ownerPath | ConvertFrom-Json
    if ($owner.operationId -ne $spec.operationId -or $owner.archiveSha256 -ne $spec.archiveSha256) { throw 'Snapshot resume identity differs from its original archive' }
}
Assert-ControlFile $spec.archive $spec.archiveSha256 $spec.archiveSize
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($spec.archive)
try {
    $entries = @($zip.Entries)
    if ($entries.Count -ne @($spec.files).Count) { throw 'Archive file set differs from the snapshot manifest' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $expected=@{}
    foreach($file in $spec.files) {$expected[$file.path]=$file}
    foreach ($entry in $entries) {
        $relative = $entry.FullName.Replace('/','\')
        if ([IO.Path]::IsPathRooted($relative) -or ($relative -split '\\') -contains '..' -or $relative.Contains(':') -or -not $seen.Add($relative)) { throw 'Unsafe or duplicate snapshot path' }
        [void](Assert-ControlPath (Join-Path $destination $relative) $destination)
        if (-not $expected.ContainsKey($entry.FullName)) { throw 'Unexpected archive entry' }
    }
    # Journal ownership before extraction. An explicit resume verifies the
    # same archive and completes missing/partial entries in its own mirror.
    if (-not (Test-Path -LiteralPath $destination)) {
        New-Item -ItemType Directory -Path $destination | Out-Null
        Write-ControlJson @{operationId=$spec.operationId;archiveSha256=$spec.archiveSha256} (Join-Path $destination '.winboat-owner.json')
    }
    foreach ($entry in $entries) {
        $path = Assert-ControlPath (Join-Path $destination $entry.FullName) $destination
        $file = $expected[$entry.FullName]
        if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -eq $file.size -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() -eq $file.sha256) { continue }
        New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $path, $true)
        Assert-ControlFile $path $file.sha256 $file.size
    }
    foreach ($file in $spec.files) { Assert-ControlFile (Join-Path $destination $file.path) $file.sha256 $file.size }
    $spec | Add-Member NoteProperty destination $destination
    $spec | Add-Member NoteProperty observed ([DateTime]::UtcNow.ToString('o'))
    Write-ControlJson $spec (Join-Path $destination '.winboat-snapshot.json')
    $spec | ConvertTo-Json -Depth 30
} finally { $zip.Dispose() }
