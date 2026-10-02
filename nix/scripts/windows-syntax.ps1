param([Parameter(Mandatory)][string]$Directory)
$failed = $false
Get-ChildItem -LiteralPath $Directory -Filter '*.ps1' | ForEach-Object {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { $errors | Format-List; $failed = $true } else { Write-Host "Parsed $($_.Name)" }
}
if ($failed) { exit 1 }
