<#
  Elisha Bay — deploy to Hostinger over FTP.

  Run from the project root:
      powershell -ExecutionPolicy Bypass -File tools\deploy-hostinger.ps1

  What it does
  ------------
  1. Copies only the files the live site needs into a temporary staging folder:
     .htaccess, index.html, api/, assets/, portal/, public/, storage/.htaccess
     and uploads/. It never ships db/, docs/, tools/, _archive/, .git/, editor
     config, or the local api/config/config.php.
  2. Writes a PRODUCTION api/config/config.php into the staging copy, built from
     config.example.php: base_path '/', debug off, secure cookies on, and the
     Hostinger database details you type in.
  3. Uploads the staging folder to public_html/ with curl (ships with Windows).

  Passwords are typed at the prompts and live only in this process. Nothing is
  written to the repository.

  Before the first run: create the MySQL database in hPanel and import
  C:\xampp\elishabay-deploy\elishabay-db.sql.zip through phpMyAdmin.
#>

$ErrorActionPreference = 'Stop'

$FtpHost   = '82.180.152.15'
$FtpUser   = 'u633386024'
$RemoteDir = 'public_html'

$Root  = Split-Path -Parent $PSScriptRoot
$Stage = Join-Path $env:TEMP 'elishabay-deploy-stage'

function Read-Secret([string]$prompt) {
    $s = Read-Host $prompt -AsSecureString
    [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}

# PHP single-quoted string literal: only \ and ' need escaping.
function PhpStr([string]$v) { "'" + ($v -replace '\\', '\\' -replace "'", "\'") + "'" }

Write-Host "`n== Hostinger database (hPanel -> Databases -> MySQL Databases) ==" -ForegroundColor Cyan
$DbName = Read-Host "Database name (e.g. ${FtpUser}_elishabay)"
$DbUser = Read-Host "Database user (e.g. ${FtpUser}_app)"
$DbPass = Read-Secret "Database password"
$DbHost = Read-Host "Database host [localhost]"
if (-not $DbHost) { $DbHost = 'localhost' }

$Https = Read-Host "Is the site served over HTTPS? [Y/n]"
$Secure = if ($Https -match '^[nN]') { 'false' } else { 'true' }

Write-Host "`n== Staging files ==" -ForegroundColor Cyan
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory $Stage | Out-Null

foreach ($f in '.htaccess', 'index.html') { Copy-Item (Join-Path $Root $f) $Stage }
foreach ($d in 'api', 'assets', 'portal', 'public', 'uploads') {
    Copy-Item (Join-Path $Root $d) (Join-Path $Stage $d) -Recurse
}
New-Item -ItemType Directory (Join-Path $Stage 'storage\mail') -Force | Out-Null
Copy-Item (Join-Path $Root 'storage\.htaccess') (Join-Path $Stage 'storage')
# curl cannot create an empty directory; a placeholder makes storage/mail exist.
Set-Content (Join-Path $Stage 'storage\mail\.gitkeep') '' -Encoding ascii

# Drop anything that must never be public.
Remove-Item (Join-Path $Stage 'api\config\config.php') -ErrorAction SilentlyContinue
Get-ChildItem $Stage -Recurse -Force -Include 'Thumbs.db', 'desktop.ini', '.DS_Store', '*.log' |
    Remove-Item -Force

# Production config from the committed template.
$cfg = Get-Content (Join-Path $Root 'api\config\config.example.php') -Raw
$swaps = [ordered]@{
    "'host'     => 'localhost',"       = "'host'     => $(PhpStr $DbHost),"
    "'name'     => 'elisha_bay_db',"   = "'name'     => $(PhpStr $DbName),"
    "'user'     => 'elishabay_app',"   = "'user'     => $(PhpStr $DbUser),"
    "'pass'     => '',"                = "'pass'     => $(PhpStr $DbPass),"
    "'base_path' => '/elishabay/',"    = "'base_path' => '/',"
    "'debug'     => true,"             = "'debug'     => false,"
    "'cookie_secure'    => false,"     = "'cookie_secure'    => $Secure,"
}
foreach ($k in $swaps.Keys) {
    if (-not $cfg.Contains($k)) { throw "config.example.php changed: cannot find $k" }
    $cfg = $cfg.Replace($k, $swaps[$k])
}
[IO.File]::WriteAllText((Join-Path $Stage 'api\config\config.php'), $cfg)

$files = Get-ChildItem $Stage -Recurse -File -Force
Write-Host "$($files.Count) files staged in $Stage"

Write-Host "`n== Upload to ftp://$FtpHost/$RemoteDir ==" -ForegroundColor Cyan
$FtpPass = Read-Secret "FTP password for $FtpUser"

# One curl run, one connection: a config file of upload-file/url pairs.
$list = Join-Path $env:TEMP 'elishabay-deploy-curl.txt'
$sb = New-Object Text.StringBuilder
foreach ($f in $files) {
    $rel = $f.FullName.Substring($Stage.Length + 1).Replace('\', '/')
    $url = "ftp://$FtpHost/$RemoteDir/" + (($rel -split '/' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/')
    [void]$sb.AppendLine("upload-file = `"$($f.FullName.Replace('\', '/'))`"")
    [void]$sb.AppendLine("url = `"$url`"")
}
[IO.File]::WriteAllText($list, $sb.ToString())

try {
    & curl.exe --ftp-create-dirs --ssl --user "${FtpUser}:$FtpPass" `
        --retry 2 --fail --show-error --progress-bar -K $list
    if ($LASTEXITCODE -ne 0) { throw "curl exited with $LASTEXITCODE" }
} finally {
    Remove-Item $list -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $Stage 'api\config\config.php') -ErrorAction SilentlyContinue
    $FtpPass = $null; $DbPass = $null
}

Write-Host "`nDone. $($files.Count) files uploaded." -ForegroundColor Green
