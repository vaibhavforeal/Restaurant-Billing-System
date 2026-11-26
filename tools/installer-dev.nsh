!macro customInstall
  CreateShortCut "$SMPROGRAMS\MasalaPOS Dev Sample Data.lnk" "$INSTDIR\MasalaPOS Dev.exe" "--sample-data"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="MasalaPOS Dev LAN"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="MasalaPOS Dev LAN" dir=in action=allow program="$INSTDIR\MasalaPOS Dev.exe" protocol=TCP localport=4100 profile=private remoteip=localsubnet enable=yes'
!macroend
!macro customUnInstall
  Delete "$SMPROGRAMS\MasalaPOS Dev Sample Data.lnk"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="MasalaPOS Dev LAN"'
!macroend
