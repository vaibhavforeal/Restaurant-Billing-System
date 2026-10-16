param()
. (Join-Path $PSScriptRoot 'outlet.ps1')
Assert-OutletAdministrator
if (Test-Path -LiteralPath $script:OutletJournal) { throw 'Finish or recover the pending update before uninstalling.' }
Stop-OutletService
& $script:OutletHostExe uninstall
if ($LASTEXITCODE -ne 0) { throw 'Service removal failed.' }
Get-NetFirewallRule -DisplayName 'ForkFlow Outlet HTTPS 4443' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$outletShortcutDirectory = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\ForkFlow'
foreach ($outletName in @('ForkFlow POS.lnk','ForkFlow Kitchen.lnk','ForkFlow Captain.lnk')) {
  $outletShortcutPath = Join-Path $outletShortcutDirectory $outletName
  if (Test-Path -LiteralPath $outletShortcutPath) { Remove-Item -LiteralPath $outletShortcutPath }
}
Write-Output 'Service and shortcuts removed. ProgramData restaurant data, backups, TLS keys and ProgramFiles releases are preserved for recovery.'
