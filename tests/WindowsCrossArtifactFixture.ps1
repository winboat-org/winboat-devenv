param([Parameter(Mandatory)][string]$Specification,[ValidateSet('x64','x86')][string]$Architecture='x64')
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$imports = @(Read-ControlJson $Specification)
if ($Architecture -eq 'x64') {
    foreach ($record in $imports) {Assert-ControlTree $record.import.root $record.files}
}
$clvk = @($imports | Where-Object target -eq 'clvk-helios')
if ($clvk.Count -ne 1) {throw 'Exactly one imported CLVK artifact is required'}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CrossArtifactLoad {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetModuleFileNameW(IntPtr module, StringBuilder path, int size);
  [DllImport("kernel32.dll", CharSet=CharSet.Ansi)]
  public static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr module);
}
'@
$paths = if ($Architecture -eq 'x64') {@('package/clvk.dll','package/vulkan-1.dll','package/OpenCL.dll')} else {@('package/x86/vulkan-1.dll')}
$loaded = @()
foreach ($relative in $paths) {
    $path = Join-Path $clvk[0].import.root $relative
    $module = [CrossArtifactLoad]::LoadLibraryExW($path,[IntPtr]::Zero,0x1100)
    if ($module -eq [IntPtr]::Zero) {throw "Host-built DLL load failed: $relative, error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"}
    try {
        $actual = [Text.StringBuilder]::new(32768)
        if (-not [CrossArtifactLoad]::GetModuleFileNameW($module,$actual,$actual.Capacity) -or $actual.ToString() -ne $path) {throw 'Loaded DLL path differs from the imported artifact'}
        $export = if ($relative -like '*vulkan-1.dll') {'vkGetInstanceProcAddr'} else {'clGetPlatformIDs'}
        if ([CrossArtifactLoad]::GetProcAddress($module,$export) -eq [IntPtr]::Zero) {throw "Required DLL export missing: $export"}
        $loaded += @{path=$relative;architecture=$Architecture;loadedPath=$actual.ToString();sha256=(Get-FileHash $path -Algorithm SHA256).Hash.ToLower();export=$export}
    } finally {[void][CrossArtifactLoad]::FreeLibrary($module)}
}
if ($Architecture -eq 'x64') {
    & "$env:SystemRoot\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Specification $Specification -Architecture x86
    if ($LASTEXITCODE) {throw 'x86 imported DLL load failed'}
    $loaded += @(Read-ControlJson (Join-Path $env:WINBOAT_JOB_ROOT 'cross-artifact-x86.json'))
    Write-ControlJson @{state='passed';imports=$imports;dlls=$loaded;installed=$false;graphicsValidated=$false} (Join-Path $env:WINBOAT_JOB_ROOT 'cross-artifact-fixture.json')
} else {
    Write-ControlJson $loaded (Join-Path $env:WINBOAT_JOB_ROOT 'cross-artifact-x86.json')
}
