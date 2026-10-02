param([Parameter(Mandatory)][string]$CertificateThumbprint)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\WinBoatDev'
$fixture = Join-Path $root 'fixture'
$kit = '10.0.26100.0'
$kitsRoot = 'C:\Program Files (x86)\Windows Kits\10'
foreach ($directory in @(Get-ChildItem -LiteralPath (Join-Path $kitsRoot 'Include') -Directory)) {
    if ($directory.Name -match '^10\.0\.\d+\.\d+$' -and [version]$directory.Name -gt [version]$kit) {
        throw "A higher kit can override the matched toolchain: $($directory.Name)"
    }
}
foreach ($file in @("Include\$kit\km\ntddk.h", "Include\$kit\shared\specstrings.h", "Lib\$kit\km\x64\ntoskrnl.lib", "bin\$kit\x64\signtool.exe")) {
    if (-not (Test-Path -LiteralPath (Join-Path $kitsRoot $file))) { throw "Incomplete matched SDK/WDK: $file" }
}
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -products '*' -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or @($vs).Count -ne 1) { throw 'Expected exactly one locked VS 2022 Build Tools installation' }
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'TestDriver.c') -Destination (Join-Path $fixture 'TestDriver.c') -Force
$commands = @(
    '@echo off',
    ('call "' + $vs + '\Common7\Tools\VsDevCmd.bat" -arch=amd64 -host_arch=amd64'),
    'if errorlevel 1 exit /b %errorlevel%',
    ('cd /d "' + $fixture + '"'),
    ('cl.exe /nologo /c /GS- /Zl /kernel /D_AMD64_ /DAMD64 /D_WIN64 /I"' + $kitsRoot + '\Include\' + $kit + '\km" /I"' + $kitsRoot + '\Include\' + $kit + '\shared" TestDriver.c'),
    'if errorlevel 1 exit /b %errorlevel%',
    ('link.exe /nologo /driver /subsystem:native /entry:DriverEntry /nodefaultlib /machine:x64 /out:wbdev-test.sys TestDriver.obj "' + $kitsRoot + '\Lib\' + $kit + '\km\x64\ntoskrnl.lib"'),
    'exit /b %errorlevel%'
)
$commands | Set-Content -LiteralPath (Join-Path $fixture 'build.cmd') -Encoding ASCII
& cmd.exe /d /c (Join-Path $fixture 'build.cmd')
if ($LASTEXITCODE -ne 0) { throw "Driver fixture build failed: $LASTEXITCODE" }
& (Join-Path $kitsRoot "bin\$kit\x64\signtool.exe") sign /v /fd SHA256 /sm /sha1 $CertificateThumbprint (Join-Path $fixture 'wbdev-test.sys')
if ($LASTEXITCODE -ne 0) { throw 'Driver fixture signing failed' }
