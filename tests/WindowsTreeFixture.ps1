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
Write-ControlJson @{schemaVersion=1;state='passed';verifiedOriginal=$true;refused=$refused} (Join-Path $env:WINBOAT_JOB_ROOT 'tree-fixture.json')
@{state='passed';refused=$refused}|ConvertTo-Json -Compress
