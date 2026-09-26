@echo off
rem Runs once, as the Windows account, at the end of the unattended install of the shared
rem Windows base disk (see apps/control-plane/src/windows.ts). Everything a Session's own
rem copy of the disk should start with goes here; when it is done the VM powers off, which
rem tells the Control Plane the base is ready.

rem Never blank, lock or sleep: the Agent looks at the screen over RDP.
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\Personalization" /v NoLockScreen /t REG_DWORD /d 1 /f
reg add "HKCU\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f

rem No update reboots under the Agent's feet: the base is installed once, Sessions are short-lived.
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" /v NoAutoUpdate /t REG_DWORD /d 1 /f

rem OpenSSH server: the Linux side of a Session runs Windows commands through it (`win ...`).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0;" ^
  "Set-Service -Name sshd -StartupType Automatic;" ^
  "New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force;" ^
  "Start-Service -Name sshd;" ^
  "if (-not (Get-NetFirewallRule -Name sshd -ErrorAction SilentlyContinue)) { New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 }"

rem Show file extensions and hidden files: the Agent reads paths off the screen.
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" /v HideFileExt /t REG_DWORD /d 0 /f
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" /v Hidden /t REG_DWORD /d 1 /f

echo sessionboxer base ready> C:\sessionboxer-base.txt
shutdown /s /t 10 /f
