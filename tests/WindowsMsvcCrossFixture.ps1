. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$results=@()
foreach($architecture in @('x64','x86')) {
    $program=Join-Path $env:WINBOAT_JOB_ROOT "probe-$architecture.exe"
    $text=(& $program | Out-String)
    if($LASTEXITCODE) {exit $LASTEXITCODE}
    $result=$text | ConvertFrom-Json
    $bits=if($architecture -eq 'x64') {64} else {32}
    if($result.state -ne 'passed' -or $result.pointerBits -ne $bits -or $result.result -ne 42) {
        throw 'Cross-built C++ executable failed runtime or architecture verification'
    }
    $results+=@{architecture=$architecture;result=$result}
}
Write-ControlJson @{schemaVersion=1;state='passed';results=$results} (Join-Path $env:WINBOAT_JOB_ROOT 'msvc-cross-fixture.json')
