param([Parameter(Mandatory)][ValidatePattern('^op-[a-f0-9]{32}$')][string]$BuildJobId)
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$build = 'C:\WinBoatDev\build\' + $BuildJobId
$resultPath = Join-Path $env:WINBOAT_JOB_ROOT 'loaded-fixture.json'
$results = @()
foreach ($architecture in @('x64','x86')) {
    $directory = 'C:\WinBoatDev\fixtures\' + (Split-Path $env:WINBOAT_JOB_ROOT -Leaf) + '\' + $architecture
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $specification = @{build=$build;directory=$directory;control=$env:WINBOAT_CONTROL_ROOT}
    $data = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($specification | ConvertTo-Json -Compress)))
    $code = @'
$ErrorActionPreference='Stop'
$spec=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('DATA')) | ConvertFrom-Json
Add-Type -Path (Join-Path $spec.control 'LoadedIdentity.cs')
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class FixtureModule {[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr LoadLibrary(string name);[DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr handle);}'
$architecture=if([IntPtr]::Size -eq 8){'x64'}else{'x86'}
$path=Join-Path $spec.directory 'fixture.dll'
Copy-Item (Join-Path $spec.build "$architecture\fixture.dll") $path
$module=[FixtureModule]::LoadLibrary($path)
if($module -eq [IntPtr]::Zero){throw 'Fixture DLL load failed'}
try {
    $first=[WinBoatLoadedIdentity]::Verify($PID,$module.ToInt64(),$path)
    Move-Item $path (Join-Path $spec.directory 'original.loaded.dll')
    Copy-Item (Join-Path $spec.build "$architecture\replacement.dll") $path
    $stale=[WinBoatLoadedIdentity]::Verify($PID,$module.ToInt64(),$path)
} finally {[void][FixtureModule]::FreeLibrary($module)}
$module=[FixtureModule]::LoadLibrary($path)
if($module -eq [IntPtr]::Zero){throw 'Replacement DLL load failed'}
try {$current=[WinBoatLoadedIdentity]::Verify($PID,$module.ToInt64(),$path)} finally {[void][FixtureModule]::FreeLibrary($module)}
if($first -ne 'mapped-code-matches' -or $stale -ne 'stale-mapped-image' -or $current -ne 'mapped-code-matches'){throw "Unexpected loaded identity: $first / $stale / $current"}
@{architecture=$architecture;first=$first;afterDiskReplacement=$stale;afterReload=$current;pid=$PID}|ConvertTo-Json -Compress
'@
    $code = $code.Replace('DATA',$data)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
    $systemDirectory = if ($architecture -eq 'x64') {'System32'} else {'SysWOW64'}
    $powerShell = Join-Path $env:SystemRoot "$systemDirectory\WindowsPowerShell\v1.0\powershell.exe"
    $lines = & $powerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    $results += ($lines | ConvertFrom-Json)
}
[IO.File]::WriteAllText($resultPath,(@{schemaVersion=1;state='passed';images=$results}|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
$results | ConvertTo-Json -Depth 10
