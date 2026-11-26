$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Install Node.js 24 LTS first." }
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major===24 && minor>=15 ? 0 : 1)"
if ($LASTEXITCODE -ne 0) { throw "Install Node.js 24.15 or later within the 24 LTS line." }
npm.cmd ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (Test-Path -LiteralPath ".env") {
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm.cmd run line-pulse -- shared-setup
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host "Connected to the configured database. Run start_line_pulse.bat or npm run dev in both folders."
    exit 0
}
$env:PGHOST = "127.0.0.1"
$port = Read-Host "PostgreSQL port [5432]"
$env:PGPORT = if ($port) { $port } else { "5432" }
$user = Read-Host "PostgreSQL administrator [postgres]"
$env:PGUSER = if ($user) { $user } else { "postgres" }
$securePassword = Read-Host "PostgreSQL administrator password" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    npm.cmd run setup:db
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Setup complete. Run start_line_pulse.bat or use npm run dev in both folders."
