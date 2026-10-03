# Shared offline installation operations. All inputs come from the Nix cache.
function Install-Ewdk($tool, $paths) {
    # The publisher's self-contained EWDK is expanded from a verified local
    # disk image. Keep its complete layout, licenses and build environment.
    $destination = 'C:\WinBoatDev\tools\EWDK'
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $image = Mount-DiskImage -ImagePath $paths[0] -PassThru
    try {
        $volume = $image | Get-Volume
        if (-not $volume.DriveLetter) { throw 'Local EWDK image has no drive letter' }
        & robocopy.exe ($volume.DriveLetter + ':\') $destination /E /COPY:DAT /DCOPY:DAT /XJ /R:2 /W:2 /NFL /NDL /NP
        if ($LASTEXITCODE -ge 8) { throw "EWDK extraction failed: $LASTEXITCODE" }
        $receipt = @{ schemaVersion = 1; complete = $true; sourceSha256 = $tool.payloads[0].sha256; robocopyExitCode = $LASTEXITCODE }
        $marker = Join-Path $destination '.winboat-ewdk.json'
        $receipt | ConvertTo-Json | Set-Content -LiteralPath ($marker + '.tmp') -Encoding UTF8
        Move-Item -LiteralPath ($marker + '.tmp') -Destination $marker -Force
    } finally { Dismount-DiskImage -ImagePath $paths[0] }
    $vs = Join-Path $destination 'Program Files\Microsoft Visual Studio\2022\BuildTools'
    [Environment]::SetEnvironmentVariable('WINBOAT_EWDK_ROOT', $destination, 'Machine')
    [Environment]::SetEnvironmentVariable('WINBOAT_VS_ROOT', $vs, 'Machine')
}
function Get-EwdkVersion {
    $marker = 'C:\WinBoatDev\tools\EWDK\.winboat-ewdk.json'
    if (-not (Test-Path -LiteralPath $marker)) { return }
    $receipt = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
    $locked = (Get-Content -Raw -LiteralPath (Join-Path $root 'provision.lock.json') | ConvertFrom-Json).tools | Where-Object id -eq 'vs-build-tools'
    if ($receipt.schemaVersion -ne 1 -or -not $receipt.complete -or $receipt.sourceSha256 -ne $locked.payloads[0].sha256) { return }
    $vs = 'C:\WinBoatDev\tools\EWDK\Program Files\Microsoft Visual Studio\2022\BuildTools'
    $compiler = Join-Path $vs 'VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\cl.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { return }
    $versionFile = Join-Path $vs 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt'
    if ((Get-Content -Raw -LiteralPath $versionFile).Trim() -ne '14.44.35207') { return }
    if ((Get-Item -LiteralPath $compiler).VersionInfo.FileVersion -ne '19.44.35209.0') { return }
    foreach ($file in @('Common7\Tools\VsDevCmd.bat','MSBuild\Current\Bin\MSBuild.exe',
        'VC\Tools\MSVC\14.44.35207\lib\spectre\x64\libcmt.lib',
        'VC\Tools\MSVC\14.44.35207\lib\spectre\x86\libcmt.lib',
        'Licenses\BuildTools\1033\ThirdPartyNotices.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $vs $file))) { return }
    }
    $command = Get-Content -Raw -LiteralPath (Join-Path $vs 'Common7\Tools\VsDevCmd.bat')
    if ($command -match 'set "VSCMD_VER=([0-9.]+)"') { $Matches[1] }
}
function New-ToolLayout($tool, $paths) {
    $layout = Join-Path $root ('layouts\' + $tool.id)
    New-Item -ItemType Directory -Path $layout -Force | Out-Null
    for ($i = 0; $i -lt $tool.payloads.Count; $i++) {
        $relative = $tool.payloads[$i].relativePath
        if ([IO.Path]::IsPathRooted($relative) -or (($relative -split '[\\/]') -contains '..')) { throw 'Unsafe installer layout path' }
        $destination = Join-Path $layout $relative
        New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
        Copy-Item -LiteralPath $paths[$i] -Destination $destination -Force
        # Publisher/CD inputs may carry ReadOnly. The private local layout must
        # permit Rust's explicitly recorded manifest URL/checksum relocation.
        (Get-Item -LiteralPath $destination).IsReadOnly = $false
    }
    return $layout
}
function Install-Kit($tool, $paths) {
    $layout = New-ToolLayout $tool $paths
    $installer = Join-Path $layout $tool.payloads[0].relativePath
    $process = Start-Process -FilePath $installer -ArgumentList @('/quiet','/norestart','/ceip','off','/features', ($tool.componentIds -join ' ')) -Wait -PassThru
    if ($process.ExitCode -notin @(0,3010)) { throw "Kit installer exited with $($process.ExitCode)" }
    if ($process.ExitCode -eq 3010) { $state.installerRebootPending = $true }
}
function Get-KitVersion([string]$Kind) {
    $kits = 'C:\Program Files (x86)\Windows Kits\10'
    $required = if ($Kind -eq 'windows-sdk') {
        @('Include\10.0.26100.0\shared\specstrings.h','Include\10.0.26100.0\um\Windows.h',
          'Lib\10.0.26100.0\um\x64\kernel32.lib','Lib\10.0.26100.0\ucrt\x64\ucrt.lib',
          'bin\10.0.26100.0\x64\signtool.exe','Debuggers\x64\cdb.exe')
    } else { @('Include\10.0.26100.0\km\ntddk.h','Lib\10.0.26100.0\km\x64\ntoskrnl.lib') }
    foreach ($file in $required) { if (-not (Test-Path -LiteralPath (Join-Path $kits $file))) { return } }
    $display = if ($Kind -eq 'windows-sdk') { '^Windows Software Development Kit - Windows 10\.0\.26100\.' } else { '^Windows Driver Kit - Windows 10\.0\.26100\.' }
    $entries = @(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -match $display })
    $versions = @($entries | ForEach-Object DisplayVersion | Select-Object -Unique)
    if ($versions.Count -eq 1) { $versions[0] }
}
function Install-Rust($tool, $paths) {
    $layout = New-ToolLayout $tool $paths
    $env:RUSTUP_HOME = 'C:\WinBoatDev\tools\rustup'
    $env:CARGO_HOME = 'C:\WinBoatDev\tools\cargo'
    $env:RUSTUP_INIT_SKIP_PATH_CHECK = 'yes'
    if ((Get-EwdkVersion) -ne '17.14.5') { throw 'Rust requires the verified locked EWDK compiler' }
    # The portable EWDK has no Visual Studio installer registration. Rustup must
    # use that verified compiler rather than offer a mutable online VS install.
    $env:RUSTUP_INIT_SKIP_MSVC_CHECK = 'yes'
    Native (Join-Path $layout 'rustup-init.exe') @('-y','--default-host','x86_64-pc-windows-msvc','--default-toolchain','none','--no-modify-path')
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
    # Rustup uses HTTP distribution metadata. Serve a verified local layout on
    # loopback only, with relocated URLs and a corresponding local checksum.
    # SYSTEM tasks have no console. Give Python real standard handles and retain
    # HTTP diagnostics rather than relying on an interactive parent's streams.
    $server = Start-Process 'C:\WinBoatDev\tools\Python\python.exe' -ArgumentList @('-B','-m','http.server', $port, '--bind','127.0.0.1','--directory', $layout) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $layout 'server.stdout.log') -RedirectStandardError (Join-Path $layout 'server.stderr.log')
    try {
        $manifestPath = Join-Path $layout ('dist\2026-07-14\channel-rust-nightly.toml')
        $manifest = (Get-Content -Raw -LiteralPath $paths[1]).Replace('https://static.rust-lang.org', ('http://127.0.0.1:' + $port))
        [IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding($false)))
        $hash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLower()
        [IO.File]::WriteAllText(($manifestPath + '.sha256'), ($hash + '  channel-rust-nightly.toml'), (New-Object Text.UTF8Encoding($false)))
        # Rustup appends /dist itself (the publisher default is its origin).
        $env:RUSTUP_DIST_SERVER = 'http://127.0.0.1:' + $port
        Start-Sleep -Seconds 2
        if ($server.HasExited) { throw 'Local Rust distribution server failed to start' }
        Native (Join-Path $env:CARGO_HOME 'bin\rustup.exe') @('toolchain','install',$tool.version,'--profile','minimal','--component','rust-src','--target','i686-pc-windows-msvc','--no-self-update')
        Native (Join-Path $env:CARGO_HOME 'bin\rustup.exe') @('default', $tool.version)
        $state.rustDistribution = @{ sourceManifestSha256 = $tool.payloads[1].sha256; localManifestSha256 = $hash; offline = $true }
    } finally { if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }; Remove-Item Env:\RUSTUP_DIST_SERVER -ErrorAction SilentlyContinue }
}
function Get-RustVersion {
    $rustup = 'C:\WinBoatDev\tools\cargo\bin\rustup.exe'
    $env:RUSTUP_HOME = 'C:\WinBoatDev\tools\rustup'; $env:CARGO_HOME = 'C:\WinBoatDev\tools\cargo'
    if (-not (Test-Path -LiteralPath $rustup)) { return }
    $version = & $rustup run 'nightly-2026-07-14' rustc --version
    if ($LASTEXITCODE -ne 0 -or $version -ne 'rustc 1.99.0-nightly (daf2e5e18 2026-07-13)') { return }
    $components = & $rustup component list --toolchain 'nightly-2026-07-14' --installed
    foreach ($component in @('rust-src','rust-std-i686-pc-windows-msvc','rust-std-x86_64-pc-windows-msvc')) {
        if ($components -notcontains $component) { return }
    }
    'nightly-2026-07-14'
}
function Install-CargoHelper($tool, $paths) {
    $directory = Join-Path 'C:\WinBoatDev\tools\helpers' $tool.id
    Expand-Archive -LiteralPath $paths[0] -DestinationPath $directory -Force
    for ($i = 1; $i -lt $paths.Count; $i++) {
        Copy-Item -LiteralPath $paths[$i] -Destination (Join-Path $directory $tool.payloads[$i].file) -Force
    }
    $bin = 'C:\WinBoatDev\tools\cargo\bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    Get-ChildItem -LiteralPath $directory -Filter '*.exe' -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $bin -Force }
}
function Get-CargoHelperVersion([string]$Name) {
    $file = Join-Path 'C:\WinBoatDev\tools\cargo\bin' ($Name + '.exe')
    if (Test-Path -LiteralPath $file) {
        [string[]]$arguments = if ($Name -eq 'cargo-make') { @('make','--version') } else { @('--version') }
        $version = & $file @arguments
        if ($LASTEXITCODE -ne 0) { throw "$Name version probe exited with $LASTEXITCODE" }
        ($version -split ' ')[-1]
    }
}
function Install-Vulkan($tool, $paths) {
    $directory = 'C:\VulkanSDK\1.4.350.0'
    Native $paths[0] @('--root', $directory, '--accept-licenses', '--default-answer', '--confirm-command', 'install')
    [Environment]::SetEnvironmentVariable('VULKAN_SDK', $directory, 'Machine')
}
function Get-VulkanVersion {
    $directory = 'C:\VulkanSDK\1.4.350.0'
    foreach ($file in @('Include\vulkan\vulkan_core.h', 'Bin\glslangValidator.exe', 'Bin\spirv-as.exe', 'components.xml')) {
        if (-not (Test-Path -LiteralPath (Join-Path $directory $file))) { return }
    }
    $header = Get-Content -Raw -LiteralPath (Join-Path $directory 'Include\vulkan\vulkan_core.h')
    if ($header -notmatch '(?m)^#define VK_HEADER_VERSION 350\s*$' -or
        $header -notmatch '#define VK_HEADER_VERSION_COMPLETE VK_MAKE_API_VERSION\(0, 1, 4, VK_HEADER_VERSION\)') { return }
    [xml]$components = Get-Content -Raw -LiteralPath (Join-Path $directory 'components.xml')
    $core = $components.SelectSingleNode("//Package[Name='com.lunarg.vulkan.core']")
    if ($core -and $core.Version -eq '1.4.350.0') { [string]$core.Version }
}
