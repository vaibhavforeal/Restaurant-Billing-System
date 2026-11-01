!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="MasalaPOS Demo LAN"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="MasalaPOS Demo LAN" dir=in action=allow program="$INSTDIR\MasalaPOS Demo.exe" protocol=TCP localport=4110 profile=private remoteip=localsubnet enable=yes'
!macroend
!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="MasalaPOS Demo LAN"'
!macroend
