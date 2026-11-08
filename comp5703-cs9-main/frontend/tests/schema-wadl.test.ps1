# Standalone regression tests for the offline NAV XML extractor.
# Run: pwsh -NoProfile -File frontend/tests/schema-wadl.test.ps1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$extractor = Join-Path $PSScriptRoot '../scripts/extract-nav-wadl.ps1'
$fixture = Join-Path $PSScriptRoot 'fixtures/hungary-nav.wadl'
$assertions = 0
function Assert-That([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw "Assertion failed: $Message" }
    $script:assertions++
}
function Extract-Text([string]$Text) {
    $temporaryPath = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $Text)
        return (& $extractor -Path $temporaryPath -SourceUrl 'https://docs.example.test/actual.wadl' | ConvertFrom-Json)
    } finally { Remove-Item -LiteralPath $temporaryPath -Force }
}
function Wrap-Schema([string]$Declarations) {
    @"
<application xmlns="http://wadl.dev.java.net/2009/02" xmlns:t="urn:test" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <grammars><xs:schema targetNamespace="urn:test" elementFormDefault="qualified">$Declarations</xs:schema></grammars>
  <resources base="/"><resource path="https://api.example.test/v1"><resource path="/items"><method name="POST">
    <request><representation mediaType="application/xml" element="t:Payload"/></request>
  </method></resource></resource></resources>
</application>
"@
}

$actual = & $extractor -Path $fixture | ConvertFrom-Json
Assert-That ($actual.candidates.Count -eq 10) 'All ten WADL operations are discovered'
Assert-That ($actual.skipped.Count -eq 0) 'Official NAV embedded types are all supported'
Assert-That (($actual.documentSchemas | ForEach-Object { $_.schemas.Count } | Measure-Object -Sum).Sum -eq 40) 'Both XML media types in both directions are preserved'
Assert-That (@($actual.candidates | Where-Object { $_.http_method -ne 'POST' }).Count -eq 0) 'Method comes from WADL'
Assert-That (@($actual.candidates | Where-Object { $_.api_endpoint -notlike 'https://api-test.onlineszamla.nav.gov.hu/*' }).Count -eq 0) 'Extractor never invents a production URL'
$query = $actual.documentSchemas | Where-Object operation_path -eq '/invoiceService/v3/queryTransactionList'
$response = $query.schemas | Where-Object { $_.direction -eq 'response' -and $_.media_type -eq 'application/xml' }
Assert-That ($response.raw.xml_root -eq 'QueryTransactionListResponse') 'XML response root retained'
Assert-That ($response.status_code -eq 'default') 'WADL absent response status is not fabricated as 200'
Assert-That ($response.raw.properties.header.properties.timestamp.format -eq 'date-time') 'Inherited namespace-qualified primitive type resolved'
$transactions = $response.raw.properties.transactionListResult
Assert-That ($transactions.properties.transaction.type -eq 'array') 'maxOccurs unbounded becomes a repeated-element array'
Assert-That ($transactions.properties.transaction.minItems -eq 0) 'minOccurs zero retained'
Assert-That ($transactions.required -notcontains 'transaction') 'Optional transaction list is not made required'
Assert-That ($transactions.required -contains 'currentPage') 'Required field preserved'
Assert-That ($transactions.properties.transaction.items.'x-xml-nillable' -eq $true) 'XML nullability retained with warning'
$request = $query.schemas | Where-Object { $_.direction -eq 'request' -and $_.media_type -eq 'application/xml' }
$crypto = $request.raw.properties.user.properties.passwordHash
Assert-That ($crypto.properties.'#text'.type -eq 'string') 'Simple XML content retains its text type'
Assert-That ($crypto.required -contains '@cryptoType') 'Required XML attribute retained separately'
Assert-That ($crypto.properties.'@cryptoType'.xml.attribute -eq $true) 'Attribute provenance retained'

$enumDoc = Wrap-Schema @'
<xs:simpleType name="State"><xs:restriction base="xs:string"><xs:enumeration value="OPEN"/><xs:enumeration value="CLOSED"/></xs:restriction></xs:simpleType>
<xs:element name="Payload"><xs:complexType><xs:sequence><xs:element name="state" type="t:State"/><xs:element name="memo" type="xs:string" minOccurs="0"/></xs:sequence></xs:complexType></xs:element>
'@
$enumerated = Extract-Text $enumDoc
$enumSchema = $enumerated.documentSchemas[0].schemas[0].raw
Assert-That (($enumSchema.properties.state.enum -join ',') -eq 'OPEN,CLOSED') 'Actual string enumeration values retained'
Assert-That (($enumSchema.required -join ',') -eq 'state') 'Only mandatory sequence elements are required'
Assert-That ($enumerated.documentSchemas[0].schemas[0].raw.'x-source-url' -eq 'https://docs.example.test/actual.wadl') 'Source provenance retained'

$unsupported = Extract-Text (Wrap-Schema '<xs:element name="Payload"><xs:complexType><xs:choice><xs:element name="a" type="xs:string"/><xs:element name="b" type="xs:string"/></xs:choice></xs:complexType></xs:element>')
Assert-That ($unsupported.documentSchemas[0].schemas.Count -eq 0) 'Unsupported choice omits entire schema instead of partial fields'
Assert-That ($unsupported.skipped[0].reason -match 'Unsupported XSD construct: choice') 'Unsupported construct has an explicit reason'

$recursive = Extract-Text (Wrap-Schema '<xs:complexType name="Loop"><xs:sequence><xs:element name="again" type="t:Loop"/></xs:sequence></xs:complexType><xs:element name="Payload" type="t:Loop"/>')
Assert-That ($recursive.documentSchemas[0].schemas.Count -eq 0) 'Recursive schema does not get truncated into an apparently complete schema'
Assert-That ($recursive.skipped[0].reason -match 'Recursive XSD type') 'Recursive type is reported'

$missing = Extract-Text (Wrap-Schema '<xs:element name="Payload" type="t:Missing"/>')
Assert-That ($missing.documentSchemas[0].schemas.Count -eq 0) 'Missing referenced type is not inferred'
Assert-That ($missing.skipped[0].reason -match 'Missing XSD type') 'Missing type has an explicit reason'

$dtdRejected = $false
try { $null = Extract-Text ('<!DOCTYPE application [<!ENTITY fake "injected">]>' + $enumDoc) } catch { $dtdRejected = $_.Exception.Message -match 'DTD' }
Assert-That $dtdRejected 'DTDs are prohibited, preventing entity expansion and external entity resolution'
Write-Output "$assertions NAV WADL extraction assertions passed."
