param([Parameter(Mandatory)][string]$Specification, [string]$Directory)
. (Join-Path $env:WINBOAT_CONTROL_ROOT 'Control.ps1')
$spec = Read-ControlJson $Specification
if ($spec.schemaVersion -ne 1 -or $spec.operationId -notmatch '^op-[0-9a-f]{32}$') { throw 'Unsupported pack request' }
$archive = Join-Path (Split-Path $Specification -Parent) 'stage.zip'
Assert-ControlFile $archive $spec.archiveSha256 $spec.archiveSize
$root = if ($Directory) { [IO.Path]::GetFullPath($Directory) } else { 'C:\WinBoatDev\bundles\' + $spec.operationId }
if (Test-Path -LiteralPath $root) { throw 'Packing directory already exists; retained for inspection' }
New-Item -ItemType Directory -Path $root | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    $expected = @{}; $seen = @{}
    foreach ($f in $spec.files) {
        if ($expected.ContainsKey($f.path.ToLowerInvariant())) { throw 'Duplicate pack input' }
        $expected[$f.path.ToLowerInvariant()] = $f
    }
    # Validate the whole archive before creating any extracted file.
    foreach ($entry in $zip.Entries) {
        $key = $entry.FullName.ToLowerInvariant()
        if ($entry.FullName -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or
            -not $expected.ContainsKey($key) -or $seen.ContainsKey($key) -or
            $entry.Length -ne $expected[$key].size -or $entry.FullName -cne $expected[$key].path) { throw 'Unexpected/unsafe packing archive entry' }
        [void](Assert-ControlPath (Join-Path $root $entry.FullName) $root)
        $seen[$key] = $true
    }
    if ($seen.Count -ne $expected.Count) { throw 'Missing packing archive file' }
    foreach ($entry in $zip.Entries) {
        $destination = Assert-ControlPath (Join-Path $root $entry.FullName) $root
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
    }
} finally { $zip.Dispose() }
foreach ($f in $spec.files) { Assert-ControlFile (Join-Path $root $f.path) $f.sha256 $f.size }
$payload = Join-Path $root 'payload'
foreach ($name in @('helios_kmd_render.sys','helios_umd.dll','helios_umd12.dll','helios_umd32.dll','helios_umd12_32.dll')) {
    $info=(Get-Item -LiteralPath (Join-Path $payload "payload\driver\$name")).VersionInfo
    if ($info.FileVersion.Trim() -ne $spec.branding.version -or $info.ProductVersion.Trim() -ne $spec.branding.version -or
        $info.ProductName -ne $spec.branding.productName -or $info.CompanyName -ne $spec.branding.publisher) { throw 'Driver resource version/branding differs from release input' }
}
$certificatePath = Join-Path $payload $spec.signing.certificate
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certificatePath)
if ($certificate.Thumbprint -cne $spec.signing.thumbprint -or $certificate.Subject -cne $spec.signing.subject -or
    (Get-FileHash -LiteralPath $certificatePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $spec.signing.certificateSha256) { throw 'Certificate identity differs from release input' }
$catalog = Join-Path $payload 'payload\driver\helios_kmd_render.cat'
if ((Get-FileHash -LiteralPath $catalog -Algorithm SHA256).Hash.ToLowerInvariant() -ne $spec.signing.catalogSha256) { throw 'Catalog identity differs from release input' }
$catalogSignature = Get-AuthenticodeSignature -LiteralPath $catalog
if (-not $catalogSignature.SignerCertificate -or $catalogSignature.SignerCertificate.Thumbprint -cne $certificate.Thumbprint -or
    $catalogSignature.Status -notin @('Valid','NotTrusted')) { throw 'Catalog signature/signer identity differs' }
# Membership verification is an exact prebuilt component artifact. No runtime
# source compilation or machine trust-store mutation occurs in root assembly.
$verifier = Join-Path $root 'VerifyCatalog.exe'
$interface = (& $verifier --interface | Out-String).Trim()
if ($LASTEXITCODE -or (($interface | ConvertFrom-Json).interfaceVersion -ne 1)) { throw 'Stale prebuilt catalog verifier interface' }
$membership = (& $verifier $catalog (Join-Path $payload 'payload\driver') | Out-String).Trim()
if ($LASTEXITCODE) { throw 'Catalog does not contain the exact selected driver images' }
$verified = $membership | ConvertFrom-Json
if ($verified.state -ne 'verified' -or $verified.catalogMembers -ne 5) { throw 'Catalog verifier returned incomplete evidence' }
$packer = Join-Path $root 'HeliosSetup.exe'
$infoPath = Join-Path $root 'packer-info.json'
$probe = Start-Process -FilePath $packer -ArgumentList ('--packer-info "{0}"' -f $infoPath) -PassThru
if (-not $probe.WaitForExit(15000)) { $probe.Kill(); throw 'Prebuilt installer did not answer the bounded interface probe' }
if ($probe.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $infoPath)) { throw 'Stale prebuilt installer interface' }
$info = Read-ControlJson $infoPath
if ($info.interfaceVersion -ne 1 -or $info.format -ne 'HLIOSET2') { throw 'Stale prebuilt installer interface' }
$output = Join-Path $root 'packed.exe'
# Quote paths because the packer is a GUI executable and the workspace may
# contain spaces. Wait on its actual exit code, preserving the native value.
$process = Start-Process -FilePath $packer -ArgumentList ('--bundle "{0}" "{1}"' -f $payload, $output) -Wait -PassThru
if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) { throw "Prebuilt packer failed: $($process.ExitCode)" }
Move-Item -LiteralPath $output -Destination $packer -Force
Write-ControlJson @{schemaVersion=1;operationId=$spec.operationId;state='packed';inputSha256=(Get-FileHash -LiteralPath $Specification -Algorithm SHA256).Hash.ToLowerInvariant();
    signatures=@{catalogSigner=$certificate.Thumbprint;catalogMembership='verified';certificateSha256=$spec.signing.certificateSha256;catalogSha256=$spec.signing.catalogSha256};
    file=@{path=$packer;sha256=(Get-FileHash -LiteralPath $packer -Algorithm SHA256).Hash.ToLowerInvariant();size=(Get-Item -LiteralPath $packer).Length}} (Join-Path (Split-Path $Specification -Parent) 'pack-result.json')
