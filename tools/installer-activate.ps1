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

Add-Type -Namespace MasalaPos -Name Handles -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
static extern uint GetFinalPathNameByHandleW(Microsoft.Win32.SafeHandles.SafeFileHandle handle, System.Text.StringBuilder path, uint size, uint flags);
/// <summary>The path the open file really has, after every junction and symbolic link on the way to it.</summary>
public static string FinalPath(Microsoft.Win32.SafeHandles.SafeFileHandle handle) {
  var path = new System.Text.StringBuilder(1024);
  uint length = GetFinalPathNameByHandleW(handle, path, 1024, 0);
  if (length == 0 || length >= 1024) return null;
  var text = path.ToString();
  if (text.StartsWith(@"\\?\UNC\")) return null;
  return text.StartsWith(@"\\?\") ? text.Substring(4) : text;
}
'@

# Reads an identity only from the file actually opened: it must sit at exactly this path (no junction or link anywhere on the way
# redirected it) and be owned by one of $owners. Both are checked on the open handle, so the file can't be swapped after the check.
function Read-Identity([string]$path, [string[]]$owners) {
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  $stream = $null
  try {
    $stream = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ([MasalaPos.Handles]::FinalPath($stream.SafeFileHandle) -ne [IO.Path]::GetFullPath($path)) { return $null }
    if ($owners -notcontains $stream.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value) { return $null }
    $saved = (New-Object IO.StreamReader($stream, (New-Object Text.UTF8Encoding $false), $true)).ReadToEnd() | ConvertFrom-Json
  } catch { return $null } finally { if ($stream) { $stream.Dispose() } }
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

$Admins = 'S-1-5-32-544'; $System = 'S-1-5-18'
$NoUser = "Setup couldn't tell which Windows user will use MasalaPOS. Sign in to Windows as that person and run setup again."

# The person whose desktop this setup runs on. Setup is elevated, possibly with another administrator's credentials, but it stays in the
# session it was started from, so the owner of that session's Explorer is the person who will use MasalaPOS (this also works over RDP).
function Get-SessionUserSid {
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  try {
    foreach ($explorer in @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'explorer.exe'" -ErrorAction Stop)) {
      if ($explorer.SessionId -ne $session) { continue }
      $owner = Invoke-CimMethod -InputObject $explorer -MethodName GetOwnerSid -ErrorAction Stop
      if ($owner.ReturnValue -eq 0 -and "$($owner.Sid)" -match '^S-1-5-') { return "$($owner.Sid)" }
    }
  } catch { }
  try {
    $name = "$((Get-CimInstance -ClassName Win32_ComputerSystem).UserName)"
    if ($name) { return (New-Object Security.Principal.NTAccount($name)).Translate([Security.Principal.SecurityIdentifier]).Value }
  } catch { }
  return $null
}

# Only a file owned by one of these accounts is trusted; anything else may have been planted by another user of this PC.
function Test-OwnedBy([string]$path, [string[]]$sids) {
  try {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    return $sids -contains (Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value
  } catch { return $false }
}

$userSid = Get-SessionUserSid
if (!$userSid) { Fail $NoUser }
$selfSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

# The staging folder is shared by every Windows user, so it must belong to administrators and let no one else write to it; otherwise a
# user could swap setup's file for one carrying an identity they know. The Support Connector holds this folder to the same rule.
$stageDir = Join-Path $env:ProgramData 'MasalaPOS'
$stagePath = Join-Path $stageDir 'activation.json'
try {
  if (Test-Path -LiteralPath $stageDir) {
    if (!(Test-OwnedBy $stageDir @($Admins, $System, $selfSid))) { Fail "$stageDir isn't owned by an administrator. Ask a local administrator to remove it, then run setup again." }
  } else { New-Item -ItemType Directory -Path $stageDir | Out-Null }
  & "$env:SystemRoot\System32\icacls.exe" $stageDir /setowner "*${Admins}" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }
  & "$env:SystemRoot\System32\icacls.exe" $stageDir /inheritance:r /grant:r "*${System}:(OI)(CI)F" "*${Admins}:(OI)(CI)F" '*S-1-5-32-545:(RX)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }
} catch { Fail "Setup couldn't prepare $stageDir. Run setup again." }

# Reinstalling must not take a second seat: reuse this PC's identity if the app (or an earlier run of setup) already has one. Only two
# profiles are looked at, the administrator running setup and the person using this session (the app keeps installation.json under
# AppData\Roaming), and only a file its own user made. The session user's file must be owned by that user alone: accepting an
# administrator-owned file there would let them point their profile at another installation's file and have setup hand them its secret.
$identityFiles = @(@{ path = (Join-Path $env:APPDATA 'masalapos-desktop\data\installation.json'); owners = @($selfSid, $Admins, $System) })
try {
  $profilePath = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$userSid" -ErrorAction Stop).ProfileImagePath
  if ($profilePath -and $userSid -ne $selfSid) { $identityFiles += @{ path = (Join-Path $profilePath 'AppData\Roaming\masalapos-desktop\data\installation.json'); owners = @($userSid) } }
} catch { }
$identityFiles += @{ path = $stagePath; owners = @($selfSid, $Admins, $System) }
$identity = $null
foreach ($file in $identityFiles) { $identity = Read-Identity $file.path $file.owners; if ($identity) { break } }
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
# The file holds the installation secret. It is created new (never reusing a file someone else may own, or a link) with its permissions
# set at creation: SYSTEM and Administrators get full control, and the person using this session, as whom MasalaPOS runs, may only read
# it and delete it once adopted (apps/server/src/license-config.ts). No other user is ever given access.
function Write-StagedSecret([string]$path, [string]$text) {
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  if (Test-Path -LiteralPath $path) { throw 'The old activation file could not be removed.' }
  $security = New-Object Security.AccessControl.FileSecurity
  # Owned by the Administrators group (not the administrator who ran setup): MasalaPOS adopts the file only when Administrators or
  # SYSTEM owns it and nobody else can write to it.
  $security.SetOwner((New-Object Security.Principal.SecurityIdentifier($Admins)))
  $security.SetAccessRuleProtection($true, $false)
  foreach ($grant in @{ sid = $System; rights = 'FullControl' }, @{ sid = $Admins; rights = 'FullControl' }, @{ sid = $userSid; rights = 'Read, Delete' }) {
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($grant.sid)), [Security.AccessControl.FileSystemRights]$grant.rights, 'Allow')))
  }
  $stream = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $security)
  try { $bytes = (New-Object Text.UTF8Encoding $false).GetBytes($text); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
  # Confirm what landed: Administrators owns it and exactly those three grants, none inherited, are on it.
  $acl = Get-Acl -LiteralPath $path
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $expected = @($System, $Admins, $userSid)
  if (@($Admins, $System) -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -or $rules.Count -ne 3 -or
      @($rules | Where-Object { $_.IsInherited -or $_.AccessControlType -ne 'Allow' -or $expected -notcontains $_.IdentityReference.Value }).Count) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    throw 'The activation file did not get the expected permissions.'
  }
}
try { Write-StagedSecret $stagePath ($staged | ConvertTo-Json -Compress) }
catch { Fail "MasalaPOS was activated but setup couldn't save it in $stageDir. Run setup again." }
[Console]::Out.Write("Activated for $($reply.customer.name), order $($reply.order.code).")
exit 0
