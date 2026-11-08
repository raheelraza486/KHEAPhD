<#
Read a NAV WADL file and emit documented XML request/response schemas as JSON.
No network or database access. Uses .NET XML with DTD/external entities disabled.

Supported XSD subset: named/inline types, namespace-aware references, sequence,
complexContent extension, simpleContent extension with attributes, primitive
types, enumeration restrictions, and element minOccurs/maxOccurs/nillable.
An unsupported or recursive definition skips its entire representation.

raw.xml_root identifies the XML document element; raw is a JSON-Schema-like
structural description, not a claim that the wire format is JSON. Attributes
use @name and simple content uses #text. XML namespace/type provenance is kept.

Usage: pwsh -NoProfile -File frontend/scripts/extract-nav-wadl.ps1 -Path file.wadl
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$SourceUrl = 'https://raw.githubusercontent.com/nav-gov-hu/Online-Invoice/master/sample/WADL/application.wadl'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$xsdNamespace = 'http://www.w3.org/2001/XMLSchema'
$wadlNamespace = 'http://wadl.dev.java.net/2009/02'
$typeIndex = [System.Collections.Generic.Dictionary[string, System.Xml.XmlElement]]::new([StringComparer]::Ordinal)
$elementIndex = [System.Collections.Generic.Dictionary[string, System.Xml.XmlElement]]::new([StringComparer]::Ordinal)
$typeStack = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$candidates = [System.Collections.Generic.List[object]]::new()
$documentSchemas = [System.Collections.Generic.List[object]]::new()
$skipped = [System.Collections.Generic.List[object]]::new()
$baseUrls = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)

function New-Properties {
    return ,([System.Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal))
}

function Get-Children($Node, [string]$Namespace = $xsdNamespace) {
    @($Node.ChildNodes | Where-Object { $_ -is [System.Xml.XmlElement] -and $_.NamespaceURI -eq $Namespace })
}

function Assert-Children($Node, [string[]]$Allowed) {
    foreach ($child in @(Get-Children $Node)) {
        if ($child.LocalName -notin $Allowed -and $child.LocalName -ne 'annotation') {
            throw "Unsupported XSD construct: $($child.LocalName) in $($Node.LocalName) $($Node.GetAttribute('name'))"
        }
    }
}

function Assert-Attributes($Node, [string[]]$Allowed) {
    foreach ($attribute in $Node.Attributes) {
        if ($attribute.NamespaceURI -eq 'http://www.w3.org/2000/xmlns/') { continue }
        if ($attribute.Name -notin $Allowed) { throw "Unsupported XSD attribute: $($attribute.Name) on $($Node.LocalName)" }
    }
}

function Get-QName($Node, [string]$Value) {
    $parts = $Value.Split(':', 2)
    $prefix = if ($parts.Length -eq 2) { $parts[0] } else { '' }
    $localName = $parts[-1]
    $namespace = $Node.GetNamespaceOfPrefix($prefix)
    if (!$namespace -or !$localName) { throw "Unresolved XSD QName: $Value" }
    return "{$namespace}$localName"
}

function Get-SchemaNamespace($Node) {
    $current = $Node
    while ($current -and !($current.LocalName -eq 'schema' -and $current.NamespaceURI -eq $xsdNamespace)) { $current = $current.ParentNode }
    if (!$current) { throw 'XSD declaration has no schema ancestor' }
    return $current.GetAttribute('targetNamespace')
}

function Get-Primitive([string]$Name) {
    $result = switch ($Name) {
        'string' { @{ type = 'string' } }
        'boolean' { @{ type = 'boolean' } }
        'decimal' { @{ type = 'number' } }
        'integer' { @{ type = 'integer' } }
        'int' { @{ type = 'integer'; minimum = -2147483648; maximum = 2147483647 } }
        'long' { @{ type = 'integer' } }
        'nonNegativeInteger' { @{ type = 'integer'; minimum = 0 } }
        'positiveInteger' { @{ type = 'integer'; minimum = 1 } }
        'dateTime' { @{ type = 'string'; format = 'date-time' } }
        'date' { @{ type = 'string'; format = 'date' } }
        'base64Binary' { @{ type = 'string'; contentEncoding = 'base64' } }
        default { throw "Unsupported XSD primitive: $Name" }
    }
    $result['x-xsd-type'] = "{$xsdNamespace}$Name"
    return $result
}

function Resolve-Type($Node, [string]$Value) {
    $key = Get-QName $Node $Value
    if ($key.StartsWith("{$xsdNamespace}")) { return Get-Primitive $key.Substring($xsdNamespace.Length + 2) }
    if (!$typeIndex.ContainsKey($key)) { throw "Missing XSD type: $key" }
    if (!$typeStack.Add($key)) { throw "Recursive XSD type is not expanded: $key" }
    try {
        $result = Convert-Type $typeIndex[$key]
        $result['x-xsd-type'] = $key
        return $result
    } finally { [void]$typeStack.Remove($key) }
}

function Add-Sequence($Object, $Sequence) {
    Assert-Attributes $Sequence @('minOccurs', 'maxOccurs')
    if (($Sequence.HasAttribute('minOccurs') -and $Sequence.GetAttribute('minOccurs') -ne '1') -or
        ($Sequence.HasAttribute('maxOccurs') -and $Sequence.GetAttribute('maxOccurs') -ne '1')) {
        throw 'Repeated or optional XSD sequence groups are unsupported'
    }
    Assert-Children $Sequence @('element')
    $required = [System.Collections.Generic.List[string]]::new()
    foreach ($name in @($Object.required)) { $required.Add($name) }
    foreach ($element in @(Get-Children $Sequence | Where-Object LocalName -eq 'element')) {
        if ($element.HasAttribute('ref')) {
            $key = Get-QName $element $element.GetAttribute('ref')
            if (!$elementIndex.ContainsKey($key)) { throw "Missing XSD element: $key" }
            $name = $elementIndex[$key].GetAttribute('name')
        } else { $name = $element.GetAttribute('name') }
        if (!$name -or $Object.properties.Contains($name)) { throw "Duplicate or unnamed XSD property: $name" }
        $Object.properties[$name] = Convert-Element $element
        $minOccurs = if ($element.HasAttribute('minOccurs')) { [int]$element.GetAttribute('minOccurs') } else { 1 }
        if ($minOccurs -gt 0) { $required.Add($name) }
    }
    $Object.required = @($required.ToArray())
}

function Add-Attributes($Object, $Container) {
    foreach ($attribute in @(Get-Children $Container | Where-Object LocalName -eq 'attribute')) {
        Assert-Attributes $attribute @('name', 'type', 'use')
        Assert-Children $attribute @()
        $name = '@' + $attribute.GetAttribute('name')
        if ($name -eq '@' -or $Object.properties.Contains($name)) { throw "Duplicate or unnamed XML attribute: $name" }
        if ($attribute.GetAttribute('use') -eq 'prohibited') { continue }
        if (!$attribute.GetAttribute('type')) { throw "Untyped XML attribute: $name" }
        $property = Resolve-Type $attribute $attribute.GetAttribute('type')
        $property['xml'] = @{ name = $attribute.GetAttribute('name'); attribute = $true }
        $Object.properties[$name] = $property
        if ($attribute.GetAttribute('use') -eq 'required') { $Object.required = @($Object.required) + $name }
    }
}

function Convert-Type($Node) {
    Assert-Attributes $Node @('name')
    if ($Node.LocalName -eq 'simpleType') {
        Assert-Children $Node @('restriction')
        $restriction = @(Get-Children $Node | Where-Object LocalName -eq 'restriction')
        if ($restriction.Count -ne 1) { throw 'Simple type must have one restriction' }
        Assert-Attributes $restriction[0] @('base')
        Assert-Children $restriction[0] @('enumeration')
        $result = Resolve-Type $restriction[0] $restriction[0].GetAttribute('base')
        $values = @(Get-Children $restriction[0] | Where-Object LocalName -eq 'enumeration' | ForEach-Object { $_.GetAttribute('value') })
        if ($values.Count) {
            if ($result.type -ne 'string') { throw 'Non-string XSD enumeration conversion is unsupported' }
            $result['enum'] = @($values)
        }
        return $result
    }
    Assert-Children $Node @('sequence', 'complexContent', 'simpleContent', 'attribute')
    $result = @{ type = 'object'; properties = New-Properties; required = @() }
    $content = @(Get-Children $Node | Where-Object { $_.LocalName -in @('complexContent', 'simpleContent') })
    $container = $Node
    if ($content.Count -gt 1) { throw 'Multiple XSD content declarations' }
    if ($content.Count -eq 1) {
        Assert-Attributes $content[0] @()
        Assert-Children $content[0] @('extension')
        $extension = @(Get-Children $content[0] | Where-Object LocalName -eq 'extension')
        if ($extension.Count -ne 1) { throw 'XSD content must have one extension' }
        $container = $extension[0]
        Assert-Attributes $container @('base')
        Assert-Children $container @('sequence', 'attribute')
        $base = Resolve-Type $container $container.GetAttribute('base')
        if ($content[0].LocalName -eq 'simpleContent') {
            if ($base.type -in @('object', 'array')) { throw 'Non-primitive simpleContent base' }
            $result.properties['#text'] = $base
            $result.required = @('#text')
        } else {
            if ($base.type -ne 'object') { throw 'Non-object complexContent base' }
            $result = $base
        }
    }
    foreach ($sequence in @(Get-Children $container | Where-Object LocalName -eq 'sequence')) { Add-Sequence $result $sequence }
    Add-Attributes $result $container
    return $result
}

function Convert-Element($Node) {
    Assert-Attributes $Node @('name', 'type', 'ref', 'minOccurs', 'maxOccurs', 'nillable')
    Assert-Children $Node @('complexType', 'simpleType')
    if ($Node.HasAttribute('ref')) {
        $key = Get-QName $Node $Node.GetAttribute('ref')
        if (!$elementIndex.ContainsKey($key)) { throw "Missing XSD element: $key" }
        if (!$typeStack.Add("element:$key")) { throw "Recursive XSD element is not expanded: $key" }
        try { $result = Convert-Element $elementIndex[$key] } finally { [void]$typeStack.Remove("element:$key") }
    } elseif ($Node.HasAttribute('type')) {
        $result = Resolve-Type $Node $Node.GetAttribute('type')
    } else {
        $inline = @(Get-Children $Node | Where-Object { $_.LocalName -in @('complexType', 'simpleType') })
        if ($inline.Count -ne 1) { throw "Element has no single stated type: $($Node.GetAttribute('name'))" }
        $result = Convert-Type $inline[0]
    }
    if (!$Node.HasAttribute('ref')) { $result['xml'] = @{ name = $Node.GetAttribute('name'); namespace = Get-SchemaNamespace $Node } }
    if ($Node.GetAttribute('nillable') -in @('true', '1')) {
        # Keep the XML-specific nullability rather than silently changing JSON
        # field types. Current comparison cannot validate xsi:nil semantics.
        $result['x-xml-nillable'] = $true
    }
    $minOccurs = if ($Node.HasAttribute('minOccurs')) { [int]$Node.GetAttribute('minOccurs') } else { 1 }
    $maximum = if ($Node.HasAttribute('maxOccurs')) { $Node.GetAttribute('maxOccurs') } else { '1' }
    if ($maximum -eq 'unbounded' -or [int]$maximum -gt 1) {
        $array = @{ type = 'array'; items = $result; minItems = $minOccurs; 'x-xml-repeated-element' = $true }
        if ($maximum -ne 'unbounded') { $array['maxItems'] = [int]$maximum }
        return $array
    }
    if ($maximum -ne '1') { throw "Unsupported maxOccurs: $maximum" }
    return $result
}

function Read-Resource($Resource, [string]$ParentBase) {
    $resourcePath = $Resource.GetAttribute('path')
    $endpoint = if ($resourcePath -match '^https?://') { $resourcePath.TrimEnd('/') } else { $ParentBase.TrimEnd('/') + '/' + $resourcePath.TrimStart('/') }
    foreach ($method in @(Get-Children $Resource $wadlNamespace | Where-Object LocalName -eq 'method')) {
        $httpMethod = $method.GetAttribute('name').ToUpperInvariant()
        $operationPath = ([uri]$endpoint).AbsolutePath
        $candidates.Add(@{ api_endpoint = $endpoint; http_method = $httpMethod; operation_path = $operationPath })
        $schemas = [System.Collections.Generic.List[object]]::new()
        foreach ($side in @(Get-Children $method $wadlNamespace | Where-Object { $_.LocalName -in @('request', 'response') })) {
            $direction = $side.LocalName
            $status = if ($direction -eq 'request') { $null } elseif ($side.GetAttribute('status')) { $side.GetAttribute('status') } else { 'default' }
            foreach ($representation in @(Get-Children $side $wadlNamespace | Where-Object LocalName -eq 'representation')) {
                $mediaType = $representation.GetAttribute('mediaType')
                try {
                    if ($mediaType -notin @('application/xml', 'text/xml')) { throw "Unsupported representation: $mediaType" }
                    $elementKey = Get-QName $representation $representation.GetAttribute('element')
                    if (!$elementIndex.ContainsKey($elementKey)) { throw "Missing representation element: $elementKey" }
                    $element = $elementIndex[$elementKey]
                    $schema = Convert-Element $element
                    $schema['xml_root'] = $element.GetAttribute('name')
                    $schema['x-source-format'] = 'WADL/XSD'
                    $schema['x-source-url'] = $SourceUrl
                    $schemas.Add(@{
                        direction = $direction; media_type = $mediaType; status_code = $status
                        raw = $schema
                        warnings = @('XML structural schema projected from WADL/XSD; attributes use @name and simple content uses #text. XML lexical rules, namespaces, sequence order and xsi:nil semantics require XML validation.')
                    })
                } catch {
                    $skipped.Add(@{ api_endpoint = $endpoint; http_method = $httpMethod; direction = $direction; media_type = $mediaType; reason = $_.Exception.Message })
                }
            }
        }
        $documentSchemas.Add(@{ operation_path = $operationPath; http_method = $httpMethod; schemas = @($schemas.ToArray()) })
    }
    foreach ($child in @(Get-Children $Resource $wadlNamespace | Where-Object LocalName -eq 'resource')) { Read-Resource $child $endpoint }
}

$settings = [System.Xml.XmlReaderSettings]::new()
$settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
$settings.XmlResolver = $null
$settings.MaxCharactersInDocument = 10000000
$reader = [System.Xml.XmlReader]::Create((Resolve-Path -LiteralPath $Path).Path, $settings)
try {
    $document = [System.Xml.XmlDocument]::new()
    $document.XmlResolver = $null
    $document.Load($reader)
} finally { $reader.Dispose() }
if ($document.DocumentElement.LocalName -ne 'application' -or $document.DocumentElement.NamespaceURI -ne $wadlNamespace) { throw 'Expected a WADL application document' }
foreach ($schema in @($document.SelectNodes('//*[local-name()="grammars"]/*[local-name()="schema"]'))) {
    if ($schema.NamespaceURI -ne $xsdNamespace) { continue }
    foreach ($declaration in @(Get-Children $schema)) {
        $key = "{$($schema.GetAttribute('targetNamespace'))}$($declaration.GetAttribute('name'))"
        if ($declaration.LocalName -in @('complexType', 'simpleType')) { $typeIndex.Add($key, $declaration) }
        if ($declaration.LocalName -eq 'element') { $elementIndex.Add($key, $declaration) }
    }
}
foreach ($resources in @(Get-Children $document.DocumentElement $wadlNamespace | Where-Object LocalName -eq 'resources')) {
    foreach ($resource in @(Get-Children $resources $wadlNamespace | Where-Object LocalName -eq 'resource')) {
        if ($resource.GetAttribute('path') -match '^https?://') { [void]$baseUrls.Add($resource.GetAttribute('path')) }
        Read-Resource $resource $resources.GetAttribute('base')
    }
}
@{
    source_url = $SourceUrl
    documented_base_urls = @($baseUrls | Sort-Object)
    candidates = @($candidates.ToArray())
    documentSchemas = @($documentSchemas.ToArray())
    skipped = @($skipped.ToArray())
    warnings = @('Only endpoints and wire formats stated by the supplied WADL are emitted. No production host aliases or metadata changes are inferred.')
} | ConvertTo-Json -Depth 100
