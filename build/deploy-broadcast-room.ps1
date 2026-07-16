param(
    [string]$HostName = '159.195.31.84',
    [int]$Port = 22179,
    [string]$User = 'root',
    [string]$RemoteAppDir = '/var/www/evd/evd-yayinodasi-server',
    [string]$RemoteTmpDir = '/tmp/evd-yayinodasi-deploy',
    [string]$IdentityFile = $env:EVD_DEPLOY_IDENTITY_FILE,
    [switch]$ForceFullUpload,
    [switch]$RestartOnly,
    [switch]$SkipRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-CommandAvailable([string]$CommandName) {
    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        throw "Gerekli komut bulunamadı: $CommandName"
    }
}

function Get-SshArgumentList() {
    $args = @('-p', "$Port")
    if ($IdentityFile) {
        $args += @('-i', $IdentityFile)
    }
    return $args
}

function Invoke-SshCommand([string]$CommandText) {
    $sshArgs = @(Get-SshArgumentList)
    $sshArgs += @($remoteTarget, $CommandText)
    & ssh @sshArgs
    if ($LASTEXITCODE -ne 0) {
        throw "SSH komutu başarısız oldu."
    }
}

function Invoke-ScpUpload([string]$LocalPath, [string]$RemotePath) {
    $scpArgs = @('-P', "$Port")
    if ($IdentityFile) {
        $scpArgs += @('-i', $IdentityFile)
    }
    $scpArgs += @($LocalPath, "${remoteTarget}:$RemotePath")
    & scp @scpArgs
    if ($LASTEXITCODE -ne 0) {
        throw "SCP yüklemesi başarısız oldu: $LocalPath"
    }
}

function Convert-ToUnixRelativePath([string]$RelativePath) {
    return ($RelativePath -replace '\\', '/')
}

function Get-UnixDirectoryName([string]$UnixPath) {
    $normalized = ([string]$UnixPath).Replace('\', '/')
    $lastSlashIndex = $normalized.LastIndexOf('/')
    if ($lastSlashIndex -lt 0) {
        return ''
    }
    return $normalized.Substring(0, $lastSlashIndex)
}

function Get-LocalFileHashValue([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-RemoteFileHashValue([string]$RemoteFilePath) {
    $commandTemplate = @'
if [ -f '__REMOTE_FILE_PATH__' ]; then sha256sum '__REMOTE_FILE_PATH__' | awk '{print $1}'; fi
'@
    $command = $commandTemplate.Replace('__REMOTE_FILE_PATH__', $RemoteFilePath)
    $sshArgs = @(Get-SshArgumentList)
    $sshArgs += @($remoteTarget, $command)
    $output = & ssh @sshArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Uzak dosya özeti alınamadı: $RemoteFilePath"
    }
    return [string]::Join('', $output).Trim().ToLowerInvariant()
}

$repoRoot = Split-Path -Parent $PSScriptRoot

$fileMappings = @(
    @{ Source = 'src\broadcast-room-web\frontend\public\join.html'; Remote = 'public/join.html' },
    @{ Source = 'src\broadcast-room-web\frontend\public\join.js'; Remote = 'public/join.js' },
    @{ Source = 'src\broadcast-room-web\frontend\public\join.css'; Remote = 'public/join.css' },
    @{ Source = 'src\broadcast-room-web\backend\package.json'; Remote = 'package.json' },
    @{ Source = 'src\broadcast-room-web\backend\src\config.js'; Remote = 'src/config.js' },
    @{ Source = 'src\broadcast-room-web\backend\src\server.js'; Remote = 'src/server.js' },
    @{ Source = 'src\broadcast-room-web\backend\src\monitor-audio-hub.js'; Remote = 'src/monitor-audio-hub.js' },
    @{ Source = 'src\broadcast-room-web\backend\src\routes\broadcast-room.js'; Remote = 'src/routes/broadcast-room.js' },
    @{ Source = 'src\broadcast-room-web\backend\src\services\token-service.js'; Remote = 'src/services/token-service.js' },
    @{ Source = 'src\broadcast-room-web\backend\src\store\room-store.js'; Remote = 'src/store/room-store.js' },
    @{ Source = 'src\locales\tr.json'; Remote = 'locales/tr.json' },
    @{ Source = 'src\locales\en.json'; Remote = 'locales/en.json' },
    @{ Source = 'src\locales\de.json'; Remote = 'locales/de.json' },
    @{ Source = 'src\locales\es.json'; Remote = 'locales/es.json' },
    @{ Source = 'src\locales\fr.json'; Remote = 'locales/fr.json' }
)

foreach ($mapping in $fileMappings) {
    $fullPath = Join-Path $repoRoot $mapping.Source
    if (-not (Test-Path -LiteralPath $fullPath)) {
        throw "Dağıtım dosyası bulunamadı: $fullPath"
    }
}

Assert-CommandAvailable 'scp'
Assert-CommandAvailable 'ssh'

$defaultIdentityFile = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
if (-not $IdentityFile -and (Test-Path -LiteralPath $defaultIdentityFile)) {
    $IdentityFile = $defaultIdentityFile
}

$remoteTarget = "$User@$HostName"
$changedFiles = @()

if (-not $RestartOnly) {
    Write-Step 'Değişen dosyalar denetleniyor'
    foreach ($mapping in $fileMappings) {
        $localPath = Join-Path $repoRoot $mapping.Source
        $localHash = Get-LocalFileHashValue $localPath
        $remoteRelativePath = Convert-ToUnixRelativePath $mapping.Remote
        $remoteFullPath = "$RemoteAppDir/$remoteRelativePath"
        $remoteHash = if ($ForceFullUpload) { '' } else { Get-RemoteFileHashValue $remoteFullPath }
        if ($ForceFullUpload -or -not $remoteHash -or $localHash -ne $remoteHash) {
            $changedFiles += ,@{
                Source = $mapping.Source
                Remote = $mapping.Remote
            }
        }
    }

    if ($changedFiles.Count -gt 0) {
        Write-Step "Sunucuya yüklenecek dosya sayısı: $($changedFiles.Count)"
        foreach ($mapping in $changedFiles) {
            Write-Host " - $($mapping.Remote)"
        }

        Write-Step 'Sunucudaki geçici dağıtım klasörü hazırlanıyor'
        Invoke-SshCommand "rm -rf '$RemoteTmpDir' && mkdir -p '$RemoteTmpDir'"

        Write-Step 'Değişen dosyalar sunucuya yükleniyor'
        foreach ($mapping in $changedFiles) {
            $sourcePath = Join-Path $repoRoot $mapping.Source
            $remoteRelativePath = Convert-ToUnixRelativePath $mapping.Remote
            $remoteFilePath = "$RemoteTmpDir/$remoteRelativePath"
            $remoteDirPath = Get-UnixDirectoryName $remoteFilePath
            if ($remoteDirPath) {
                Invoke-SshCommand "mkdir -p '$remoteDirPath'"
            }
            Invoke-ScpUpload $sourcePath $remoteFilePath
        }
    } else {
        Write-Step 'Değişen dosya bulunmadı'
    }
}

if (-not $SkipRestart) {
    Write-Step 'Sunucuda dosyalar yerine alınıp uygulama yeniden başlatılıyor'
    $restartScriptTemplate = @'
set -e
APP_DIR='__REMOTE_APP_DIR__'
TMP_DIR='__REMOTE_TMP_DIR__'
if [ -d "$TMP_DIR" ]; then
  cp -R "$TMP_DIR/." "$APP_DIR/"
fi
cd "$APP_DIR"
npm list ws >/dev/null 2>&1 || npm install ws --omit=dev
APP_PIDS=$(ps -eo pid=,comm=,args= | grep '[[:space:]]node[[:space:]].*src/server.js' | awk '{print $1}' || true)
if [ -n "$APP_PIDS" ]; then
  printf '%s\n' "$APP_PIDS" | xargs -r kill 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    REMAINING_PIDS=$(ps -eo pid=,comm=,args= | grep '[[:space:]]node[[:space:]].*src/server.js' | awk '{print $1}' || true)
    if [ -z "$REMAINING_PIDS" ]; then
      break
    fi
    sleep 1
  done
fi
REMAINING_PIDS=$(ps -eo pid=,comm=,args= | grep '[[:space:]]node[[:space:]].*src/server.js' | awk '{print $1}' || true)
if [ -n "$REMAINING_PIDS" ]; then
  printf '%s\n' "$REMAINING_PIDS" | xargs -r kill -9 2>/dev/null || true
  sleep 1
fi
set -a
. ./.env
set +a
nohup /usr/bin/node src/server.js > server.log 2>&1 &
sleep 4
curl -fsS http://127.0.0.1:4100/api/health
'@
    $restartScript = $restartScriptTemplate.Replace('__REMOTE_APP_DIR__', $RemoteAppDir).Replace('__REMOTE_TMP_DIR__', $RemoteTmpDir)
    Invoke-SshCommand $restartScript
} else {
    Write-Step 'SkipRestart seçildi, sunucuda restart yapılmadı'
}

if (-not $RestartOnly -and $changedFiles.Count -gt 0) {
    Write-Step 'Sunucudaki geçici dağıtım klasörü temizleniyor'
    Invoke-SshCommand "rm -rf '$RemoteTmpDir'"
}

Write-Step 'Dağıtım tamamlandı'
if ($IdentityFile) {
    Write-Host "SSH anahtarı kullanıldı: $IdentityFile" -ForegroundColor DarkGray
}
Write-Host "Komut tamamlandı. Gerekirse EVD uygulamasını yeniden açın." -ForegroundColor Green
