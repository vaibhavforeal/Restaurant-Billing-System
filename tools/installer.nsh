!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ForkFlow POS LAN"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="ForkFlow POS LAN" dir=in action=allow program="$INSTDIR\ForkFlow.exe" protocol=TCP localport=4100 profile=private remoteip=localsubnet enable=yes'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "ForkFlow was installed, but Windows could not add the LAN firewall rule. Billing on this PC will work. Ask your administrator to allow ForkFlow on private networks for other counters."
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ForkFlow POS LAN"'
!macroend
