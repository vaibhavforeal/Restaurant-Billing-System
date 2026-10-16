param(
  [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
  [Parameter(Mandatory=$true)][string]$TrustedPublicKeyFile,
  [Parameter(Mandatory=$true)][string]$TrustedNodeFile,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$TrustedNodeSha256,
  [Parameter(Mandatory=$true)][string]$ServerAddress,
  [string]$ExistingDataDirectory,
  [switch]$OpenPrivateSubnetFirewall
)
. (Join-Path $PSScriptRoot 'outlet.ps1')
Assert-OutletAdministrator
if ((Test-Path -LiteralPath $script:OutletInstall) -or (Get-Service -Name $script:OutletServiceName -ErrorAction SilentlyContinue)) { throw 'An outlet installation already exists. Use update.ps1 or recover the interrupted installation.' }
if (Test-Path -LiteralPath $script:OutletState) { throw 'Existing ProgramData outlet state must be reviewed; installation will not overwrite it.' }
if ((Get-FileHash -LiteralPath $TrustedNodeFile -Algorithm SHA256).Hash -ne $TrustedNodeSha256) { throw 'Bootstrap Node checksum differs from externally trusted SHA-256.' }
if (Get-NetFirewallRule -DisplayName 'ForkFlow Outlet HTTPS 4443' -ErrorAction SilentlyContinue) { throw 'An existing outlet firewall rule must be reviewed before installation.' }
$outletSelectedIp = $null
if (-not [Net.IPAddress]::TryParse($ServerAddress, [ref]$outletSelectedIp) -or $outletSelectedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'ServerAddress must be the reserved IPv4 address of this POS PC.' }
if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq $ServerAddress })) { throw 'ServerAddress is not assigned to this POS PC.' }
$outletSource = [IO.Path]::GetFullPath($ReleaseDirectory)
# The bootstrap verifier is trusted installer code, never executed from the incoming release.
$outletVerifiedOutput = & $TrustedNodeFile (Join-Path $PSScriptRoot 'release.mjs') verify $outletSource $TrustedPublicKeyFile
if ($LASTEXITCODE -ne 0) { throw 'Release signature verification failed.' }
$outletManifest = $outletVerifiedOutput | ConvertFrom-Json
$outletDestination = Get-OutletRelease $outletManifest.version
if ($ExistingDataDirectory) {
  $outletExisting = [IO.Path]::GetFullPath($ExistingDataDirectory)
  if (-not (Test-Path -LiteralPath (Join-Path $outletExisting 'forkflow.db'))) { throw 'Existing data directory has no database.' }
}
New-Item -ItemType Directory -Path (Join-Path $script:OutletInstall 'releases') -Force | Out-Null
New-Item -ItemType Directory -Path $script:OutletData -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $script:OutletState 'logs') -Force | Out-Null
# Tighten access before any restaurant data or certificate private key is copied.
Set-OutletDirectoryAcl $script:OutletInstall ''
Set-OutletDirectoryAcl $script:OutletState '' -Recursive
Copy-Item -LiteralPath $TrustedPublicKeyFile -Destination $script:OutletTrustKey
& $TrustedNodeFile (Join-Path $PSScriptRoot 'release.mjs') stage $outletSource $script:OutletTrustKey $outletDestination
if ($LASTEXITCODE -ne 0) { throw 'Verified release staging failed.' }
$outletStagedManifest = Read-OutletJson (Join-Path $outletDestination 'release.json')
if ($outletStagedManifest.version -ne $outletManifest.version) { throw 'Release changed during installer staging; do not activate it.' }
Copy-Item -LiteralPath (Join-Path $outletDestination 'ForkFlowOutlet.exe') -Destination $script:OutletHostExe
Set-OutletServiceXml $outletDestination
& $script:OutletHostExe install
if ($LASTEXITCODE -ne 0) { throw 'WinSW installation failed; preserve files and inspect its diagnostics.' }
& sc.exe sidtype $script:OutletServiceName unrestricted | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Service identity configuration failed.' }
if ($ExistingDataDirectory) {
  # Copy runs while holding the source database lock, including WAL, installation identity, backups and recovery state.
  Invoke-OutletNode $outletDestination @((Join-Path $outletDestination 'maintenance.mjs'), 'migrate-data', $outletExisting, $script:OutletData)
  # Keep the previous certificate configuration until the operator explicitly renews it for the new address.
}
if (-not (Test-Path -LiteralPath (Join-Path $script:OutletData 'captain-https.json'))) {
  & (Join-Path $outletDestination 'setup-captain-https.ps1') -ServerAddress $ServerAddress -DataDirectory $script:OutletData -Port 4443
} else {
  $outletTls = Read-OutletJson (Join-Path $script:OutletData 'captain-https.json')
  if ($outletTls.port -ne 4443 -or $outletTls.addresses -notcontains $ServerAddress) { throw 'Existing TLS does not cover the selected address on port 4443. Renew the certificate before starting this service.' }
}
Set-OutletPermissions
if ($OpenPrivateSubnetFirewall) {
  New-NetFirewallRule -DisplayName 'ForkFlow Outlet HTTPS 4443' -Direction Inbound -Protocol TCP -LocalPort 4443 -Action Allow -Profile Private -RemoteAddress LocalSubnet -Program (Join-Path $outletDestination 'node.exe') | Out-Null
}
Write-OutletJson (Join-Path $script:OutletInstall 'installed.json') @{ version=$outletManifest.version; installedAt=[DateTime]::UtcNow.ToString('o') }
Start-Service -Name $script:OutletServiceName
Wait-OutletHealth $outletDestination $outletManifest.version
$outletStartMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\ForkFlow'
New-Item -ItemType Directory -Path $outletStartMenu -Force | Out-Null
$outletShell = New-Object -ComObject WScript.Shell
foreach ($outletLink in @(@('ForkFlow POS','pos'), @('ForkFlow Kitchen','kitchen'), @('ForkFlow Captain','captain'))) {
  $outletShortcut = $outletShell.CreateShortcut((Join-Path $outletStartMenu ($outletLink[0] + '.lnk')))
  $outletShortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $outletShortcut.Arguments = '-NoProfile -File "' + (Join-Path $outletDestination 'launch.ps1') + '" -Mode ' + $outletLink[1]
  $outletShortcut.WindowStyle = 7; $outletShortcut.Save()
}
Write-Output 'Outlet service is installed and healthy. Trust the public restaurant-ca.cer on each POS/kitchen/captain browser device, then use the Start Menu shortcuts.'
