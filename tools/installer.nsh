!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="MasalaPOS POS LAN"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="MasalaPOS POS LAN" dir=in action=allow program="$INSTDIR\MasalaPOS.exe" protocol=TCP localport=4100 profile=private remoteip=localsubnet enable=yes'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "MasalaPOS was installed, but Windows could not add the LAN firewall rule. Billing on this PC will work. Ask your administrator to allow MasalaPOS on private networks for other counters."
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="MasalaPOS POS LAN"'
!macroend
