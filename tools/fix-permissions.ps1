# Fix storage/ permissions on Windows so the web server can write and delete.
# Run from the app folder in an elevated PowerShell.
param([string]$User = 'IIS_IUSRS')
$root = Split-Path -Parent $PSScriptRoot
$storage = Join-Path $root 'storage'
if (-not (Test-Path $storage)) { Write-Error 'storage/ not found next to this script.'; exit 1 }
Set-Location $root
icacls storage /grant "${User}:(OI)(CI)F" /T
icacls storage /grant "Users:(OI)(CI)M" /T
Write-Host "storage/ permissions updated for $User"