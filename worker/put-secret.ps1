# Puts one secret into the Mullo Pro Worker without it touching a file, the
# screen, or a chat. Opens as its own window; the person pastes the value.
#   powershell -ExecutionPolicy Bypass -File worker\put-secret.ps1 -Name GEMINI_API_KEY -Hint "..."
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Hint = ''
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Write-Host ''
Write-Host "Mullo Pro: set $Name" -ForegroundColor Cyan
if ($Hint) { Write-Host $Hint }
Write-Host 'Paste it below and press Enter. It will not show as you type.' -ForegroundColor Yellow
$secure = Read-Host -AsSecureString "$Name"
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ([string]::IsNullOrWhiteSpace($plain)) { Write-Host 'Nothing pasted. Close this window and try again.' -ForegroundColor Red; exit 1 }
# Not a PowerShell pipe: Windows PowerShell adds a line ending ("key`r`n") and
# Cloudflare would store it with the stray character. Node hands over the
# exact bytes. The value travels in this process's environment, never as an
# argument (arguments show up in the process list).
$env:ECHO_SECRET_VALUE = $plain.Trim()
$plain = $null
node -e "const r=require('child_process').spawnSync('npx',['wrangler','secret','put',process.argv[1]],{input:process.env.ECHO_SECRET_VALUE,stdio:['pipe','inherit','inherit'],shell:true});process.exit(r.status??1)" $Name
Remove-Item Env:ECHO_SECRET_VALUE
if ($LASTEXITCODE -eq 0) {
  Write-Host ''
  Write-Host "Done. $Name is saved in Cloudflare. You can close this window." -ForegroundColor Green
} else {
  Write-Host "Cloudflare did not accept it (see above)." -ForegroundColor Red
}
