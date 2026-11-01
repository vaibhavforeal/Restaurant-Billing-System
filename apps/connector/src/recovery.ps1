param([ValidateSet('Watch','Restore')][string]$Action = 'Restore', [int]$ParentId = 0)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules') + ';' + (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules')
$root = Join-Path $env:ProgramData 'MasalaPOS\SupportConnector\recovery'
$marker = Join-Path $root 'restore.json'
$taskName = 'MasalaPOS Support Connector Restore'
$keyPath = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$valueName = 'PromptOnSecureDesktop'
$mutex = [Threading.Mutex]::new($false, 'Global\MasalaPOSSupportPromptRecovery')
$held = $false
$registry = $null
function Restore-Policy {
  if (!(Test-Path -LiteralPath $marker)) { return }
  $saved = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine','Registry64').OpenSubKey($keyPath,$true)
  try {
    if ($saved.exists) { $registry.SetValue($valueName,[int]$saved.value,[Microsoft.Win32.RegistryValueKind]::DWord) }
    else { $registry.DeleteValue($valueName,$false) }
    $registry.Flush()
    if ($saved.exists -and $registry.GetValue($valueName) -ne [int]$saved.value) { throw 'Windows policy restoration was refused' }
    if (!$saved.exists -and $registry.GetValueNames() -contains $valueName) { throw 'Windows policy restoration was refused' }
  } finally { $registry.Dispose() }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $marker -Force
}
try {
  try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
  if (!$held) { throw 'A support recovery session is already running' }
  if ($Action -eq 'Restore') { Restore-Policy; exit 0 }
  $parent = Get-Process -Id $ParentId -ErrorAction Stop
  $parentStart = $parent.StartTime.ToUniversalTime().Ticks
  Restore-Policy
  # The launcher creates this administrator-owned directory before launching Electron.
  if (!(Test-Path -LiteralPath $root)) { throw 'Protected recovery directory missing' }
  $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine','Registry64').OpenSubKey($keyPath,$true)
  $exists = $registry.GetValueNames() -contains $valueName
  if ($exists -and $registry.GetValueKind($valueName) -ne [Microsoft.Win32.RegistryValueKind]::DWord) { throw 'Unexpected Windows policy type' }
  @{ exists=$exists; value=$registry.GetValue($valueName); parentId=$ParentId; parentStart=$parentStart } | ConvertTo-Json -Compress | Set-Content -LiteralPath $marker -Encoding UTF8
  $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action Restore'
  $taskAction = New-ScheduledTaskAction -Execute $exe -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtStartup
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
  if (!(Get-ScheduledTask -TaskName $taskName)) { throw 'Recovery task was not registered' }
  $registry.SetValue($valueName,0,[Microsoft.Win32.RegistryValueKind]::DWord)
  $registry.Flush()
  if ($registry.GetValue($valueName) -ne 0) { throw 'Windows policy refused the change' }
  [Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
  $last = [DateTime]::UtcNow
  $read = [Console]::In.ReadLineAsync()
  while ($true) {
    Start-Sleep -Milliseconds 200
    $process = Get-Process -Id $ParentId -ErrorAction SilentlyContinue
    if (!$process -or $process.StartTime.ToUniversalTime().Ticks -ne $parentStart) { break }
    if ($read.IsCompleted) {
      $line = $read.Result
      if ($null -eq $line -or $line -eq 'STOP') { break }
      if ($line -eq 'PING') { $last = [DateTime]::UtcNow }
      $read = [Console]::In.ReadLineAsync()
    }
    if (([DateTime]::UtcNow - $last).TotalSeconds -gt 10) { break }
  }
} catch { [Console]::Error.WriteLine('Windows admin-prompt recovery failed. The restore marker has been retained if restoration is needed.'); exit 1 }
finally {
  if ($registry) { $registry.Dispose() }
  if ($held) { try { Restore-Policy } catch { [Console]::Error.WriteLine('Windows policy restoration failed; restart Windows to retry recovery.') }; $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
