$ErrorActionPreference = 'Stop'
# No /f: an application may veto shutdown. The host observes completion and
# preserves the guest on timeout rather than killing QEMU implicitly.
& "$env:SystemRoot\System32\shutdown.exe" /s /t 0
if ($LASTEXITCODE -ne 0) { throw "Windows shutdown request failed: $LASTEXITCODE" }
