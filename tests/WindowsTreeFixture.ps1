. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$build=Join-Path 'C:\WinBoatDev\build' (Split-Path $env:WINBOAT_JOB_ROOT -Leaf)
$root=Join-Path $build 'tree'
New-Item -ItemType Directory -Path $root -Force | Out-Null
$path=Join-Path $root 'source.txt'
[IO.File]::WriteAllText($path,'verified source')
$file=@{path='source.txt';sha256=(Get-FileHash $path -Algorithm SHA256).Hash.ToLower();size=(Get-Item $path).Length}
Assert-ControlTree $root @($file)
$refused=@()
function Assert-Refused([string]$Name,[ScriptBlock]$Action) {
    $failed=$false
    try {& $Action} catch {$failed=$true}
    if(-not $failed) {throw "Input tree accepted $Name"}
}
[IO.File]::WriteAllText((Join-Path $root 'unexpected.dll'),'unmanifested')
Assert-Refused 'extra-file' {Assert-ControlTree $root @($file)}
$refused+='extra-file'
Remove-Item (Join-Path $root 'unexpected.dll')
[IO.File]::WriteAllText($path,'different source')
Assert-Refused 'changed-file' {Assert-ControlTree $root @($file)}
$refused+='changed-file'
[IO.File]::WriteAllText($path,'verified source')
Assert-Refused 'escaping-file' {Assert-ControlTree $root @(@{path='..\outside.txt';sha256=$file.sha256;size=$file.size})}
$refused+='escaping-file'
$outside=Join-Path $build 'outside'
New-Item -ItemType Directory -Path $outside | Out-Null
New-Item -ItemType Junction -Path (Join-Path $root 'linked') -Target $outside | Out-Null
Assert-Refused 'junction' {Assert-ControlTree $root @($file)}
$refused+='junction'
$symbolRoot=Join-Path $build 'separate-symbols'
New-Item -ItemType Directory -Path $symbolRoot | Out-Null
$runtime=Join-Path $symbolRoot 'runtime.dll'
$symbol=Join-Path $symbolRoot 'runtime.pdb'
[IO.File]::WriteAllText($runtime,'runtime bytes')
[IO.File]::WriteAllText($symbol,'symbol bytes')
$symbolFiles=@(Get-ChildItem $symbolRoot -File | ForEach-Object {
    @{path=$_.Name;sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower();size=$_.Length}
})
[IO.File]::WriteAllText($symbol,'unused bytes')
Assert-Refused 'strict-symbol-hash' {Assert-ControlTree $symbolRoot $symbolFiles}
Assert-ControlTree $symbolRoot $symbolFiles -SkipSymbolHashes
[IO.File]::WriteAllText($runtime,'changed bytes')
Assert-Refused 'runtime-hash-with-separate-symbols' {Assert-ControlTree $symbolRoot $symbolFiles -SkipSymbolHashes}
[IO.File]::WriteAllText($runtime,'runtime bytes')
[IO.File]::WriteAllText($symbol,'different-sized symbol')
Assert-Refused 'symbol-size' {Assert-ControlTree $symbolRoot $symbolFiles -SkipSymbolHashes}
$refused+=@('strict-symbol-hash','runtime-hash-with-separate-symbols','symbol-size')
Write-ControlJson @{schemaVersion=1;state='passed';verifiedOriginal=$true;separateSymbolPolicy=$true;refused=$refused} (Join-Path $env:WINBOAT_JOB_ROOT 'tree-fixture.json')
@{state='passed';refused=$refused}|ConvertTo-Json -Compress
