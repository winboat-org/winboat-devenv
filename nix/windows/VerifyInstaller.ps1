param([Parameter(Mandatory)][string]$Directory)
. (Join-Path $PSScriptRoot 'Control.ps1')
$Directory = (Resolve-Path -LiteralPath $Directory).Path
$manifest = Read-ControlJson (Join-Path $Directory 'component.json')
if ($manifest.schemaVersion -ne 1 -or $manifest.target -ne 'helios-installer') { throw 'Wrong installer artifact' }
$entry = @($manifest.files | Where-Object path -eq 'files/HeliosSetup.exe')
if ($entry.Count -ne 1) { throw 'Missing or duplicate prebuilt installer' }
$packer = Assert-ControlPath (Join-Path $Directory $entry[0].path) $Directory
Assert-ControlFile $packer $entry[0].sha256 $entry[0].size
$infoPath = Join-Path $env:RUNNER_TEMP ('packer-interface-' + [Guid]::NewGuid().ToString('N') + '.json')
$probe = Start-Process -FilePath $packer -ArgumentList ('--packer-info "{0}"' -f $infoPath) -PassThru
if (-not $probe.WaitForExit(15000)) { $probe.Kill(); throw 'Prebuilt installer interface timed out' }
if ($probe.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $infoPath)) { throw 'Prebuilt installer interface failed' }
$info = Read-ControlJson $infoPath
if ($info.interfaceVersion -ne 1 -or $info.format -ne 'HLIOSET2') { throw 'Stale prebuilt installer interface' }
$info | ConvertTo-Json -Compress
