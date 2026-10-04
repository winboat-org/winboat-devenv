. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$root = 'C:\ProgramData\WinBoatDev'
$inventory = Read-ControlJson (Join-Path $root 'provisioning.json')
$lockPath = Join-Path $root 'provision.lock.json'
if ((Get-FileHash $lockPath -Algorithm SHA256).Hash.ToLower() -ne $inventory.lockSha256) { throw 'Prepared toolchain lock changed' }
$tool = @((Read-ControlJson $lockPath).tools | Where-Object id -eq 'powershell')
if ($tool.Count -ne 1 -or $tool[0].status -ne 'locked' -or @($tool[0].payloads).Count -ne 1) { throw 'Expected one locked PowerShell MSI' }
$payload = $tool[0].payloads[0]
$msi = Join-Path $root ('downloads\' + $payload.sha256 + '\' + $payload.file)
if ((Get-FileHash $msi -Algorithm SHA256).Hash.ToLower() -ne $payload.sha256) { throw 'Cached PowerShell input differs from its lock' }
$output = Join-Path $env:WINBOAT_JOB_ROOT 'tool-recovery'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$statePath = Join-Path $output 'state.json'
$task = Get-ScheduledTask -TaskName 'WinBoatDev-Provision'
function Read-ProductUpdateOptions {
    $hive=[Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine',[Microsoft.Win32.RegistryView]::Registry64)
    try {
        $product=$hive.OpenSubKey('SOFTWARE\Microsoft\PowerShellCore')
        $saved=$hive.OpenSubKey('SOFTWARE\Microsoft\PowerShellCore\InstallerProperties')
        try {
            return @{useMU=if($product){$product.GetValue('UseMU',$null)}else{$null};
                savedUseMU=if($saved){$saved.GetValue('UseMU',$null)}else{$null};
                savedEnableMU=if($saved){$saved.GetValue('EnableMU',$null)}else{$null}}
        } finally {if($product){$product.Dispose()};if($saved){$saved.Dispose()}}
    } finally {$hive.Dispose()}
}
function Read-GlobalUpdateServices {
    $manager=New-Object -ComObject Microsoft.Update.ServiceManager
    return (@($manager.Services | ForEach-Object {
        '{0}:{1}:{2}' -f $_.ServiceID,$_.IsRegisteredWithAU,$_.IsDefaultAUService
    } | Sort-Object) -join '|')
}
if (Test-Path $statePath) {
    $state=@{}
    foreach($property in (Read-ControlJson $statePath).PSObject.Properties) {$state[$property.Name]=$property.Value}
} else {
    $products = @(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object {
        $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'PowerShell 7-x64'
    })
    if ($products.Count -ne 1 -or $products[0].DisplayVersion -notmatch '^7\.6\.\d+\.\d+$' -or $products[0].PSChildName -notmatch '^\{[A-Fa-f0-9-]+\}$') { throw 'Refusing an unknown or ambiguous PowerShell installation' }
    $state=@{schemaVersion=1;state='preflight';sourceLockSha256=$inventory.lockSha256;payloadSha256=$payload.sha256;desired=$tool[0].version;
        prior=@{version=$products[0].DisplayVersion;productCode=$products[0].PSChildName;fileSha256=(Get-FileHash 'C:\Program Files\PowerShell\7\pwsh.exe' -Algorithm SHA256).Hash.ToLower()};provisioningEnabled=($task.State -ne 'Disabled');lastStep='preflight';exitCode=0;observed=$null;fileSha256=$null;rebootRequired=$false}
    # Preserve the original MSI before removing its product. A failed recovery
    # retains both the old package and the exact selected replacement input.
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $localPackage = $installer.GetType().InvokeMember('ProductInfo',[Reflection.BindingFlags]::GetProperty,$null,$installer,@($products[0].PSChildName,'LocalPackage'))
    if (-not (Test-Path -LiteralPath $localPackage -PathType Leaf)) { throw 'The previous PowerShell MSI is unavailable for recovery' }
    Copy-Item -LiteralPath $localPackage -Destination (Join-Path $output 'prior.msi')
    $state.prior.packageSha256=(Get-FileHash (Join-Path $output 'prior.msi') -Algorithm SHA256).Hash.ToLower()
    Write-ControlJson $state $statePath
}
if(-not $state.ContainsKey('updateOptionsBefore')) {
    $state.updateOptionsBefore=Read-ProductUpdateOptions
    $state.globalUpdateServicesBefore=Read-GlobalUpdateServices
    Write-ControlJson $state $statePath
}
function Invoke-Msi([string[]]$Arguments,[string]$Step) {
    for ($attempt=0;$attempt -lt 30;$attempt++) {
        $process=Start-Process msiexec.exe -ArgumentList ($Arguments + @('/qn','/norestart','/l*v',('"'+(Join-Path $output "$Step.log")+'"'))) -Wait -PassThru
        if ($process.ExitCode -ne 1618) {break}
        Start-Sleep -Seconds 2
    }
    $state.lastStep=$Step;$state.exitCode=$process.ExitCode;Write-ControlJson $state $statePath
    if ($process.ExitCode -notin @(0,3010)) {exit $process.ExitCode}
    if ($process.ExitCode -eq 3010) {$state.rebootRequired=$true;Write-ControlJson $state $statePath}
}
Disable-ScheduledTask -TaskName 'WinBoatDev-Provision' | Out-Null
try {
    $deadline=(Get-Date).AddSeconds(60)
    while ((Get-ScheduledTask -TaskName 'WinBoatDev-Provision').State -eq 'Running') {
        if ((Get-Date) -gt $deadline) { throw 'Provisioning is still running; no product was removed' }
        Start-Sleep -Seconds 2
    }
    $actual=if(Test-Path 'C:\Program Files\PowerShell\7\pwsh.exe') {(& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -Command '$PSVersionTable.PSVersion.ToString()').Trim()} else {''}
    if ($actual -ne $tool[0].version) {
        if (Test-Path 'C:\Program Files\PowerShell\7\pwsh.exe') {
            $hash=(Get-FileHash 'C:\Program Files\PowerShell\7\pwsh.exe' -Algorithm SHA256).Hash.ToLower()
            if ($hash -ne $state.prior.fileSha256) {throw 'Installed PowerShell changed after recovery preflight'}
            $state.state='removing-drift';Write-ControlJson $state $statePath
            Invoke-Msi @('/x',$state.prior.productCode) 'remove-drift'
        }
        $state.state='installing-locked';Write-ControlJson $state $statePath
        # USE_MU opts this product out; ENABLE_MU=0 leaves global MU unchanged.
        Invoke-Msi @('/i',('"'+$msi+'"'),'USE_MU=0','ENABLE_MU=0') 'install-locked'
    } else {
        $options=Read-ProductUpdateOptions
        if($options.useMU -eq 1 -or $options.savedUseMU -ne '0' -or $options.savedEnableMU -ne '0') {
            $state.state='opting-out-locked';Write-ControlJson $state $statePath
            # Repair this exact MSI's registry settings even when its installed
            # version already matches. Missing/older files retain MSI's checks.
            Invoke-Msi @('/fmu',('"'+$msi+'"'),'USE_MU=0','ENABLE_MU=0') 'opt-out-locked'
            $options=Read-ProductUpdateOptions
            if($options.useMU -eq 1 -or $options.savedUseMU -ne '0') {
                # MSI repair can retain the already installed conditional MU
                # component. Reinstall the preserved, selected product to let
                # the installer remove that component through its own rules.
                $hash=(Get-FileHash 'C:\Program Files\PowerShell\7\pwsh.exe' -Algorithm SHA256).Hash.ToLower()
                if($hash -ne $state.prior.fileSha256) {throw 'PowerShell changed during update-option repair'}
                $state.state='reinstalling-locked';Write-ControlJson $state $statePath
                Invoke-Msi @('/x',$state.prior.productCode) 'remove-update-component'
                Invoke-Msi @('/i',('"'+$msi+'"'),'USE_MU=0','ENABLE_MU=0') 'reinstall-locked'
            }
        }
    }
    $actual=(& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -Command '$PSVersionTable.PSVersion.ToString()').Trim()
    if ($LASTEXITCODE -or $actual -ne $tool[0].version) {throw 'Restored PowerShell does not pass its locked installed probe'}
    $state.updateOptionsAfter=Read-ProductUpdateOptions
    $state.globalUpdateServicesAfter=Read-GlobalUpdateServices
    Write-ControlJson $state $statePath
    if($state.updateOptionsAfter.useMU -notin @($null,0) -or
        $state.updateOptionsAfter.savedUseMU -ne '0' -or $state.updateOptionsAfter.savedEnableMU -ne '0') {throw 'PowerShell product update opt-out did not take effect'}
    if($state.globalUpdateServicesAfter -ne $state.globalUpdateServicesBefore) {throw 'Global Microsoft Update services changed during PowerShell recovery'}
    $state.state='restored';$state.observed=$actual;$state.fileSha256=(Get-FileHash 'C:\Program Files\PowerShell\7\pwsh.exe' -Algorithm SHA256).Hash.ToLower()
    Write-ControlJson $state $statePath
    $state | ConvertTo-Json -Depth 12
    if ($state.rebootRequired) {exit 3010}
} finally {
    if ($state.provisioningEnabled) {Enable-ScheduledTask -TaskName 'WinBoatDev-Provision' | Out-Null;Start-ScheduledTask -TaskName 'WinBoatDev-Provision'}
}
