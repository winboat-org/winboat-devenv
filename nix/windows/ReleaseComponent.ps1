param([Parameter(Mandatory)][string]$Specification)
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$spec = Read-ControlJson $Specification
if ($spec.schemaVersion -ne 1 -or $spec.target -ne 'helios-installer' -or $spec.operationId -notmatch '^op-[0-9a-f]{32}$') { throw 'Unsupported component request' }
$archive = Join-Path (Split-Path $Specification -Parent) 'component-inputs.zip'
Assert-ControlFile $archive $spec.archiveSha256 $spec.archiveSize
$build = 'C:\WinBoatDev\build\' + $spec.operationId
if (Test-Path -LiteralPath $build) { throw 'Component directory already exists; evidence retained' }
New-Item -ItemType Directory -Path $build | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    $expected = @{}; $seen = @{}
    foreach ($f in $spec.files) { if ($expected.ContainsKey($f.path.ToLowerInvariant())) { throw 'Duplicate component input' }; $expected[$f.path.ToLowerInvariant()] = $f }
    foreach ($entry in $zip.Entries) {
        $key = $entry.FullName.ToLowerInvariant()
        if ($entry.FullName -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or -not $expected.ContainsKey($key) -or $seen.ContainsKey($key) -or $entry.FullName -cne $expected[$key].path -or $entry.Length -ne $expected[$key].size) { throw 'Unsafe/mismatched component archive' }
        [void](Assert-ControlPath (Join-Path $build $entry.FullName) $build); $seen[$key] = $true
    }
    if ($seen.Count -ne $expected.Count) { throw 'Component archive omits a required file' }
    foreach ($entry in $zip.Entries) {
        $destination = Assert-ControlPath (Join-Path $build $entry.FullName) $build
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
    }
} finally { $zip.Dispose() }
foreach ($f in $spec.files) { Assert-ControlFile (Join-Path $build $f.path) $f.sha256 $f.size }
Import-ControlBuildEnvironment x64
$env:RUSTUP_TOOLCHAIN = 'nightly-2026-07-14'
$env:RUST_TOOLCHAIN = $env:RUSTUP_TOOLCHAIN
$env:CARGO_HOME = Join-Path $build 'cargo-home'
$env:CARGO_TARGET_DIR = Join-Path $build 'cargo-target'
$env:CARGO_NET_OFFLINE = 'true'
New-Item -ItemType Directory -Path $env:CARGO_HOME | Out-Null
$vendor = Join-Path $build 'dependencies\vendor'
$configuration = (Get-Content -LiteralPath (Join-Path $build 'dependencies\config.toml') -Raw).Replace('directory = "cargo-vendor-dir"', ('directory = "' + $vendor.Replace('\','/') + '"'))
[IO.File]::WriteAllText((Join-Path $env:CARGO_HOME 'config.toml'), $configuration)
$source = Join-Path $build 'source'
if ((Get-FileHash (Join-Path $source 'installer\Cargo.lock') -Algorithm SHA256).Hash -ne (Get-FileHash (Join-Path $build 'dependencies\Cargo.lock') -Algorithm SHA256).Hash) { throw 'Installer dependency lock differs' }
$output = Join-Path $build 'artifact'
& (Join-Path $source 'ci\windows\Build-Installer.ps1') -RepoRoot $source -OutputDir $output -Configuration $spec.configuration
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Copy-Item -LiteralPath (Join-Path $build 'dependencies\licenses') -Destination $output -Recurse
Set-Content -LiteralPath (Join-Path $output 'licenses\NOTICE') -Encoding UTF8 -Value 'Source attribution: winboat-org/helios installer, migrated to winboat-org/winboat-devenv. See migration/helios-installer-source.json for the exact source identity.'
$toolchain = @{}
foreach ($tool in @('rustc.exe','cargo.exe','cl.exe','rc.exe','llvm-readobj.exe')) {
    $p = (Get-Command $tool -ErrorAction Stop).Source
    $toolchain[$tool] = @{path=$p;sha256=(Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant()}
}
Write-ControlJson $toolchain (Join-Path $output 'toolchain.json')
$inspection = (& llvm-readobj.exe --file-headers --coff-imports --coff-directives --sections (Join-Path $output 'HeliosSetup.exe') | Out-String)
if ($LASTEXITCODE -or $inspection -notmatch 'IMAGE_FILE_MACHINE_AMD64') { throw 'Installer PE inspection failed' }
Write-ControlJson @(@{path='HeliosSetup.exe';architecture='x64';format='PE';staticCrtVerified=$true;inspection=$inspection}) (Join-Path $output 'images.json')
$files = @(Get-ChildItem -LiteralPath $output -Recurse -File | Sort-Object FullName | ForEach-Object {@{path=$_.FullName.Substring($output.Length+1).Replace('\','/');sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant();size=$_.Length}})
$outputArchive = Join-Path $build 'artifact.zip'
$zip = [IO.Compression.ZipFile]::Open($outputArchive, [IO.Compression.ZipArchiveMode]::Create)
try { foreach ($f in $files) { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $output $f.path), $f.path, [IO.Compression.CompressionLevel]::Fastest) } } finally { $zip.Dispose() }
Write-ControlJson @{schemaVersion=1;operationId=$spec.operationId;rootRevision=$spec.rootRevision;state='built';toolchain=$toolchain;files=$files;archive=@{path=$outputArchive;sha256=(Get-FileHash $outputArchive -Algorithm SHA256).Hash.ToLowerInvariant();size=(Get-Item $outputArchive).Length}} (Join-Path (Split-Path $Specification -Parent) 'component-result.json')
