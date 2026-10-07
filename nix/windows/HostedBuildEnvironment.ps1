param([ValidateSet('x64','x86')][string]$Architecture)
$record = Read-ControlJson $env:WINBOAT_HOSTED_TOOLCHAIN
if ($record.kind -ne 'winboat-hosted-windows-toolchain' -or $record.schemaVersion -ne 1) { throw 'Unknown hosted toolchain' }
$tools = Split-Path $env:WINBOAT_HOSTED_TOOLCHAIN -Parent
$msvc = Join-Path $tools 'msvc'
$kits = Join-Path $tools 'kits'
$compiler = Join-Path $msvc "bin\Hostx64\$Architecture\cl.exe"
if ((Get-Item -LiteralPath $compiler).VersionInfo.FileVersion -ne $record.compilerFileVersion) { throw 'MSVC compiler version differs from locked media' }
$env:VCToolsInstallDir = $msvc + '\'
$env:WindowsSdkDir = $kits + '\'
$env:WDKContentRoot = $kits
$env:WindowsSDKVersion = $record.sdkVersion + '\'
$env:Version_Number = $record.sdkVersion
$env:VSCMD_ARG_TGT_ARCH = $Architecture
$env:INCLUDE = "$kits\Include\$($record.sdkVersion)\ucrt;$kits\Include\$($record.sdkVersion)\shared;$kits\Include\$($record.sdkVersion)\um;$msvc\include"
$env:LIB = "$kits\Lib\$($record.sdkVersion)\um\$Architecture;$kits\Lib\$($record.sdkVersion)\ucrt\$Architecture;$msvc\lib\spectre\$Architecture"
$env:LIBCLANG_PATH = Join-Path $tools 'llvm\bin'
$env:RUSTC = Join-Path $tools 'rust\bin\rustc.exe'
$env:RUSTDOC = Join-Path $tools 'rust\bin\rustdoc.exe'
$env:HELIOS_CLANG_CL = Join-Path $tools 'llvm\bin\clang-cl.exe'
$env:HELIOS_MSVC_LIB = Join-Path $tools 'llvm\bin\llvm-lib.exe'
$env:HELIOS_WDK_INCLUDE = Join-Path $kits "Include\$($record.sdkVersion)"
$env:PATH = ((@((Join-Path $tools 'rust\bin'),(Join-Path $tools 'llvm\bin'),(Join-Path $tools 'python'),(Split-Path $compiler -Parent),(Join-Path $kits "bin\$($record.sdkVersion)\x64"),$env:PATH)) -join ';')
if ((& $env:RUSTC --version) -ne 'rustc 1.99.0-nightly (daf2e5e18 2026-07-13)') { throw 'Rust compiler differs from the locked distribution' }
