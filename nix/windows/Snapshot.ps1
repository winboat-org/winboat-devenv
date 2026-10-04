param([Parameter(Mandatory)][string]$Specification)
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$spec = Get-Content -Raw -LiteralPath $Specification | ConvertFrom-Json
if ($spec.schemaVersion -ne 1 -or $spec.operationId -notmatch '^op-[a-f0-9]{32}$') { throw 'Unsupported source snapshot' }
$kind = if ($spec.PSObject.Properties['destinationKind']) {$spec.destinationKind} else {'source'}
if ($kind -notin @('source','artifact')) {throw 'Unsupported snapshot destination kind'}
if ($kind -eq 'artifact') {
    $inventory = Read-ControlJson 'C:\ProgramData\WinBoatDev\provisioning.json'
    if ($inventory.phase -ne 'verified' -or $inventory.lockSha256 -ne $spec.provisionLockSha256) {throw 'Artifact import requires the selected verified guest toolchain'}
    $destination = Assert-ControlPath ('C:\WinBoatDev\build\' + $spec.operationId + '\artifact') 'C:\WinBoatDev\build'
} else {
    $destination = Assert-ControlPath ('C:\WinBoatDev\src\' + $spec.operationId) 'C:\WinBoatDev\src'
}
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
    # The protected destination has one operation owner. Scan existing
    # directories once on resume, then validate each archive path lexically;
    # walking all ancestors twice per entry makes large compiler mirrors slow.
    if(Test-Path -LiteralPath $destination) {
        foreach($directory in Get-ChildItem -LiteralPath $destination -Directory -Recurse -Force) {
            if($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Reparse point in snapshot destination'}
        }
    }
    foreach ($entry in $entries) {
        $relative = $entry.FullName.Replace('/','\')
        if ([IO.Path]::IsPathRooted($relative) -or ($relative -split '\\') -contains '..' -or $relative.Contains(':') -or -not $seen.Add($relative)) { throw 'Unsafe or duplicate snapshot path' }
        $path=[IO.Path]::GetFullPath((Join-Path $destination $relative))
        if(-not $path.StartsWith($destination+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'Archive entry escaped the snapshot destination'}
        if (-not $expected.ContainsKey($entry.FullName)) { throw 'Unexpected archive entry' }
    }
    # Journal ownership before extraction. An explicit resume verifies the
    # same archive and completes missing/partial entries in its own mirror.
    if (-not (Test-Path -LiteralPath $destination)) {
        New-Item -ItemType Directory -Path $destination | Out-Null
        Write-ControlJson @{operationId=$spec.operationId;archiveSha256=$spec.archiveSha256} (Join-Path $destination '.winboat-owner.json')
    }
    foreach ($entry in $entries) {
        $path = [IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
        $file = $expected[$entry.FullName]
        if(Test-Path -LiteralPath $path) {
            $existing=Get-Item -LiteralPath $path -Force
            if($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Reparse point in snapshot file'}
            if($existing.Length -eq $file.size -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() -eq $file.sha256) {continue}
        }
        New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $path, $true)
        Assert-ControlFile $path $file.sha256 $file.size
    }
    Assert-ControlTree $destination $spec.files
    if ($kind -eq 'artifact') {
        $imagePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($image in $spec.images) {
            if (-not $expected.ContainsKey($image.path) -or -not $imagePaths.Add($image.path) -or $image.architecture -notin @('x64','x86')) {throw 'Invalid imported image declaration'}
            $path = Join-Path $destination $image.path
            $headers = (& 'C:\WinBoatDev\tools\LLVM\bin\llvm-readobj.exe' --file-headers --coff-imports --coff-directives $path | Out-String)
            if ($LASTEXITCODE) {throw "Cannot inspect imported Windows image: $($image.path)"}
            $machines = @([regex]::Matches($headers,'Machine: (IMAGE_FILE_MACHINE_[A-Z0-9_]+)') | ForEach-Object {$_.Groups[1].Value} | Select-Object -Unique)
            $required = if ($image.architecture -eq 'x86') {'IMAGE_FILE_MACHINE_I386'} else {'IMAGE_FILE_MACHINE_AMD64'}
            if ($machines.Count -ne 1 -or $machines[0] -ne $required) {throw "Imported image architecture differs: $($image.path)"}
            if ($headers -match '(?i)(DEFAULTLIB:|Name: )(MSVCRT[D]?|MSVCPRT[D]?|MSVCR\d+|MSVCP\d+|VCRUNTIME\d+(?:_\d+)?|UCRTBASE|api-ms-win-crt-[^\s.]+)(?:\.dll|\.lib)?(?:["\s]|$)') {throw "Imported image requires dynamic CRT: $($image.path)"}
        }
        foreach ($file in $spec.files) {
            if ([IO.Path]::GetExtension($file.path) -in @('.a','.lib','.dll','.sys','.exe') -and -not $imagePaths.Contains($file.path)) {throw "Imported image has no architecture/CRT declaration: $($file.path)"}
        }
        if (-not $imagePaths.Count) {throw 'Artifact import has no Windows images'}
    }
    foreach ($file in $spec.files) {
        $path = Join-Path $destination $file.path
        # ZIP stores local times without a timezone. Source identity comes
        # from contents; do not let a host/guest timezone difference make
        # Meson refuse a source as being in the future. Also covers resume.
        (Get-Item -LiteralPath $path).LastWriteTimeUtc = [DateTime]'1980-01-01T00:00:00Z'
    }
    $spec | Add-Member NoteProperty destination $destination
    $spec | Add-Member NoteProperty observed ([DateTime]::UtcNow.ToString('o'))
    Write-ControlJson $spec (Join-Path $destination '.winboat-snapshot.json')
    $spec | ConvertTo-Json -Depth 30
} finally { $zip.Dispose() }
