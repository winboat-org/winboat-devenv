param([Parameter(Mandatory)][string]$Specification)
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$spec = Get-Content -Raw -LiteralPath $Specification | ConvertFrom-Json
$sourceRoot = Assert-ControlPath $spec.sourceRoot 'C:\WinBoatDev\src'
$buildRoot = Assert-ControlPath $spec.buildRoot 'C:\WinBoatDev\build'
$snapshot = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot '.winboat-snapshot.json') | ConvertFrom-Json
foreach ($file in $snapshot.files) { Assert-ControlFile (Join-Path $sourceRoot $file.path) $file.sha256 $file.size }
$inventory = Get-Content -Raw -LiteralPath 'C:\ProgramData\WinBoatDev\provisioning.json' | ConvertFrom-Json
if ($inventory.phase -ne 'verified' -or $inventory.lockSha256 -ne $spec.provisionLockSha256) { throw 'Guest provisioning inventory is not the selected verified toolchain' }
Import-ControlBuildEnvironment $spec.architecture
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
        $requiredMachine = if ($spec.architecture -eq 'x86') {'IMAGE_FILE_MACHINE_I386'} else {'IMAGE_FILE_MACHINE_AMD64'}
        $otherMachine = if ($spec.architecture -eq 'x86') {'IMAGE_FILE_MACHINE_AMD64'} else {'IMAGE_FILE_MACHINE_I386'}
        if ($headers -notmatch $requiredMachine -or $headers -match $otherMachine) { throw "Output architecture differs from the declared target: $relative" }
        if ($headers -match '(?i)(DEFAULTLIB:|Name: )(MSVCRT[D]?|MSVCP\d+|VCRUNTIME\d+|api-ms-win-crt)[.\s]') { throw "Dynamic CRT dependency violates the /MT contract: $relative" }
        $images += @{path=$relative;architecture=$spec.architecture;machine=$requiredMachine;staticCrtVerified=$true;embeddedCodeView=($headers -match '\.debug\$[ST]')}
    }
}
Write-ControlJson $images (Join-Path $output 'images.json')
$licenses = Join-Path $output 'licenses'
New-Item -ItemType Directory -Path $licenses | Out-Null
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
$toolchain | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $output 'toolchain.json') -Encoding UTF8
$files = @(Get-ChildItem $output -Recurse -File | Sort-Object FullName | ForEach-Object {
    @{path=$_.FullName.Substring($output.Length+1).Replace('\','/');sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower();size=$_.Length}
})
Write-ControlJson @{schemaVersion=1;operationId=$spec.operationId;sourceRoot=$sourceRoot;buildRoot=$buildRoot;output=$output;files=$files;toolchain=$toolchain;state='built';installed=$false;loaded=$false} (Join-Path $env:WINBOAT_JOB_ROOT 'build-result.json')
