Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinBoatPowerPolicy {
    [DllImport("powrprof.dll")]
    public static extern uint PowerReadACValueIndex(IntPtr root, ref Guid scheme, ref Guid subgroup, ref Guid setting, out uint value);
    [DllImport("powrprof.dll")]
    public static extern uint PowerReadDCValueIndex(IntPtr root, ref Guid scheme, ref Guid subgroup, ref Guid setting, out uint value);
}
'@
function Get-DevboxSleepPolicy {
    $schemes='HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
    $active=[Guid](Get-ItemProperty -LiteralPath $schemes).ActivePowerScheme
    $sleep=[Guid]'238c9fa8-0aad-41ed-83f4-97be242c8f20'
    $settings=@()
    foreach($id in @('29f6c1db-86da-48c5-9fdb-f2b67b1f44da','7bc4a2f9-d8fc-4469-b07b-33eb785aaca0')) {
        $idle=[Guid]$id
        [uint32]$ac=0;[uint32]$dc=0
        $acCode=[WinBoatPowerPolicy]::PowerReadACValueIndex([IntPtr]::Zero,[ref]$active,[ref]$sleep,[ref]$idle,[ref]$ac)
        $dcCode=[WinBoatPowerPolicy]::PowerReadDCValueIndex([IntPtr]::Zero,[ref]$active,[ref]$sleep,[ref]$idle,[ref]$dc)
        if($acCode -or $dcCode) {throw "Cannot read devbox sleep policy: AC=$acCode DC=$dcCode"}
        $settings+=@{setting=$id;acSeconds=$ac;dcSeconds=$dc}
    }
    return @{scheme=$active.ToString();settings=$settings}
}
$before=Get-DevboxSleepPolicy
foreach($supply in @('ac','dc')) {
    & powercfg.exe /change "standby-timeout-$supply" 0
    if($LASTEXITCODE) {throw "Cannot disable automatic devbox sleep on $supply power"}
    & powercfg.exe "/set${supply}valueindex" SCHEME_CURRENT SUB_SLEEP '7bc4a2f9-d8fc-4469-b07b-33eb785aaca0' 0
    if($LASTEXITCODE) {throw "Cannot disable unattended devbox sleep on $supply power"}
}
& powercfg.exe /setactive $before.scheme
if($LASTEXITCODE) {throw 'Cannot activate the updated devbox sleep policy'}
$after=Get-DevboxSleepPolicy
if(@($after.settings | Where-Object {$_.acSeconds -ne 0 -or $_.dcSeconds -ne 0}).Count) {throw 'Automatic devbox sleep remains enabled'}
@{schemaVersion=1;before=$before;after=$after;observed=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 5
