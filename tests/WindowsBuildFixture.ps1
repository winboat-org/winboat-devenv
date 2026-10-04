Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$build='C:\WinBoatDev\build\' + (Split-Path $env:WINBOAT_JOB_ROOT -Leaf)
New-Item -ItemType Directory -Path $build -Force | Out-Null
$code='__declspec(dllexport) int wbfixture(void) { return WBVALUE; }'
[IO.File]::WriteAllText((Join-Path $build 'fixture.c'),$code)
foreach($arch in @('x64','x86')) {
    $directory=Join-Path $build $arch
    New-Item -ItemType Directory -Path $directory | Out-Null
    Import-ControlBuildEnvironment $arch
    $commands=@('@echo off',('cd /d "'+$directory+'"'),'cl.exe /nologo /LD /MT /Zi /DWBVALUE=42 ..\fixture.c /link /DEBUG /OUT:fixture.dll /PDB:fixture.pdb','if errorlevel 1 exit /b %errorlevel%','cl.exe /nologo /LD /MT /Zi /DWBVALUE=43 ..\fixture.c /link /DEBUG /OUT:replacement.dll /PDB:replacement.pdb','exit /b %errorlevel%')
    $commands | Set-Content (Join-Path $directory 'build.cmd') -Encoding ASCII
    & cmd.exe /d /c (Join-Path $directory 'build.cmd')
    if($LASTEXITCODE) {exit $LASTEXITCODE}
    $llvm='C:\WinBoatDev\tools\LLVM\bin\llvm-readobj.exe'
    & $llvm --file-headers --coff-imports (Join-Path $directory 'fixture.dll')
    if($LASTEXITCODE) {exit $LASTEXITCODE}
}
$files=@(Get-ChildItem $build -Recurse -File | Where-Object Extension -in @('.dll','.pdb') | ForEach-Object {@{path=$_.FullName;sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower();size=$_.Length}})
[IO.File]::WriteAllText((Join-Path $env:WINBOAT_JOB_ROOT 'fixture-build.json'),(@{schemaVersion=1;state='built';files=$files;buildRoot=$build;cargoTarget=$env:CARGO_TARGET_DIR}|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
