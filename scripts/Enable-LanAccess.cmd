@echo off
powershell.exe -NoProfile -NonInteractive -Command "$script='%~dp0Enable-LanAccess.ps1'; Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoExit -NoProfile -ExecutionPolicy Bypass -File '+[char]34+$script+[char]34)"
