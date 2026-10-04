param([Parameter(Mandatory)][string]$BuildResult)
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$result=Read-ControlJson $BuildResult
if ($result.schemaVersion -ne 1 -or $result.state -ne 'built' -or $result.operationId -notmatch '^op-[a-f0-9]{32}$') {throw 'Unexpected original build result'}
$source=Assert-ControlPath $result.output 'C:\WinBoatDev\build'
if ($source -ne "C:\WinBoatDev\build\$($result.operationId)\artifact") {throw 'Original artifact output differs from its operation'}
$expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in $result.files) {
    if (-not $expected.Add($file.path)) {throw 'Duplicate artifact output path'}
    $path=Assert-ControlPath (Join-Path $source $file.path) $source
    Assert-ControlFile $path $file.sha256 $file.size
}
$actual=@(Get-ChildItem $source -Recurse -File)
if ($actual.Count -ne $expected.Count) {throw 'Artifact contains unmanifested files'}
foreach ($file in $actual) {
    [void](Assert-ControlPath $file.FullName $source)
    if (-not $expected.Contains($file.FullName.Substring($source.Length+1).Replace('\','/'))) {throw 'Unexpected artifact path'}
}
$build=Join-Path 'C:\WinBoatDev\build' (Split-Path $env:WINBOAT_JOB_ROOT -Leaf)
New-Item -ItemType Directory -Path $build -Force | Out-Null
$archive=Join-Path $build 'artifact.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($source,$archive,[IO.Compression.CompressionLevel]::Optimal,$false)
Write-ControlJson @{path=$archive;sha256=(Get-FileHash $archive -Algorithm SHA256).Hash.ToLower();size=(Get-Item $archive).Length;originalOperationId=$result.operationId} (Join-Path $env:WINBOAT_JOB_ROOT 'artifact-export.json')
