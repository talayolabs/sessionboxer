@echo off
rem Runs once, as the Windows account, at the end of the unattended install of the shared
rem Windows base disk (see apps/control-plane/src/windows.ts). Everything a Session's own
rem copy of the disk should start with goes here; when it is done the VM powers off, which
rem tells the Control Plane the base is ready.
rem
rem The Agent of a Windows Session runs inside the VM (ADR-0057): the tools it needs are
rem installed here, pinned to the versions the Linux Sandbox image ships. No login or secret
rem is written to the disk: the Daemon hands those to the Agent at start.

setlocal
set "OPENSSH_VERSION=10.0.0.0"
set "OPENSSH_TAG=10.0.0.0p2-Preview"
set "NODE_VERSION=22.23.3"
set "GIT_VERSION=2.55.0"
set "GIT_BUILD=5"
set "UV_VERSION=0.12.13"
set "CLAUDE_CODE_VERSION=2.1.272"
set "CLAUDE_AGENT_ACP_VERSION=0.77.0"
set "CODEX_ACP_VERSION=1.1.9"
set "DEVIN_CLI_VERSION=3000.10.27"
set "CURSOR_CLI_VERSION=2026.09.23-86fc751"
set "PI_VERSION=0.99.2"
set "PI_ACP_VERSION=0.0.34"
set "OPENCODE_VERSION=1.18.32"
set "LOG=C:\sessionboxer-install.log"
set "DL=%TEMP%\sessionboxer-install"
mkdir "%DL%" 2>nul

echo [%date% %time%] sessionboxer base install starting> "%LOG%"

rem Never blank, lock or sleep: the Agent looks at the screen over RDP.
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\Personalization" /v NoLockScreen /t REG_DWORD /d 1 /f
reg add "HKCU\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f

rem No update reboots under the Agent's feet: the base is installed once, Sessions are short-lived.
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" /v NoAutoUpdate /t REG_DWORD /d 1 /f

rem Show file extensions and hidden files: the Agent reads paths off the screen.
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" /v HideFileExt /t REG_DWORD /d 0 /f
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" /v Hidden /t REG_DWORD /d 1 /f

rem OpenSSH server: the Sandbox next to the VM runs the Agent, git, the Terminal and `win ...`
rem through it. Its shell is cmd.exe so the Agent's ACP stream (JSON lines) passes through
rem untouched; PowerShell would re-encode it line by line. Microsoft's MSI rather than the
rem in-box capability: DISM is not usable this early after setup (DismInitialize 0xc0040009).
echo [%time%] openssh %OPENSSH_VERSION%>> "%LOG%"
curl.exe -fsSL --retry 5 --retry-all-errors -o "%DL%\openssh.msi" "https://github.com/PowerShell/Win32-OpenSSH/releases/download/%OPENSSH_TAG%/OpenSSH-Win64-v%OPENSSH_VERSION%.msi" >> "%LOG%" 2>&1
msiexec /i "%DL%\openssh.msi" /qn /norestart >> "%LOG%" 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Set-Service -Name sshd -StartupType Automatic;" ^
  "New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null;" ^
  "New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\cmd.exe' -PropertyType String -Force | Out-Null;" ^
  "Start-Service -Name sshd;" ^
  "if (-not (Get-NetFirewallRule -Name sshd -ErrorAction SilentlyContinue)) { New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 }" >> "%LOG%" 2>&1

rem The Workspace: repositories are cloned here by the Sandbox, the Agent starts here.
mkdir C:\workspace 2>nul

rem Node.js (npm/npx for the Agent CLIs and the user's MCP servers).
echo [%time%] node %NODE_VERSION%>> "%LOG%"
curl.exe -fsSL --retry 5 --retry-all-errors -o "%DL%\node.msi" "https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-x64.msi" >> "%LOG%" 2>&1
msiexec /i "%DL%\node.msi" /qn /norestart >> "%LOG%" 2>&1
set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%"

rem Git for Windows (git, bash, ssh client, tar-compatible tools) without any prompts.
echo [%time%] git %GIT_VERSION%.%GIT_BUILD%>> "%LOG%"
curl.exe -fsSL --retry 5 --retry-all-errors -o "%DL%\git.exe" "https://github.com/git-for-windows/git/releases/download/v%GIT_VERSION%.windows.%GIT_BUILD%/Git-%GIT_VERSION%.%GIT_BUILD%-64-bit.exe" >> "%LOG%" 2>&1
"%DL%\git.exe" /VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /o:PathOption=Cmd /o:CRLFOption=LFOnly /o:UseCredentialManager=Disabled /o:EnableSymlinks=Enabled >> "%LOG%" 2>&1
set "PATH=C:\Program Files\Git\cmd;%PATH%"
git config --system credential.helper ""
git config --system core.longpaths true

rem uv / uvx (Python MCP servers), pinned; installs to %USERPROFILE%\.local\bin.
echo [%time%] uv %UV_VERSION%>> "%LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "irm https://astral.sh/uv/%UV_VERSION%/install.ps1 | iex" >> "%LOG%" 2>&1

rem Claude Code + its ACP adapter, Codex through its ACP adapter: the same pins as the Sandbox image.
echo [%time%] npm globals>> "%LOG%"
call npm install -g --no-fund --no-audit ^
  @anthropic-ai/claude-code@%CLAUDE_CODE_VERSION% ^
  @agentclientprotocol/claude-agent-acp@%CLAUDE_AGENT_ACP_VERSION% ^
  @agentclientprotocol/codex-acp@%CODEX_ACP_VERSION% >> "%LOG%" 2>&1
call npm cache clean --force >> "%LOG%" 2>&1

rem pi and pi-acp, the adapter that bridges `pi --mode rpc` to ACP (ADR-0075): the same pins as the Sandbox image.
echo [%time%] pi %PI_VERSION% pi-acp %PI_ACP_VERSION%>> "%LOG%"
call npm install -g --no-fund --no-audit ^
  @earendil-works/pi-coding-agent@%PI_VERSION% ^
  pi-acp@%PI_ACP_VERSION% >> "%LOG%" 2>&1
call npm cache clean --force >> "%LOG%" 2>&1

rem Devin CLI (`devin acp`): the pinned bundle its installer would fetch, checked against the
rem manifest's sha256, put where the installer puts it; the installer itself is not run as it ends
rem in an interactive `devin setup` that would wait for a login here.
echo [%time%] devin %DEVIN_CLI_VERSION%>> "%LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
  "$m = (Invoke-WebRequest -Uri 'https://static.devin.ai/cli/%DEVIN_CLI_VERSION%/manifest.json' -UseBasicParsing).Content | ConvertFrom-Json;" ^
  "$p = $m.platforms.'x86_64-pc-windows';" ^
  "$zip = '%DL%\devin.zip'; Invoke-WebRequest -Uri $p.url -OutFile $zip -UseBasicParsing;" ^
  "$hash = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant();" ^
  "if ($hash -ne $p.sha256.ToLowerInvariant()) { throw \"devin bundle checksum mismatch: $hash\" };" ^
  "$root = Join-Path $env:LOCALAPPDATA 'devin\cli'; $ver = Join-Path $root \"_versions\$($m.version)\"; $bin = Join-Path $root 'bin';" ^
  "New-Item -ItemType Directory -Force -Path $ver, $bin | Out-Null;" ^
  "Expand-Archive -LiteralPath $zip -DestinationPath $ver -Force;" ^
  "Copy-Item -LiteralPath (Join-Path $ver 'bin\devin.exe') -Destination (Join-Path $bin 'devin.exe') -Force;" ^
  "Set-Content -LiteralPath (Join-Path $root 'distribution') -Value 'irm-iex'" >> "%LOG%" 2>&1

rem Cursor CLI (`cursor-agent acp`), the Windows package unpacked where the launcher looks for it.
echo [%time%] cursor %CURSOR_CLI_VERSION%>> "%LOG%"
curl.exe -fsSL --retry 5 --retry-all-errors -o "%DL%\cursor.zip" "https://downloads.cursor.com/lab/%CURSOR_CLI_VERSION%/windows/x64/agent-cli-package.zip" >> "%LOG%" 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dest = Join-Path $env:LOCALAPPDATA 'Programs\cursor-agent';" ^
  "New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null;" ^
  "Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue;" ^
  "Expand-Archive -LiteralPath '%DL%\cursor.zip' -DestinationPath \"$dest.tmp\" -Force;" ^
  "$inner = Get-ChildItem -LiteralPath \"$dest.tmp\" -Directory | Select-Object -First 1;" ^
  "Move-Item -LiteralPath $inner.FullName -Destination $dest;" ^
  "Remove-Item -LiteralPath \"$dest.tmp\" -Recurse -Force -ErrorAction SilentlyContinue" >> "%LOG%" 2>&1

rem OpenCode (`opencode acp`): the single binary of its Windows npm platform package, where the launcher looks for it.
echo [%time%] opencode %OPENCODE_VERSION%>> "%LOG%"
curl.exe -fsSL --retry 5 --retry-all-errors -o "%DL%\opencode.tgz" "https://registry.npmjs.org/opencode-windows-x64/-/opencode-windows-x64-%OPENCODE_VERSION%.tgz" >> "%LOG%" 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dest = Join-Path $env:LOCALAPPDATA 'Programs\opencode';" ^
  "New-Item -ItemType Directory -Force -Path $dest, \"$dest.tmp\" | Out-Null;" ^
  "tar.exe -xzf '%DL%\opencode.tgz' -C \"$dest.tmp\";" ^
  "Copy-Item -LiteralPath (Join-Path \"$dest.tmp\" 'package\bin\opencode.exe') -Destination (Join-Path $dest 'opencode.exe') -Force;" ^
  "Remove-Item -LiteralPath \"$dest.tmp\" -Recurse -Force -ErrorAction SilentlyContinue" >> "%LOG%" 2>&1

rem The account's PATH for interactive shells (the Terminal pane, `win ...`): what the installers
rem put in place. The Agent's launcher adds the same directories itself.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dirs = @('C:\Program Files\nodejs', \"$env:APPDATA\npm\", 'C:\Program Files\Git\cmd', \"$env:USERPROFILE\.local\bin\", \"$env:LOCALAPPDATA\devin\cli\bin\", \"$env:LOCALAPPDATA\Programs\cursor-agent\", \"$env:LOCALAPPDATA\Programs\opencode\");" ^
  "$user = [Environment]::GetEnvironmentVariable('Path', 'User');" ^
  "$parts = @(); if ($user) { $parts = $user -split ';' | Where-Object { $_ -ne '' } };" ^
  "foreach ($d in $dirs) { if ($parts -notcontains $d) { $parts += $d } };" ^
  "[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')" >> "%LOG%" 2>&1

rem What got installed, for the log the Control Plane shows.
echo [%time%] versions>> "%LOG%"
call node --version >> "%LOG%" 2>&1
call git --version >> "%LOG%" 2>&1
call "%USERPROFILE%\.local\bin\uv.exe" --version >> "%LOG%" 2>&1
call claude-agent-acp --version >> "%LOG%" 2>&1
call codex-acp --version >> "%LOG%" 2>&1
set "PI_SKIP_VERSION_CHECK=1"
call pi --version >> "%LOG%" 2>&1
call "%LOCALAPPDATA%\devin\cli\bin\devin.exe" --version >> "%LOG%" 2>&1
call "%LOCALAPPDATA%\Programs\cursor-agent\cursor-agent.cmd" --version >> "%LOG%" 2>&1
set "OPENCODE_DISABLE_AUTOUPDATE=1"
call "%LOCALAPPDATA%\Programs\opencode\opencode.exe" --version >> "%LOG%" 2>&1

rmdir /s /q "%DL%" 2>nul
echo [%time%] done>> "%LOG%"
echo sessionboxer base ready> C:\sessionboxer-base.txt
shutdown /s /t 10 /f
