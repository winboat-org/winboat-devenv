. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$operation='op-'+[Guid]::NewGuid().ToString('N')
$directory=Join-Path 'C:\WinBoatDev\src' $operation
$archive=Join-Path $env:WINBOAT_JOB_ROOT 'snapshot-fixture.zip'
$content=[Text.Encoding]::UTF8.GetBytes('verified snapshot fixture')
$sha=[Security.Cryptography.SHA256]::Create()
try {$hash=([BitConverter]::ToString($sha.ComputeHash($content))).Replace('-','').ToLower()} finally {$sha.Dispose()}
$zip=[IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)
try {
    $entry=$zip.CreateEntry('nested/input.txt')
    $stream=$entry.Open()
    try {$stream.Write($content,0,$content.Length)} finally {$stream.Dispose()}
} finally {$zip.Dispose()}
$request=@{schemaVersion=1;operationId=$operation;mode='fixture';sources=@{};
    files=@(@{path='nested/input.txt';sha256=$hash;size=$content.Length});archive=$archive;
    archiveSha256=(Get-FileHash $archive -Algorithm SHA256).Hash.ToLower();archiveSize=(Get-Item $archive).Length}
$specification=Join-Path $env:WINBOAT_JOB_ROOT 'snapshot-fixture.json'
Write-ControlJson $request $specification
$snapshot=Join-Path $env:WINBOAT_JOB_ROOT 'Snapshot.ps1'
& $snapshot -Specification $specification | Out-Null
Assert-ControlFile (Join-Path $directory 'nested/input.txt') $hash $content.Length
[IO.File]::WriteAllText((Join-Path $directory 'nested/input.txt'),'changed')
& $snapshot -Specification $specification | Out-Null
Assert-ControlFile (Join-Path $directory 'nested/input.txt') $hash $content.Length
$extra=Join-Path $directory 'extra.txt'
[IO.File]::WriteAllText($extra,'unexpected')
$refused=$false
try {& $snapshot -Specification $specification | Out-Null} catch {$refused=$true}
if(-not $refused) {throw 'Snapshot accepted an extra file on resume'}
Remove-Item -LiteralPath $extra
$outside=Join-Path $env:WINBOAT_JOB_ROOT 'outside'
New-Item -ItemType Directory -Path $outside | Out-Null
$junction=Join-Path $directory 'escape'
New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
$refused=$false
try {& $snapshot -Specification $specification | Out-Null} catch {$refused=$true}
if(-not $refused) {throw 'Snapshot accepted a junction on resume'}
Write-ControlJson @{state='passed';snapshotOperation=$operation;valid=$true;tamperRepaired=$true;
    extraFileRefused=$true;junctionRefused=$true} (Join-Path $env:WINBOAT_JOB_ROOT 'snapshot-fixture-result.json')
Write-Output 'Snapshot extraction/resume, repaired content, extra-file and junction checks passed'
