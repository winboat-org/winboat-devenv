Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\WinBoatDev'
New-Item -ItemType Directory -Path $root -Force | Out-Null
& icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect provisioning state' }
& powercfg.exe /hibernate off
if ($LASTEXITCODE -ne 0) { throw 'Cannot disable hybrid shutdown for durable startup tasks' }
foreach ($file in @('Provision.ps1', 'Autologin.ps1', 'Toolchain.ps1', 'Mirror.ps1', 'BuildFixture.ps1', 'TestDriver.c', 'provision.lock.json', 'authorized_keys',
                    'share-password', 'ssh_host_ed25519_key', 'ssh_host_ed25519_key.pub')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $root $file) -Force
}
. (Join-Path $root 'Autologin.ps1')
Set-DevboxAutologin -ComputerName (Get-CimInstance Win32_ComputerSystem).Name | Out-Null
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$root\Provision.ps1`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 12) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'WinBoatDev-Provision' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'WinBoatDev-Provision'
# The scheduled SYSTEM task survives this login, SSH/MCP disconnects and reboot.
