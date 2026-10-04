param([string]$Value='encoded '' quotes & $literal', [int]$ExitCode=0, [int]$Seconds=12)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$git=Get-Command git.exe -ErrorAction SilentlyContinue
$evidence=@{principal=[Security.Principal.WindowsIdentity]::GetCurrent().Name;sessionId=(Get-Process -Id $PID).SessionId;purpose=$env:WINBOAT_PURPOSE;argument=$Value;cargoTarget=$env:CARGO_TARGET_DIR;git=if($git){$git.Source}else{$null};pid=$PID}
for($tick=0;$tick -lt $Seconds;$tick++) {
    Write-Output "tick=$tick pid=$PID"
    Start-Sleep -Seconds 1
}
$evidence | ConvertTo-Json -Compress
if($env:WINBOAT_JOB_ROOT) {
    [IO.File]::WriteAllText((Join-Path $env:WINBOAT_JOB_ROOT 'fixture-result.json'),($evidence|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
}
exit $ExitCode
