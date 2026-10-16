param([Parameter(Mandatory=$true)][ValidateSet('status','backup','restore')][string]$Command, [string]$BackupFile)
. (Join-Path $PSScriptRoot 'outlet.ps1')
Assert-OutletAdministrator
if (Test-Path -LiteralPath $script:OutletJournal) { throw 'Finish the pending update with update.ps1 -Resume before manual maintenance.' }
$outletInstalled = Read-OutletJson (Join-Path $script:OutletInstall 'installed.json')
$outletRelease = Get-OutletRelease $outletInstalled.version
Stop-OutletService
try {
  $outletArguments = @((Join-Path $outletRelease 'maintenance.mjs'), $Command, $script:OutletData)
  if ($Command -eq 'restore') {
    if (-not $BackupFile) { throw 'Restore requires a verified backup file.' }
    $outletArguments += [IO.Path]::GetFullPath($BackupFile)
  }
  Invoke-OutletNode $outletRelease $outletArguments
} finally { Start-Service -Name $script:OutletServiceName }
Wait-OutletHealth $outletRelease $outletInstalled.version
