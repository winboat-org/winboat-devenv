# Inventory schema 2 retains full package provenance once and immutable receipt
# references. Individual file rows do not duplicate entire artifact manifests.
function Get-RegistryProvenanceSummary($Provenance) {
    if(-not $Provenance) {return $null}
    $summary=@{}
    foreach($field in @('operationId','manifestSha256','kind','source','sources')) {
        if($Provenance -is [Collections.IDictionary]) {
            if($Provenance.Contains($field)) {$summary[$field]=$Provenance[$field]}
        } elseif($Provenance.PSObject.Properties[$field]) {$summary[$field]=$Provenance.$field}
    }
    $summary.provenanceRef=if($summary.ContainsKey('kind') -and $summary.kind -eq 'fixture-transaction') {
        @{kind='transaction-receipt';operationId=$summary.operationId}
    } else {@{kind='packageProvenance'}}
    return $summary
}
function Get-RegistryTransactionSummary($Transaction) {
    $summary=@{}
    foreach($field in @('schemaVersion','operationId','state','observed','manifestSha256','changed','expectedRegistration','receipt')) {
        if($Transaction.PSObject.Properties[$field]) {$summary[$field]=$Transaction.$field}
    }
    if($Transaction.PSObject.Properties['requestedManifest']) {
        $manifest=@{}
        foreach($field in @('schemaVersion','packageId','version','architecture','includesWow64','source','signing')) {
            if($Transaction.requestedManifest.PSObject.Properties[$field]) {$manifest[$field]=$Transaction.requestedManifest.$field}
        }
        $summary.requestedManifest=$manifest
        $summary.requestedManifestRef='receipt.requestedManifest'
    }
    return $summary
}
