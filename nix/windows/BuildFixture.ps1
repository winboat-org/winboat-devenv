param(
    [Parameter(Mandatory)][string]$CertificateThumbprint,
    [string]$SourceRoot = 'C:\ProgramData\WinBoatDev',
    [string]$OutputRoot = 'C:\ProgramData\WinBoatDev\fixture'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\WinBoatDev'
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
$fixture = [IO.Path]::GetFullPath($OutputRoot)
if ($SourceRoot -ne $root -and -not $SourceRoot.StartsWith('C:\WinBoatDev\src\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixture sources must be in the protected payload or local source mirror'
}
if ($fixture -ne (Join-Path $root 'fixture') -and -not $fixture.StartsWith('C:\WinBoatDev\build\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixture outputs must be in the protected fixture or local build root'
}
foreach ($directory in @($SourceRoot, $fixture)) {
    $parent = $directory
    while ($parent) {
        if ((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Fixture path contains a reparse point'
        }
        $parent = Split-Path $parent -Parent
    }
}
$kit = '10.0.26100.0'
$kitsRoot = 'C:\Program Files (x86)\Windows Kits\10'
foreach ($directory in @(Get-ChildItem -LiteralPath (Join-Path $kitsRoot 'Include') -Directory)) {
    if ($directory.Name -match '^10\.0\.\d+\.\d+$' -and [version]$directory.Name -gt [version]$kit) {
        throw "A higher kit can override the matched toolchain: $($directory.Name)"
    }
}
foreach ($file in @("Include\$kit\km\ntddk.h", "Include\$kit\shared\specstrings.h", "Include\$kit\ucrt\ctype.h", "Lib\$kit\km\x64\ntoskrnl.lib", "bin\$kit\x64\signtool.exe")) {
    if (-not (Test-Path -LiteralPath (Join-Path $kitsRoot $file))) { throw "Incomplete matched SDK/WDK: $file" }
}
. (Join-Path $root 'Toolchain.ps1')
if ((Get-EwdkVersion) -ne '17.14.5') { throw 'Expected the verified locked EWDK VS 2022 Build Tools' }
$ewdk = 'C:\WinBoatDev\tools\EWDK'
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $SourceRoot 'TestDriver.c') -Destination (Join-Path $fixture 'TestDriver.c') -Force
$commands = @(
    '@echo off',
    ('call "' + $ewdk + '\BuildEnv\SetupBuildEnv.cmd" amd64'),
    'if errorlevel 1 exit /b %errorlevel%',
    ('cd /d "' + $fixture + '"'),
    ('cl.exe /nologo /c /GS- /Zl /kernel /D_AMD64_ /DAMD64 /D_WIN64 /I"' + $kitsRoot + '\Include\' + $kit + '\km" /I"' + $kitsRoot + '\Include\' + $kit + '\shared" /I"' + $kitsRoot + '\Include\' + $kit + '\ucrt" TestDriver.c'),
    'if errorlevel 1 exit /b %errorlevel%',
    ('link.exe /nologo /driver /subsystem:native /entry:DriverEntry /nodefaultlib /machine:x64 /out:wbdev-test.sys TestDriver.obj "' + $kitsRoot + '\Lib\' + $kit + '\km\x64\ntoskrnl.lib"'),
    'exit /b %errorlevel%'
)
$commands | Set-Content -LiteralPath (Join-Path $fixture 'build.cmd') -Encoding ASCII
& cmd.exe /d /c (Join-Path $fixture 'build.cmd')
if ($LASTEXITCODE -ne 0) { throw "Driver fixture build failed: $LASTEXITCODE" }
& (Join-Path $kitsRoot "bin\$kit\x64\signtool.exe") sign /v /fd SHA256 /sm /sha1 $CertificateThumbprint (Join-Path $fixture 'wbdev-test.sys')
if ($LASTEXITCODE -ne 0) { throw 'Driver fixture signing failed' }
