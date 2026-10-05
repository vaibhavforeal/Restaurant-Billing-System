param(
  [Parameter(Mandatory = $true)][string]$ServerAddress,
  [string]$DataDirectory = (Join-Path $env:APPDATA 'forkflow-desktop\data'),
  [ValidateRange(1, 65535)][int]$Port = 4443,
  [switch]$Renew,
  [switch]$OpenFirewall
)
$ErrorActionPreference = 'Stop'
$parsedAddress = $null
if (-not [Net.IPAddress]::TryParse($ServerAddress, [ref]$parsedAddress) -or $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
  throw 'ServerAddress must be the POS PC IPv4 address, for example 192.168.1.20.'
}
if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq $ServerAddress })) { throw 'Choose an IPv4 address assigned to this POS PC.' }
$captainData = [IO.Path]::GetFullPath($DataDirectory)
$captainConfig = Join-Path $captainData 'captain-https.json'
if ((Test-Path -LiteralPath $captainConfig) -and -not $Renew) { throw 'Captain HTTPS is already configured. Use -Renew to renew its certificate while keeping the tablet trust certificate.' }
if ($OpenFirewall) {
  $captainIdentity = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $captainIdentity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Opening the firewall requires an Administrator PowerShell window. Omit -OpenFirewall to prepare certificates only.' }
}
New-Item -ItemType Directory -Path $captainData -Force | Out-Null
$captainFolderName = 'captain-tls\' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff')
$captainFolder = Join-Path $captainData $captainFolderName
New-Item -ItemType Directory -Path $captainFolder -Force | Out-Null
# Restrict private keys to this Windows account, SYSTEM and local administrators.
$captainAcl = [Security.AccessControl.DirectorySecurity]::new()
$captainAcl.SetAccessRuleProtection($true, $false)
foreach ($captainSid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $captainRule = [Security.AccessControl.FileSystemAccessRule]::new($captainSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $captainAcl.AddAccessRule($captainRule)
}
Set-Acl -LiteralPath $captainFolder -AclObject $captainAcl
$captainAuthority = $null
if ($Renew -and (Test-Path -LiteralPath $captainConfig)) {
  $captainPrevious = Get-Content -LiteralPath $captainConfig -Raw | ConvertFrom-Json
  $captainAuthority = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $captainPrevious.caThumbprint) -ErrorAction SilentlyContinue
  if (-not $captainAuthority -or -not $captainAuthority.HasPrivateKey) { throw 'The original restaurant CA private key is unavailable in this Windows account. Restore it or plan a new certificate setup on every tablet.' }
  if ($captainAuthority.NotAfter -lt [DateTime]::Now.AddDays(366)) { throw 'The restaurant CA expires within a year. Plan replacement and tablet trust setup before renewal.' }
} else {
  $captainAuthority = New-SelfSignedCertificate -Type Custom -Subject 'CN=ForkFlow Restaurant Captain CA' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage CertSign,CRLSign,DigitalSignature -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0') -NotBefore ([DateTime]::Now.AddMinutes(-5)) -NotAfter ([DateTime]::Now.AddYears(3))
}
$captainSan = @('DNS=localhost', 'IPAddress=127.0.0.1', ('IPAddress=' + $ServerAddress)) | Select-Object -Unique
$captainLeaf = New-SelfSignedCertificate -Type Custom -Subject ('CN=' + $ServerAddress) -Signer $captainAuthority -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -TextExtension @(('2.5.29.17={text}' + ($captainSan -join '&')), '2.5.29.37={text}1.3.6.1.5.5.7.3.1', '2.5.29.19={critical}{text}ca=0') -NotBefore ([DateTime]::Now.AddMinutes(-5)) -NotAfter ([DateTime]::Now.AddDays(365))
$captainRandom = New-Object byte[] 32
$captainRng = [Security.Cryptography.RandomNumberGenerator]::Create()
$captainRng.GetBytes($captainRandom)
$captainRng.Dispose()
$captainPassword = [Convert]::ToBase64String($captainRandom)
$captainSecurePassword = ConvertTo-SecureString $captainPassword -AsPlainText -Force
Export-PfxCertificate -Cert $captainLeaf -FilePath (Join-Path $captainFolder 'server.pfx') -Password $captainSecurePassword -CryptoAlgorithmOption AES256_SHA256 | Out-Null
Export-PfxCertificate -Cert $captainAuthority -FilePath (Join-Path $captainFolder 'restaurant-ca-private.pfx') -Password $captainSecurePassword -CryptoAlgorithmOption AES256_SHA256 | Out-Null
Export-Certificate -Cert $captainAuthority -FilePath (Join-Path $captainFolder 'restaurant-ca.cer') -Type CERT | Out-Null
Export-Certificate -Cert $captainLeaf -FilePath (Join-Path $captainFolder 'server.cer') -Type CERT | Out-Null
$captainUtf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $captainFolder 'pfx-password.txt'), $captainPassword, $captainUtf8)
$captainSettings = [ordered]@{
  port = $Port; addresses = @($ServerAddress)
  pfxFile = ($captainFolderName + '\server.pfx'); passphraseFile = ($captainFolderName + '\pfx-password.txt')
  caFile = ($captainFolderName + '\restaurant-ca.cer'); certificateFile = ($captainFolderName + '\server.cer')
  caThumbprint = $captainAuthority.Thumbprint
}
[IO.File]::WriteAllText(($captainConfig + '.tmp'), ($captainSettings | ConvertTo-Json), $captainUtf8)
Move-Item -LiteralPath ($captainConfig + '.tmp') -Destination $captainConfig -Force
if ($OpenFirewall) {
  $captainFirewallName = 'ForkFlow Captain HTTPS ' + $Port
  if (-not (Get-NetFirewallRule -DisplayName $captainFirewallName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $captainFirewallName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private -RemoteAddress LocalSubnet | Out-Null
  }
}
$captainHasher = [Security.Cryptography.SHA256]::Create()
$captainFingerprint = ([BitConverter]::ToString($captainHasher.ComputeHash($captainAuthority.RawData))).Replace('-', ':')
$captainHasher.Dispose()
Write-Output ('Captain HTTPS configured: https://' + $ServerAddress + ':' + $Port + '/captain/')
Write-Output ('Public tablet trust certificate: ' + (Join-Path $captainFolder 'restaurant-ca.cer'))
Write-Output ('CA SHA-256: ' + $captainFingerprint)
Write-Output ('Server certificate expires: ' + $captainLeaf.NotAfter.ToString('yyyy-MM-dd'))
Write-Output 'Restart ForkFlow, then trust ONLY restaurant-ca.cer on the tablets. Private PFX/password files stay on the POS PC.'
Write-Output 'This script does not install a trusted root on this PC or expose the POS to the internet.'
