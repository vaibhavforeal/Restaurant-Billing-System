param([string]$ReleaseDirectory, [switch]$Resume)
. (Join-Path $PSScriptRoot 'outlet.ps1')
Assert-OutletAdministrator
$outletInstalled = Read-OutletJson (Join-Path $script:OutletInstall 'installed.json')
$outletOld = Get-OutletRelease $outletInstalled.version
if ($Resume) {
  if (-not (Test-Path -LiteralPath $script:OutletJournal)) { throw 'No update is pending.' }
  Invoke-OutletNode $outletOld @((Join-Path $outletOld 'update.mjs'), $script:OutletInstall, (Join-Path $outletOld 'update-action.ps1'), 'resume')
  return
}
if (-not $ReleaseDirectory) { throw 'Provide a signed release directory or use -Resume.' }
if (Test-Path -LiteralPath $script:OutletJournal) { throw 'A previous update is pending; use -Resume before attempting another update.' }
$outletIncoming = [IO.Path]::GetFullPath($ReleaseDirectory)
$outletCandidate = Test-OutletRelease $outletOld $outletIncoming
$outletCompatibility = Join-Path $script:OutletInstall 'update-compatibility.json'
Write-OutletJson $outletCompatibility @{ currentVersion=$outletInstalled.version }
$outletDestination = Get-OutletRelease $outletCandidate.version
# Installed Node and verifier authenticate the package before any service stop or untrusted execution.
Invoke-OutletNode $outletOld @((Join-Path $outletOld 'release.mjs'), 'stage', $outletIncoming, $script:OutletTrustKey, $outletDestination, $outletCompatibility)
$outletStagedManifest = Read-OutletJson (Join-Path $outletDestination 'release.json')
if ($outletStagedManifest.version -ne $outletCandidate.version -or $outletStagedManifest.winsw -ne '2.12.0') { throw 'Release version changed during staging or WinSW requires separate installer migration.' }
Set-OutletDirectoryAcl $outletDestination 'ReadAndExecute' -Recursive -PublicRead
# Prevent a reboot from starting the old normal XML between snapshot and probe.
Set-Service -Name $script:OutletServiceName -StartupType Manual
Stop-OutletService
try {
  $outletSnapshotOutput = Invoke-OutletNode $outletOld @((Join-Path $outletOld 'maintenance.mjs'), 'prepare-update', $script:OutletData, (Join-Path $outletDestination 'release.json'))
  $outletSnapshot = $outletSnapshotOutput | ConvertFrom-Json
} catch { Set-Service -Name $script:OutletServiceName -StartupType Automatic; Start-Service -Name $script:OutletServiceName; throw }
Write-OutletJson $script:OutletJournal @{ phase='prepared'; oldVersion=$outletInstalled.version; newVersion=$outletCandidate.version; backup=$outletSnapshot.backup }
Invoke-OutletNode $outletOld @((Join-Path $outletOld 'update.mjs'), $script:OutletInstall, (Join-Path $outletOld 'update-action.ps1'), 'run')
Write-Output ('Outlet updated to ' + $outletCandidate.version)
