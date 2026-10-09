!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ForkFlow Dev LAN"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="ForkFlow Dev LAN" dir=in action=allow program="$INSTDIR\ForkFlow Dev.exe" protocol=TCP localport=4100 profile=private remoteip=localsubnet enable=yes'
!macroend
!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ForkFlow Dev LAN"'
!macroend
