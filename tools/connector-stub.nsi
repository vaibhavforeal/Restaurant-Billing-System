Unicode true
!include "LogicLib.nsh"
Name "MasalaPOS Support Connector"
OutFile "${OUTPUT}"
RequestExecutionLevel admin
SilentInstall silent
SetCompressor /SOLID lzma
Var BootstrapDir
Section
  ; Atomically create a private scratch directory before extracting privileged scripts.
  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "D:P(A;;FA;;;SY)(A;;FA;;;BA)", i 1, *p .r0, p 0) i.r1'
  ${If} $1 == 0
    Abort
  ${EndIf}
  System::Call '*(i 12, p r0, i 0) p.r2'
  System::Call 'kernel32::GetTickCount() i.r3'
  System::Call 'kernel32::GetCurrentProcessId() i.r4'
  StrCpy $BootstrapDir "$TEMP\MasalaPOS-Connector-$4-$3"
  System::Call 'kernel32::CreateDirectoryW(w "$BootstrapDir", p r2) i.r1'
  System::Free $2
  System::Call 'kernel32::LocalFree(p r0)'
  ${If} $1 == 0
    Abort
  ${EndIf}
  SetOutPath "$BootstrapDir"
  File /oname=bootstrap.ps1 "${BOOTSTRAP}"
  File /oname=manifest-key.xml "${MANIFEST_KEY}"
  StrCpy $5 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$5" +2 0
    StrCpy $5 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ExecWait '"$5" -NoLogo -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "$BootstrapDir\bootstrap.ps1" -LauncherPath "$EXEPATH" -Origin "${ORIGIN}" -KeyFile "$BootstrapDir\manifest-key.xml" -Development ${DEVELOPMENT}' $0
  SetOutPath "$TEMP"
  RMDir /r "$BootstrapDir"
  SetErrorLevel $0
SectionEnd
