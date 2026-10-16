$ErrorActionPreference = 'Stop'
$script:OutletServiceName = 'ForkFlowOutlet'
$script:OutletInstall = Join-Path $env:ProgramFiles 'ForkFlow\Outlet'
$script:OutletState = Join-Path $env:ProgramData 'ForkFlow\Outlet'
$script:OutletData = Join-Path $script:OutletState 'data'
$script:OutletHostExe = Join-Path $script:OutletInstall 'ForkFlowOutlet.exe'
$script:OutletHostXml = Join-Path $script:OutletInstall 'ForkFlowOutlet.xml'
$script:OutletTrustKey = Join-Path $script:OutletInstall 'trusted-release-key.pem'
$script:OutletJournal = Join-Path $script:OutletInstall 'update-pending.json'

function Assert-OutletAdministrator {
  $outletPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $outletPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Outlet installation and offline maintenance require an elevated local Administrator PowerShell session.' }
}
function Assert-OutletChild([string]$Parent, [string]$Child) {
  $outletParentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $outletChildPath = [IO.Path]::GetFullPath($Child)
  if (-not $outletChildPath.StartsWith($outletParentPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path is outside the intended outlet directory.' }
  # Never follow junctions/reparse points in service-controlled directories.
  $outletWalk = $outletChildPath
  while ($outletWalk -and $outletWalk.Length -ge $outletParentPath.TrimEnd('\').Length) {
    if ((Test-Path -LiteralPath $outletWalk) -and ((Get-Item -LiteralPath $outletWalk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse points are not allowed in outlet installation/data paths.' }
    $outletWalk = Split-Path -Parent $outletWalk
  }
  return $outletChildPath
}
function Get-OutletRelease([string]$Version) {
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid installed release version.' }
  return Assert-OutletChild $script:OutletInstall (Join-Path $script:OutletInstall ('releases\' + $Version))
}
function Read-OutletJson([string]$Path) { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) }
function Write-OutletJson([string]$Path, $Value) {
  $outletTemp = $Path + '.tmp'
  $outletBytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20))
  $outletStream = [IO.File]::Open($outletTemp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $outletStream.Write($outletBytes, 0, $outletBytes.Length); $outletStream.Flush($true) } finally { $outletStream.Dispose() }
  if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($outletTemp, $Path, $null) } else { [IO.File]::Move($outletTemp, $Path) }
}
function Invoke-OutletNode([string]$Release, [string[]]$Arguments) {
  & (Join-Path $Release 'node.exe') @Arguments
  if ($LASTEXITCODE -ne 0) { throw 'Outlet runtime command failed; inspect the preceding diagnostic.' }
}
function Test-OutletRelease([string]$ToolRelease, [string]$Candidate) {
  $outletOutput = Invoke-OutletNode $ToolRelease @((Join-Path $ToolRelease 'release.mjs'), 'verify', $Candidate, $script:OutletTrustKey)
  return ($outletOutput | ConvertFrom-Json)
}
function Stop-OutletService {
  $outletService = Get-Service -Name $script:OutletServiceName -ErrorAction SilentlyContinue
  if ($outletService -and $outletService.Status -ne 'Stopped') {
    Stop-Service -Name $script:OutletServiceName
    $outletService.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(65))
  }
}
function Set-OutletServiceXml([string]$Release, [switch]$Probe) {
  $outletTemplate = [IO.File]::ReadAllText((Join-Path $Release 'service-template.xml'))
  $outletBinXml = [Security.SecurityElement]::Escape($Release)
  $outletStateXml = [Security.SecurityElement]::Escape($script:OutletState)
  $outletXml = $outletTemplate.Replace('{RELEASE}', $outletBinXml).Replace('{STATE}', $outletStateXml)
  if ($Probe) { $outletXml = $outletXml.Replace('</service>', '<env name="FORKFLOW_UPDATE_PROBE" value="1"/></service>') }
  $outletTempXml = $script:OutletHostXml + '.tmp'
  [IO.File]::WriteAllText($outletTempXml, $outletXml, [Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $script:OutletHostXml) { [IO.File]::Replace($outletTempXml, $script:OutletHostXml, $null) } else { [IO.File]::Move($outletTempXml, $script:OutletHostXml) }
}
function Set-OutletDirectoryAcl([string]$Path, [string]$ServiceRights, [switch]$Recursive, [switch]$PublicRead) {
  $outletAcl = [Security.AccessControl.DirectorySecurity]::new()
  $outletAcl.SetAccessRuleProtection($true, $false)
  $outletAdminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $outletAcl.SetOwner($outletAdminSid)
  foreach ($outletSid in @($outletAdminSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $outletAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($outletSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  if ($ServiceRights) { $outletAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(('NT SERVICE\' + $script:OutletServiceName), $ServiceRights, 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }
  if ($PublicRead) { $outletAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }
  Set-Acl -LiteralPath $Path -AclObject $outletAcl
  if ($Recursive) {
    foreach ($outletItem in Get-ChildItem -LiteralPath $Path -Recurse -Force) {
      Assert-OutletChild $Path $outletItem.FullName | Out-Null
      $outletInherited = Get-Acl -LiteralPath $outletItem.FullName
      $outletInherited.SetAccessRuleProtection($false, $false)
      foreach ($outletRule in @($outletInherited.Access | Where-Object { -not $_.IsInherited })) { $outletInherited.RemoveAccessRuleSpecific($outletRule) }
      $outletInherited.SetOwner($outletAdminSid)
      Set-Acl -LiteralPath $outletItem.FullName -AclObject $outletInherited
    }
  }
}
function Set-OutletPermissions {
  # Binary/control files are immutable to the virtual service identity.
  Set-OutletDirectoryAcl $script:OutletInstall 'ReadAndExecute' -Recursive -PublicRead
  Set-OutletDirectoryAcl $script:OutletState 'ReadAndExecute' -Recursive
  Set-OutletDirectoryAcl $script:OutletData 'Modify' -Recursive
  Set-OutletDirectoryAcl (Join-Path $script:OutletState 'logs') 'Modify' -Recursive
}
function Wait-OutletHealth([string]$Release, [string]$Version) {
  $outletHealth = Join-Path $Release 'health.mjs'
  Invoke-OutletNode $Release @($outletHealth, $script:OutletData, $Version)
}
