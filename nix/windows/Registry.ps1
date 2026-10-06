param([ValidateSet('show','reconcile','verify')][string]$Mode='reconcile')
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'RegistryProjection.ps1')
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
$observationErrors=[Collections.Generic.List[object]]::new()
$transactions=@(Get-ChildItem (Join-Path $root 'transactions') -Filter 'transaction.json' -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    $receipt=$_
    $record=Read-ControlJson $receipt.FullName
    # Rollback snapshots remain in their original durable receipt. Repeating
    # them inside each inventory recursively expands previous inventories.
    $summary=@{receipt=@{path=$receipt.FullName;sha256=(Get-FileHash -LiteralPath $receipt.FullName -Algorithm SHA256).Hash.ToLower();size=$receipt.Length}}
    foreach($field in @('schemaVersion','operationId','state','observed','manifestSha256','changed','expectedRegistration','requestedManifest')) {
        if($record.PSObject.Properties[$field]) {$summary[$field]=$record.$field}
    }
    [pscustomobject]$summary
})
function Add-ObservedFile([string]$Path, [string]$Role, [string]$Architecture='unknown', [string]$ExpectedHash='', $Provenance=$null, [switch]$DataFile) {
    $Provenance=Get-RegistryProvenanceSummary $Provenance
    $desired=if($ExpectedHash){@{sha256=$ExpectedHash.ToLower()}}else{$null}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if($ExpectedHash) {$entries.Add(@{role=$Role;path=$Path;sha256=$null;desired=$desired;built=$null;staged=$null;installed='drift';reason='missing';loaded=@();provenance=$Provenance})}
        return
    }
    $file = Get-Item -LiteralPath $Path
    $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
    $state = if ($ExpectedHash) {if($hash -eq $ExpectedHash.ToLower()) {'verified'} else {'drift'}} else {'unknown'}
    $actualArchitecture='unknown'
    if(-not $DataFile -and $file.Extension -in @('.dll','.sys','.exe')) {
        $stream=[IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
        $reader=[IO.BinaryReader]::new($stream)
        try {
            if($reader.ReadUInt16() -ne 0x5a4d) {throw 'Missing DOS image signature'}
            [void]$stream.Seek(60,[IO.SeekOrigin]::Begin);$pe=$reader.ReadInt32()
            if($pe -lt 64 -or $pe+6 -gt $stream.Length) {throw 'Invalid PE header offset'}
            [void]$stream.Seek($pe,[IO.SeekOrigin]::Begin)
            if($reader.ReadUInt32() -ne 0x4550) {throw 'Missing PE image signature'}
            $actualArchitecture=switch($reader.ReadUInt16()) {0x8664 {'x64'};0x14c {'x86'};default {'unknown'}}
            if($Architecture -in @('x64','x86') -and $Architecture -ne $actualArchitecture) {$state='drift'}
        } catch {$state='unknown';$observationErrors.Add(@{role=$Role;path=$Path;state='unknown';error=$_.ToString()})}
        finally {$reader.Dispose();$stream.Dispose()}
    }
    $built=if($ExpectedHash -and $Provenance) {@{sha256=$ExpectedHash.ToLower();provenance=$Provenance}} else {$null}
    $entries.Add(@{role=$Role;path=$file.FullName;sha256=$hash;size=$file.Length;version=$file.VersionInfo.FileVersion;architecture=$actualArchitecture;expectedArchitecture=$Architecture;desired=$desired;built=$built;staged=if($built){@{manifestSha256=$Provenance.manifestSha256}}else{$null};installed=$state;provenance=$Provenance;loaded=@()})
}
foreach($transaction in $transactions) {
    if($transaction.state -eq 'rolled-back') {continue}
    $provenance=@{operationId=$transaction.operationId;manifestSha256=$transaction.manifestSha256;kind='fixture-transaction';source=$null}
    # Installation fixtures contain deliberate text markers named fixture.dll.
    # Their installed identity is the manifested hash, without a PE claim.
    foreach($file in $transaction.changed) {Add-ObservedFile $file.path 'install-fixture' 'unknown' $file.sha256 $provenance -DataFile}
    if($transaction.PSObject.Properties['expectedRegistration']) {
        $expected=$transaction.expectedRegistration
        $current=if(Test-Path $expected.key) {(Get-Item $expected.key).GetValue($expected.name,$null)} else {$null}
        $entries.Add(@{role='fixture-registration';path=$expected.key;name=$expected.name;expected=$expected.value;observed=$current;desired=$expected;built=$null;staged=$null;provenance=$provenance;loaded=@();installed=if($current -eq $expected.value){'verified'} else {'drift'}})
    }
}
$provisioning = Read-ControlJson (Join-Path $root 'provisioning.json')
$lockPath=Join-Path $root 'provision.lock.json'
if ((Get-FileHash $lockPath -Algorithm SHA256).Hash.ToLower() -ne $provisioning.lockSha256) {throw 'Provisioning lock differs from its recorded identity'}
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Toolchain.ps1')
$observedTools=@()
foreach($tool in (Read-ControlJson $lockPath).tools) {
    if($tool.status -ne 'locked') {continue}
    $version=$null;$errorMessage=$null;$status='unknown';$global:LASTEXITCODE=0
    try {
        $version=((& ([ScriptBlock]::Create($tool.probe))) | Out-String).Trim()
        $status=if($LASTEXITCODE -or $version -cne $tool.version) {'drift'} else {'verified'}
    } catch {$errorMessage=$_.ToString()}
    $observedTools+=@{id=$tool.id;desired=$tool.version;installed=$version;state=$status;error=$errorMessage;observed=[DateTime]::UtcNow.ToString('o')}
    if($status -ne 'verified') {$observationErrors.Add(@{role='provisioning-tool';id=$tool.id;state=$status;desired=$tool.version;observed=$version;error=$errorMessage})}
}
$installStatePath = Join-Path $env:ProgramData 'Helios\install-state.json'
$installState = if (Test-Path $installStatePath) {Get-Content -Raw $installStatePath | ConvertFrom-Json} else {$null}
$requestedPackage=$null
$packageProvenance=$null
$packageTransactions=@($transactions | Where-Object {
    $_.PSObject.Properties['requestedManifest'] -and $_.requestedManifest.PSObject.Properties['packageId'] -and
    $_.state -ne 'rolled-back'
} | Sort-Object observed -Descending)
$desiredTransaction=if($packageTransactions.Count) {$packageTransactions[0]} else {$null}
$matchingTransactions=@($packageTransactions | Where-Object {$installState -and $_.requestedManifest.packageId -eq $installState.packageId})
if($matchingTransactions.Count) {
    $requestedPackage=$matchingTransactions[0].requestedManifest
    $packageProvenance=@{operationId=$matchingTransactions[0].operationId;manifestSha256=$matchingTransactions[0].manifestSha256;
        sources=$requestedPackage.source;artifacts=if($requestedPackage.PSObject.Properties['artifacts']) {$requestedPackage.artifacts} else {@()}}
}
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
    if($device.InfName) {
        $hash=if($installState -and $device.InfName -eq $installState.activeInf) {$installState.activeInfSha256} else {''}
        Add-ObservedFile (Join-Path 'C:\Windows\INF' $device.InfName) 'active-INF' 'x64' $hash $packageProvenance
    }
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
                    Add-ObservedFile $path $name $architecture $expectedHash $packageProvenance
                    if($name -eq 'UserModeDriverName') {
                        $store=Split-Path $path -Parent
                        foreach($file in Get-ChildItem $store -File | Where-Object Extension -in @('.sys','.inf','.cat')) {
                            $expected=@(if($requestedPackage) {$requestedPackage.files | Where-Object path -eq ('payload/driver/'+$file.Name)})
                            $hash=if($expected.Count -eq 1) {$expected[0].sha256} else {''}
                            Add-ObservedFile $file.FullName 'DriverStore-package' 'x64' $hash $packageProvenance
                        }
                    }
                }
            }
        }
        $registration[$classPath]=$values
    }
}
if($installState) {
    if($installState.PSObject.Properties['runtimeFiles']) {
        $runtime=Join-Path $installState.installRoot 'runtime'
        foreach($file in $installState.runtimeFiles) {
            $hash=$file.sha256
            if($requestedPackage) {
                if(-not $file.path.StartsWith($runtime+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'Runtime file escaped the managed installation'}
                $relative='payload/'+$file.path.Substring($runtime.Length+1).Replace('\','/')
                $expected=@($requestedPackage.files | Where-Object path -eq $relative)
                $hash=if($expected.Count -eq 1) {$expected[0].sha256} else {''}
            }
            Add-ObservedFile $file.path 'Helios-runtime' 'unknown' $hash $packageProvenance
        }
    }
    # Package paths and hashes belong to installed-state evidence, separately
    # from active DriverStore/PnP registration and mapped process code.
}
foreach($architecture in @('x64','x86')) {
    $systemDirectory=if($architecture -eq 'x64') {'C:\Windows\System32'} else {'C:\Windows\SysWOW64'}
    foreach($file in @('vulkan-1.dll','OpenCL.dll')) {
        $relative='payload/loaders/'+$(if($architecture -eq 'x86') {'x86/'} else {''})+$file
        $expected=@(if($requestedPackage) {$requestedPackage.files | Where-Object path -eq $relative})
        $hash=if($expected.Count -eq 1) {$expected[0].sha256} else {''}
        if($installState -and $expected.Count -eq 1) {
            $privatePath=Join-Path $installState.installRoot ('runtime\'+$relative.Substring('payload/'.Length).Replace('/','\'))
            Add-ObservedFile $privatePath 'Helios-package-loader' $architecture $hash $packageProvenance
        }
        # Global loaders may belong to an existing SDK. The installer preserves
        # them; their presence cannot acquire the selected package's provenance.
        Add-ObservedFile (Join-Path $systemDirectory $file) 'Khronos-global-loader' $architecture
    }
}
$mapped=[Collections.Generic.List[object]]::new()
$kernelModules=@()
try {$kernelModules=@([WinBoatKernelModule]::Query())} catch {$observationErrors.Add(@{role='kernel-module-discovery';state='unknown';error=$_.ToString()})}
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
    if((RegistrationIdentity $previous.registrations) -ne (RegistrationIdentity $registration)) {
        $authorizedChange=$requestedPackage -and (-not $previous.PSObject.Properties['requestedPackage'] -or
            -not $previous.requestedPackage -or $previous.requestedPackage.packageId -ne $requestedPackage.packageId)
        $observationErrors.Add(@{role='registration';state=if($authorizedChange){'changed-by-installation'}else{'drift'};
            previousObservation=$previous.observed;provenance=if($authorizedChange){$packageProvenance}else{$null}})
    }
}
$installedVerified=$false
$installationCheck=@{state='unknown';exitCode=$null;output=$null}
if($requestedPackage) {
    # Preserve the original installer verification contract, then independently
    # reconcile native/WoW64 paths and hashes above. A manually copied install
    # state cannot acquire the requested source identity without its transaction.
    $script=Join-Path $env:ProgramData 'Helios\Verify-Helios.ps1'
    foreach($name in @('Verify-Helios.ps1','Helios-PackageCommon.ps1')) {
        $expected=@($requestedPackage.files | Where-Object path -eq $name)
        if($expected.Count -ne 1) {throw 'Installed verification script lacks package provenance'}
        Assert-ControlFile (Join-Path $env:ProgramData "Helios\$name") $expected[0].sha256 $expected[0].size
    }
    $output=(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script 2>&1 | Out-String)
    $installationCheck=@{state=if($LASTEXITCODE) {'failed'} else {'verified'};exitCode=$LASTEXITCODE;output=$output}
    $certificateVerified=@($certificates | Where-Object Thumbprint -eq $requestedPackage.signing.thumbprint).Count -eq 2
    $desiredVerified=$desiredTransaction -and $desiredTransaction.state -eq 'installed' -and
        $desiredTransaction.operationId -eq $matchingTransactions[0].operationId
    $installedVerified=$desiredVerified -and $LASTEXITCODE -eq 0 -and $certificateVerified -and $drift.Count -eq 0 -and @($observedTools | Where-Object state -ne 'verified').Count -eq 0
}
$value=@{schemaVersion=2;transactionsView="summary-with-retained-receipts";observed=[DateTime]::UtcNow.ToString('o');bootTime=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');provisioning=$provisioning;observedTools=$observedTools;entries=@($entries.ToArray());devices=$devices;systemDrivers=$drivers;registrations=$registration;certificates=$certificates;loadedImages=@($mapped.ToArray());kernelModules=$kernelModules;observationErrors=@($observationErrors.ToArray());installState=$installState;requestedPackage=$requestedPackage;packageProvenance=$packageProvenance;installationCheck=$installationCheck;transactions=@($transactions | ForEach-Object {Get-RegistryTransactionSummary $_});state=if($drift.Count -or @($observationErrors | Where-Object state -eq 'drift').Count){'drift'} else {'observed'};loadedKernelIdentity='unknown-requires-kernel-image-evidence';installedVerified=$installedVerified;loadedVerified=$false}
$graphics=@(Get-ChildItem (Join-Path $root 'jobs') -Recurse -File -Filter 'graphics-result.json' | ForEach-Object {Read-ControlJson $_.FullName} | Where-Object {
    $_.state -eq 'passed' -and $requestedPackage -and $_.packageId -eq $requestedPackage.packageId -and
    $_.manifestSha256 -eq $packageProvenance.manifestSha256 -and $_.bootTime -eq $value.bootTime
} | Sort-Object observed -Descending)
$value.graphics=if($graphics.Count) {$graphics[0]} else {$null}
$value.desiredPackage=if($desiredTransaction) {$desiredTransaction.requestedManifest} else {$null}
$value.desiredTransaction=if($desiredTransaction) {@{operationId=$desiredTransaction.operationId;state=$desiredTransaction.state;manifestSha256=$desiredTransaction.manifestSha256}} else {$null}
Write-ControlJson $value $registryPath
Write-ControlJson $value (Join-Path $env:WINBOAT_JOB_ROOT 'registry-result.json')
if($Mode -eq 'verify' -and -not $installedVerified) {exit 76}
