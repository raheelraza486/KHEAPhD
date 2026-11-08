# CS-9 Business API Ecosystem: build and run with Docker (Windows).
#
# Usage: put this file next to (or inside) the downloaded "comp5703-cs9-main"
# folder, start Docker Desktop, then in PowerShell run:
#     powershell -ExecutionPolicy Bypass -File .\run-cs9.ps1
#
# This file contains the team's API keys. Do not share it further or commit it.
# "Continue", not "Stop": Windows PowerShell 5.1 turns docker's stderr output into
# errors under "Stop". Every docker call is checked through $LASTEXITCODE instead.
$ErrorActionPreference = "Continue"

$ProjectName = "comp5703-cs9-main"
$Image = "cs9-frontend"
$Container = "cs9"

function Say($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }

# 1. Docker must be installed and running.
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail "Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and run this script again."
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Fail "Docker is installed but not running. Start Docker Desktop, wait until it says 'Engine running', then run this script again."
}

# 2. Find the project folder.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Candidates = @(
  $ScriptDir,
  (Join-Path $ScriptDir ".."),
  (Join-Path $ScriptDir $ProjectName),
  (Get-Location).Path,
  (Join-Path (Get-Location).Path $ProjectName),
  (Join-Path $HOME "Downloads\$ProjectName"),
  (Join-Path $HOME "Desktop\$ProjectName")
)
$Project = $null
foreach ($dir in $Candidates) {
  if (Test-Path (Join-Path $dir "frontend\Dockerfile")) { $Project = (Resolve-Path $dir).Path; break }
}
if (-not $Project) { Fail "Could not find the '$ProjectName' folder. Put this script next to it (or inside it) and run it again." }
Say "Project folder: $Project"

# 3. Write the keys to frontend\.env.local (UTF-8 without BOM, LF line endings, as Docker expects).
$EnvFile = Join-Path $Project "frontend\.env.local"
$EnvContent = @'
# Keys for calling real APIs from this machine. Not committed (.gitignore: .env.*).
# Paste each value after its "=" with no quotes or spaces. Leave unused ones empty.
# None of these start with NEXT_PUBLIC_, so Next.js keeps them on the server
# and never sends them to the browser. Do not rename them to NEXT_PUBLIC_*.

# --- Transformation: generate a UBL invoice (register one of these) ---
# NormAPI — https://normapi.de — Bearer key, shaped nk_live_...
NORMAPI_KEY=nk_live_60c3241d41bf92e065a634c7df891b36fb306876973d421f
# beliq — https://beliq.eu — sent as X-API-Key
BELIQ_API_KEY=blq_live_NdP452ochzJOmJBs_3eF27eWJc60VWjHsgydJM_VcrA
# e-invoice conversion — https://myinvoice.llc — sent as X-API-Key, shaped ek_live_...
MYINVOICE_API_KEY=

# --- Communication: send the invoice (whichever test account you obtain) ---
# Greece AADE myDATA test environment — user id and subscription key from the dev registration
AADE_MYDATA_USER_ID=
AADE_MYDATA_SUBSCRIPTION_KEY=

# --- LLM stream ---
# Google AI Studio — https://aistudio.google.com
GEMINI_API_KEY=$env:GEMINI_API_KEY = "your-real-key"

# Peppol Validator needs no key.

# Public Supabase values (same as the live site bundle)
NEXT_PUBLIC_SUPABASE_URL=https://dpdrsyigdzadaotvhnhb.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_AR3g-klpzFDWzkslvl9woA_BTcjNOBv

# Sending (Peppol test network) — sandbox keys only
B2BROUTER_API_KEY=test_22f5fe813af757b4f9755d037057c9b63de86311
STORECOVE_API_KEY=

# B2Brouter account that sends (the sandbox demo company); not a secret
B2BROUTER_ACCOUNT_ID=343767

# ESS Schematron (client guide, 7 Oct 2026): OAuth2 client credentials
ESS_CLIENT_ID=7d30bi87iptegbrf2bp37p42gg
ESS_CLIENT_SECRET=880tema3rvh3h63j4nquvgoh0lgts11n09bq8597fgrkvvd62su
ESS_SCOPE=eat/read
ESS_TOKEN_URL=https://dev-eat.auth.eu-central-1.amazoncognito.com/oauth2/token
ESS_BASE_URL=https://services.ebusiness-cloud.com/ess-schematron

SMARTDOCFLOW_API_KEY=Si7LKu6aPH5EZm9aOZbvF668erlJmmVh03AuAGR2

MAILGUN_API_KEY=$env:MAILGUN_KEY = "your-real-key"
MAILGUN_DOMAIN=sandbox4aa8f0e007a94c9ca26e9622bb735f09.mailgun.org

UPBRAINS_WEBHOOK_URL=https://agents.upbrains.ai/v1/webhooks/TUoawjPRNWzxAheNajwe8

# Copied from the live ECS service (cs9-api-repository) on 2026-11-05
MAILGUN_ALLOWED_RECIPIENTS=chenguoqiangsg@gmail.com
NEXT_PUBLIC_SITE_URL=https://cs-47e1208ec06d46068a1db07170ff2d0a.ecs.ap-southeast-2.on.aws
WORKFLOW_ARTIFACT_BUCKET=bp-sfn-artifacts-803964123922
SUPABASE_URL=https://dpdrsyigdzadaotvhnhb.supabase.co
MAILGUN_FROM=CS9-5 Business API Ecosystem <postmaster@sandbox4aa8f0e007a94c9ca26e9622bb735f09.mailgun.org>
SUPABASE_SECRET_KEY=$env:SUPABASE_SECRET_KEY = "your-real-key"
'@
$EnvContent = ($EnvContent -replace "`r", "") + "`n"
try {
  [System.IO.File]::WriteAllText($EnvFile, $EnvContent, (New-Object System.Text.UTF8Encoding($false)))
} catch { Fail "Could not write $EnvFile : $($_.Exception.Message)" }
Say "Keys written to frontend\.env.local"

function EnvValue($name) {
  foreach ($line in ($EnvContent -split "`n")) {
    if ($line.StartsWith("$name=")) { return $line.Substring($name.Length + 1).Trim() }
  }
  return ""
}

# 4. Build the image (first time takes a few minutes).
Say "Building the Docker image..."
docker build -t $Image `
  --build-arg "NEXT_PUBLIC_SUPABASE_URL=$(EnvValue 'NEXT_PUBLIC_SUPABASE_URL')" `
  --build-arg "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$(EnvValue 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')" `
  (Join-Path $Project "frontend")
if ($LASTEXITCODE -ne 0) { Fail "The Docker build failed. The output above shows why (often no internet access to npm or cdn.sheetjs.com)." }

# 5. Remove old CS-9 containers (from this script, or "cs9_frontend" from an
#    earlier "docker compose up"), which hold the name and port 3000.
#    The local Postgres container "cs9_postgres" is left alone.
foreach ($name in @($Container, "cs9_frontend")) {
  $id = docker ps -aq --filter "name=^/$name`$"
  if ($id) {
    Say "Removing old container '$name'..."
    docker rm -f $name | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Could not remove the old container '$name'. Run 'docker rm -f $name' (or delete it in Docker Desktop > Containers), then run this script again." }
  }
}
Start-Sleep -Seconds 1

# 6. Pick a free port and start the new container.
$Port = 3000
while (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $Port++ }
Say "Starting the container on port $Port..."
docker run -d --name $Container -p "${Port}:3000" --env-file $EnvFile $Image | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "The container could not start. The output above shows why." }

# 7. Wait until the app answers, then open it.
$Url = "http://localhost:$Port"
for ($i = 0; $i -lt 60; $i++) {
  try {
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
    Say "CS-9 is running at $Url"
    Start-Process $Url
    Write-Host "`nStop it:   docker stop $Container`nStart it:  docker start $Container`nLogs:      docker logs $Container"
    Read-Host "`nPress Enter to close this window (the app keeps running)"
    exit 0
  } catch { Start-Sleep -Seconds 1 }
}
docker logs --tail 40 $Container
Fail "The container started but $Url did not answer within 60 seconds. The log above shows why."
