param([Parameter(Mandatory=$true)][string]$LauncherPath,[Parameter(Mandatory=$true)][string]$Origin,[Parameter(Mandatory=$true)][string]$KeyFile,[int]$Development = 0)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules') + ';' + (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Net.Http
$script:cancelled = $false
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$runtimeDir = $null
$progress = $null
$sessionMutex = [Threading.Mutex]::new($false, 'Global\MasalaPOSSupportConnector')
$sessionHeld = $false
function Protect-Directory([string]$path) {
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The connector cache must not be a link.' }
    $acl = Get-Acl -LiteralPath $path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin @('S-1-5-32-544','S-1-5-18')) { throw 'The connector cache is not administrator-owned. Ask a local administrator to remove it.' }
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @('S-1-5-32-544','S-1-5-18') -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write)) { throw 'The connector cache permits non-administrator writes.' }
    }
    return
  }
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $security.SetOwner($admins); $security.SetAccessRuleProtection($true,$false)
  foreach ($principal in @($admins,$system)) { $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }
  [IO.Directory]::CreateDirectory($path,$security) | Out-Null
}
function Receive-Runtime([string]$url,[string]$path,[long]$size) {
  $handler = [Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect = $false
  $client = [Net.Http.HttpClient]::new($handler)
  $cancel = [Threading.CancellationTokenSource]::new(900000)
  $response = $null; $source = $null; $output = $null
  function Await-Download($task) {
    while (!$task.IsCompleted) {
      [Windows.Forms.Application]::DoEvents()
      if ($script:cancelled) { $cancel.Cancel(); throw 'Download cancelled. No screen sharing started.' }
      Start-Sleep -Milliseconds 30
    }
    return $task.GetAwaiter().GetResult()
  }
  try {
    $response = Await-Download ($client.GetAsync($url,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cancel.Token))
    $response.EnsureSuccessStatusCode() | Out-Null
    $source = Await-Download ($response.Content.ReadAsStreamAsync())
    $output = [IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $buffer = New-Object byte[] 65536; $total = [long]0
    while ($true) {
      $count = Await-Download ($source.ReadAsync($buffer,0,$buffer.Length,$cancel.Token))
      if ($count -eq 0) { break }
      $total += $count
      if ($total -gt $size) { throw 'The runtime exceeds its signed size.' }
      $output.Write($buffer,0,$count)
      $label.Text = 'Downloading Support Connector: ' + [Math]::Floor(100*$total/$size) + '%'
    }
    if ($total -ne $size) { throw 'The runtime download is incomplete.' }
  } finally {
    if ($output) { $output.Dispose() }; if ($source) { $source.Dispose() }; if ($response) { $response.Dispose() }
    $cancel.Dispose(); $client.Dispose(); $handler.Dispose()
  }
}
function Read-Json([string]$url) {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $url -MaximumRedirection 0 -TimeoutSec 30
  if ($response.Content.Length -gt 32768) { throw 'Invalid server response' }
  return $response.Content | ConvertFrom-Json
}
try {
  try { $sessionHeld = $sessionMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $sessionHeld = $true }
  if (!$sessionHeld) { throw 'Support Connector is already running on this PC.' }
  if ([Uri]$Origin -and ([Uri]$Origin).Scheme -ne 'https') { throw 'Support requires HTTPS' }
  $match = [regex]::Match([IO.Path]::GetFileName($LauncherPath),'^MasalaPOS-Support-C-\d+-([A-Za-z0-9_-]{43})(?: \(\d+\))?\.exe$')
  if ($match.Success) { $redeemBody = @{ token = $match.Groups[1].Value } }
  else {
    Add-Type -AssemblyName Microsoft.VisualBasic
    $code = [Microsoft.VisualBasic.Interaction]::InputBox('Paste the connector code from your MasalaPOS support chat.','MasalaPOS Support')
    if (!$code) { exit 0 }
    if ($code -notmatch '^[A-Za-z0-9-]{12,19}$') { throw 'Use the full code from the support chat.' }
    $redeemBody = @{ code = $code }
  }
  $progress = [Windows.Forms.Form]::new(); $progress.Text = 'MasalaPOS Support'; $progress.Width = 440; $progress.Height = 150; $progress.StartPosition = 'CenterScreen'; $progress.ControlBox = $true
  $progress.Add_FormClosing({ param($sender,$event) $script:cancelled = $true })
  $label = [Windows.Forms.Label]::new(); $label.Text = 'Preparing Support Connector. The first download may take a few minutes.'; $label.Dock = 'Fill'; $label.Padding = [Windows.Forms.Padding]::new(20); $progress.Controls.Add($label); $progress.Show(); [Windows.Forms.Application]::DoEvents()
  $manifest = Read-Json ($Origin + '/support/connector-runtime/latest.json')
  if ($manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$' -or $manifest.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$manifest.size -lt 1 -or [long]$manifest.size -gt 536870912) { throw 'Invalid runtime manifest' }
  $payloadUrl = [Uri]$manifest.url
  if ($payloadUrl.Scheme -ne 'https' -or !$payloadUrl.Host.EndsWith('.cloudfront.net') -or $payloadUrl.UserInfo -or $payloadUrl.Query -or $payloadUrl.Fragment) { throw 'Invalid runtime download location' }
  $signed = $manifest.version + "`n" + $manifest.sha256 + "`n" + $manifest.size + "`n" + $manifest.url + "`n" + ([string][bool]$manifest.production).ToLowerInvariant()
  $rsa = [Security.Cryptography.RSACryptoServiceProvider]::new()
  try {
    $rsa.FromXmlString((Get-Content -LiteralPath $KeyFile -Raw))
    if (!$rsa.VerifyData([Text.Encoding]::UTF8.GetBytes($signed),'SHA256',[Convert]::FromBase64String($manifest.signature))) { throw 'The runtime manifest signature is invalid' }
  } finally { $rsa.Dispose() }
  if (!$manifest.production -and !$Development) { throw 'This runtime is not approved for production distribution' }
  $parent = Join-Path $env:ProgramData 'MasalaPOS'; Protect-Directory $parent
  $root = Join-Path $parent 'SupportConnector'; Protect-Directory $root
  $recoveryDir = Join-Path $root 'recovery'; Protect-Directory $recoveryDir
  $cache = Join-Path $root ('cache-' + $manifest.version + '-' + $manifest.sha256); Protect-Directory $cache
  $zip = Join-Path $cache 'runtime.zip'
  if (Test-Path -LiteralPath $zip) {
    if ((Get-Item -LiteralPath $zip).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid cached archive' }
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { Remove-Item -LiteralPath $zip -Force }
  }
  if (!(Test-Path -LiteralPath $zip)) {
    $part = Join-Path $cache ([Guid]::NewGuid().ToString('N') + '.part')
    try {
      Receive-Runtime $manifest.url $part ([long]$manifest.size)
      if ((Get-Item -LiteralPath $part).Length -ne [long]$manifest.size -or (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw 'The download is incomplete or has been changed. Please try again.' }
      Move-Item -LiteralPath $part -Destination $zip -Force
    } finally { if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force } }
  }
  # Re-extract verified cached bytes into a fresh protected directory on each run. Never execute a previously modified extracted tree.
  $runtimeDir = Join-Path $root ('run-' + [Guid]::NewGuid().ToString('N')); Protect-Directory $runtimeDir
  $base = [IO.Path]::GetFullPath($runtimeDir) + [IO.Path]::DirectorySeparatorChar
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $total = [long]0
    foreach ($entry in $archive.Entries) {
      $total += $entry.Length
      if ($total -gt 1073741824 -or $entry.FullName.Contains(':') -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Unsafe archive entry' }
      $destination = [IO.Path]::GetFullPath((Join-Path $runtimeDir $entry.FullName))
      if (!$destination.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive path' }
      if (!$entry.Name) { [IO.Directory]::CreateDirectory($destination) | Out-Null; continue }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$destination,$false)
    }
  } finally { $archive.Dispose() }
  $exe = Join-Path $runtimeDir 'MasalaPOS Support.exe'
  if (!$Development) {
    $signature = Get-AuthenticodeSignature -LiteralPath $exe
    if ($signature.Status -ne 'Valid' -or !$signature.TimeStamperCertificate) { throw 'The Support Connector signature could not be verified' }
  }
  $recovery = Join-Path $runtimeDir 'recovery.ps1'
  # Keep a protected recovery copy until restoration completes; boot recovery must outlive this transient extraction.
  $recoveryCopy = Join-Path $recoveryDir 'recovery.ps1'
  if (!(Test-Path -LiteralPath (Join-Path $recoveryDir 'restore.json'))) { Copy-Item -LiteralPath $recovery -Destination $recoveryCopy -Force }
  & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $recoveryCopy -Action Restore
  if ($LASTEXITCODE -ne 0) { throw 'A support session is running or Windows recovery needs attention' }
  $label.Text = 'Opening your support invitation...'; [Windows.Forms.Application]::DoEvents()
  if ($script:cancelled) { throw 'Cancelled. No screen sharing started.' }
  $context = Invoke-RestMethod -Method Post -Uri ($Origin + '/v1/connector/redeem') -ContentType 'application/json' -Body ($redeemBody | ConvertTo-Json -Compress) -MaximumRedirection 0 -TimeoutSec 30
  if ($context.token -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Invalid invitation response' }
  $start = [Diagnostics.ProcessStartInfo]::new($exe,'--bootstrap'); $start.UseShellExecute = $false; $start.WorkingDirectory = $runtimeDir; $start.RedirectStandardInput = $true
  $process = [Diagnostics.Process]::Start($start)
  $process.StandardInput.WriteLine(($context | ConvertTo-Json -Depth 12 -Compress)); $process.StandardInput.Close()
  $context = $null; $redeemBody = $null
  $progress.Close(); $progress = $null
  $process.WaitForExit()
} catch {
  if ($progress) { $progress.Close() }
  [Windows.Forms.MessageBox]::Show('Support Connector could not start. ' + $_.Exception.Message,'MasalaPOS Support','OK','Error') | Out-Null
  exit 1
} finally {
  if ($progress) { $progress.Dispose() }
  if ($sessionHeld) { $sessionMutex.ReleaseMutex() }; $sessionMutex.Dispose()
  if ($runtimeDir) {
    $resolved = [IO.Path]::GetFullPath($runtimeDir)
    $expected = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'MasalaPOS\SupportConnector')) + '\'
    if ($resolved.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^run-[a-f0-9]{32}$') { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
