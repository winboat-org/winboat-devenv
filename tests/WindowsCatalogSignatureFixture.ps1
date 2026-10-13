param([string]$ControlRoot=$env:WINBOAT_CONTROL_ROOT)
$ErrorActionPreference = 'Stop'
. (Join-Path $ControlRoot 'Control.ps1')
Add-Type -AssemblyName System.Security
if (-not ('System.Security.Cryptography.Pkcs.SignedCms' -as [type])) {
    Add-Type -AssemblyName System.Security.Cryptography.Pkcs
}
$directory = Join-Path ([IO.Path]::GetTempPath()) ('wb-catalog-signature-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
function Certificate([string]$Name, [string]$Usage='1.3.6.1.5.5.7.3.3') {
    $key = if ($PSVersionTable.PSEdition -eq 'Desktop') {
        [Security.Cryptography.RSACng]::new(2048)
    } else { [Security.Cryptography.RSA]::Create(2048) }
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        "CN=$Name", $key, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $oids = [Security.Cryptography.OidCollection]::new()
    [void]$oids.Add([Security.Cryptography.Oid]::new($Usage))
    [void]$request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$false))
    return $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddHours(1))
}
function Sign([string]$Path, $Certificate) {
    $cms = [Security.Cryptography.Pkcs.SignedCms]::new([Security.Cryptography.Pkcs.ContentInfo]::new([Text.Encoding]::UTF8.GetBytes('verified catalog content')))
    $signer = [Security.Cryptography.Pkcs.CmsSigner]::new($Certificate)
    $signer.IncludeOption = [Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
    $cms.ComputeSignature($signer, $true)
    [IO.File]::WriteAllBytes($Path,$cms.Encode())
}
function Reject([ScriptBlock]$Operation) {
    $rejected=$false
    try { & $Operation } catch { $rejected=$true }
    if (-not $rejected) { throw 'Invalid catalog signature was accepted' }
}
try {
    $certificate = Certificate 'Selected test signer'
    $catalog = Join-Path $directory 'catalog.cat'
    Sign $catalog $certificate
    Assert-ControlCatalogSignature $catalog $certificate
    $other = Certificate 'Wrong signer'
    Reject { Assert-ControlCatalogSignature $catalog $other }
    $bytes=[IO.File]::ReadAllBytes($catalog)
    $bytes[$bytes.Length-1]=$bytes[$bytes.Length-1] -bxor 1
    [IO.File]::WriteAllBytes($catalog,$bytes)
    Reject { Assert-ControlCatalogSignature $catalog $certificate }
    $wrongUsage = Certificate 'Wrong usage' '1.3.6.1.5.5.7.3.1'
    Sign $catalog $wrongUsage
    Reject { Assert-ControlCatalogSignature $catalog $wrongUsage }
    Write-Host 'Verified untrusted pinned CMS signer; wrong signer, corrupt signature and wrong certificate usage rejected'
} finally { Remove-Item -LiteralPath $directory -Recurse -Force }
