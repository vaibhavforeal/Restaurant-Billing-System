# Run by the MasalaPOS setup wizard (tools/installer.nsh) before anything is installed. It activates this computer with the Customer ID
# and Order ID from the setup card, the same POST /v1/enroll a counter makes from Setup, and leaves the identity and licence for the app
# to adopt at first start (apps/server/src/license-config.ts). Exit 0 on success; otherwise stdout carries one plain sentence to show.
# tools/build-desktop.mjs fills in the placeholders for each customer build.
param([Parameter(Mandatory = $true)][string]$Ids)
$ErrorActionPreference = 'Stop'
$ServiceUrl = '__MASALAPOS_LICENSE_SERVICE_URL__'
$Fingerprint = '__MASALAPOS_KEY_FINGERPRINT__'
$AppVersion = '__MASALAPOS_APP_VERSION__'

$CheckCodes = 'Check the Customer ID and Order ID. They are on the setup card MasalaPOS gave you.'
$Unreachable = "Couldn't reach the MasalaPOS licensing service. Check this computer's internet connection and try again."
$WrongKey = 'The licensing service signs with a different key than this installer trusts. Contact MasalaPOS support.'
$NotRecognised = "The licensing service doesn't recognise this computer. Contact MasalaPOS support."
$Busy = 'The licensing service is busy. Try again in a minute.'

function Fail([string]$message) { [Console]::Out.Write($message); exit 1 }

# The same check as parseVendorCode (packages/domain/src/vendor-codes.ts), so a typo never goes over the network.
$Alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function Read-VendorCode([string]$prefix, [string]$text) {
  $t = ($text.ToUpperInvariant() -replace '[\s-]+', '')
  if ($t.Length -eq ($prefix.Length + 7) -and $t.StartsWith($prefix)) { $t = $t.Substring($prefix.Length) }
  $t = ($t -replace '[IL]', '1') -replace 'O', '0'
  if ($t.Length -ne 7) { return $null }
  $values = @()
  foreach ($c in $t.ToCharArray()) { $v = $Alphabet.IndexOf($c); if ($v -lt 0) { return $null }; $values += $v }
  $sum = 0
  for ($i = 0; $i -lt 6; $i++) { $sum += $values[$i] * (2 * $i + 1) }
  if ($values[6] -ne ($sum % 32)) { return $null }
  return "$prefix-$($t.Substring(0, 4))-$($t.Substring(4))"
}

function Read-Identity([string]$path) {
  if (!(Test-Path -LiteralPath $path)) { return $null }
  try { $saved = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { return $null }
  if ("$($saved.installationId)" -match '^[0-9a-fA-F-]{36}$' -and "$($saved.installationSecret)" -cmatch '^[a-f0-9]{64}$') {
    return @{ installationId = "$($saved.installationId)"; installationSecret = "$($saved.installationSecret)" }
  }
  return $null
}

try {
  $lines = @(Get-Content -LiteralPath $Ids)
  $customerId = Read-VendorCode 'FC' "$($lines[0])"
  $orderId = Read-VendorCode 'FO' "$($lines[1])"
} catch { Fail $CheckCodes }
if (!$customerId -or !$orderId) { Fail $CheckCodes }

$stageDir = Join-Path $env:ProgramData 'MasalaPOS'
$stagePath = Join-Path $stageDir 'activation.json'
# Reinstalling must not take a second seat: reuse this PC's identity if the app (or an earlier run of setup) already has one.
# Setup runs elevated, possibly as a different administrator than the person who uses the app, so $env:APPDATA is not enough: look in
# the signed-in user's profile and every other profile too, newest first (the app keeps installation.json under AppData\Roaming).
$interactiveUser = $null
try { $interactiveUser = "$((Get-CimInstance -ClassName Win32_ComputerSystem).UserName)" } catch { }
$identityFiles = @(Join-Path $env:APPDATA 'masalapos-desktop\data\installation.json')
if ($interactiveUser -match '\\(.+)$') { $identityFiles += Join-Path (Join-Path (Split-Path -Parent $env:USERPROFILE) $Matches[1]) 'AppData\Roaming\masalapos-desktop\data\installation.json' }
try {
  $identityFiles += @(Get-ChildItem -LiteralPath (Split-Path -Parent $env:USERPROFILE) -Directory -ErrorAction Stop |
    ForEach-Object { Join-Path $_.FullName 'AppData\Roaming\masalapos-desktop\data\installation.json' } |
    Where-Object { Test-Path -LiteralPath $_ } | Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending)
} catch { }
$identity = $null
foreach ($file in $identityFiles) { $identity = Read-Identity $file; if ($identity) { break } }
if (!$identity) { $identity = Read-Identity $stagePath }
if (!$identity) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()
  $identity = @{ installationId = [guid]::NewGuid().ToString(); installationSecret = (($bytes | ForEach-Object { $_.ToString('x2') }) -join '') }
}

$activation = [ordered]@{
  format = 'masalapos-activation-request'; version = 1; installationId = $identity.installationId
  licenseId = $null; organizationId = $null; outletId = $null; currentRevision = 0
  generatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); verificationKeyFingerprint = $Fingerprint; appVersion = $AppVersion
}
$body = [ordered]@{ activation = $activation; customerId = $customerId; orderId = $orderId } | ConvertTo-Json -Depth 4 -Compress

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(30)
  $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "$ServiceUrl/v1/enroll")
  $request.Headers.Add('X-MasalaPOS-Installation-Secret', $identity.installationSecret)
  $request.Content = New-Object System.Net.Http.StringContent($body, [Text.Encoding]::UTF8, 'application/json')
  $response = $client.SendAsync($request).GetAwaiter().GetResult()
  $status = [int]$response.StatusCode
  $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
} catch { Fail $Unreachable }

$reply = $null
try { $reply = $text | ConvertFrom-Json } catch { }
if ($status -lt 200 -or $status -ge 300) {
  # The same answers a counter gives in Setup (Licensing.enroll in apps/server/src/licensing.ts).
  if ($status -eq 409 -and $reply.error -eq 'wrong_key') { Fail $WrongKey }
  if ($status -eq 401) { Fail $NotRecognised }
  if ($status -eq 429) { Fail $Busy }
  if ($status -eq 404) { Fail $CheckCodes }
  if ($status -eq 409 -and $reply.message -is [string]) { Fail ($reply.message.Substring(0, [Math]::Min(300, $reply.message.Length))) }
  Fail $Unreachable
}
if (!$reply -or !$reply.customer -or !$reply.order) { Fail $Unreachable }

$staged = [ordered]@{
  format = 'masalapos-installer-activation'; version = 1
  installationId = $identity.installationId; installationSecret = $identity.installationSecret
  license = $reply.license; customerCode = "$($reply.customer.code)"; orderCode = "$($reply.order.code)"; createdAt = $activation.generatedAt
}
try {
  New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
  # The file holds the installation secret, so it is locked down before the secret is written. Only SYSTEM and Administrators get full
  # control; MasalaPOS runs as the signed-in user, who needs to read the file and delete it once adopted (apps/server/src/license-config.ts).
  # If that user can't be found, any local user may read and delete it, as the app only adopts a file made for its own identity.
  $reader = '*S-1-5-32-545'
  try { $reader = '*' + (New-Object Security.Principal.NTAccount($interactiveUser)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { }
  Remove-Item -LiteralPath $stagePath -Force -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText($stagePath, '', (New-Object Text.UTF8Encoding $false))
  & "$env:SystemRoot\System32\icacls.exe" $stagePath /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "${reader}:(R,D)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }
  [IO.File]::WriteAllText($stagePath, ($staged | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
} catch { Fail "MasalaPOS was activated but setup couldn't save it in $stageDir. Run setup again." }
[Console]::Out.Write("Activated for $($reply.customer.name), order $($reply.order.code).")
exit 0
