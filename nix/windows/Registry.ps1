param([ValidateSet('show','reconcile','verify')][string]$Mode='reconcile')
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$root = 'C:\ProgramData\WinBoatDev'
$registryPath = Join-Path $root 'stack-registry.json'
if ($Mode -eq 'show') {
    $stored=if(Test-Path $registryPath) {Read-ControlJson $registryPath} else {@{schemaVersion=1;state='unknown';entries=@()}}
    Write-ControlJson $stored (Join-Path $env:WINBOAT_JOB_ROOT 'registry-result.json')
    exit 0
}
Add-Type -Path (Join-Path $env:WINBOAT_CONTROL_ROOT 'LoadedIdentity.cs')
$previous = if (Test-Path $registryPath) {Read-ControlJson $registryPath} else {$null}
$entries = [Collections.Generic.List[object]]::new()
$transactions=@(Get-ChildItem (Join-Path $root 'transactions') -Filter 'transaction.json' -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {Read-ControlJson $_.FullName})
function Add-ObservedFile([string]$Path, [string]$Role, [string]$Architecture='unknown', [string]$ExpectedHash='', $Provenance=$null) {
    $desired=if($ExpectedHash){@{sha256=$ExpectedHash.ToLower()}}else{$null}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if($ExpectedHash) {$entries.Add(@{role=$Role;path=$Path;sha256=$null;desired=$desired;built=$null;staged=$null;installed='drift';reason='missing';loaded=@();provenance=$Provenance})}
        return
    }
    $file = Get-Item -LiteralPath $Path
    $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
    $state = if ($ExpectedHash) {if($hash -eq $ExpectedHash.ToLower()) {'verified'} else {'drift'}} else {'unknown'}
    $entries.Add(@{role=$Role;path=$file.FullName;sha256=$hash;size=$file.Length;version=$file.VersionInfo.FileVersion;architecture=$Architecture;desired=$desired;built=$null;staged=$null;installed=$state;provenance=$Provenance;loaded=@()})
}
foreach($transaction in $transactions) {
    if($transaction.state -eq 'rolled-back') {continue}
    $provenance=@{operationId=$transaction.operationId;manifestSha256=$transaction.manifestSha256;kind='fixture-transaction';source=$null}
    foreach($file in $transaction.changed) {Add-ObservedFile $file.path 'install-fixture' 'unknown' $file.sha256 $provenance}
    if($transaction.PSObject.Properties['expectedRegistration']) {
        $expected=$transaction.expectedRegistration
        $current=if(Test-Path $expected.key) {(Get-Item $expected.key).GetValue($expected.name,$null)} else {$null}
        $entries.Add(@{role='fixture-registration';path=$expected.key;name=$expected.name;expected=$expected.value;observed=$current;desired=$expected;built=$null;staged=$null;provenance=$provenance;loaded=@();installed=if($current -eq $expected.value){'verified'} else {'drift'}})
    }
}
$provisioning = Read-ControlJson (Join-Path $root 'provisioning.json')
$installStatePath = Join-Path $env:ProgramData 'Helios\install-state.json'
$installState = if (Test-Path $installStatePath) {Get-Content -Raw $installStatePath | ConvertFrom-Json} else {$null}
$devices = @(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceID -like 'PCI\VEN_1AF4&DEV_1050*' })
$drivers = @(Get-CimInstance Win32_SystemDriver | Where-Object { $_.Name -match '(?i)helios|wbdev-test' } | Select-Object Name,State,PathName,StartMode)
$registration = @{}
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine',$view)
    try {
        foreach ($path in @('SOFTWARE\Khronos\Vulkan\Drivers','SOFTWARE\Khronos\OpenCL\Vendors','SOFTWARE\Microsoft\Windows NT\CurrentVersion\OpenGLDrivers')) {
            $key = $hive.OpenSubKey($path)
            if ($key) {
                try {
                    $values=@{}
                    foreach($name in $key.GetValueNames()) {$values[$name]=$key.GetValue($name)}
                    $registration[$view.ToString()+':'+$path]=$values
                    foreach($name in $key.GetValueNames()) {
                        if (Test-Path -LiteralPath $name -PathType Leaf) {
                            Add-ObservedFile $name 'ICD-registration' $view.ToString()
                            if ($name -like '*.json') {
                                $icd=Get-Content -Raw -LiteralPath $name | ConvertFrom-Json
                                $library=$icd.ICD.library_path
                                if(-not [IO.Path]::IsPathRooted($library)) {$library=Join-Path (Split-Path $name -Parent) $library}
                                Add-ObservedFile $library 'Vulkan-ICD' $view.ToString()
                            }
                        }
                    }
                } finally {$key.Dispose()}
            }
        }
    } finally {$hive.Dispose()}
}
foreach ($device in $devices) {
    if($device.InfName) {Add-ObservedFile (Join-Path 'C:\Windows\INF' $device.InfName) 'active-INF' 'x64'}
    $deviceKey = Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Enum\' + $device.DeviceID) -ErrorAction SilentlyContinue
    if ($deviceKey -and $deviceKey.PSObject.Properties['Driver']) {
        $classPath='HKLM:\SYSTEM\CurrentControlSet\Control\Class\' + $deviceKey.Driver
        $key=Get-Item -LiteralPath $classPath
        $values=@{}
        foreach($name in @('UserModeDriverName','UserModeDriverNameWoW','InstalledDisplayDrivers','OpenGLDriverName','OpenGLDriverNameWow')) {
            $values[$name]=$key.GetValue($name,$null)
            foreach($path in @($values[$name])) {
                if($path -and [IO.Path]::IsPathRooted($path)) {
                    $expectedHash=''
                    if($installState -and $installState.PSObject.Properties['driverFiles']) {
                        $matching=@($installState.driverFiles | Where-Object name -eq ([IO.Path]::GetFileName($path)))
                        if($matching.Count -eq 1) {$expectedHash=$matching[0].sha256}
                    }
                    $architecture=if($name -match 'WoW|Wow') {'x86'} else {'x64'}
                    Add-ObservedFile $path $name $architecture $expectedHash
                    if($name -eq 'UserModeDriverName') {
                        $store=Split-Path $path -Parent
                        foreach($file in Get-ChildItem $store -File | Where-Object Extension -in @('.sys','.inf','.cat')) {Add-ObservedFile $file.FullName 'DriverStore-package' 'x64'}
                    }
                }
            }
        }
        $registration[$classPath]=$values
    }
}
if($installState) {
    if($installState.PSObject.Properties['runtimeFiles']) {foreach($file in $installState.runtimeFiles) {Add-ObservedFile $file.path 'Helios-runtime' 'unknown' $file.sha256}}
    # Package paths and hashes belong to installed-state evidence, separately
    # from active DriverStore/PnP registration and mapped process code.
}
foreach($architecture in @('x64','x86')) {
    $systemDirectory=if($architecture -eq 'x64') {'C:\Windows\System32'} else {'C:\Windows\SysWOW64'}
    foreach($file in @('vulkan-1.dll','OpenCL.dll')) {Add-ObservedFile (Join-Path $systemDirectory $file) 'Khronos-loader' $architecture}
}
$mapped=[Collections.Generic.List[object]]::new()
$observationErrors=[Collections.Generic.List[object]]::new()
foreach($process in Get-Process) {
    try {
        foreach($module in $process.Modules) {
            if($module.ModuleName -notmatch '(?i)helios|vulkan_virtio|clvk|gallium|vulkan-1|OpenCL|^fixture\.dll$') {continue}
            $status='unknown';$errorMessage=$null
            try {$status=[WinBoatLoadedIdentity]::Verify($process.Id,$module.BaseAddress.ToInt64(),$module.FileName)} catch {$errorMessage=$_.ToString()}
            $mapped.Add(@{pid=$process.Id;process=$process.ProcessName;sessionId=$process.SessionId;processStart=$process.StartTime.ToUniversalTime().ToString('o');path=$module.FileName;baseAddress=$module.BaseAddress.ToInt64();mappedCode=$status;error=$errorMessage})
        }
    } catch { if($process.ProcessName -in @('dwm','explorer')) {$observationErrors.Add(@{pid=$process.Id;process=$process.ProcessName;state='unknown';error=$_.ToString()})} }
}
foreach($entry in $entries) {
    if($entry.ContainsKey('loaded')) {$entry.loaded=@($mapped | Where-Object path -eq $entry.path)}
}
$certificates=@(Get-ChildItem Cert:\LocalMachine\Root,Cert:\LocalMachine\TrustedPublisher | Where-Object Subject -match 'WinBoat|Helios' | Select-Object Subject,Thumbprint,NotAfter)
$drift=@($entries | Where-Object installed -eq 'drift')
function RegistrationIdentity($Object) {
    $rows=@()
    $keys=if($Object -is [Collections.IDictionary]) {@($Object.Keys | Sort-Object)} else {@($Object.PSObject.Properties | ForEach-Object Name | Sort-Object)}
    foreach($key in $keys) {
        $values=$Object.$key
        $names=if($values -is [Collections.IDictionary]) {@($values.Keys | Sort-Object)} else {@($values.PSObject.Properties | ForEach-Object Name | Sort-Object)}
        foreach($name in $names) {$rows += "$key|$name|" + ($values.$name | ConvertTo-Json -Depth 10 -Compress)}
    }
    return $rows -join "`n"
}
if($previous -and $previous.PSObject.Properties['registrations']) {
    if((RegistrationIdentity $previous.registrations) -ne (RegistrationIdentity $registration)) {$observationErrors.Add(@{role='registration';state='drift';previousObservation=$previous.observed})}
}
$value=@{schemaVersion=1;observed=[DateTime]::UtcNow.ToString('o');bootTime=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');provisioning=$provisioning;entries=@($entries.ToArray());devices=$devices;systemDrivers=$drivers;registrations=$registration;certificates=$certificates;loadedImages=@($mapped.ToArray());observationErrors=@($observationErrors.ToArray());installState=$installState;transactions=$transactions;state=if($drift.Count -or @($observationErrors | Where-Object state -eq 'drift').Count){'drift'} else {'observed'};loadedKernelIdentity='unknown-requires-kernel-image-evidence';installedVerified=$false;loadedVerified=$false}
Write-ControlJson $value $registryPath
Write-ControlJson $value (Join-Path $env:WINBOAT_JOB_ROOT 'registry-result.json')
if($Mode -eq 'verify') {exit 76} # Full kernel/stack verification is still required.
