param([Parameter(Mandatory)][string]$Specification)
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$spec = Get-Content -Raw -LiteralPath $Specification | ConvertFrom-Json
$sourceRoot = Assert-ControlPath $spec.sourceRoot 'C:\WinBoatDev\src'
$buildRoot = Assert-ControlPath $spec.buildRoot 'C:\WinBoatDev\build'
$snapshot = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot '.winboat-snapshot.json') | ConvertFrom-Json
Assert-ControlTree $sourceRoot $snapshot.files
$inventory = Get-Content -Raw -LiteralPath 'C:\ProgramData\WinBoatDev\provisioning.json' | ConvertFrom-Json
if ($inventory.phase -ne 'verified' -or $inventory.lockSha256 -ne $spec.provisionLockSha256) { throw 'Guest provisioning inventory is not the selected verified toolchain' }
Import-ControlBuildEnvironment $spec.architecture
$prerequisites = @(if ($spec.PSObject.Properties.Name -contains 'prerequisites') {$spec.prerequisites})
foreach ($prerequisite in $prerequisites) {
    $root = Assert-ControlPath $prerequisite.root 'C:\WinBoatDev\src'
    Assert-ControlTree $root $prerequisite.files
    if (-not $prerequisite.PSObject.Properties['kind'] -or $prerequisite.kind -eq 'widl') {
        $env:PATH = (Join-Path $root 'bin') + ';' + $env:PATH
    }
}
foreach($dependency in $spec.componentDependencies) {
    $root=Assert-ControlPath $dependency.root 'C:\WinBoatDev\build'
    Assert-ControlTree $root $dependency.files
}
$env:LIBCLANG_PATH = 'C:\WinBoatDev\tools\LLVM\bin'
$env:RUSTUP_TOOLCHAIN = 'nightly-2026-07-14'
$env:RUST_TOOLCHAIN = $env:RUSTUP_TOOLCHAIN
$env:CARGO_TARGET_DIR = Join-Path $buildRoot 'cargo'
if ($env:WindowsSDKVersion.TrimEnd('\') -ne '10.0.26100.0') { throw 'SDK/WDK selection differs from the matched kit' }
$higher = @(Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Include' -Directory | Where-Object { $_.Name -match '^10\.0\.\d+\.\d+$' -and [version]$_.Name -gt [version]'10.0.26100.0' })
if ($higher.Count) { throw 'A higher incomplete kit may override the matched SDK/WDK' }
$toolchain = [ordered]@{}
foreach ($tool in @('clang-cl.exe','git.exe','meson.exe','ninja.exe','glslangValidator.exe')) {
    $command = Get-Command $tool -ErrorAction Stop
    $toolchain[$tool] = @{path=$command.Source;sha256=(Get-FileHash $command.Source -Algorithm SHA256).Hash.ToLower();version=(& $command.Source --version | Out-String).Trim()}
}
$msvc = Get-Command cl.exe -ErrorAction Stop
$toolchain['cl.exe'] = @{path=$msvc.Source;sha256=(Get-FileHash $msvc.Source -Algorithm SHA256).Hash.ToLower();version=(Get-Item $msvc.Source).VersionInfo.FileVersion}
$toolchain['environment'] = @{sdk=$env:WindowsSDKVersion;include=$env:INCLUDE;libraries=$env:LIB;cargoTarget=$env:CARGO_TARGET_DIR;libclang=$env:LIBCLANG_PATH}
if (@($prerequisites | Where-Object { -not $_.PSObject.Properties['kind'] -or $_.kind -eq 'widl' }).Count) {
    $widl = Get-Command widl.exe -ErrorAction Stop
    $version = (& $widl.Source -V | Out-String).Trim()
    if ($LASTEXITCODE) { throw 'Native Windows WIDL prerequisite probe failed' }
    $toolchain['widl.exe'] = @{path=$widl.Source;sha256=(Get-FileHash $widl.Source -Algorithm SHA256).Hash.ToLower();version=$version}
}
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
foreach ($command in $spec.commands) {
    $program = $command[0]
    $arguments = @($command | Select-Object -Skip 1)
    & $program @arguments
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
$output = Join-Path $buildRoot 'artifact'
New-Item -ItemType Directory -Path $output | Out-Null
$images = @()
foreach ($relative in $spec.outputs) {
    $inputPath = Assert-ControlPath (Join-Path $buildRoot $relative) $buildRoot
    if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) { throw "Required output missing: $relative" }
    $destination = Assert-ControlPath (Join-Path $output $relative) $output
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $inputPath -Destination $destination
    if ([IO.Path]::GetExtension($inputPath) -in @('.a','.lib','.dll','.sys','.exe')) {
        $headers = (& 'C:\WinBoatDev\tools\LLVM\bin\llvm-readobj.exe' --file-headers --sections --coff-imports --coff-directives $inputPath | Out-String)
        if ($LASTEXITCODE) { throw "Cannot inspect required Windows image: $relative" }
        $architecture=$spec.architecture
        if ($spec.PSObject.Properties['outputArchitectures'] -and $spec.outputArchitectures.PSObject.Properties[$relative]) {$architecture=$spec.outputArchitectures.$relative}
        $requiredMachine = if ($architecture -eq 'x86') {'IMAGE_FILE_MACHINE_I386'} else {'IMAGE_FILE_MACHINE_AMD64'}
        $otherMachine = if ($architecture -eq 'x86') {'IMAGE_FILE_MACHINE_AMD64'} else {'IMAGE_FILE_MACHINE_I386'}
        if ($headers -notmatch $requiredMachine -or $headers -match $otherMachine) { throw "Output architecture differs from the declared target: $relative" }
        if ($headers -match '(?i)(DEFAULTLIB:|Name: )(MSVCRT[D]?|MSVCR\d+|MSVCP\d+|VCRUNTIME\d+(?:_\d+)?|UCRTBASE|api-ms-win-crt-[^\s.]+)(?:\.dll|\.lib)?(?:["\s]|$)') { throw "Dynamic CRT dependency violates the /MT contract: $relative" }
        $images += @{path=$relative;architecture=$architecture;machine=$requiredMachine;staticCrtVerified=$true;embeddedCodeView=($headers -match '\.debug\$[ST]')}
    }
}
Write-ControlJson $images (Join-Path $output 'images.json')
$licenses = Join-Path $output 'licenses'
New-Item -ItemType Directory -Path $licenses | Out-Null
foreach ($prerequisite in $prerequisites) {
    $notices = Join-Path $prerequisite.root 'share\licenses'
    if (Test-Path $notices) {Get-ChildItem $notices -Directory | Copy-Item -Destination $licenses -Recurse}
}
foreach ($source in $spec.sources.PSObject.Properties) {
    $repository = Join-Path $sourceRoot $source.Value.relativePath
    $notices = @(Get-ChildItem $repository -File | Where-Object { $_.Name -match '(?i)^(LICENSE|COPYING|NOTICE)' })
    $destination = Join-Path $licenses $source.Name
    New-Item -ItemType Directory -Path $destination | Out-Null
    foreach ($notice in $notices) { Copy-Item -LiteralPath $notice.FullName -Destination $destination }
    # Retain nested shader/header attribution too.
    Get-ChildItem $repository -Recurse -File | Where-Object { $_.Name -match '(?i)^(LICENSE|COPYING|NOTICE)' } | ForEach-Object {
        $relative = $_.FullName.Substring($repository.Length+1)
        $target = Join-Path $destination $relative
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
    if (-not $notices.Count -and $source.Name -eq 'helios') {
        'The source snapshot has no declared root/protocol license. Distribution requires owner license clarification.' | Set-Content (Join-Path $destination 'NOTICE')
    }
}
Get-ChildItem $buildRoot -Recurse -File -Filter '*.pdb' | Where-Object { -not $_.FullName.StartsWith($output + '\') } | ForEach-Object {
    $relative=$_.FullName.Substring($buildRoot.Length+1)
    $destination=Join-Path $output $relative
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}
if ($spec.target -match '^(dxvk|vkd3d)-engine-') {
    # The UMD bridge consumes generated build headers as well as archives.
    # Preserve their exact bytes in the dependency artifact's file table.
    Get-ChildItem $buildRoot -Recurse -File -Filter '*.h' | Where-Object { -not $_.FullName.StartsWith($output + '\') } | ForEach-Object {
        $relative=$_.FullName.Substring($buildRoot.Length+1)
        $destination=Join-Path $output $relative
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    }
}
if ($spec.PSObject.Properties['preserveDirectories']) {
    foreach ($relative in $spec.preserveDirectories) {
        $directory=Assert-ControlPath (Join-Path $buildRoot $relative) $buildRoot
        $destination=Assert-ControlPath (Join-Path $output $relative) $output
        if (-not (Test-Path $directory -PathType Container)) {throw "Required evidence directory missing: $relative"}
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        Get-ChildItem -LiteralPath $directory -Force | Copy-Item -Destination $destination -Recurse -Force
    }
}
if ($spec.target -match '^helios-guest-') {
    Get-ChildItem (Join-Path $buildRoot 'cargo') -Recurse -File | Where-Object Name -in @('d3d10umddi.rs','d3d12umddi.rs','dxgk_bindings.rs') | ForEach-Object {
        $relative=$_.FullName.Substring($buildRoot.Length+1)
        $destination=Join-Path $output $relative
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $destination
    }
}
$toolchain | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $output 'toolchain.json') -Encoding UTF8
$files = @(Get-ChildItem $output -Recurse -File | Sort-Object FullName | ForEach-Object {
    @{path=$_.FullName.Substring($output.Length+1).Replace('\','/');sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower();size=$_.Length}
})
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=Join-Path $buildRoot 'artifact.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($output,$archive,[IO.Compression.CompressionLevel]::Optimal,$false)
$archiveFile=Get-Item $archive
Write-ControlJson @{schemaVersion=1;operationId=$spec.operationId;sourceRoot=$sourceRoot;buildRoot=$buildRoot;output=$output;files=$files;toolchain=$toolchain;archive=@{path=$archive;sha256=(Get-FileHash $archive -Algorithm SHA256).Hash.ToLower();size=$archiveFile.Length};state='built';installed=$false;loaded=$false} (Join-Path $env:WINBOAT_JOB_ROOT 'build-result.json')
