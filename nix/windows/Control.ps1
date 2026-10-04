param(
    [ValidateSet('start','status','cancel','resume','direct')][string]$Action,
    [string]$JobRoot,
    [string]$RequestSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Shared control bundles are verified before use and published once per guest.

function Write-ControlJson($Value, [string]$Path) {
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    try {
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            try {
                if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
                else { [IO.File]::Move($temporary, $Path) }
                return
            } catch [IO.IOException] { Start-Sleep -Milliseconds 100 }
        }
        throw "Cannot publish atomic receipt: $Path"
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}

function Read-ControlJson([string]$Path) {
    for ($attempt=0; $attempt -lt 40; $attempt++) {
        try {
            $stream = [IO.File]::Open($Path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
            try {
                $reader = [IO.StreamReader]::new($stream)
                try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
            } finally { $stream.Dispose() }
        } catch [IO.IOException] { Start-Sleep -Milliseconds 100 }
    }
    throw "Cannot read atomic receipt: $Path"
}

function Assert-ControlPath([string]$Path, [string]$Boundary) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($Boundary.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped the protected operation root' }
    for ($parent = $full; $parent; $parent = Split-Path $parent -Parent) {
        if ((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Reparse point in operation path: $parent" }
    }
    return $full
}

function Assert-ControlFile([string]$Path, [string]$Sha256, [long]$Size) {
    $file = Get-Item -LiteralPath $Path -Force
    if($file.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Verified file is a reparse point'}
    if ($file.Length -ne $Size -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() -ne $Sha256) { throw "Verified file changed: $Path" }
}

function Assert-ControlTree([string]$Directory,$Files) {
    [void](Assert-ControlPath $Directory (Split-Path $Directory -Parent))
    foreach($child in Get-ChildItem -LiteralPath $Directory -Directory -Recurse -Force) {
        if($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Reparse point in verified input tree'}
    }
    $expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($file in $Files) {
        if(-not $expected.Add($file.path.Replace('/','\'))) {throw 'Duplicate input tree file'}
        $path=[IO.Path]::GetFullPath((Join-Path $Directory $file.path))
        if(-not $path.StartsWith($Directory.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'Verified input path escaped its tree'}
        Assert-ControlFile $path $file.sha256 $file.size
    }
    foreach($file in Get-ChildItem -LiteralPath $Directory -File -Recurse -Force) {
        $relative=$file.FullName.Substring($Directory.Length+1)
        if($relative -in @('.winboat-owner.json','.winboat-snapshot.json')) {continue}
        if(-not $expected.Remove($relative)) {throw "Unexpected file in verified input tree: $relative"}
    }
    if($expected.Count) {throw 'Verified input tree is incomplete'}
}

function Invoke-ControlPayload([string]$Script, [object[]]$Arguments) {
    # PowerShell array splatting treats '-Name' as positional text. Bind known
    # script parameters explicitly without evaluating argument text as code.
    $parameters = (Get-Command -Name $Script -CommandType ExternalScript).Parameters
    $named = @{}
    $positional = [Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $Arguments.Count; $index++) {
        $argument = [string]$Arguments[$index]
        if ($argument -match '^-(\w+)$' -and $parameters.ContainsKey($matches[1])) {
            $name = $matches[1]
            if ($named.ContainsKey($name)) { throw "Repeated script parameter: $name" }
            if ($parameters[$name].ParameterType -eq [Management.Automation.SwitchParameter]) { $named[$name] = $true }
            else {
                $index++
                if ($index -ge $Arguments.Count) { throw "Missing value for script parameter: $name" }
                $named[$name] = $Arguments[$index]
            }
        } else { $positional.Add($Arguments[$index]) }
    }
    $remaining = $positional.ToArray()
    & $Script @named @remaining
}

function Import-ControlBuildEnvironment([ValidateSet('x64','x86')][string]$Architecture) {
    $ewdk = [Environment]::GetEnvironmentVariable('WINBOAT_EWDK_ROOT','Machine')
    if (-not $ewdk) { throw 'The locked portable EWDK is not configured' }
    $setup = Join-Path $ewdk 'BuildEnv\SetupBuildEnv.cmd'
    # Keep all build executables native AMD64. An x86 host-tool PATH can feed
    # 32-bit MSVC runtime DLLs to 64-bit shader tools (STATUS_INVALID_IMAGE_FORMAT).
    $platform = 'amd64'
    $batch = Join-Path $env:WINBOAT_JOB_ROOT ('environment-' + $Architecture + '.cmd')
    @('@echo off',('call "' + $setup + '" ' + $platform + ' >nul'),'@echo off','if errorlevel 1 exit /b %errorlevel%','set') | Set-Content -LiteralPath $batch -Encoding ASCII
    $systemDirectory=Join-Path $env:SystemRoot 'System32'
    $environment = & (Join-Path $systemDirectory 'cmd.exe') /d /c $batch
    if ($LASTEXITCODE) { throw 'Portable EWDK environment setup failed' }
    foreach ($line in $environment) {
        if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1],$matches[2],'Process') }
    }
    # SetupBuildEnv defaults to a kernel environment. User-mode components need
    # the separately verified SDK's UM/UCRT libraries, alongside MSVC /MT.
    $kits = 'C:\Program Files (x86)\Windows Kits\10'
    $kit = '10.0.26100.0'
    foreach ($file in @("Include\$kit\km\ntddk.h","Include\$kit\um\Windows.h","Include\$kit\shared\specstrings.h","Include\$kit\ucrt\ctype.h","Lib\$kit\um\$Architecture\kernel32.lib","Lib\$kit\ucrt\$Architecture\ucrt.lib")) {
        if (-not (Test-Path -LiteralPath (Join-Path $kits $file))) { throw "Incomplete matched SDK/WDK: $file" }
    }
    if (-not $env:VCToolsInstallDir) { throw 'Portable EWDK did not select its MSVC tools' }
    $env:WindowsSdkDir = $kits + '\'
    $env:WindowsSDKVersion = $kit + '\'
    $env:INCLUDE = "$kits\Include\$kit\ucrt;$kits\Include\$kit\shared;$kits\Include\$kit\um;" + (Join-Path $env:VCToolsInstallDir 'include')
    $env:LIB = "$kits\Lib\$kit\um\$Architecture;$kits\Lib\$kit\ucrt\$Architecture;" + (Join-Path $env:VCToolsInstallDir ('lib\spectre\' + $Architecture))
    $vulkan = [Environment]::GetEnvironmentVariable('VULKAN_SDK','Machine')
    if (-not $vulkan) { throw 'The verified Vulkan shader toolchain is not configured' }
    $compiler = Join-Path $env:VCToolsInstallDir ('bin\Hostx64\' + $Architecture)
    # SetupBuildEnv can replace PATH on each architecture switch. Cargo's
    # executable lives in the provisioned tool directory even when a build has
    # its own offline CARGO_HOME; restore that native executable explicitly.
    $rustBin = 'C:\WinBoatDev\tools\cargo\bin'
    if (-not (Test-Path -LiteralPath (Join-Path $rustBin 'cargo.exe'))) { throw 'The verified native Rust toolchain is missing' }
    $env:VSCMD_ARG_TGT_ARCH = $Architecture
    $systemPath=@($systemDirectory,$env:SystemRoot,(Join-Path $systemDirectory 'Wbem'),(Join-Path $systemDirectory 'WindowsPowerShell\v1.0')) -join ';'
    $env:PATH = 'C:\WinBoatDev\tools\Git\cmd;C:\WinBoatDev\tools\LLVM\bin;C:\WinBoatDev\tools\Python;C:\WinBoatDev\tools\Python\Scripts;C:\WinBoatDev\tools\Ninja;' + $rustBin + ';' + $compiler + ';' + (Join-Path $kits "bin\$kit\x64") + ';' + (Join-Path $vulkan 'Bin') + ';' + $systemPath + ';' + $env:PATH
    $env:PATH = (($env:PATH -split ';' | Where-Object { $_ -and $_ -notmatch '(?i)msys[^;]*[\\/]usr[\\/]bin|[\\/]bin[\\/]Hostx86[\\/]' } | Select-Object -Unique) -join ';')
}

function Read-ControlRequest([string]$Directory, [string]$Hash, [bool]$VerifyInputs=$true) {
    [void](Assert-ControlPath $Directory 'C:\ProgramData\WinBoatDev\jobs')
    $path = Join-Path $Directory 'request.json'
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() -ne $Hash) { throw 'Task request hash mismatch' }
    $request = Read-ControlJson $path
    if ($request.schemaVersion -ne 1 -or $request.operationId -notmatch '^op-[a-f0-9]{32}$' -or (Split-Path $Directory -Leaf) -ne $request.operationId) { throw 'Unexpected task request schema/identity' }
    if ($request.purpose -notin @('build','install','desktop','system')) { throw 'Unknown session purpose' }
    [void](Assert-ControlPath $request.script $Directory)
    Assert-ControlFile $request.script $request.scriptSha256 $request.scriptSize
    if ($VerifyInputs) {
        foreach ($inputFile in $request.inputs) {
            [void](Assert-ControlPath $inputFile.path $Directory)
            Assert-ControlFile $inputFile.path $inputFile.sha256 $inputFile.size
        }
    }
    return $request
}

function Get-ControlObservation([string]$Directory, $Request) {
    $path = Join-Path $Directory 'receipt.json'
    $task = Get-ScheduledTask -TaskName ('WinBoatDev-' + $Request.operationId) -ErrorAction SilentlyContinue
    $value = if (Test-Path -LiteralPath $path) { Read-ControlJson $path } else {
        [pscustomobject]@{ schemaVersion=1; operationId=$Request.operationId; state='queued'; exitCode=0; purpose=$Request.purpose }
    }
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $task.TaskName
        $value | Add-Member -Force NoteProperty task @{ name=$task.TaskName; state=$task.State.ToString(); lastTaskResult=$info.LastTaskResult }
        if ($value.state -in @('running','queued') -and $task.State -ne 'Running' -and $info.LastRunTime.Year -gt 2000) {
            $value.state = 'interrupted'; $value.exitCode = 75
        }
    }
    $logs = @{}
    foreach ($name in @('stdout.log','stderr.log','bootstrap.log')) {
        $log = Join-Path $Directory $name
        if (Test-Path -LiteralPath $log) {
            $stream = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
            try {
                [void]$stream.Seek([Math]::Max(0,$stream.Length-65536), 'Begin')
                $reader = [IO.StreamReader]::new($stream)
                try { $logs[$name] = $reader.ReadToEnd() } finally { $reader.Dispose() }
            } finally { $stream.Dispose() }
        }
    }
    $value | Add-Member -Force NoteProperty logs $logs
    $value | Add-Member -Force NoteProperty boundedBytesPerLog 65536
    return $value
}

if (-not $Action) { return }
$request = Read-ControlRequest $JobRoot $RequestSha256 ($Action -in @('start','resume','direct'))
$taskName = 'WinBoatDev-' + $request.operationId
$receiptPath = Join-Path $JobRoot 'receipt.json'
if ($Action -eq 'cancel') {
    $current = Get-ControlObservation $JobRoot $request
    if ($current.state -in @('succeeded','failed','reboot-required','cancelled')) { $current | ConvertTo-Json -Depth 30 -Compress; exit $current.exitCode }
    if ($current.PSObject.Properties['childProcessId']) {
        $child = Get-Process -Id $current.childProcessId -ErrorAction SilentlyContinue
        if ($child -and $child.StartTime.ToUniversalTime().ToString('o') -eq $current.childStartTime) {
            & taskkill.exe /PID $child.Id /T /F | Out-Null
        }
    }
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Write-ControlJson @{schemaVersion=1;operationId=$request.operationId;state='cancelled';exitCode=130;purpose=$request.purpose;observed=[DateTime]::UtcNow.ToString('o')} $receiptPath
} elseif ($Action -in @('start','resume','direct')) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing -and $existing.State -eq 'Running') { throw 'This task is already running; observe its existing receipt' }
    if ((Test-Path -LiteralPath $receiptPath) -and $Action -eq 'start') { throw 'Existing task requires explicit resume' }
    if ($Action -eq 'resume' -and (Test-Path -LiteralPath $receiptPath)) {
        $archive = Join-Path $JobRoot ('attempts\' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $archive | Out-Null
        foreach ($name in @('receipt.json','stdout.log','stderr.log','bootstrap.log')) {
            $prior = Join-Path $JobRoot $name
            if (Test-Path -LiteralPath $prior) { Copy-Item -LiteralPath $prior -Destination (Join-Path $archive $name) }
        }
    }
    $wrapper = Join-Path $PSScriptRoot 'Task.ps1'
    $call = "& '$($wrapper.Replace("'","''"))' -JobRoot '$($JobRoot.Replace("'","''"))' -RequestSha256 '$RequestSha256'"
    $bootstrap=Join-Path $JobRoot 'bootstrap.log'
    $call = '$ErrorActionPreference="Stop"; try { ' + $call + '; exit $LASTEXITCODE } catch { [IO.File]::WriteAllText(' + "'$($bootstrap.Replace("'","''"))'" + ',($_ | Out-String)); exit 1 }'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($call))
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ($Action -eq 'direct') {
        & $powerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded
    } else {
        if ($request.purpose -eq 'desktop') {
            $explorers = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object SessionId -gt 0 | Where-Object {
                $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
                $owner.User -eq 'wbdev' -and $owner.Domain -eq $env:COMPUTERNAME
            })
            if ($explorers.Count -ne 1) { throw 'Desktop work requires one authenticated wbdev interactive session' }
            # SSH runs with an administrator token, but an interactive limited
            # token cannot read that token's default file ACL. Grant only this
            # desktop job and immutable helper directory to the guest account.
            foreach ($parent in @('C:\ProgramData\WinBoatDev','C:\ProgramData\WinBoatDev\control','C:\ProgramData\WinBoatDev\jobs')) {
                & icacls.exe $parent /grant "$env:COMPUTERNAME\wbdev:RX" /Q | Out-Null
                if ($LASTEXITCODE) { throw 'Cannot grant desktop parent path inspection' }
            }
            & icacls.exe $PSScriptRoot /grant "$env:COMPUTERNAME\wbdev:(OI)(CI)RX" /T /Q | Out-Null
            if ($LASTEXITCODE) { throw 'Cannot grant desktop helper read access' }
            & icacls.exe $JobRoot /grant "$env:COMPUTERNAME\wbdev:(OI)(CI)M" /T /Q | Out-Null
            if ($LASTEXITCODE) { throw 'Cannot grant desktop job access' }
            $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\wbdev" -LogonType Interactive -RunLevel Limited
        } else { $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest }
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
        $actionObject = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
        Register-ScheduledTask -TaskName $taskName -Action $actionObject -Principal $principal -Settings $settings -Force | Out-Null
        Write-ControlJson @{schemaVersion=1;operationId=$request.operationId;state='queued';exitCode=0;purpose=$request.purpose;observed=[DateTime]::UtcNow.ToString('o')} $receiptPath
        Start-ScheduledTask -TaskName $taskName
    }
}
$observation = Get-ControlObservation $JobRoot $request
$observation | ConvertTo-Json -Depth 30 -Compress
exit $observation.exitCode
