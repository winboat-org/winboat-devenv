Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\ProgramData\WinBoatDev'
$statePath = Join-Path $root 'provisioning.json'
$lockPath = Join-Path $root 'provision.lock.json'
$lock = Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json
$mutex = New-Object Threading.Mutex($false, 'Global\WinBoatDev-Provision')
if (-not $mutex.WaitOne(0)) { exit 0 }
$state = @{ schemaVersion = 1; phase = 'bootstrap'; computerName = $env:COMPUTERNAME; username = 'wbdev';
    taskName = 'WinBoatDev-Provision'; retries = 0; rebootCount = 0; tools = @(); signedDriverLoaded = $false;
    lockSha256 = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLower() }
if (Test-Path -LiteralPath $statePath) {
    $saved = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ($saved.schemaVersion -ne 1 -or $saved.lockSha256 -ne $state.lockSha256) { throw 'Provision state/lock changed; explicit migration required' }
    foreach ($property in $saved.PSObject.Properties) { $state[$property.Name] = $property.Value }
}
function Save-State {
    $state.observed = (Get-Date).ToUniversalTime().ToString('o')
    $temp = $statePath + '.tmp'
    $state | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $statePath -Force
}
function Native([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File exited with $LASTEXITCODE" }
}
function Download-Payload($payload) {
    $destination = Join-Path $root ('downloads\' + $payload.sha256 + '-' + $payload.file)
    New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
    if (Test-Path -LiteralPath $destination) {
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLower() -eq $payload.sha256) { return $destination }
        throw 'Existing payload has an unexpected hash'
    }
    $state.phase = 'download'; $state.currentPayload = $payload.file; Save-State
    $partial = $destination + '.partial'
    Invoke-WebRequest -Uri $payload.url -OutFile $partial -UseBasicParsing
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLower() -ne $payload.sha256) { throw "Payload hash mismatch: $($payload.file)" }
    Move-Item -LiteralPath $partial -Destination $destination
    return $destination
}
try {
    Start-Transcript -Path (Join-Path $root 'provision.log') -Append | Out-Null
    $state.retries = [int]$state.retries + 1
    if ($lock.schemaVersion -ne 1 -or $env:COMPUTERNAME -ne 'WB-DEVBOX') { throw 'Guest identity or lock schema mismatch' }
    $pending = @($lock.tools | Where-Object status -ne 'locked' | ForEach-Object id)
    New-Item -ItemType Directory -Path 'C:\WinBoatDev\src', 'C:\WinBoatDev\build' -Force | Out-Null
    foreach ($tool in $lock.tools) {
        if ($tool.status -ne 'locked') { continue }
        $state.phase = 'install'; $state.currentTool = $tool.id; Save-State
        $paths = @($tool.payloads | ForEach-Object { Download-Payload $_ })
        $probe = [ScriptBlock]::Create($tool.probe)
        $observed = & $probe
        if (-not $observed -or [string]$observed -ne $tool.version) {
            $installer = [ScriptBlock]::Create($tool.install)
            & $installer $paths $root
            $observed = & $probe
            if ([string]$observed -ne $tool.version) { throw "Installed $($tool.id) version differs: expected $($tool.version), observed $observed" }
        }
        $state.tools = @($state.tools | Where-Object id -ne $tool.id) + @(@{ id = $tool.id; version = [string]$observed;
            verified = $true; payloads = $tool.payloads; componentIds = $tool.componentIds })
        Save-State
    }
    # Install pre-generated host keys so the host trusts an authenticated key;
    # neither ssh-keyscan nor accepting an unknown key establishes identity.
    $sshRoot = 'C:\ProgramData\ssh'
    New-Item -ItemType Directory -Path $sshRoot -Force | Out-Null
    foreach ($file in @('ssh_host_ed25519_key', 'ssh_host_ed25519_key.pub')) {
        Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $sshRoot $file) -Force
        Native 'icacls.exe' @((Join-Path $sshRoot $file), '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F')
    }
    Copy-Item -LiteralPath (Join-Path $root 'authorized_keys') -Destination (Join-Path $sshRoot 'administrators_authorized_keys') -Force
    Native 'icacls.exe' @((Join-Path $sshRoot 'administrators_authorized_keys'), '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F')
    @('Port 22', 'PubkeyAuthentication yes', 'PasswordAuthentication no',
      'HostKey __PROGRAMDATA__/ssh/ssh_host_ed25519_key', 'Match Group administrators',
      '    AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys') | Set-Content -LiteralPath (Join-Path $sshRoot 'sshd_config') -Encoding ASCII
    Set-Service sshd -StartupType Automatic
    Restart-Service sshd
    if (-not (Get-NetFirewallRule -Name 'WinBoatDev-SSH' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'WinBoatDev-SSH' -DisplayName 'WinBoatDev SSH' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow | Out-Null
    }
    $sharePassword = Get-Content -Raw -LiteralPath (Join-Path $root 'share-password')
    if (-not (Get-SmbMapping -LocalPath 'Z:' -ErrorAction SilentlyContinue)) {
        New-SmbMapping -LocalPath 'Z:' -RemotePath '\\10.0.2.2\workspace' -UserName 'wbdev' -Password $sharePassword -Persistent $true | Out-Null
    }
    $state.share = @{ drive = 'Z:\'; remote = '\\10.0.2.2\workspace'; session = 'SYSTEM'; verified = (Test-Path -LiteralPath 'Z:\README.md') }
    if (-not $state.share.verified) { throw 'Workspace SMB compatibility probe failed' }
    if ($pending.Count) { $state.phase = 'blocked-inputs'; $state.unresolvedInputs = $pending; Save-State; exit 3 }
    $secureBoot = $false
    try { $secureBoot = Confirm-SecureBootUEFI } catch { $state.secureBootDiagnostic = $_.Exception.Message }
    if ($secureBoot) { throw 'Secure Boot is enabled; test signing requires unenrolled Secure Boot keys in the persistent Nix firmware state' }
    $state.secureBoot = $secureBoot
    $state.hvci = @(Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty SecurityServicesRunning)
    $certificate = Get-ChildItem Cert:\LocalMachine\My | Where-Object Subject -eq 'CN=WinBoatDev Test Signing' | Select-Object -First 1
    if (-not $certificate) {
        $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=WinBoatDev Test Signing' -CertStoreLocation Cert:\LocalMachine\My -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(5)
    }
    $state.certificateThumbprint = $certificate.Thumbprint
    Export-Certificate -Cert $certificate -FilePath (Join-Path $root 'test-signing.cer') | Out-Null
    Import-Certificate -FilePath (Join-Path $root 'test-signing.cer') -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
    Import-Certificate -FilePath (Join-Path $root 'test-signing.cer') -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
    # Query the effective current boot entry after an actual reboot, not only the
    # requested on-disk BCD setting immediately after bcdedit /set.
    $bootId = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
    if (-not $state.ContainsKey('signingRequestedAtBoot')) {
        Native 'bcdedit.exe' @('/set', '{current}', 'testsigning', 'on')
        $state.signingRequestedAtBoot = $bootId
        $state.phase = 'reboot'; $state.rebootCount = [int]$state.rebootCount + 1; Save-State
        Restart-Computer -Force
        exit 3010
    }
    if ($state.signingRequestedAtBoot -eq $bootId) { throw 'Signing reboot has not occurred' }
    $bcd = & bcdedit.exe /enum '{current}'
    if ($LASTEXITCODE -ne 0 -or ($bcd -join "`n") -notmatch '(?im)^testsigning\s+Yes\s*$') { throw 'Effective TESTSIGNING is not enabled' }
    $state.effectiveBcd = $bcd; $state.phase = 'signing-fixture'; Save-State
    # Build/load verification is a provisioning fixture, separate from Helios.
    # A missing verified fixture is a pending live gate, never an invented load.
    $fixture = Join-Path $root 'fixture\wbdev-test.sys'
    if (-not (Test-Path -LiteralPath $fixture)) { & (Join-Path $root 'BuildFixture.ps1') -CertificateThumbprint $certificate.Thumbprint }
    $signature = Get-AuthenticodeSignature -FilePath $fixture
    if ($signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) { throw 'Fixture certificate differs from the devbox signing identity' }
    $fixtureHash = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLower()
    if ($state.signedDriverLoaded -and $state.fixtureSha256 -ne $fixtureHash) { throw 'Fixture changed since its retained load observation' }
    if (-not (Get-Service 'wbdev-test' -ErrorAction SilentlyContinue)) { Native 'sc.exe' @('create', 'wbdev-test', 'type=', 'kernel', 'binPath=', $fixture) }
    if ((Get-Service 'wbdev-test').Status -ne 'Running') { Native 'sc.exe' @('start', 'wbdev-test') }
    $driver = Get-CimInstance Win32_SystemDriver -Filter "Name='wbdev-test'"
    if ($driver.State -ne 'Running' -or $driver.PathName -ne $fixture) { throw 'Signed fixture driver did not load' }
    if ((Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLower() -ne $fixtureHash) { throw 'Fixture changed during load observation' }
    $state.signedDriverLoaded = $true; $state.fixtureSha256 = $fixtureHash
    $state.phase = 'verified'; Save-State
} catch {
    $state.failedPhase = $state.phase; $state.phase = 'failed'; $state.error = $_.Exception.Message; Save-State
    throw
} finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
