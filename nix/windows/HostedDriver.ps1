param([Parameter(Mandatory)][string]$PreparedDirectory,[Parameter(Mandatory)][string]$OutputDirectory)
. (Join-Path $PSScriptRoot 'Control.ps1')
$prepared = (Resolve-Path -LiteralPath $PreparedDirectory).Path
$request = Read-ControlJson (Join-Path $prepared 'driver-request.json')
if ($request.schemaVersion -ne 1 -or $request.kind -ne 'winboat-hosted-driver-request' -or $request.operationId -notmatch '^op-[0-9a-f]{32}$') { throw 'Unknown hosted driver request' }
$archive = Join-Path $prepared 'driver-inputs.zip'
Assert-ControlFile $archive $request.archive.sha256 $request.archive.size
$inputs = 'C:\WinBoatDev\src\' + $request.operationId
$build = 'C:\WinBoatDev\build\' + $request.operationId
if ((Test-Path -LiteralPath $inputs) -or (Test-Path -LiteralPath $build)) { throw 'Driver operation already exists' }
New-Item -ItemType Directory -Path $inputs,$build | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    $expected = @{}; $seen = @{}
    foreach ($f in $request.files) { $key=$f.path.ToLowerInvariant(); if ($expected.ContainsKey($key)) { throw 'Duplicate input member' }; $expected[$key]=$f }
    foreach ($entry in $zip.Entries) {
        $key=$entry.FullName.ToLowerInvariant()
        if ($entry.FullName -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or -not $expected.ContainsKey($key) -or $seen.ContainsKey($key) -or $entry.FullName -cne $expected[$key].path -or $entry.Length -ne $expected[$key].size) { throw 'Unsafe or mismatched driver archive' }
        [void](Assert-ControlPath (Join-Path $inputs $entry.FullName) $inputs); $seen[$key]=$true
    }
    if ($seen.Count -ne $expected.Count) { throw 'Driver archive omits an input' }
    foreach ($entry in $zip.Entries) {
        $destination=Assert-ControlPath (Join-Path $inputs $entry.FullName) $inputs
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$destination,$false)
    }
} finally { $zip.Dispose() }
foreach ($f in $request.files) { Assert-ControlFile (Join-Path $inputs $f.path) $f.sha256 $f.size }
$tools=Join-Path $inputs 'toolchain'
$env:WINBOAT_HOSTED_TOOLCHAIN=Join-Path $tools 'toolchain.json'
$toolchain=Read-ControlJson $env:WINBOAT_HOSTED_TOOLCHAIN
if ($toolchain.provisionLockSha256 -ne $request.provisionLockSha256) { throw 'Hosted toolchain lock differs' }
$python=Start-Process -FilePath (Join-Path $tools 'python-installer.exe') -ArgumentList @('/quiet','InstallAllUsers=0','Include_test=0','Include_doc=0','Include_tcltk=0','Include_launcher=0','Include_pip=0','PrependPath=0',('TargetDir="'+(Join-Path $tools 'python')+'"')) -Wait -PassThru
if ($python.ExitCode -notin @(0,3010)) { throw "Pinned Python installer failed: $($python.ExitCode)" }
$env:WINBOAT_CONTROL_ROOT=$PSScriptRoot
$env:WINBOAT_JOB_ROOT=Join-Path $build 'control'
New-Item -ItemType Directory -Path $env:WINBOAT_JOB_ROOT | Out-Null
Import-ControlBuildEnvironment x64
$certificate=New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Helios Development Test Signing' -CertStoreLocation 'Cert:\LocalMachine\My' -HashAlgorithm SHA256 -KeyAlgorithm RSA -KeyLength 2048
$source=Join-Path $inputs 'source'
$specification=Join-Path $env:WINBOAT_JOB_ROOT 'build.json'
$bindings=@{'@heliosSourceDirectory@'=(Join-Path $source 'helios');'@sourceDirectory@'=(Join-Path $source 'helios');'@buildDirectory@'=$build;'@specification@'=$specification}
$commands=@(foreach ($command in $request.recipe.commands) {
    ,@(foreach ($argument in $command) {
        $value=[string]$argument
        foreach ($token in $bindings.Keys) { $value=$value.Replace($token,$bindings[$token]) }
        if ($value -match '@[A-Za-z]+@') { throw 'Unbound component command token' }
        $value
    })
})
$dependencies=@(foreach($dependency in $request.dependencies){@{target=$dependency.target;root=(Join-Path $inputs ('engines\'+$dependency.target));files=$dependency.files}})
$cargoFiles=@($request.files | Where-Object path -like 'cargo/*' | ForEach-Object {
    @{path=$_.path.Substring(6);sha256=$_.sha256;size=$_.size}
})
$spec=@{
    schemaVersion=1;operationId=$request.operationId;target='helios-guest-x64'
    architecture='x64';configuration=$request.configuration
    sourceRoot=$source;buildRoot=$build;sources=$request.sources;commands=$commands
    outputs=$request.recipe.outputs;outputArchitectures=$request.recipe.outputArchitectures
    prerequisites=@(@{kind='cargo';root=(Join-Path $inputs 'cargo');files=$cargoFiles})
    componentDependencies=$dependencies;preserveDirectories=@();symbolStorage='artifact'
    hostedToolchain=$env:WINBOAT_HOSTED_TOOLCHAIN;provisionLockSha256=$request.provisionLockSha256
    certificateThumbprint=$certificate.Thumbprint
}
Write-ControlJson $spec $specification
& (Join-Path $PSScriptRoot 'GuestBuild.ps1') -Specification $specification
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$result=Read-ControlJson (Join-Path $env:WINBOAT_JOB_ROOT 'build-result.json')
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
Copy-Item -LiteralPath $result.archive.path -Destination (Join-Path $OutputDirectory 'artifact.zip')
Copy-Item -LiteralPath (Join-Path $env:WINBOAT_JOB_ROOT 'build-result.json') -Destination $OutputDirectory
