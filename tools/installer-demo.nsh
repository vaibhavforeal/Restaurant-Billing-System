!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ForkFlow Demo LAN"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="ForkFlow Demo LAN" dir=in action=allow program="$INSTDIR\ForkFlow Demo.exe" protocol=TCP localport=4110 profile=private remoteip=localsubnet enable=yes'
!macroend
!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ForkFlow Demo LAN"'
!macroend
