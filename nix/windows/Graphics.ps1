param([Parameter(Mandatory)][string]$Specification)
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
if([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {throw 'Graphics acceptance requires the interactive desktop session'}
$spec=Read-ControlJson $Specification
$state=Read-ControlJson 'C:\ProgramData\Helios\install-state.json'
if($state.packageId -ne $spec.manifest.packageId) {throw 'Installed package differs from the selected graphics transaction'}
$runtime=Join-Path $state.installRoot 'runtime'
$classKey=Get-Item -LiteralPath $state.classKey
$result=@{schemaVersion=1;state='running';transactionId=$spec.transactionId;manifestSha256=$spec.manifestSha256;
    packageId=$state.packageId;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;
    principal=[Security.Principal.WindowsIdentity]::GetCurrent().Name;
    bootTime=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');
    observed=[DateTime]::UtcNow.ToString('o');mappedImages=@();workloads=@()}
$resultPath=Join-Path $env:WINBOAT_JOB_ROOT 'graphics-result.json'
Write-ControlJson $result $resultPath
try {
    foreach($architecture in @('x64','x86')) {
        $relative=if($architecture -eq 'x86') {'x86\'} else {''}
        $systemDirectory=if($architecture -eq 'x86') {'SysWOW64'} else {'System32'}
        $registration=if($architecture -eq 'x86') {'UserModeDriverNameWoW'} else {'UserModeDriverName'}
        $slots=@($classKey.GetValue($registration,$null))
        if($slots.Count -ne 4) {throw 'Four architecture-specific Direct3D registration slots are required'}
        $images=@(
            @{path=Join-Path $env:SystemRoot "$systemDirectory\vulkan-1.dll";package='payload/loaders/'+$relative.Replace('\','/')+'vulkan-1.dll'},
            @{path=$slots[0];package='payload/driver/'+[IO.Path]::GetFileName($slots[0])},
            @{path=$slots[3];package='payload/driver/'+[IO.Path]::GetFileName($slots[3])},
            @{path=Join-Path $runtime "mesa\${relative}vulkan_virtio.dll";package='payload/mesa/'+$relative.Replace('\','/')+'vulkan_virtio.dll'},
            @{path=Join-Path $runtime "mesa\${relative}libgallium_wgl.dll";package='payload/mesa/'+$relative.Replace('\','/')+'libgallium_wgl.dll'}
        )
        if($architecture -eq 'x64') {
            $images+=@(
                @{path=Join-Path $env:SystemRoot 'System32\OpenCL.dll';package='payload/loaders/OpenCL.dll'},
                @{path=Join-Path $runtime 'opencl\clvk.dll';package='payload/opencl/clvk.dll'}
            )
        }
        foreach($image in $images) {
            $expected=@($spec.manifest.files | Where-Object path -eq $image.package)
            if($expected.Count -ne 1) {throw "Selected package lacks $($image.package)"}
            $image.sha256=$expected[0].sha256;$image.size=$expected[0].size;$image.architecture=$architecture
        }
        $data=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{images=$images;control=$env:WINBOAT_CONTROL_ROOT}|ConvertTo-Json -Depth 10 -Compress)))
        $code=@'
$ErrorActionPreference='Stop'
$spec=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('SPECIFICATION'))|ConvertFrom-Json
Add-Type -Path (Join-Path $spec.control 'LoadedIdentity.cs')
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class GraphicsLibrary {[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern IntPtr LoadLibraryEx(string path,IntPtr file,uint flags);}'
$images=@()
foreach($image in $spec.images) {
    $file=Get-Item -LiteralPath $image.path
    $hash=(Get-FileHash $image.path -Algorithm SHA256).Hash.ToLower()
    if($hash -ne $image.sha256 -or $file.Length -ne $image.size) {throw "Selected image differs from its package: $($image.path)"}
    $module=[GraphicsLibrary]::LoadLibraryEx($image.path,[IntPtr]::Zero,8)
    if($module -eq [IntPtr]::Zero) {throw "Cannot load $($image.path): $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"}
    $mapped=[WinBoatLoadedIdentity]::Verify($PID,$module.ToInt64(),$image.path)
    if($mapped -ne 'mapped-code-matches') {throw "Mapped image identity failed: $($image.path): $mapped"}
    $images+=@{path=$image.path;packagePath=$image.package;sha256=$hash;architecture=$image.architecture;pid=$PID;
        processStart=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o');
        baseAddress=$module.ToInt64().ToString('x');mappedCode=$mapped;observed=[DateTime]::UtcNow.ToString('o')}
}
@{images=$images}|ConvertTo-Json -Depth 10 -Compress
'@
        $code=$code.Replace('SPECIFICATION',$data)
        $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
        $powerShell=Join-Path $env:SystemRoot "$systemDirectory\WindowsPowerShell\v1.0\powershell.exe"
        $lines=& $powerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded
        if($LASTEXITCODE) {throw "Mapped $architecture image observation failed with exit $LASTEXITCODE"}
        $result.mappedImages+=@(($lines|ConvertFrom-Json).images)
        Write-ControlJson $result $resultPath
        # These are the component's actual graphics programs, independently of
        # the mapped-image observation above. Vulkan is restricted to this ICD.
        $env:VK_ICD_FILENAMES=if($architecture -eq 'x86') {$state.vulkanManifestX86} else {$state.vulkanManifest}
        $env:VK_DRIVER_FILES=$env:VK_ICD_FILENAMES
        $smoke=Join-Path $runtime "smoke\$relative"
        $workloads=@(
            @{name='vulkan';file='vulkan-smoke.exe';arguments=@()},
            @{name='vulkan-wsi';file='vulkan-wsi-probe.exe';arguments=@('2')},
            @{name='d3d11';file='d3d11-smoke.exe';arguments=@()},
            @{name='opengl';file='opengl-smoke.exe';arguments=@()},
            @{name='d3d12-device';file='d3d12-smoke.exe';arguments=@('--expect','ok')},
            @{name='d3d12-clear';file='d3d12-clear.exe';arguments=@('--adapter','helios','--expect','ok')}
        )
        if($architecture -eq 'x64') {$workloads+=@{name='opencl';file='opencl-smoke.exe';arguments=@()}}
        foreach($workload in $workloads) {
            $path=Join-Path $smoke $workload.file
            $expected=@($spec.manifest.files | Where-Object path -eq ('payload/smoke/'+$relative.Replace('\','/')+$workload.file))
            if($expected.Count -ne 1) {throw 'Unmanifested graphics program'}
            Assert-ControlFile $path $expected[0].sha256 $expected[0].size
            $output=(& $path @($workload.arguments) 2>&1 | Out-String)
            $code=$LASTEXITCODE
            $result.workloads+=@{name=$workload.name;architecture=$architecture;path=$path;sha256=$expected[0].sha256;
                arguments=$workload.arguments;exitCode=$code;output=$output;observed=[DateTime]::UtcNow.ToString('o')}
            Write-ControlJson $result $resultPath
            if($code) {throw "Graphics workload $($workload.name) $architecture failed with exit $code"}
        }
    }
    $result.state='passed'
    Write-ControlJson $result $resultPath
} catch {
    $result.state='failed';$result.error=$_.ToString()
    Write-ControlJson $result $resultPath
    throw
}
