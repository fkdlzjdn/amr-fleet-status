# Run in an elevated Windows PowerShell. This only adds TCP 3100 rules for the robot LAN.
# It does not restart WSL, alter robot settings, or disable either firewall.
[CmdletBinding()]
param([ValidateRange(1,65535)][int]$Port = 3100,
      [string]$RemoteSubnet = '192.168.20.0/24')
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Windows administrator permission is required. Run Enable-LanAccess.cmd and accept the UAC prompt.'
}
$vm = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
$name = "AMRFleetStatus$Port"
Get-Command New-NetFirewallHyperVRule -ErrorAction Stop | Out-Null
# Refuse to replace an unrelated rule with the same name.
foreach ($cmd in @('Get-NetFirewallRule', 'Get-NetFirewallHyperVRule')) {
    $existing = & $cmd -Name $name -ErrorAction SilentlyContinue
    if ($existing) { throw "Rule $name already exists. Inspect it before adding or replacing rules." }
}
$windowsAdded = $false
try {
    New-NetFirewallRule -Name $name -DisplayName "AMR Fleet Status TCP $Port (robot LAN)" `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress $RemoteSubnet -Profile Any | Out-Null
    $windowsAdded = $true
    New-NetFirewallHyperVRule -Name $name -DisplayName "AMR Fleet Status TCP $Port (robot LAN)" `
        -Direction Inbound -VMCreatorId $vm -Protocol TCP -LocalPorts $Port -RemoteAddresses $RemoteSubnet -Action Allow | Out-Null
} catch {
    if ($windowsAdded) { Remove-NetFirewallRule -Name $name -ErrorAction SilentlyContinue }
    throw
}
Write-Host "Added Windows + WSL inbound TCP $Port rules, source $RemoteSubnet only."
Write-Host "From another LAN PC open http://<server-LAN-IP>:$Port"
Write-Host "On this Windows PC use http://127.0.0.1:$Port"
Write-Host "Undo: Remove-NetFirewallRule -Name $name; Remove-NetFirewallHyperVRule -Name $name"
