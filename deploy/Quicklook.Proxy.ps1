#requires -Version 5.1
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Deployment.Common.ps1')

function Read-QuicklookIisConfig {
    param([Parameter(Mandatory = $true)][string]$Path)
    $configPath = (Get-Item -LiteralPath $Path).FullName
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in @('SiteName', 'DeploymentRoot', 'BackendPort', 'PublicOrigin')) {
        if ($null -eq $config.PSObject.Properties[$name]) { throw "Missing Quicklook IIS configuration property: $name" }
    }
    if ($config.SiteName -isnot [string] -or $config.SiteName -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw 'Invalid SiteName.' }
    if ($config.DeploymentRoot -isnot [string]) { throw 'DeploymentRoot must be a path string.' }
    $config.DeploymentRoot = Resolve-LocalDeploymentPath -Value $config.DeploymentRoot -BasePath (Split-Path -Parent $configPath) -Name 'DeploymentRoot'
    if (($config.BackendPort -isnot [int] -and $config.BackendPort -isnot [long]) -or $config.BackendPort -ne 8765) {
        throw 'The unmodified Quicklook service listens on loopback port 8765. BackendPort must be 8765.'
    }
    $origin = $null
    if ($config.PublicOrigin -isnot [string] -or -not [Uri]::TryCreate($config.PublicOrigin, [UriKind]::Absolute, [ref]$origin) -or
        $origin.Scheme -notin @('http', 'https') -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment -or $origin.UserInfo -or
        $config.PublicOrigin -cne $origin.GetLeftPart([UriPartial]::Authority)) {
        throw 'PublicOrigin must be a canonical HTTP origin, without path, credentials, trailing slash or default port.'
    }
    if ($origin.Scheme -ne 'http') {
        throw 'HTTPS is not supported by the existing Quicklook POST Origin check (it requires http:// plus Host). Keep Host and Origin intact; HTTPS requires a separately authorized child-application change.'
    }
    if ($origin.HostNameType -notin @([UriHostNameType]::Dns, [UriHostNameType]::IPv4)) { throw 'PublicOrigin must use a DNS name or IPv4 address.' }
    return $config
}

function Get-QuicklookRootApiPaths {
    return @('/api/catalog', '/api/table', '/api/workbooks', '/api/workbook', '/api/sheet', '/api/search', '/api/raw', '/api/import', '/api/sync', '/api/config', '/api/recognition')
}

function Get-QuicklookProxyRequirements {
    # The backend accepts at most 256 MiB of raw file bytes; leave 1 MiB of request headroom.
    return [pscustomobject]@{ MaxAllowedContentLength = 269484032L; MinimumTimeoutSeconds = 300; Owner = 'DataPlatform-Quicklook-Proxy-v1' }
}

function New-QuicklookXmlElement {
    param([xml]$Document, [string]$Name, [hashtable]$Attributes = @{})
    $element = $Document.CreateElement($Name)
    foreach ($key in $Attributes.Keys) { $element.SetAttribute($key, [string]$Attributes[$key]) }
    return ,$element
}

function New-QuicklookProxyWebConfig {
    param([Parameter(Mandatory = $true)][xml]$Document, [Parameter(Mandatory = $true)][object]$Config)
    $requirements = Get-QuicklookProxyRequirements
    $owner = $requirements.Owner
    [xml]$copy = $Document.CloneNode($true)
    if ($copy.DocumentType -or $copy.DocumentElement.Name -ne 'configuration') { throw 'Expected an IIS configuration document without a DTD.' }
    $rootScopes = @($copy.SelectNodes('/configuration/location[@path="."][@inheritInChildApplications="false"]/system.webServer'))
    if ($rootScopes.Count -ne 1) { throw 'The portal must have one location path="." with inheritInChildApplications="false" and system.webServer.' }
    $rootScope = $rootScopes[0]
    if ($copy.SelectSingleNode('/configuration/system.webServer/rewrite')) { throw 'Unowned root rewrite configuration exists outside the isolated portal location; review it separately.' }
    $rewrite = $rootScope.SelectSingleNode('rewrite')
    if ($rewrite -and ($rewrite.Attributes.Count -ne 0 -or @($rewrite.SelectNodes('*[name()!="rules"]')).Count -ne 0)) { throw 'Unowned rewrite settings or outbound rules exist. No response rewriting or existing settings will be replaced.' }
    if (-not $rewrite) { $rewrite = New-QuicklookXmlElement $copy 'rewrite'; [void]$rootScope.AppendChild($rewrite) }
    $rules = $rewrite.SelectSingleNode('rules')
    if (-not $rules) { $rules = New-QuicklookXmlElement $copy 'rules'; [void]$rewrite.AppendChild($rules) }
    $names = @("$owner trailing slash", "$owner assets", "$owner exact root APIs")
    $owned = @($rules.SelectNodes('comment()') | Where-Object { $_.Value -ceq $owner })
    $existingRules = @($rules.SelectNodes('*'))
    if ($rules.Attributes.Count -ne 0 -or $owned.Count -gt 1 -or ($existingRules.Count -gt 0 -and $owned.Count -ne 1)) { throw 'Existing rewrite rules are not owned by the Quicklook deployment tool.' }
    foreach ($rule in $existingRules) {
        if ($rule.LocalName -ne 'rule' -or $rule.GetAttribute('name') -cnotin $names) { throw 'Unrelated rewrite rules exist; review their precedence separately. Nothing will be replaced.' }
    }
    if (@($existingRules | ForEach-Object { $_.GetAttribute('name') } | Select-Object -Unique).Count -ne $existingRules.Count) { throw 'Duplicate Quicklook rule names.' }
    foreach ($rule in $existingRules) { [void]$rules.RemoveChild($rule) }
    foreach ($comment in $owned) { [void]$rules.RemoveChild($comment) }
    [void]$rules.AppendChild($copy.CreateComment($owner))
    $authority = ([Uri]$Config.PublicOrigin).Authority
    $apiNames = (Get-QuicklookRootApiPaths | ForEach-Object { [Regex]::Escape($_.Substring(5)) }) -join '|'
    $definitions = @(
        @{ Name = $names[0]; Pattern = '^quicklook$'; Type = 'Redirect'; Url = '/quicklook/' },
        @{ Name = $names[1]; Pattern = '^quicklook/(.*)$'; Type = 'Rewrite'; Url = ('http://127.0.0.1:' + $Config.BackendPort + '/{R:1}') },
        @{ Name = $names[2]; Pattern = ('^(api/(?:' + $apiNames + '))$'); Type = 'Rewrite'; Url = ('http://127.0.0.1:' + $Config.BackendPort + '/{R:1}') }
    )
    foreach ($definition in $definitions) {
        $rule = New-QuicklookXmlElement $copy 'rule' @{ name = $definition.Name; stopProcessing = 'true' }
        [void]$rule.AppendChild((New-QuicklookXmlElement $copy 'match' @{ url = $definition.Pattern; ignoreCase = 'false' }))
        $conditions = New-QuicklookXmlElement $copy 'conditions' @{ logicalGrouping = 'MatchAll' }
        [void]$conditions.AppendChild((New-QuicklookXmlElement $copy 'add' @{ input = '{HTTP_HOST}'; pattern = ('^' + [Regex]::Escape($authority) + '$'); ignoreCase = 'true' }))
        [void]$conditions.AppendChild((New-QuicklookXmlElement $copy 'add' @{ input = '{HTTPS}'; pattern = '^OFF$'; ignoreCase = 'true' }))
        [void]$rule.AppendChild($conditions)
        $action = New-QuicklookXmlElement $copy 'action' @{ type = $definition.Type; url = $definition.Url; appendQueryString = 'true' }
        if ($definition.Type -eq 'Redirect') { $action.SetAttribute('redirectType', 'Temporary') }
        [void]$rule.AppendChild($action)
        [void]$rules.AppendChild($rule)
    }
    # Keep backend errors intact, with only the import path accepting large bodies.
    # These locations are part of the portal application, never child IIS applications.
    foreach ($path in @('quicklook') + @(Get-QuicklookRootApiPaths | ForEach-Object { $_.TrimStart('/') })) {
        $locations = @($copy.SelectNodes('/configuration/location') | Where-Object { $_.GetAttribute('path') -ieq $path })
        if ($locations.Count -gt 1) { throw "Duplicate location: $path" }
        if ($locations.Count -eq 1) {
            $location = $locations[0]
            $markers = @($location.SelectNodes('comment()') | Where-Object { $_.Value -ceq $owner })
            if ($markers.Count -ne 1 -or $location.GetAttribute('inheritInChildApplications') -cne 'false' -or $location.Attributes.Count -ne 2 -or
                @($location.SelectNodes('*[name()!="system.webServer"]')).Count -ne 0 -or
                @($location.SelectNodes('system.webServer/*[name()!="httpErrors" and name()!="security"]')).Count -ne 0 -or
                @($location.SelectNodes('system.webServer/security/*[name()!="requestFiltering"]')).Count -ne 0 -or
                @($location.SelectNodes('system.webServer/security/requestFiltering/*[name()!="requestLimits"]')).Count -ne 0 -or
                @($location.SelectNodes('system.webServer/httpErrors/* | system.webServer/security/requestFiltering/requestLimits/*')).Count -ne 0) {
                throw "Location '$path' contains unowned configuration. It will not be replaced."
            }
            [void]$copy.DocumentElement.RemoveChild($location)
        }
        $location = New-QuicklookXmlElement $copy 'location' @{ path = $path; inheritInChildApplications = 'false' }
        [void]$location.AppendChild($copy.CreateComment($owner))
        $server = New-QuicklookXmlElement $copy 'system.webServer'
        [void]$server.AppendChild((New-QuicklookXmlElement $copy 'httpErrors' @{ existingResponse = 'PassThrough' }))
        if ($path -in @('quicklook', 'api/import')) {
            $security = New-QuicklookXmlElement $copy 'security'
            $filtering = New-QuicklookXmlElement $copy 'requestFiltering'
            [void]$filtering.AppendChild((New-QuicklookXmlElement $copy 'requestLimits' @{ maxAllowedContentLength = $requirements.MaxAllowedContentLength }))
            [void]$security.AppendChild($filtering); [void]$server.AppendChild($security)
        }
        [void]$location.AppendChild($server); [void]$copy.DocumentElement.AppendChild($location)
    }
    return ,$copy
}
