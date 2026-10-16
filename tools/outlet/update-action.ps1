param([ValidateSet('stop','configure','start','health','restore')][string]$Action, [string]$Version, [string]$Backup, [switch]$Probe)
. (Join-Path $PSScriptRoot 'outlet.ps1')
Assert-OutletAdministrator
switch ($Action) {
  'stop' { Stop-OutletService }
  'configure' {
    $outletRelease = Get-OutletRelease $Version
    Set-OutletServiceXml $outletRelease -Probe:$Probe
    if ($Probe) { Set-Service -Name $script:OutletServiceName -StartupType Manual }
    else { Set-Service -Name $script:OutletServiceName -StartupType Automatic }
    $outletFirewallRule = Get-NetFirewallRule -DisplayName 'ForkFlow Outlet HTTPS 4443' -ErrorAction SilentlyContinue
    if ($outletFirewallRule) { $outletFirewallRule | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program (Join-Path $outletRelease 'node.exe') }
  }
  'start' { Start-Service -Name $script:OutletServiceName }
  'health' { Wait-OutletHealth (Get-OutletRelease $Version) $Version }
  'restore' {
    $outletBackupPath = Assert-OutletChild $script:OutletData (Join-Path $script:OutletData ('backups\' + $Backup))
    Invoke-OutletNode (Get-OutletRelease $Version) @((Join-Path (Get-OutletRelease $Version) 'maintenance.mjs'), 'restore', $script:OutletData, $outletBackupPath)
  }
}
