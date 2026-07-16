const { ipcMain, dialog, Menu, BrowserWindow, Notification, app, shell } = require('electron');
const ffmpegHandler = require('./ffmpeg-handler');
const ttsHandler = require('./tts-handler');
const mediaCompatibility = require('./media-compatibility-service');
const liveEffectsHandler = require('./live-effects-handler');
const path = require('path');
const fs = require('fs');
const os = require('os');
const i18n = require('./i18n');
const { execFile } = require('child_process');
const http = require('http');
const logger = require('./logger');
const broadcastRoomHandler = require('./broadcast-room-handler');
const nativeAudioPlatform = require('./native-audio-platform');

// const geminiHandler = require('./gemini-handler'); // Removed to prevent duplicate registration

function t(key, fallback, params) {
    const value = i18n.t(key, params);
    return value.startsWith('[') ? fallback : value;
}

function sanitizeMultilineValue(value) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
}

function execFileAsync(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, args, options, (error, stdout, stderr) => {
            if (error) {
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

async function resolveWindowHandleProcessIds(handles = []) {
    const uniqueHandles = [...new Set((handles || [])
        .map((handle) => Number(handle || 0))
        .filter((handle) => Number.isFinite(handle) && handle > 0))];
    if (!uniqueHandles.length || process.platform !== 'win32') {
        return new Map();
    }
    const handleCsv = uniqueHandles.join(',');
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -Namespace EVD -Name Win32 -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);'",
        `$handles = @(${handleCsv})`,
        "$items = foreach ($handle in $handles) { $pid = 0; [void][EVD.Win32]::GetWindowThreadProcessId([IntPtr]$handle, [ref]$pid); [pscustomobject]@{ Handle = [int64]$handle; ProcessId = [int64]$pid } }",
        "$items | ConvertTo-Json -Compress"
    ].join('; ');
    try {
        const { stdout } = await execFileAsync('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            script
        ], {
            windowsHide: true,
            timeout: 8000,
            maxBuffer: 1024 * 1024
        });
        const parsed = stdout?.trim() ? JSON.parse(stdout.trim()) : [];
        const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        return new Map(rows
            .map((row) => [Number(row.Handle || 0), Number(row.ProcessId || 0)])
            .filter(([handle, pid]) => handle > 0 && pid > 0));
    } catch (error) {
        logger.warn?.('Window handle PID resolution failed:', error.message);
        return new Map();
    }
}

function decodeXmlText(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function stripXmlTags(value) {
    return decodeXmlText(String(value || '').replace(/<[^>]+>/g, ' '));
}

function collectXmlText(xml, textTagPattern) {
    const parts = [];
    const pattern = textTagPattern || /<(?:a|w):t\b[^>]*>([\s\S]*?)<\/(?:a|w):t>/g;
    let match = pattern.exec(xml);
    while (match) {
        const text = decodeXmlText(match[1]);
        if (text) {
            parts.push(text);
        }
        match = pattern.exec(xml);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function collectOpenXmlAltText(xml) {
    const parts = [];
    const pattern = /<(?:wp:docPr|p:cNvPr|xdr:cNvPr)\b([^>]*)>/g;
    let match = pattern.exec(xml);
    while (match) {
        const attrs = match[1] || '';
        const title = /(?:^|\s)title="([^"]*)"/.exec(attrs)?.[1] || '';
        const descr = /(?:^|\s)descr="([^"]*)"/.exec(attrs)?.[1] || '';
        [title, descr].forEach((item) => {
            const text = decodeXmlText(item);
            if (text) {
                parts.push(text);
            }
        });
        match = pattern.exec(xml);
    }
    return [...new Set(parts)];
}

function getAccessibleShareAltTextPrefix() {
    return t('broadcast_room.accessible_share_alt_text_prefix', 'Görsel açıklaması');
}

function getAccessibleShareSlideLabel(index) {
    return t('broadcast_room.accessible_share_slide_label', 'Slayt {number}', { number: index + 1 });
}

function getAccessibleShareSheetLabel(index) {
    return t('broadcast_room.accessible_share_sheet_label', 'Sayfa {number}', { number: index + 1 });
}

function numericSortByPath(left, right) {
    const leftNumber = Number(String(left || '').match(/(\d+)(?!.*\d)/)?.[1] || 0);
    const rightNumber = Number(String(right || '').match(/(\d+)(?!.*\d)/)?.[1] || 0);
    return leftNumber - rightNumber || String(left || '').localeCompare(String(right || ''));
}

function readXmlIfExists(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf8');
        }
    } catch (_error) {
        // Ignore malformed XML inputs and continue with partial extraction.
    }
    return '';
}

function walkFiles(rootDir, predicate) {
    const results = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(fullPath);
            } else if (!predicate || predicate(fullPath)) {
                results.push(fullPath);
            }
        }
    };
    visit(rootDir);
    return results;
}

async function extractOfficeArchiveToTemp(filePath) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evd-accessible-share-'));
    const zipPath = path.join(tempRoot, 'document.zip');
    const extractDir = path.join(tempRoot, 'unzipped');
    fs.mkdirSync(extractDir, { recursive: true });
    fs.copyFileSync(filePath, zipPath);
    await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "& { param($zipPath, $extractDir) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force }",
        zipPath,
        extractDir
    ], { windowsHide: true });
    return { tempRoot, extractDir };
}

async function extractDocxAccessibleItems(filePath) {
    const { tempRoot, extractDir } = await extractOfficeArchiveToTemp(filePath);
    try {
        const xml = readXmlIfExists(path.join(extractDir, 'word', 'document.xml'));
        const text = collectXmlText(xml, /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g);
        const altTexts = collectOpenXmlAltText(xml);
        const altPrefix = getAccessibleShareAltTextPrefix();
        const fullText = [text, ...altTexts.map((item) => `${altPrefix}: ${item}`)].filter(Boolean).join('\n\n');
        return {
            kind: 'docx',
            items: [{
                index: 0,
                label: path.basename(filePath),
                text: fullText || stripXmlTags(xml)
            }]
        };
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

async function extractPptxAccessibleItems(filePath) {
    const { tempRoot, extractDir } = await extractOfficeArchiveToTemp(filePath);
    try {
        const slideDir = path.join(extractDir, 'ppt', 'slides');
        const slideFiles = fs.existsSync(slideDir)
            ? walkFiles(slideDir, (item) => /slide\d+\.xml$/i.test(item)).sort(numericSortByPath)
            : [];
        const items = slideFiles.map((slidePath, index) => {
            const xml = readXmlIfExists(slidePath);
            const text = collectXmlText(xml, /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g);
            const altTexts = collectOpenXmlAltText(xml);
            const altPrefix = getAccessibleShareAltTextPrefix();
            return {
                index,
                label: getAccessibleShareSlideLabel(index),
                text: [text, ...altTexts.map((item) => `${altPrefix}: ${item}`)].filter(Boolean).join('\n\n') || stripXmlTags(xml)
            };
        }).filter((item) => item.text);
        return { kind: 'pptx', items };
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

async function extractXlsxAccessibleItems(filePath) {
    const { tempRoot, extractDir } = await extractOfficeArchiveToTemp(filePath);
    try {
        const sharedStringsXml = readXmlIfExists(path.join(extractDir, 'xl', 'sharedStrings.xml'));
        const sharedStrings = [];
        const sharedStringPattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
        let match = sharedStringPattern.exec(sharedStringsXml);
        while (match) {
            sharedStrings.push(collectXmlText(match[1], /<t\b[^>]*>([\s\S]*?)<\/t>/g) || stripXmlTags(match[1]));
            match = sharedStringPattern.exec(sharedStringsXml);
        }
        const sheetDir = path.join(extractDir, 'xl', 'worksheets');
        const sheetFiles = fs.existsSync(sheetDir)
            ? walkFiles(sheetDir, (item) => /sheet\d+\.xml$/i.test(item)).sort(numericSortByPath)
            : [];
        const items = sheetFiles.map((sheetPath, index) => {
            const xml = readXmlIfExists(sheetPath);
            const cells = [];
            const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
            let cellMatch = cellPattern.exec(xml);
            while (cellMatch) {
                const attrs = cellMatch[1] || '';
                const body = cellMatch[2] || '';
                const ref = /(?:^|\s)r="([^"]*)"/.exec(attrs)?.[1] || '';
                const type = /(?:^|\s)t="([^"]*)"/.exec(attrs)?.[1] || '';
                const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] || '';
                const inlineText = collectXmlText(body, /<t\b[^>]*>([\s\S]*?)<\/t>/g);
                let text = inlineText;
                if (!text && type === 's') {
                    text = sharedStrings[Number(value)] || '';
                }
                if (!text) {
                    text = decodeXmlText(value);
                }
                if (text) {
                    cells.push(`${ref || cells.length + 1}: ${text}`);
                }
                cellMatch = cellPattern.exec(xml);
            }
            return {
                index,
                label: getAccessibleShareSheetLabel(index),
                text: cells.join('\n')
            };
        }).filter((item) => item.text);
        return { kind: 'xlsx', items };
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

async function extractAccessibleDocument(filePath) {
    const normalizedPath = String(filePath || '').trim();
    if (!normalizedPath || !fs.existsSync(normalizedPath)) {
        throw new Error('file_not_found');
    }
    const ext = path.extname(normalizedPath).toLowerCase();
    if (['.txt', '.md', '.csv', '.log'].includes(ext)) {
        return {
            kind: ext.replace(/^\./, '') || 'text',
            items: [{
                index: 0,
                label: path.basename(normalizedPath),
                text: fs.readFileSync(normalizedPath, 'utf8').trim()
            }]
        };
    }
    if (ext === '.docx') {
        return extractDocxAccessibleItems(normalizedPath);
    }
    if (ext === '.pptx') {
        return extractPptxAccessibleItems(normalizedPath);
    }
    if (ext === '.xlsx') {
        return extractXlsxAccessibleItems(normalizedPath);
    }
    throw new Error('unsupported_accessible_document_type');
}

async function getPowerPointSlideShowState() {
    const script = [
        "$ErrorActionPreference = 'Stop'",
        'try {',
        "  $ppt = [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')",
        '  if ($null -eq $ppt -or $ppt.SlideShowWindows.Count -lt 1) {',
        "    @{ success = $false; error = 'powerpoint_slideshow_not_running' } | ConvertTo-Json -Compress",
        '    exit 0',
        '  }',
        '  $window = $ppt.SlideShowWindows.Item(1)',
        '  $view = $window.View',
        '  $presentation = $window.Presentation',
        '  @{',
        '    success = $true',
        '    currentIndex = [int]$view.Slide.SlideIndex - 1',
        '    slideNumber = [int]$view.CurrentShowPosition',
        '    slideIndex = [int]$view.Slide.SlideIndex',
        '    total = [int]$presentation.Slides.Count',
        '    fullName = [string]$presentation.FullName',
        '    name = [string]$presentation.Name',
        '  } | ConvertTo-Json -Compress',
        '} catch {',
        "  $powerPointRunning = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue).Count -gt 0",
        "  $errorCode = if ($powerPointRunning) { 'powerpoint_com_unavailable' } else { 'powerpoint_slideshow_not_running' }",
        '  @{ success = $false; error = $_.Exception.Message; errorCode = $errorCode; powerPointRunning = $powerPointRunning } | ConvertTo-Json -Compress',
        '}'
    ].join('\n');
    const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script
    ], { windowsHide: true });
    return JSON.parse(String(stdout || '{}'));
}

function appendBroadcastRoomDebugLog(payload) {
    try {
        const logPath = path.join(app.getPath('userData'), 'broadcast-room-debug.log');
        const line = `${new Date().toISOString()} ${JSON.stringify(payload)}\n`;
        fs.appendFile(logPath, line, () => {});
    } catch (_error) {
        // Debug logging must never affect the broadcast room flow.
    }
}

function getFfmpegBinaryPath() {
    let ffmpegPath = null;
    try { ffmpegPath = require('ffmpeg-static'); } catch (_error) { }
    if (!ffmpegPath) {
        try { ffmpegPath = require('@ffmpeg-installer/ffmpeg').path; } catch (_error) { }
    }
    if (ffmpegPath && ffmpegPath.includes('app.asar')) {
        ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    }
    return ffmpegPath;
}

let obsAudioBridgeServer = null;
let obsAudioBridgePort = 0;
const obsAudioBridgeSessions = new Map();

function getObsAudioBridgeHtml(token) {
    const safeToken = JSON.stringify(String(token || ''));
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>EVD OBS Audio Bridge</title>
  <style>html,body{margin:0;width:100%;height:100%;background:#000;color:#fff;font:14px sans-serif}</style>
</head>
<body>
  <p id="status">EVD OBS audio bridge waiting.</p>
  <audio id="audio" autoplay playsinline></audio>
  <script>
    const token = ${safeToken};
    const statusEl = document.getElementById('status');
    const audioEl = document.getElementById('audio');
    let pc = null;
    const waitForIceComplete = (peer) => new Promise((resolve) => {
      if (peer.iceGatheringState === 'complete') return resolve();
      const timeout = setTimeout(resolve, 1500);
      peer.addEventListener('icegatheringstatechange', () => {
        if (peer.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    async function poll() {
      while (true) {
        try {
          const resp = await fetch('/obs-audio-bridge/poll?role=obs&token=' + encodeURIComponent(token) + '&t=' + Date.now());
          const payload = await resp.json();
          if (payload.offer && !pc) {
            statusEl.textContent = 'Connecting audio...';
            pc = new RTCPeerConnection({ iceServers: [] });
            pc.ontrack = (event) => {
              audioEl.srcObject = event.streams[0] || new MediaStream([event.track]);
              audioEl.play().catch(() => {});
              statusEl.textContent = 'Audio connected.';
            };
            pc.onconnectionstatechange = () => {
              const currentPc = pc;
              if (!currentPc) {
                return;
              }
              statusEl.textContent = 'Connection: ' + currentPc.connectionState;
              if (['failed', 'closed', 'disconnected'].includes(currentPc.connectionState)) {
                pc = null;
              }
            };
            await pc.setRemoteDescription(payload.offer);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await waitForIceComplete(pc);
            await fetch('/obs-audio-bridge/answer?token=' + encodeURIComponent(token), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(pc.localDescription)
            });
          }
        } catch (error) {
          statusEl.textContent = 'Bridge error: ' + (error && error.message ? error.message : error);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    poll();
  </script>
</body>
</html>`;
}

function ensureObsAudioBridgeSession(token) {
    const key = String(token || 'default');
    if (!obsAudioBridgeSessions.has(key)) {
        obsAudioBridgeSessions.set(key, {
            offer: null,
            answer: null,
            updatedAt: Date.now()
        });
    }
    return obsAudioBridgeSessions.get(key);
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function ensureObsAudioBridgeServer() {
    if (obsAudioBridgeServer && obsAudioBridgePort > 0) {
        return obsAudioBridgePort;
    }
    obsAudioBridgeServer = http.createServer(async (req, res) => {
        try {
            const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
            if (requestUrl.pathname === '/obs-audio-bridge') {
                const token = requestUrl.searchParams.get('token') || 'default';
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(getObsAudioBridgeHtml(token));
                return;
            }
            if (requestUrl.pathname === '/obs-audio-bridge/offer' && req.method === 'POST') {
                const token = requestUrl.searchParams.get('token') || 'default';
                const session = ensureObsAudioBridgeSession(token);
                session.offer = JSON.parse(await readRequestBody(req));
                session.answer = null;
                session.updatedAt = Date.now();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                return;
            }
            if (requestUrl.pathname === '/obs-audio-bridge/answer' && req.method === 'POST') {
                const token = requestUrl.searchParams.get('token') || 'default';
                const session = ensureObsAudioBridgeSession(token);
                session.answer = JSON.parse(await readRequestBody(req));
                session.updatedAt = Date.now();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                return;
            }
            if (requestUrl.pathname === '/obs-audio-bridge/poll') {
                const token = requestUrl.searchParams.get('token') || 'default';
                const role = requestUrl.searchParams.get('role') || '';
                const session = ensureObsAudioBridgeSession(token);
                const payload = role === 'obs'
                    ? { offer: session.offer }
                    : { answer: session.answer };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
                return;
            }
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
    });
    await new Promise((resolve, reject) => {
        obsAudioBridgeServer.once('error', reject);
        obsAudioBridgeServer.listen(0, '127.0.0.1', () => {
            obsAudioBridgeServer.off('error', reject);
            obsAudioBridgePort = obsAudioBridgeServer.address().port;
            resolve();
        });
    });
    return obsAudioBridgePort;
}

function getSceneBackgroundCacheDir() {
    const cacheDir = path.join(app.getPath('userData'), 'scene-background-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    return cacheDir;
}

function sanitizeSceneBackgroundStem(value = '') {
    return String(value || 'background')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 80) || 'background';
}

function getSceneBackgroundType(filePath = '') {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext)) return 'image';
    if (['.mp4', '.webm', '.mov', '.m4v', '.mkv'].includes(ext)) return 'video';
    return '';
}

function buildSceneBackgroundCachePath(filePath, type) {
    const stat = fs.statSync(filePath);
    const stem = sanitizeSceneBackgroundStem(path.basename(filePath, path.extname(filePath)));
    const suffix = `${stat.size}_${Math.round(stat.mtimeMs)}`;
    const ext = type === 'video' ? '.mp4' : '.jpg';
    return path.join(getSceneBackgroundCacheDir(), `${stem}_${suffix}_1920x1080${ext}`);
}

function pickVideoStream(metadata = {}) {
    const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
    return streams.find((stream) => stream.codec_type === 'video') || null;
}

function buildDialogAnnouncementPayload(options = {}) {
    return {
        title: String(options.title || '').trim(),
        message: String(options.message || '').trim(),
        detail: String(options.detail || '').trim()
    };
}

async function announceDialogForAccessibility(targetWindow, options = {}) {
    if (!targetWindow || targetWindow.isDestroyed() || !targetWindow.webContents) {
        return;
    }

    const payload = buildDialogAnnouncementPayload(options);
    if (!payload.title && !payload.message && !payload.detail) {
        return;
    }

    try {
        targetWindow.webContents.send('accessibility-dialog-announce', payload);
        await new Promise((resolve) => setTimeout(resolve, 420));
    } catch (error) {
        console.warn('Dialog accessibility announcement failed:', error.message);
    }
}

function buildFeedbackDraftBody({ includeDiagnostics, currentFilePath }) {
    const lines = [
        t('feedback_mail.body.greeting', 'Merhaba,'),
        '',
        t('feedback_mail.body.prompt', 'Yasadiginiz durumu, beklentinizi veya onerilerinizi asagiya yazabilirsiniz.'),
        '',
        t('feedback_mail.body.steps_label', 'Ne yapiyordunuz?'),
        '',
        '',
        t('feedback_mail.body.expected_label', 'Ne olmasini bekliyordunuz?'),
        '',
        '',
        t('feedback_mail.body.actual_label', 'Ne oldu?'),
        '',
        ''
    ];

    if (includeDiagnostics) {
        const diagnostics = [
            `${t('feedback_mail.body.app_version', 'Uygulama surumu')}: ${app.getVersion()}`,
            `${t('feedback_mail.body.platform', 'Platform')}: ${process.platform} ${os.release()} (${os.arch()})`,
            `${t('feedback_mail.body.language', 'Uygulama dili')}: ${i18n.getCurrentLanguage()}`,
            `${t('feedback_mail.body.timestamp', 'Tarih')}: ${new Date().toISOString()}`
        ];

        if (currentFilePath) {
            diagnostics.push(`${t('feedback_mail.body.current_file', 'Acik dosya')}: ${currentFilePath}`);
        }

        const recentLogs = sanitizeMultilineValue(logger.getRecentLogExcerpt());
        lines.push(
            t('feedback_mail.body.diagnostics_heading', 'Tani bilgileri (kullanici izniyle eklendi):'),
            diagnostics.join('\n')
        );

        if (recentLogs) {
            lines.push(
                '',
                t('feedback_mail.body.log_heading', 'Son oturum log ozeti:'),
                recentLogs
            );
        }
    }

    return lines.join('\n');
}

function getNativeWindowSources() {
    if (process.platform !== 'win32') {
        return Promise.resolve([]);
    }

    const script = `
$code = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class KveWindowProbe {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
}
"@
Add-Type -TypeDefinition $code
$windows = New-Object System.Collections.Generic.List[object]
$shellWindow = [KveWindowProbe]::GetShellWindow()
[KveWindowProbe]::EnumWindows({
    param($hWnd, $lParam)
    if ($hWnd -eq $shellWindow) { return $true }
    if (-not [KveWindowProbe]::IsWindowVisible($hWnd)) { return $true }
    $length = [KveWindowProbe]::GetWindowTextLength($hWnd)
    if ($length -le 0) { return $true }
    $builder = New-Object System.Text.StringBuilder ($length + 1)
    [void][KveWindowProbe]::GetWindowText($hWnd, $builder, $builder.Capacity)
    $title = $builder.ToString().Trim()
    if ([string]::IsNullOrWhiteSpace($title)) { return $true }
    $windows.Add([PSCustomObject]@{
        name = $title
        id = "native:$($hWnd.ToInt64().ToString('X'))"
        _native = $true
    }) | Out-Null
    return $true
}, [IntPtr]::Zero) | Out-Null
$windows | ConvertTo-Json -Compress
`;

    return new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
            windowsHide: true,
            timeout: 10000,
            maxBuffer: 1024 * 1024 * 4
        }, (error, stdout) => {
            if (error) {
                console.error('getNativeWindowSources error:', error.message);
                resolve([]);
                return;
            }

            const trimmed = String(stdout || '').trim();
            if (!trimmed) {
                resolve([]);
                return;
            }

            try {
                const parsed = JSON.parse(trimmed);
                resolve(Array.isArray(parsed) ? parsed : [parsed]);
            } catch (parseError) {
                console.error('getNativeWindowSources parse error:', parseError.message);
                resolve([]);
            }
        });
    });
}

function setupIpcHandlers(mainWindow) {
    // Gemini handlers are already set up in index.js via gemini-handler module

    ipcMain.handle('get-main-process-info', async () => ({
        pid: process.pid,
        platform: process.platform
    }));

    ipcMain.handle('get-native-audio-capabilities', async () => nativeAudioPlatform.getNativeAudioCapabilities());

    ipcMain.handle('resolve-native-audio-capture-command', async (_event, options = {}) => {
        const helperPath = nativeAudioPlatform.resolveNativeAudioHelperPath();
        if (!helperPath) return { success: false, error: 'native_audio_helper_missing' };
        const args = process.platform === 'win32'
            ? ['--pid', String(process.pid), '--exclude-tree']
            : nativeAudioPlatform.buildCaptureArgs({
                captureMode: options.captureMode || 'native-system-audio',
                targetProcessId: options.targetProcessId,
                targetBundleId: options.targetBundleId,
                includeSelfExclusion: options.includeSelfExclusion !== false
            });
        return { success: true, command: helperPath, args, targetPid: process.pid };
    });

    ipcMain.handle('obs-audio-bridge-ensure', async (_event, { token = 'default' } = {}) => {
        const port = await ensureObsAudioBridgeServer();
        const bridgeToken = String(token || 'default');
        ensureObsAudioBridgeSession(bridgeToken);
        return {
            success: true,
            port,
            token: bridgeToken,
            url: `http://127.0.0.1:${port}/obs-audio-bridge?token=${encodeURIComponent(bridgeToken)}`
        };
    });

    // Pencere başlığını ayarla
    ipcMain.on('set-window-title', (event, title) => {
        if (mainWindow) {
            mainWindow.setTitle(title);
        }
    });

    // Dialog penceresini kapat (ana uygulamayı kapatmadan)
    ipcMain.on('close-dialog-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && win !== mainWindow) {
            win.close();
        }
    });

    // --- DIALOG HANDLERS ---

    ipcMain.handle('add-recent-file', async (_event, filePath) => {
        try {
            if (!filePath || !fs.existsSync(filePath)) {
                return { success: false };
            }
            const { addToRecentFiles } = require('./menu');
            addToRecentFiles(filePath, mainWindow);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Dosya açma diyaloğu
    ipcMain.handle('open-file-dialog', async (event, options) => {
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        const result = await dialog.showOpenDialog(win, options);
        return result;
    });

    // Kaydetme diyaloğu
    ipcMain.handle('show-save-dialog', async (event, options) => {
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        const result = await dialog.showSaveDialog(win, options);
        return result;
    });
    // --- END DIALOG HANDLERS ---

    // Video metadata al (ve Probe)
    ipcMain.handle('get-video-metadata', async (event, filePath) => {
        try {
            const metadata = await ffmpegHandler.getVideoMetadata(filePath);
            return { success: true, data: metadata };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('inspect-scene-background-file', async (_event, filePath) => {
        try {
            if (!filePath || !fs.existsSync(filePath)) {
                return { success: false, error: 'file_not_found' };
            }

            const type = getSceneBackgroundType(filePath);
            if (!type) {
                return { success: false, error: 'unsupported_background_file' };
            }

            if (type === 'image') {
                const sharp = require('sharp');
                const metadata = await sharp(filePath).metadata();
                const width = Number(metadata.width || 0);
                const height = Number(metadata.height || 0);
                const needsNormalize = width !== 1920 || height !== 1080;
                return {
                    success: true,
                    type,
                    path: filePath,
                    width,
                    height,
                    duration: 0,
                    needsNormalize,
                    recommendedWidth: 1920,
                    recommendedHeight: 1080
                };
            }

            const metadata = await ffmpegHandler.getVideoMetadata(filePath);
            const videoStream = pickVideoStream(metadata);
            const width = Number(videoStream?.width || metadata?.width || 0);
            const height = Number(videoStream?.height || metadata?.height || 0);
            const duration = Number(metadata?.duration || metadata?.format?.duration || 0) || 0;
            const needsNormalize = width !== 1920 || height !== 1080 || path.extname(filePath).toLowerCase() !== '.mp4';
            return {
                success: true,
                type,
                path: filePath,
                width,
                height,
                duration,
                needsNormalize,
                recommendedWidth: 1920,
                recommendedHeight: 1080,
                longVideoWarning: duration > 30
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('prepare-scene-background-file', async (_event, { filePath, type } = {}) => {
        try {
            if (!filePath || !fs.existsSync(filePath)) {
                return { success: false, error: 'file_not_found' };
            }

            const normalizedType = type || getSceneBackgroundType(filePath);
            if (!['image', 'video'].includes(normalizedType)) {
                return { success: false, error: 'unsupported_background_file' };
            }

            const outputPath = buildSceneBackgroundCachePath(filePath, normalizedType);
            if (fs.existsSync(outputPath)) {
                return { success: true, path: outputPath, type: normalizedType, reused: true };
            }

            if (normalizedType === 'image') {
                const sharp = require('sharp');
                await sharp(filePath)
                    .rotate()
                    .resize(1920, 1080, { fit: 'cover', position: 'centre' })
                    .jpeg({ quality: 92 })
                    .toFile(outputPath);
                return { success: true, path: outputPath, type: normalizedType };
            }

            const ffmpegPath = getFfmpegBinaryPath();
            if (!ffmpegPath) {
                return { success: false, error: 'ffmpeg_not_found' };
            }
            const metadata = await ffmpegHandler.getVideoMetadata(filePath).catch(() => null);
            const hdrToSdrFilter = ffmpegHandler.buildHdrToSdrFilter
                ? ffmpegHandler.buildHdrToSdrFilter(metadata)
                : '';
            const backgroundVideoFilter = [hdrToSdrFilter, 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1']
                .filter(Boolean)
                .join(',');

            await execFileAsync(ffmpegPath, [
                '-y',
                '-i', filePath,
                '-vf', backgroundVideoFilter,
                '-an',
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '23',
                '-pix_fmt', 'yuv420p',
                ...(ffmpegHandler.buildProcessedVideoColorOutputOptions
                    ? ffmpegHandler.buildProcessedVideoColorOutputOptions(metadata)
                    : []),
                '-movflags', '+faststart',
                outputPath
            ], { windowsHide: true });

            return { success: true, path: outputPath, type: normalizedType };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // TTS Önizleme
    ipcMain.handle('preview-tts', async (event, { text, voice, speed, volume, videoPath, startTime, duration, videoVolume, service, ttsService }) => {
        try {
            const normalizedText = sanitizeMultilineValue(text);
            const normalizedSpeed = Number(speed) > 0 ? Number(speed) : 1;
            const normalizedVolume = Math.max(0, Math.min(100, Math.round(Number(volume) || 100)));
            const normalizedVideoVolume = Math.max(0, Math.min(100, Math.round(Number(videoVolume) || 100)));
            const trimmedVideoPath = String(videoPath || '').trim();
            const previewStart = Math.max(0, Number(startTime) || 0);
            const previewDuration = Math.max(1, Math.min(15, Number(duration) || 5));
            const selectedService = String(ttsService || service || 'system');

            if (trimmedVideoPath) {
                const stamp = Date.now();
                const ttsPath = path.join(os.tmpdir(), `tts_preview_${stamp}.${selectedService === 'system' ? 'wav' : 'mp3'}`);
                const videoAudioPath = path.join(os.tmpdir(), `tts_video_preview_${stamp}.wav`);
                const mixedAudioPath = path.join(os.tmpdir(), `tts_mix_preview_${stamp}.wav`);

                console.log('TTS Preview (Mixed):', {
                    text: normalizedText.slice(0, 40),
                    service: selectedService,
                    voice,
                    speed: normalizedSpeed,
                    ttsVolume: normalizedVolume,
                    videoVolume: normalizedVideoVolume,
                    previewStart,
                    previewDuration
                });

                await ttsHandler.textToSpeechFile({
                    text: normalizedText,
                    voice,
                    speed: normalizedSpeed,
                    outputPath: ttsPath,
                    volume: normalizedVolume,
                    service: selectedService
                });
                await ffmpegHandler.previewAudioSegment(trimmedVideoPath, videoAudioPath, previewStart, previewDuration, {
                    volume: normalizedVideoVolume,
                    muted: normalizedVideoVolume <= 0,
                    channelMode: 'source',
                    noiseReduction: { enabled: false },
                    audioEffects: { echo: false, reverb: false, phone: false }
                });
                await ffmpegHandler.createAudioFromMix([
                    { path: videoAudioPath, offset: 0 },
                    { path: ttsPath, offset: 0 }
                ], mixedAudioPath);

                try { if (fs.existsSync(ttsPath)) fs.unlinkSync(ttsPath); } catch (cleanupError) { }
                try { if (fs.existsSync(videoAudioPath)) fs.unlinkSync(videoAudioPath); } catch (cleanupError) { }

                return { success: true, audioPath: mixedAudioPath };
            }

            if (selectedService === 'system') {
                console.log('TTS Preview (Direct Speak):', { text: normalizedText.slice(0, 40), voice, speed: normalizedSpeed });
                await ttsHandler.speak(normalizedText, voice, normalizedSpeed);
                return { success: true, spokeDirect: true };
            }

            const ttsPath = path.join(os.tmpdir(), `tts_preview_${Date.now()}.mp3`);
            await ttsHandler.textToSpeechFile({
                text: normalizedText,
                voice,
                speed: normalizedSpeed,
                outputPath: ttsPath,
                volume: normalizedVolume,
                service: selectedService
            });
            return { success: true, audioPath: ttsPath };
        } catch (error) {
            console.error('TTS Preview Error:', error);
            return { success: false, error: error.message };
        }
    });



    // Video kes
    ipcMain.handle('cut-video', async (event, { inputPath, outputPath, startTime, endTime }) => {
        try {
            const ext = path.extname(inputPath).toLowerCase();
            const isAudio = ['.wav', '.mp3', '.aac', '.ogg', '.m4a', '.wma'].includes(ext);

            if (isAudio && ffmpegHandler.cutAudio) {
                await ffmpegHandler.cutAudio(inputPath, outputPath, startTime, endTime, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut-audio', percent });
                });
            } else {
                await ffmpegHandler.cutVideo(inputPath, outputPath, startTime, endTime, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut', percent });
                }, (log) => {
                    mainWindow.webContents.send('ffmpeg-log', log);
                });
            }
            mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut', percent: 100 });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Hızlı video kes (stream copy - re-encode yok)
    ipcMain.handle('cut-video-fast', async (event, { inputPath, outputPath, startTime, endTime, mode }) => {
        try {
            const ext = path.extname(inputPath).toLowerCase();
            const isAudio = ['.wav', '.mp3', '.aac', '.ogg', '.m4a', '.wma'].includes(ext);

            if (isAudio && ffmpegHandler.cutAudio) {
                await ffmpegHandler.cutAudio(inputPath, outputPath, startTime, endTime, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut-audio', percent });
                });
            } else {
                await ffmpegHandler.cutVideoFast(inputPath, outputPath, startTime, endTime, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut-fast', percent });
                }, { mode });
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-cut-video-fast-bounds', async (event, { inputPath, startTime, endTime }) => {
        try {
            const bounds = await ffmpegHandler.getCutVideoFastBounds(inputPath, startTime, endTime);
            return { success: true, ...bounds };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Remux (MKV -> MP4)
    ipcMain.handle('ffmpeg-remux', async (event, { inputPath, targetFormat }) => {
        try {
            console.log(`IPC: ffmpeg-remux requested for ${inputPath} to ${targetFormat}`);
            if (ffmpegHandler.remuxVideo) {
                const result = await ffmpegHandler.remuxVideo(inputPath, targetFormat);
                return result;
            } else {
                return { success: false, error: 'ffmpegHandler.remuxVideo not implemented' };
            }
        } catch (error) {
            console.error('IPC Remux Error:', error);
            return { success: false, error: error.message };
        }
    });

    // Recording finished: Add to project and close dialog
    ipcMain.on('recording-finished-add-to-project', (event, filePath) => {
        console.log(`Adding recording to project: ${filePath}`);
        if (mainWindow) {
            mainWindow.webContents.send('add-to-timeline', filePath);
            const win = BrowserWindow.fromWebContents(event.sender);
            if (win && win !== mainWindow) {
                win.close();
            }
        }
    });

    // Akıllı video kes (hızlı dene, olmazsa re-encode)
    ipcMain.handle('cut-video-smart', async (event, { inputPath, outputPath, startTime, endTime, options }) => {
        try {
            const ext = path.extname(inputPath).toLowerCase();
            const isAudio = ['.wav', '.mp3', '.aac', '.ogg', '.m4a', '.wma'].includes(ext);

            if (isAudio && ffmpegHandler.cutAudio) {
                await ffmpegHandler.cutAudio(inputPath, outputPath, startTime, endTime, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut-audio', percent });
                });
            } else {
                await ffmpegHandler.cutVideoSmart(inputPath, outputPath, startTime, endTime, options || {}, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut-smart', percent });
                }, (log) => {
                    mainWindow.webContents.send('ffmpeg-log', log);
                });
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Timeline'ı tek seferde render et (Filter Complex - Single Pass)
    // Bu yöntem parçalama/birleştirme hatalarını önler
    // Timeline'ı tek seferde render et (Filter Complex - Single Pass)
    // Bu yöntem parçalama/birleştirme hatalarını önler
    ipcMain.handle('render-timeline', async (event, { inputPath, segments, outputPath, options }) => {
        try {
            await ffmpegHandler.renderTimeline(inputPath, segments, outputPath, (progress) => {
                const payload = typeof progress === 'number'
                    ? { operation: 'render-timeline', percent: progress }
                    : {
                        operation: progress?.operation || 'render-timeline',
                        percent: progress?.percent,
                        current: progress?.current,
                        total: progress?.total,
                        stage: progress?.stage
                    };
                mainWindow.webContents.send('ffmpeg-progress', payload);
            }, options);
            return { success: true };
        } catch (error) {
            console.error('Render timeline hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Videoları birleştir
    ipcMain.handle('concat-videos', async (event, { inputPaths, outputPath }) => {
        try {
            const firstInput = inputPaths[0];
            const ext = path.extname(firstInput).toLowerCase();
            const isAudio = ['.wav', '.mp3', '.aac', '.ogg', '.m4a', '.wma'].includes(ext);

            if (isAudio && ffmpegHandler.concatenateAudios) {
                await ffmpegHandler.concatenateAudios(inputPaths, outputPath, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'concat-audio', percent });
                });
            } else {
                await ffmpegHandler.concatenateVideos(inputPaths, outputPath, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'concat', percent });
                }, (log) => {
                    mainWindow.webContents.send('ffmpeg-log', log);
                });
            }
            // İşlem bittiğinde %100 gönder
            mainWindow.webContents.send('ffmpeg-progress', { operation: 'concat', percent: 100 });
            return { success: true };
        } catch (error) {
            console.error('Concat error:', error);
            return { success: false, error: error.message };
        }
    });

    // Hızlı video birleştir (stream copy - aynı codec gerekli)
    ipcMain.handle('concat-videos-fast', async (event, { inputPaths, outputPath }) => {
        try {
            await ffmpegHandler.concatenateVideosFast(inputPaths, outputPath, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'concat-fast', percent });
            }, (log) => {
                mainWindow.webContents.send('ffmpeg-log', log);
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Video döndür
    ipcMain.handle('rotate-video', async (event, { inputPath, outputPath, degrees }) => {
        try {
            await ffmpegHandler.rotateVideo(inputPath, outputPath, degrees, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'rotate', percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Ses çıkar
    ipcMain.handle('extract-audio', async (event, { inputPath, outputPath }) => {
        try {
            await ffmpegHandler.extractAudio(inputPath, outputPath, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'extract-audio', percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Video çıkar (sessiz)
    ipcMain.handle('extract-video', async (event, { inputPath, outputPath }) => {
        try {
            await ffmpegHandler.extractVideo(inputPath, outputPath, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'extract-video', percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Ses karıştır
    // Ses karıştır
    ipcMain.handle('mix-audio', async (event, params) => {
        try {
            // ffmpegHandler.mixAudio artık tek bir obje parametresi + callback bekliyor
            await ffmpegHandler.mixAudio(params, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'mix-audio', percent });
            });
            return { success: true, outputPath: params.outputPath };
        } catch (error) {
            console.error('mix-audio hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Gelişmiş ses karıştırma
    ipcMain.handle('mix-audio-advanced', async (event, options) => {
        try {
            await ffmpegHandler.mixAudioAdvanced(options, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'mix-audio-advanced', percent });
            });
            return { success: true, outputPath: options.outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Ses Ayarları için Render Edilmiş Önizleme (5sn)
    ipcMain.handle('preview-audio-segment', async (event, params) => {
        try {
            const { videoPath, startTime, duration, settings } = params;
            const tempDir = os.tmpdir();
            const timestamp = Date.now();
            const outputPath = path.join(tempDir, `preview_audio_${timestamp}.wav`);

            console.log('IPC: Preview Audio Segment requested', params);

            // Pass onStatus callback to notify renderer
            // We need to modify previewAudioSegment in ffmpeg-handler to invoke this callback which calls ensureRNNoiseModel
            // Actually, we modified call site in ffmpeg-handler.js but we didn't pass the callback FROM here properly to there.
            // Wait, ffmpegHandler.previewAudioSegment signature is: (input, output, start, dur, settings, onStatus) - I need to update it in ffmpeg-handler first!

            // Let's assume I updated ffmpeg-handler to accept onStatus as 6th arg or inside settings?
            // Since I only updated the CALL to ensureRNNoiseModel inside previewAudioSegment, I hardcoded the callback there.
            // To make it dynamic, I should have updated previewAudioSegment signature.

            // Re-eval step: Update ffmpeg-handler.previewAudioSegment signature first.

            await ffmpegHandler.previewAudioSegment(videoPath, outputPath, startTime, duration, settings, (status) => {
                if (status === 'downloading') {
                    mainWindow.webContents.send('show-info', {
                        title: t('messages.ai_model_downloading_title', 'AI Model Downloading'),
                        message: t('messages.ai_model_downloading_message', 'The AI model required for noise reduction is being downloaded. This is only done once.')
                    });
                }
            });

            return { success: true, audioPath: outputPath };
        } catch (error) {
            console.error('Preview Audio Error:', error);
            return { success: false, error: error.message };
        }
    });

    // Dosyayı Base64 olarak oku
    ipcMain.handle('read-file-base64', async (event, filePath) => {
        try {
            if (!fs.existsSync(filePath)) throw new Error('Dosya bulunamadı.');
            const buffer = fs.readFileSync(filePath);
            return { success: true, base64: buffer.toString('base64') };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });



    // Altyazı yak
    ipcMain.handle('burn-subtitles', async (event, { videoPath, subtitlePath, outputPath, styleOptions } = {}) => {
        try {
            await ffmpegHandler.burnSubtitles(videoPath, subtitlePath, outputPath, styleOptions, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'burn-subtitles', percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Metin ekle
    ipcMain.handle('add-text-overlay', async (event, params) => {
        try {
            const {
                videoPath, outputPath, text,
                font, fontSize, fontColor, background, position, transition,
                customX, customY,
                startTime, endTime, shadow,
                ttsEnabled, ttsVoice, ttsSpeed, ttsVolume, videoVolume
            } = params;
            const options = {
                font,
                fontSize,
                fontColor,
                background,
                position,
                customX,
                customY,
                transition,
                startTime,
                endTime,
                shadow,
                ttsEnabled,
                ttsVoice,
                ttsSpeed,
                ttsVolume,
                videoVolume
            };
            await ffmpegHandler.addTextOverlay(videoPath, outputPath, text, options, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-text', percent });
            });
            mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-text', percent: 100 });
            return { success: true, outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Görsel overlay ekle
    ipcMain.handle('add-image-overlay', async (event, params) => {
        try {
            const { videoPath, imagePath, outputPath, options } = params;
            await ffmpegHandler.addImageOverlay(videoPath, imagePath, outputPath, options, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-image', percent });
            });
            return { success: true, outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Geçiş efekti ekle
    ipcMain.handle('add-transition', async (event, params) => {
        try {
            const { videoPath, outputPath, options } = params;
            await ffmpegHandler.addTransition(videoPath, outputPath, options, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-transition', percent });
            });
            return { success: true, outputPath };
        } catch (error) {
            console.error('add-transition hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Akıllı Geçiş Uygulama (Toplu)
    ipcMain.handle('apply-transitions-smart', async (event, params) => {
        try {
            const { videoPath, outputPath, transitions } = params;
            await ffmpegHandler.applyTransitionsSmart(videoPath, outputPath, transitions, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'apply-transitions', percent });
            });
            return { success: true, outputPath };
        } catch (error) {
            console.error('Smart transition hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Base64 görüntüyü dosyaya kaydet (Geçici)
    ipcMain.handle('save-base64-image', async (event, { base64Data, filename }) => {
        try {
            const data = base64Data.replace(/^data:image\/\w+;base64,/, "");
            const buffer = Buffer.from(data, 'base64');
            const tempPath = path.join(os.tmpdir(), filename || `temp_img_${Date.now()}.png`);
            await fs.promises.writeFile(tempPath, buffer);
            return { success: true, filePath: tempPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Görsellerden video oluştur
    ipcMain.handle('create-video-from-images', async (event, { imagePaths, outputPath, duration }) => {
        try {
            await ffmpegHandler.createVideoFromImages(imagePaths, outputPath, duration, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'images-to-video', percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Kare çıkar
    ipcMain.handle('extract-frame', async (event, { videoPath, outputPath, time }) => {
        try {
            await ffmpegHandler.extractFrame(videoPath, outputPath, time);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Video dönüştürme
    ipcMain.handle('convert-video', async (event, { inputPath, outputPath, options }) => {
        try {
            await ffmpegHandler.safeConvertVideo(inputPath, outputPath, options, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'convert', percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Dosya varlık kontrolü
    ipcMain.handle('check-file-exists', async (event, filePath) => {
        try {
            return fs.existsSync(filePath);
        } catch (error) {
            console.error('File check error:', error);
            return false;
        }
    });

    // Ses mixleme (ffmpeg)spiti
    ipcMain.handle('detect-silence', async (event, { inputPath, minDuration, threshold }) => {
        try {
            const silences = await ffmpegHandler.detectSilence(inputPath, minDuration, threshold, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'detect-silence', percent });
            });
            return { success: true, data: silences };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Zaman formatla
    ipcMain.handle('format-time', (event, seconds) => {
        return ffmpegHandler.formatTime(seconds);
    });

    // Zaman parse et
    ipcMain.handle('parse-time', (event, timeString) => {
        return ffmpegHandler.parseTime(timeString);
    });

    // Hata mesajı göster
    ipcMain.handle('show-error', async (event, { title, message }) => {
        const targetWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        const options = {
            type: 'error',
            title: title,
            message: message
        };
        await announceDialogForAccessibility(targetWindow, options);
        await dialog.showMessageBox(targetWindow, options);
    });

    // Bilgi mesajı göster
    ipcMain.handle('show-info', async (event, { title, message }) => {
        const targetWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        const options = {
            type: 'info',
            title: title,
            message: message
        };
        await announceDialogForAccessibility(targetWindow, options);
        await dialog.showMessageBox(targetWindow, options);
    });

    // Generic Message Box (Restored from Backup for Audio/Video Dialogs)
    ipcMain.handle('show-message-box', async (event, options) => {
        const targetWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        await announceDialogForAccessibility(targetWindow, options);
        const result = await dialog.showMessageBox(targetWindow, options);
        return result;
    });

    ipcMain.handle('show-save-confirm', async (_event, { title, message }) => {
        const options = {
            type: 'question',
            title,
            message,
            buttons: [
                t('menu.file.save', 'Save'),
                t('runtime.app.dont_save', 'Do Not Save'),
                t('dialog.cancel', 'Cancel')
            ],
            defaultId: 0,
            cancelId: 2,
            noLink: true
        };
        await announceDialogForAccessibility(mainWindow, options);
        const result = await dialog.showMessageBox(mainWindow, options);
        return result.response;
    });

    // Onay diyaloğu (Restored)
    ipcMain.handle('show-confirm', async (event, { title, message }) => {
        const targetWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        const options = {
            type: 'question',
            title: title,
            message: message,
            buttons: [
                t('dialog.confirm.yes', 'Evet'),
                t('dialog.confirm.no', 'Hayır')
            ],
            defaultId: 0,
            cancelId: 1
        };
        await announceDialogForAccessibility(targetWindow, options);
        const result = await dialog.showMessageBox(targetWindow, options);
        return result.response === 0;
    });

    ipcMain.handle('create-feedback-draft', async (_event, { includeDiagnostics = false, currentFilePath = '' } = {}) => {
        try {
            const subject = t('feedback_mail.subject', 'EVD geri bildirim');
            const body = buildFeedbackDraftBody({
                includeDiagnostics,
                currentFilePath: sanitizeMultilineValue(currentFilePath)
            });
            const mailtoUrl = `mailto:yilmaeng@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

            await shell.openExternal(mailtoUrl);

            return {
                success: true,
                includedDiagnostics: includeDiagnostics
            };
        } catch (error) {
            console.error('Feedback draft oluşturulamadı:', error);
            return {
                success: false,
                error: error.message
            };
        }
    });



    // TTS: Sesleri al
    ipcMain.handle('get-tts-voices', async (_event, { service } = {}) => {
        try {
            const voices = await ttsHandler.getProviderVoices(service || 'system');
            return { success: true, voices };
        } catch (error) {
            console.error('TTS voices error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-system-tts-voices-detailed', async () => {
        try {
            const voices = await ttsHandler.getSystemVoicesDetailed();
            return { success: true, voices };
        } catch (error) {
            console.error('Detailed system TTS voices error:', error);
            return { success: false, error: error.message };
        }
    });

    // TTS: Metni WAV dosyasına çevir
    ipcMain.handle('generate-tts', async (event, { text, voice, speed, outputPath, volume, service, ttsService }) => {
        try {
            const selectedService = String(ttsService || service || 'system');
            const wavPath = outputPath || (selectedService === 'system'
                ? ttsHandler.getTempWavPath()
                : path.join(os.tmpdir(), `tts_${Date.now()}.mp3`));
            const finalPath = await ttsHandler.textToSpeechFile({
                text,
                voice,
                speed,
                outputPath: wavPath,
                volume,
                service: selectedService
            });
            return { success: true, wavPath: finalPath, audioPath: finalPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // TTS: Önizleme için seslendir
    ipcMain.handle('tts-speak-preview', async (event, { text, voice, speed }) => {
        try {
            await ttsHandler.speak(text, voice, speed);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // TTS: Seslendirmeyi durdur
    ipcMain.handle('tts-stop', async () => {
        try {
            ttsHandler.stop();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Geçici dosya yolu oluştur
    ipcMain.handle('get-temp-path', async (event, filename) => {
        const os = require('os');
        return path.join(os.tmpdir(), filename);
    });

    // Dosya kopyala
    ipcMain.handle('copy-file', async (event, { src, dest }) => {
        const fs = require('fs');
        try {
            fs.copyFileSync(src, dest);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Dosya sil (Toplu)
    ipcMain.handle('delete-files', async (event, filePaths) => {
        const fs = require('fs');
        try {
            for (const filePath of filePaths) {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }
            return { success: true };
        } catch (error) {
            console.error('Dosya silme hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Dosya İçeriği Kaydet (JSON/Text)
    ipcMain.handle('save-file-content', async (event, { filePath, content }) => {
        try {
            const fs = require('fs');
            fs.writeFileSync(filePath, content, 'utf-8');
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Concat Audio
    ipcMain.handle('create-audio-from-concat', async (event, { concatFilePath, outputPath }) => {
        try {
            await ffmpegHandler.createAudioFromConcat(concatFilePath, outputPath, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'create-audio-concat', percent });
            });
            return { success: true, outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Generate Silence
    ipcMain.handle('generate-silence', async (event, { duration, outputPath }) => {
        try {
            await ffmpegHandler.generateSilence(duration, outputPath);
            return { success: true, outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });



    // Create Audio from Mix (Adelay + Amix)
    ipcMain.handle('create-audio-from-mix', async (event, { audioSegments, outputPath }) => {
        try {
            await ffmpegHandler.createAudioFromMix(audioSegments, outputPath, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'create-audio-mix', percent });
            });
            return { success: true, outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Dosya İçeriği Oku
    ipcMain.handle('read-file-content', async (event, filePath) => {
        try {
            const fs = require('fs');
            if (!fs.existsSync(filePath)) throw new Error('Dosya bulunamadı');
            const content = fs.readFileSync(filePath, 'utf-8');
            return { success: true, content };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('broadcast-room-extract-accessible-document', async (_event, filePath) => {
        try {
            const result = await extractAccessibleDocument(filePath);
            return {
                success: true,
                fileName: path.basename(String(filePath || '')),
                title: path.basename(String(filePath || ''), path.extname(String(filePath || ''))),
                kind: result.kind,
                items: Array.isArray(result.items) ? result.items : []
            };
        } catch (error) {
            return {
                success: false,
                error: error.message || String(error || 'unknown_error')
            };
        }
    });

    ipcMain.handle('broadcast-room-get-powerpoint-slide-state', async () => {
        try {
            return await getPowerPointSlideShowState();
        } catch (error) {
            return {
                success: false,
                error: error.message || String(error || 'unknown_error')
            };
        }
    });


    // Vertical Video Wizard (Shorts)
    ipcMain.handle('create-vertical-video', async (event, { inputPath, outputPath, options }) => {
        try {
            await ffmpegHandler.createVerticalVideo(inputPath, outputPath, options, (percent) => {
                event.sender.send('ffmpeg-progress', { percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('create-vertical-video-preview', async (event, { inputPath, options }) => {
        try {
            const os = require('os');
            const tempPath = path.join(os.tmpdir(), `preview_vert_${Date.now()}.mp4`);
            await ffmpegHandler.createVerticalVideoPreview(inputPath, tempPath, options);
            return { success: true, outputPath: tempPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // === MEDIA COMPATIBILITY SERVICE ===

    // Akıllı dosya açma - uyumluluk kontrolü ve gerekirse dönüştürme
    ipcMain.handle('smart-open-video', async (event, filePath) => {
        try {
            const result = await mediaCompatibility.smartOpen(
                filePath,
                // Progress callback
                (progress) => {
                    mainWindow.webContents.send('media-compat-progress', progress);
                },
                // Status change callback
                (status) => {
                    mainWindow.webContents.send('media-compat-status', status);
                }
            );
            return result;
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Sadece uyumluluk analizi yap (dönüştürme yapmadan)
    ipcMain.handle('analyze-video-compatibility', async (event, filePath) => {
        try {
            const analysis = await mediaCompatibility.analyzeCompatibility(filePath);
            return { success: true, ...analysis };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Video probe (detaylı metadata)
    ipcMain.handle('probe-video', async (event, filePath) => {
        try {
            const probe = await mediaCompatibility.probeVideo(filePath);
            return { success: true, probe };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Hızlı remux (container değiştir)
    ipcMain.handle('quick-remux', async (event, filePath) => {
        try {
            const result = await mediaCompatibility.quickRemux(filePath, (progress) => {
                mainWindow.webContents.send('ffmpeg-progress', {
                    operation: 'remux',
                    percent: progress.percent
                });
            });
            return result;
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Tam transcode
    ipcMain.handle('smart-transcode', async (event, { filePath, options }) => {
        try {
            const result = await mediaCompatibility.transcode(filePath, options, (progress) => {
                mainWindow.webContents.send('ffmpeg-progress', {
                    operation: 'transcode',
                    percent: progress.percent,
                    stage: progress.stage,
                    speed: progress.speed
                });
            });
            return result;
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Cache temizle
    ipcMain.handle('clear-media-cache', async (event, olderThanDays) => {
        try {
            const cleared = mediaCompatibility.clearCache(olderThanDays || 7);
            return { success: true, clearedFiles: cleared };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Cache boyutunu al
    ipcMain.handle('get-media-cache-size', async () => {
        try {
            const size = mediaCompatibility.getCacheSize();
            return { success: true, size };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Context Menu Göster
    ipcMain.on('show-context-menu', (event, template) => {
        if (!template || !Array.isArray(template)) return;

        const menuTemplate = template.map(item => ({
            label: item.label,
            click: () => {
                event.sender.send('context-menu-command', { action: item.click, id: item.id, index: item.index });
            }
        }));

        const menu = Menu.buildFromTemplate(menuTemplate);
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            menu.popup({ window: win });
        }
    });

    // --- SYNC WIZARD HANDLERS ---

    // Open Sync Wizard (from Renderer)
    ipcMain.on('open-sync-wizard', (event, mode) => {
        const { openSyncWizard } = require('./dialog-windows');
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            openSyncWizard(win, mode);
        }
    });

    // Open Vertical Video Wizard (Shorts/Reels) from Renderer
    ipcMain.on('open-vertical-wizard', (event, data) => {
        const { openVerticalWizard } = require('./dialog-windows');
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            openVerticalWizard(win, data || null);
        }
    });

    // Open Accessible Recording Wizard from Renderer
    ipcMain.on('open-recording-wizard', (event, options) => {
        const { openRecordingWizard } = require('./dialog-windows');
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            openRecordingWizard(win, options || {});
        }
    });

    ipcMain.handle('recording-wizard-minimize-app-windows', async () => {
        try {
            BrowserWindow.getAllWindows().forEach((win) => {
                if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) {
                    return;
                }
                win.minimize();
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.on('open-live-effects-panel', (event) => {
        const { openLiveEffectsPanel } = require('./dialog-windows');
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            openLiveEffectsPanel(win);
        }
    });

    ipcMain.on('open-broadcast-room', (event, options) => {
        const { openBroadcastRoom } = require('./dialog-windows');
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            openBroadcastRoom(win, options || {});
        }
    });

    ipcMain.handle('broadcast-room-create-prototype-room', async (event, options = {}) => {
        try {
            const win = BrowserWindow.fromWebContents(event.sender);
            if (!win) {
                return { success: false, error: 'window_not_found' };
            }

            const snapshot = broadcastRoomHandler.createPrototypeRoom(win, options || {});
            return { success: true, snapshot };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('broadcast-room-open-test-guest-window', async (event, options = {}) => {
        try {
            const { openBroadcastRoomGuestWindow } = require('./dialog-windows');
            const win = BrowserWindow.fromWebContents(event.sender);
            if (!win) {
                return { success: false, error: 'window_not_found' };
            }

            const guestWindow = openBroadcastRoomGuestWindow(win, options || {});
            return { success: true, guestWindowId: guestWindow.id };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('broadcast-room-open-join-window', async (event, options = {}) => {
        try {
            const { openBroadcastRoomJoinWindow } = require('./dialog-windows');
            const win = BrowserWindow.fromWebContents(event.sender);
            if (!win) {
                return { success: false, error: 'window_not_found' };
            }

            const joinWindow = openBroadcastRoomJoinWindow(win, options || {});
            return { success: true, windowId: joinWindow.id };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('broadcast-room-protect-stage-output-window', async (_event, options = {}) => {
        try {
            const requestedTitle = String(options?.title || '').trim();
            if (!requestedTitle) {
                return { success: false, error: 'title_required' };
            }
            const matchingWindows = BrowserWindow.getAllWindows().filter((win) => {
                if (!win || win.isDestroyed()) {
                    return false;
                }
                const title = String(win.getTitle?.() || '').trim();
                return title === requestedTitle || title.includes(requestedTitle);
            });
            matchingWindows.forEach((win) => {
                try { win.setSkipTaskbar(true); } catch (_error) {}
                try { win.setMinimizable(false); } catch (_error) {}
                try { win.setMenu(null); } catch (_error) {}
                try { win.setAutoHideMenuBar(true); } catch (_error) {}
                try { win.setMenuBarVisibility(false); } catch (_error) {}
                if (!win.__evdStageOutputProtected) {
                    win.__evdStageOutputProtected = true;
                    win.on('minimize', () => {
                        setTimeout(() => {
                            if (!win || win.isDestroyed()) {
                                return;
                            }
                            try {
                                if (win.isMinimized()) {
                                    win.restore();
                                }
                                if (typeof win.showInactive === 'function') {
                                    win.showInactive();
                                } else {
                                    win.show();
                                }
                            } catch (_error) {}
                        }, 80);
                    });
                }
                if (win.isMinimized()) {
                    try { win.restore(); } catch (_error) {}
                }
                try {
                    if (typeof win.showInactive === 'function') {
                        win.showInactive();
                    }
                } catch (_error) {}
            });
            return { success: true, count: matchingWindows.length };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('broadcast-room-join-prototype-room', async (event, options = {}) => {
        try {
            const win = BrowserWindow.fromWebContents(event.sender);
            if (!win) {
                return { success: false, error: 'window_not_found' };
            }

            const snapshot = broadcastRoomHandler.joinPrototypeRoom(win, options || {});
            return { success: true, snapshot };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('broadcast-room-get-prototype-room-snapshot', async (_event, roomId) => {
        try {
            const snapshot = broadcastRoomHandler.getPrototypeRoomSnapshot(roomId);
            return { success: true, snapshot };
        } catch (error) {
            return { success: false, error: error.message, snapshot: null };
        }
    });

    ipcMain.handle('broadcast-room-update-prototype-media-state', async (event, options = {}) => {
        try {
            const win = BrowserWindow.fromWebContents(event.sender);
            if (!win) {
                return { success: false, error: 'window_not_found' };
            }

            const snapshot = broadcastRoomHandler.updatePrototypeParticipantMediaState(win, options || {});
            return { success: true, snapshot };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('broadcast-room-update-prototype-share-state', async (event, options = {}) => {
        try {
            const win = BrowserWindow.fromWebContents(event.sender);
            if (!win) {
                return { success: false, error: 'window_not_found' };
            }

            const snapshot = broadcastRoomHandler.updatePrototypeParticipantShareState(win, options || {});
            return { success: true, snapshot };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.on('recording-wizard-log', (_event, payload) => {
        const safePayload = payload && typeof payload === 'object'
            ? payload
            : { message: String(payload || '') };
        console.log('[RecordingWizard]', safePayload);
    });

    ipcMain.on('broadcast-room-log', (_event, payload) => {
        const safePayload = payload && typeof payload === 'object'
            ? payload
            : { message: String(payload || '') };
        console.log('[BroadcastRoom]', safePayload);
        appendBroadcastRoomDebugLog(safePayload);
    });

    ipcMain.handle('live-effects-get-state', async () => {
        return { success: true, state: liveEffectsHandler.getState() };
    });

    ipcMain.handle('live-effects-save-profile', async (_event, profile) => {
        return { success: true, state: liveEffectsHandler.saveProfile(profile) };
    });

    ipcMain.handle('live-effects-create-profile', async (_event, { name }) => {
        return { success: true, state: liveEffectsHandler.createProfile(name) };
    });

    ipcMain.handle('live-effects-delete-profile', async (_event, { profileId }) => {
        return { success: true, state: liveEffectsHandler.deleteProfile(profileId) };
    });

    ipcMain.handle('live-effects-set-active-profile', async (_event, { profileId }) => {
        return { success: true, state: liveEffectsHandler.setActiveProfile(profileId) };
    });

    // Render Sync Video
    ipcMain.handle('render-sync-video', async (event, { videoPath, audioPath, offsetMs, muteOriginal, targetOutputPath }) => {
        try {
            const path = require('path');
            // If targetOutputPath is provided, use it. Otherwise default to auto-generated.
            let outputPath = targetOutputPath || path.join(path.dirname(videoPath), `synced_output_${Date.now()}.mp4`);
            if (outputPath && !path.extname(outputPath)) {
                outputPath += '.mp4';
            }

            await ffmpegHandler.replaceAudio(videoPath, audioPath, offsetMs, muteOriginal, outputPath, (percent) => {
                // Optional: Send progress back?
            });
            return { success: true, outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('ffmpeg-add-separate-audio-track', async (_event, { videoPath, segments, outputPath, trackTitle, originalUnderVolume, dubVolume } = {}) => {
        try {
            if (!videoPath) {
                throw new Error('videoPath required');
            }
            if (!Array.isArray(segments) || segments.length === 0) {
                throw new Error('segments required');
            }
            const path = require('path');
            const targetOutput = outputPath || path.join(
                path.dirname(videoPath),
                `${path.parse(videoPath).name}-dublajli${path.extname(videoPath) || '.mp4'}`
            );
            const result = await ffmpegHandler.addSeparateAudioTrack(videoPath, segments, targetOutput, {
                trackTitle,
                originalUnderVolume,
                dubVolume
            }, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-dub-track', percent });
            });
            return { success: true, outputPath: result?.outputPath || targetOutput };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('ffmpeg-add-separate-audio-track-from-audio', async (_event, { videoPath, audioPath, outputPath, trackTitle, originalUnderVolume, dubVolume } = {}) => {
        try {
            if (!videoPath) {
                throw new Error('videoPath required');
            }
            if (!audioPath) {
                throw new Error('audioPath required');
            }
            const path = require('path');
            const targetOutput = outputPath || path.join(
                path.dirname(videoPath),
                `${path.parse(videoPath).name}-canli-ceviri-kanalli${path.extname(videoPath) || '.mp4'}`
            );
            const result = await ffmpegHandler.addSeparateAudioTrackFromAudio(videoPath, audioPath, targetOutput, {
                trackTitle,
                originalUnderVolume,
                dubVolume
            }, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-live-interpreter-track', percent });
            });
            return { success: true, outputPath: result?.outputPath || targetOutput };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('ffmpeg-create-single-dubbed-recording', async (_event, { videoPath, segments, outputPath, trackTitle, originalUnderVolume, dubVolume } = {}) => {
        try {
            if (!videoPath) {
                throw new Error('videoPath required');
            }
            if (!Array.isArray(segments) || segments.length === 0) {
                throw new Error('segments required');
            }
            const path = require('path');
            const targetOutput = outputPath || path.join(
                path.dirname(videoPath),
                `${path.parse(videoPath).name}-dublajli-tek-ses${path.extname(videoPath) || '.mp4'}`
            );
            const result = await ffmpegHandler.createSingleDubbedRecording(videoPath, segments, targetOutput, {
                trackTitle,
                originalUnderVolume,
                dubVolume
            }, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'create-single-dubbed-recording', percent });
            });
            return { success: true, outputPath: result?.outputPath || targetOutput };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('ffmpeg-create-single-dubbed-recording-from-audio', async (_event, { videoPath, dubAudioPath, outputPath, trackTitle, originalUnderVolume, dubVolume } = {}) => {
        try {
            if (!videoPath) {
                throw new Error('videoPath required');
            }
            if (!dubAudioPath) {
                throw new Error('dubAudioPath required');
            }
            const path = require('path');
            const targetOutput = outputPath || path.join(
                path.dirname(videoPath),
                `${path.parse(videoPath).name}-elevenlabs-dublaj${path.extname(videoPath) || '.mp4'}`
            );
            const result = await ffmpegHandler.createSingleDubbedRecordingFromAudio(videoPath, dubAudioPath, targetOutput, {
                trackTitle,
                originalUnderVolume,
                dubVolume
            }, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'create-elevenlabs-dubbed-recording', percent });
            });
            return { success: true, outputPath: result?.outputPath || targetOutput };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('ffmpeg-mix-extra-audio-into-recording', async (_event, { videoPath, audioPath, outputPath, audioVolume = 1 } = {}) => {
        try {
            if (!videoPath) {
                throw new Error('videoPath required');
            }
            if (!audioPath) {
                throw new Error('audioPath required');
            }
            const ffmpegPath = getFfmpegBinaryPath();
            if (!ffmpegPath) {
                throw new Error('FFmpeg binary not found');
            }
            const targetOutput = outputPath || path.join(
                path.dirname(videoPath),
                `${path.parse(videoPath).name}-konuk-sesli${path.extname(videoPath) || '.mp4'}`
            );
            const volume = Math.max(0, Math.min(4, Number(audioVolume) || 1));
            const metadata = await ffmpegHandler.getVideoMetadata(videoPath).catch(() => null);
            const hasOriginalAudio = Array.isArray(metadata?.streams)
                && metadata.streams.some((stream) => stream.codec_type === 'audio');
            const args = hasOriginalAudio ? [
                '-y',
                '-i', videoPath,
                '-i', audioPath,
                '-filter_complex',
                `[0:a:0]aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp[base];[1:a:0]volume=${volume},aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp,apad[extra];[base][extra]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[aout]`,
                '-map', '0:v:0',
                '-map', '[aout]',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-movflags', '+faststart',
                targetOutput
            ] : [
                '-y',
                '-i', videoPath,
                '-i', audioPath,
                '-filter_complex',
                `[1:a:0]volume=${volume},aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp,apad,atrim=0:${Number(metadata?.duration || 0) || 999999}[aout]`,
                '-map', '0:v:0',
                '-map', '[aout]',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-movflags', '+faststart',
                '-shortest',
                targetOutput
            ];
            await execFileAsync(ffmpegPath, args);
            return { success: true, outputPath: targetOutput };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('ffmpeg-overlay-local-backup-video-into-recording', async (_event, {
        videoPath,
        backupPath,
        outputPath,
        offsetSeconds = 0,
        backupAudioVolume = 1,
        pipHeight = 260,
        margin = 48
    } = {}) => {
        try {
            if (!videoPath) {
                throw new Error('videoPath required');
            }
            if (!backupPath) {
                throw new Error('backupPath required');
            }
            const ffmpegPath = getFfmpegBinaryPath();
            if (!ffmpegPath) {
                throw new Error('FFmpeg binary not found');
            }
            const targetOutput = outputPath || path.join(
                path.dirname(videoPath),
                `${path.parse(videoPath).name}-konuk-kamerali${path.extname(videoPath) || '.mp4'}`
            );
            const mainMetadata = await ffmpegHandler.getVideoMetadata(videoPath).catch(() => null);
            const backupMetadata = await ffmpegHandler.getVideoMetadata(backupPath).catch(() => null);
            const mainHasAudio = Array.isArray(mainMetadata?.streams)
                && mainMetadata.streams.some((stream) => stream.codec_type === 'audio');
            const backupHasAudio = Array.isArray(backupMetadata?.streams)
                && backupMetadata.streams.some((stream) => stream.codec_type === 'audio');
            const backupHasVideo = Array.isArray(backupMetadata?.streams)
                && backupMetadata.streams.some((stream) => stream.codec_type === 'video');
            if (!backupHasVideo) {
                throw new Error('local_backup_recording_video_missing');
            }
            const offset = Math.max(0, Number(offsetSeconds) || 0);
            const delayMs = Math.round(offset * 1000);
            const safePipHeight = Math.max(120, Math.min(540, Number(pipHeight) || 260));
            const safeMargin = Math.max(0, Math.min(240, Number(margin) || 48));
            const safeVolume = Math.max(0, Math.min(4, Number(backupAudioVolume) || 1));
            const mainHdrToSdrFilter = ffmpegHandler.buildHdrToSdrFilter
                ? ffmpegHandler.buildHdrToSdrFilter(mainMetadata)
                : '';
            const mainVideoLabel = mainHdrToSdrFilter ? 'mainv' : '0:v:0';
            const filters = [
                ...(mainHdrToSdrFilter ? [`[0:v:0]${mainHdrToSdrFilter}[mainv]`] : []),
                `[1:v:0]setpts=PTS+${offset}/TB,scale=-2:${safePipHeight},format=yuva420p[backupv]`,
                `[${mainVideoLabel}][backupv]overlay=W-w-${safeMargin}:H-h-${safeMargin}:enable='gte(t,${offset})'[vout]`
            ];
            const args = [
                '-y',
                '-i', videoPath,
                '-i', backupPath
            ];
            const maps = ['-map', '[vout]'];
            const audioOutputOptions = [];
            if (mainHasAudio && backupHasAudio) {
                filters.push(`[0:a:0]aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp[basea]`);
                filters.push(`[1:a:0]volume=${safeVolume},aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp,adelay=${delayMs}:all=1,apad[backupa]`);
                filters.push('[basea][backupa]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[aout]');
                maps.push('-map', '[aout]');
                audioOutputOptions.push('-c:a', 'aac', '-b:a', '192k');
            } else if (mainHasAudio) {
                maps.push('-map', '0:a:0');
                audioOutputOptions.push('-c:a', 'aac', '-b:a', '192k');
            } else if (backupHasAudio) {
                filters.push(`[1:a:0]volume=${safeVolume},aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp,adelay=${delayMs}:all=1,apad,atrim=0:${Number(mainMetadata?.duration || 0) || 999999}[aout]`);
                maps.push('-map', '[aout]');
                audioOutputOptions.push('-c:a', 'aac', '-b:a', '192k');
            }
            args.push(
                '-filter_complex', filters.join(';'),
                ...maps,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '23',
                '-pix_fmt', 'yuv420p',
                ...(ffmpegHandler.buildProcessedVideoColorOutputOptions
                    ? ffmpegHandler.buildProcessedVideoColorOutputOptions(mainMetadata)
                    : []),
                ...audioOutputOptions,
                '-movflags', '+faststart',
                '-shortest',
                targetOutput
            );
            await execFileAsync(ffmpegPath, args);
            return { success: true, outputPath: targetOutput };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('ffmpeg-overlay-local-backup-video-by-timeline', async (_event, {
        videoPath,
        backupPath,
        outputPath,
        offsetSeconds = 0,
        backupAudioVolume = 1,
        segments = []
    } = {}) => {
        try {
            if (!videoPath) {
                throw new Error('videoPath required');
            }
            if (!backupPath) {
                throw new Error('backupPath required');
            }
            const normalizedSegments = Array.isArray(segments)
                ? segments
                    .map((segment) => ({
                        start: Math.max(0, Number(segment?.start || 0)),
                        end: Math.max(0, Number(segment?.end || 0)),
                        baseWidth: Math.max(1, Number(segment?.baseWidth || 1920)),
                        baseHeight: Math.max(1, Number(segment?.baseHeight || 1080)),
                        rect: {
                            x: Math.max(0, Number(segment?.rect?.x || 0)),
                            y: Math.max(0, Number(segment?.rect?.y || 0)),
                            width: Math.max(1, Number(segment?.rect?.width || 0)),
                            height: Math.max(1, Number(segment?.rect?.height || 0))
                        }
                    }))
                    .filter((segment) => segment.end - segment.start >= 0.2 && segment.rect.width > 0 && segment.rect.height > 0)
                    .slice(0, 80)
                : [];
            if (!normalizedSegments.length) {
                throw new Error('recording_timeline_no_matching_segments');
            }
            const ffmpegPath = getFfmpegBinaryPath();
            if (!ffmpegPath) {
                throw new Error('FFmpeg binary not found');
            }
            const targetOutput = outputPath || path.join(
                path.dirname(videoPath),
                `${path.parse(videoPath).name}-timeline-sahne${path.extname(videoPath) || '.mp4'}`
            );
            const mainMetadata = await ffmpegHandler.getVideoMetadata(videoPath).catch(() => null);
            const backupMetadata = await ffmpegHandler.getVideoMetadata(backupPath).catch(() => null);
            const mainVideoStream = Array.isArray(mainMetadata?.streams)
                ? mainMetadata.streams.find((stream) => stream.codec_type === 'video')
                : null;
            const outputWidth = Math.max(1, Number(mainVideoStream?.width || 1920));
            const outputHeight = Math.max(1, Number(mainVideoStream?.height || 1080));
            const mainHasAudio = Array.isArray(mainMetadata?.streams)
                && mainMetadata.streams.some((stream) => stream.codec_type === 'audio');
            const backupHasAudio = Array.isArray(backupMetadata?.streams)
                && backupMetadata.streams.some((stream) => stream.codec_type === 'audio');
            const backupHasVideo = Array.isArray(backupMetadata?.streams)
                && backupMetadata.streams.some((stream) => stream.codec_type === 'video');
            if (!backupHasVideo) {
                throw new Error('local_backup_recording_video_missing');
            }
            const offset = Math.max(0, Number(offsetSeconds) || 0);
            const delayMs = Math.round(offset * 1000);
            const safeVolume = Math.max(0, Math.min(4, Number(backupAudioVolume) || 1));
            const mainHdrToSdrFilter = ffmpegHandler.buildHdrToSdrFilter
                ? ffmpegHandler.buildHdrToSdrFilter(mainMetadata)
                : '';
            const filters = [];
            let previousVideoLabel = mainHdrToSdrFilter ? 'mainv' : '0:v:0';
            if (mainHdrToSdrFilter) {
                filters.push(`[0:v:0]${mainHdrToSdrFilter}[mainv]`);
            }
            const makeEven = (value) => Math.max(2, Math.round(Number(value || 0) / 2) * 2);
            if (normalizedSegments.length === 1) {
                filters.push(`[1:v:0]setpts=PTS+${offset}/TB[backupraw0]`);
            } else {
                const splitLabels = normalizedSegments.map((_, index) => `[backupraw${index}]`).join('');
                filters.push(`[1:v:0]setpts=PTS+${offset}/TB,split=${normalizedSegments.length}${splitLabels}`);
            }
            normalizedSegments.forEach((segment, index) => {
                const scaleX = outputWidth / segment.baseWidth;
                const scaleY = outputHeight / segment.baseHeight;
                segment.outputRect = {
                    x: Math.round(segment.rect.x * scaleX),
                    y: Math.round(segment.rect.y * scaleY),
                    width: makeEven(segment.rect.width * scaleX),
                    height: makeEven(segment.rect.height * scaleY)
                };
                filters.push(`[backupraw${index}]scale=${segment.outputRect.width}:${segment.outputRect.height}:force_original_aspect_ratio=increase,crop=${segment.outputRect.width}:${segment.outputRect.height},setsar=1[backupv${index}]`);
            });
            normalizedSegments.forEach((segment, index) => {
                const outputLabel = index === normalizedSegments.length - 1 ? 'vout' : `vtmp${index}`;
                const enable = `between(t,${segment.start.toFixed(3)},${segment.end.toFixed(3)})`;
                filters.push(`[${previousVideoLabel}][backupv${index}]overlay=${segment.outputRect.x}:${segment.outputRect.y}:enable='${enable}'[${outputLabel}]`);
                previousVideoLabel = outputLabel;
            });

            const args = [
                '-y',
                '-i', videoPath,
                '-i', backupPath
            ];
            const maps = ['-map', '[vout]'];
            const audioOutputOptions = [];
            if (mainHasAudio && backupHasAudio) {
                filters.push(`[0:a:0]aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp[basea]`);
                filters.push(`[1:a:0]volume=${safeVolume},aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp,adelay=${delayMs}:all=1,apad[backupa]`);
                filters.push('[basea][backupa]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[aout]');
                maps.push('-map', '[aout]');
                audioOutputOptions.push('-c:a', 'aac', '-b:a', '192k');
            } else if (mainHasAudio) {
                maps.push('-map', '0:a:0');
                audioOutputOptions.push('-c:a', 'aac', '-b:a', '192k');
            } else if (backupHasAudio) {
                filters.push(`[1:a:0]volume=${safeVolume},aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp,adelay=${delayMs}:all=1,apad,atrim=0:${Number(mainMetadata?.duration || 0) || 999999}[aout]`);
                maps.push('-map', '[aout]');
                audioOutputOptions.push('-c:a', 'aac', '-b:a', '192k');
            }
            args.push(
                '-filter_complex', filters.join(';'),
                ...maps,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '23',
                '-pix_fmt', 'yuv420p',
                ...(ffmpegHandler.buildProcessedVideoColorOutputOptions
                    ? ffmpegHandler.buildProcessedVideoColorOutputOptions(mainMetadata)
                    : []),
                ...audioOutputOptions,
                '-movflags', '+faststart',
                '-shortest',
                targetOutput
            );
            await execFileAsync(ffmpegPath, args);
            return { success: true, outputPath: targetOutput, segmentCount: normalizedSegments.length };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('ffmpeg-preview-rebalanced-dubbed-recording', async (_event, options = {}) => {
        try {
            if (!options.videoPath) {
                throw new Error('videoPath required');
            }
            const path = require('path');
            const os = require('os');
            const outputPath = path.join(os.tmpdir(), `evd_rebalance_preview_${Date.now()}.m4a`);
            const result = await ffmpegHandler.previewRebalancedDubbedRecording(options.videoPath, outputPath, options, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'preview-rebalanced-dubbed-recording', percent });
            });
            return { success: true, outputPath: result?.outputPath || outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('ffmpeg-create-rebalanced-dubbed-recording', async (_event, options = {}) => {
        try {
            if (!options.videoPath) {
                throw new Error('videoPath required');
            }
            const path = require('path');
            const targetOutput = options.outputPath || path.join(
                path.dirname(options.videoPath),
                `${path.parse(options.videoPath).name}-yeniden-dengeli${path.extname(options.videoPath) || '.mp4'}`
            );
            const result = await ffmpegHandler.createRebalancedDubbedRecording(options.videoPath, targetOutput, options, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'create-rebalanced-dubbed-recording', percent });
            });
            return { success: true, outputPath: result?.outputPath || targetOutput };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Save Temp Recording
    ipcMain.handle('save-temp-recording', async (event, buffer) => {
        try {
            const path = require('path');
            const os = require('os');
            const fs = require('fs');
            const tempName = `rec_${Date.now()}`;
            const videoPath = path.join(os.tmpdir(), `${tempName}.webm`);
            const audioPath = path.join(os.tmpdir(), `${tempName}.wav`);

            fs.writeFileSync(videoPath, buffer);

            // Extract Audio and Normalize
            await new Promise((resolve, reject) => {
                const ffmpeg = require('fluent-ffmpeg');
                const ffmpegPath = getFfmpegBinaryPath();
                if (ffmpegPath) {
                    ffmpeg.setFfmpegPath(ffmpegPath);
                }
                ffmpeg(videoPath)
                    .audioFilters('dynaudnorm=f=150:g=15:m=10.0') // SESİ DENGELER VE GÜÇLENDİRİR
                    .output(audioPath)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });

            return { success: true, videoPath, audioPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Helper for Wizard File Selection
    ipcMain.handle('show-open-dialog', async (event, { extensions, allowMultiple = false }) => {
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
            filters: [
                { name: t('messages.media_files_filter', 'Media Files'), extensions: extensions || ['*'] }
            ],
            properties: allowMultiple ? ['openFile', 'multiSelections'] : ['openFile']
        });
        return result;
    });




    // === VIDEO LAYER (Picture-in-Picture) HANDLERS ===

    // CTA Overlay Ekle
    ipcMain.handle('add-cta-overlay', async (event, params) => {
        try {
            await ffmpegHandler.addCtaOverlay(params, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-cta-overlay', percent });
            });
            return { success: true, outputPath: params.outputPath };
        } catch (error) {
            console.error('CTA Overlay Hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Smart CTA Overlay Ekle (Toplu)
    ipcMain.handle('apply-cta-overlays-smart', async (event, params) => {
        try {
            const { videoPath, outputPath, overlays } = params;
            await ffmpegHandler.applyCtaOverlaysSmart(videoPath, outputPath, overlays, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'apply-cta-smart', percent });
            });
            return { success: true, outputPath };
        } catch (error) {
            console.error('Smart CTA Overlay Hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Video katmanı ekle
    ipcMain.handle('add-video-layer', async (event, params) => {
        try {
            const result = await ffmpegHandler.addVideoLayer(params, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-video-layer', percent });
            });
            return { success: true, outputPath: result };
        } catch (error) {
            console.error('Video katmanı ekleme hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // AI ile konum önerisi al
    ipcMain.handle('get-video-layer-ai-suggestion', async (event, params) => {
        try {
            const { mainVideoPath, layerVideoPath, purpose, currentTime } = params;

            // Video metadata'larını al
            const mainMeta = await ffmpegHandler.getVideoMetadata(mainVideoPath);
            const layerMeta = await ffmpegHandler.getVideoMetadata(layerVideoPath);

            const mainWidth = mainMeta.width || 1920;
            const mainHeight = mainMeta.height || 1080;

            // Amaca göre varsayılan öneriler
            let suggestions = [];

            switch (purpose) {
                case 'sign-language':
                    // İşaret dili: Sağ alt, %12.5 (Türkiye standardı: 8'de bir)
                    const slWidth = Math.round(mainWidth * 0.125);
                    const slHeight = Math.round(slWidth * (layerMeta.height / layerMeta.width));
                    suggestions.push({
                        x: mainWidth - slWidth - 20,
                        y: mainHeight - slHeight - 20,
                        width: slWidth,
                        height: slHeight,
                        positionKey: 'runtime.video_layer.position_bottom_right',
                        positionFallback: 'Bottom Right',
                        reasonKey: 'runtime.video_layer.ai_reason_sign_language',
                        reasonFallback: 'Standard sign-language position (12.5%, one eighth of the frame).'
                    });
                    break;

                case 'split-screen':
                    // Split screen: Sol yarı
                    suggestions.push({
                        x: 0,
                        y: 0,
                        width: Math.round(mainWidth / 2),
                        height: mainHeight,
                        positionKey: 'runtime.video_layer.ai_position_left_half',
                        positionFallback: 'Left Half',
                        reasonKey: 'runtime.video_layer.ai_reason_split_screen',
                        reasonFallback: 'Left half is suitable for split-screen mode.'
                    });
                    break;

                case 'camera-corner':
                    // Kamera köşede: Sağ üst, %15
                    const ccWidth = Math.round(mainWidth * 0.15);
                    const ccHeight = Math.round(ccWidth * (layerMeta.height / layerMeta.width));
                    suggestions.push({
                        x: mainWidth - ccWidth - 10,
                        y: 10,
                        width: ccWidth,
                        height: ccHeight,
                        positionKey: 'runtime.video_layer.position_top_right',
                        positionFallback: 'Top Right',
                        reasonKey: 'runtime.video_layer.ai_reason_camera_corner',
                        reasonFallback: 'Ideal position for a corner camera.'
                    });
                    break;

                default:
                    // Serbest: Merkez-alt öner
                    const defWidth = Math.round(mainWidth * 0.25);
                    const defHeight = Math.round(defWidth * (layerMeta.height / layerMeta.width));
                    suggestions.push({
                        x: Math.round((mainWidth - defWidth) / 2),
                        y: mainHeight - defHeight - 20,
                        width: defWidth,
                        height: defHeight,
                        positionKey: 'runtime.video_layer.position_bottom_center',
                        positionFallback: 'Bottom Center',
                        reasonKey: 'runtime.video_layer.ai_reason_default',
                        reasonFallback: 'A centered position that is less likely to cover important content.'
                    });
            }

            return {
                success: true,
                suggestions,
                mainResolution: { width: mainWidth, height: mainHeight },
                layerResolution: { width: layerMeta.width, height: layerMeta.height }
            };
        } catch (error) {
            console.error('AI öneri hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Dosya Yeniden Adlandır
    ipcMain.handle('rename-file', async (event, { oldPath, newPath }) => {
        try {
            // Önce hedef dosya varsa sil
            if (fs.existsSync(newPath)) {
                fs.unlinkSync(newPath);
            }
            fs.renameSync(oldPath, newPath);
            return { success: true };
        } catch (error) {
            console.error('Dosya yeniden adlandırma hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Uygulamayı kapat
    ipcMain.on('quit-app', () => {
        const { app } = require('electron');
        app.quit();
    });

    // Desktop Capturer Sources (Moved from Renderer to Main to avoid crash)
    ipcMain.handle('get-desktop-sources', async (event, options) => {
        try {
            const { desktopCapturer } = require('electron');
            const opts = options || { types: ['screen', 'window'] };
            if (!opts.thumbnailSize) opts.thumbnailSize = { width: 0, height: 0 };
            const sources = await desktopCapturer.getSources(opts);
            const windowHandles = (sources || [])
                .map((source) => {
                    const parts = String(source.id || '').split(':');
                    return String(source.id || '').startsWith('window:') ? Number(parts[1] || 0) : 0;
                })
                .filter((handle) => Number.isFinite(handle) && handle > 0);
            const handlePidMap = await resolveWindowHandleProcessIds(windowHandles);
            const normalizedSources = (sources || []).map((source) => {
                const id = String(source.id || '');
                const idParts = id.split(':');
                const windowHandle = id.startsWith('window:') ? Number(idParts[1] || 0) : 0;
                const pid = Number(source.processId || source.pid || idParts[2] || handlePidMap.get(windowHandle) || 0);
                return {
                    id,
                    name: String(source.name || ''),
                    display_id: String(source.display_id || ''),
                    appIcon: source.appIcon || null,
                    thumbnail: source.thumbnail || null,
                    processId: Number.isFinite(pid) && pid > 0 ? pid : 0
                };
            });
            return { success: true, sources: normalizedSources };
        } catch (error) {
            console.error('get-desktop-sources error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-window-process-sources', async () => {
        let scriptPath = '';
        try {
            if (process.platform === 'darwin') {
                return await nativeAudioPlatform.listNativeAudioSources();
            }
            if (process.platform !== 'win32') {
                return { success: true, sources: [] };
            }
            const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace EVD -Name Win32 -MemberDefinition @'
public delegate bool EnumWindowsProc(System.IntPtr hWnd, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
'@
$items = New-Object System.Collections.Generic.List[object]
$callback = [EVD.Win32+EnumWindowsProc] {
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if ([EVD.Win32]::IsWindowVisible($hWnd)) {
        $builder = New-Object System.Text.StringBuilder 512
        [void][EVD.Win32]::GetWindowText($hWnd, $builder, $builder.Capacity)
        $title = $builder.ToString()
        if ($title) {
            $pid = 0
            [void][EVD.Win32]::GetWindowThreadProcessId($hWnd, [ref]$pid)
            if ($pid -gt 0) {
                $processName = ''
                try { $processName = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch {}
                $items.Add([pscustomobject]@{
                    Id = [int64]$pid
                    ProcessName = $processName
                    MainWindowTitle = $title
                    Handle = $hWnd.ToInt64()
                })
            }
        }
    }
    return $true
}
[void][EVD.Win32]::EnumWindows($callback, [IntPtr]::Zero)
$items | ConvertTo-Json -Compress
`;
            scriptPath = path.join(os.tmpdir(), `evd-window-sources-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
            fs.writeFileSync(scriptPath, script, 'utf8');
            const { stdout } = await execFileAsync('powershell.exe', [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                scriptPath
            ], {
                windowsHide: true,
                timeout: 8000,
                maxBuffer: 1024 * 1024
            });
            const parsed = stdout?.trim() ? JSON.parse(stdout.trim()) : [];
            const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
            const sources = rows
                .map((row) => ({
                    id: `process:${Number(row.Id || 0)}`,
                    name: String(row.MainWindowTitle || row.ProcessName || '').trim(),
                    processName: String(row.ProcessName || '').trim(),
                    processId: Number(row.Id || 0)
                }))
                .filter((source) => source.processId > 0 && source.name);
            return { success: true, sources };
        } catch (error) {
            console.error('get-window-process-sources error:', error);
            return { success: false, error: error.message };
        } finally {
            if (scriptPath) {
                try { fs.unlinkSync(scriptPath); } catch (_error) {}
            }
        }
    });

    ipcMain.handle('broadcast-room-prepare-display-media-request', async (event, options = {}) => {
        try {
            const sourceId = String(options.sourceId || '').trim();
            const includeAudio = options.includeAudio === true;
            if (!sourceId) {
                return { success: false, error: 'source_id_missing' };
            }
            const targetSession = event.sender?.session;
            if (!targetSession || typeof targetSession.setDisplayMediaRequestHandler !== 'function') {
                return { success: false, error: 'display_media_request_handler_unavailable' };
            }

            targetSession.setDisplayMediaRequestHandler(async (_request, callback) => {
                try {
                    const { desktopCapturer } = require('electron');
                    const sources = await desktopCapturer.getSources({
                        types: ['screen', 'window'],
                        thumbnailSize: { width: 0, height: 0 },
                        fetchWindowIcons: false
                    });
                    const matchedSource = (sources || []).find((item) => (
                        String(item.id || '').trim() === sourceId
                        || String(item.name || '').trim() === sourceId
                    ));
                    if (!matchedSource) {
                        callback({});
                        return;
                    }
                    callback({
                        video: matchedSource,
                        audio: includeAudio ? 'loopback' : false
                    });
                } catch (handlerError) {
                    console.error('broadcast-room-prepare-display-media-request handler error:', handlerError);
                    callback({});
                } finally {
                    try {
                        targetSession.setDisplayMediaRequestHandler(null);
                    } catch (_clearError) {
                        // ignore clear errors
                    }
                }
            }, { useSystemPicker: false });

            return { success: true };
        } catch (error) {
            console.error('broadcast-room-prepare-display-media-request error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-native-window-sources', async () => {
        try {
            const sources = await getNativeWindowSources();
            return { success: true, sources };
        } catch (error) {
            console.error('get-native-window-sources error:', error);
            return { success: false, error: error.message, sources: [] };
        }
    });

    ipcMain.handle('show-native-notification', async (event, { title, body, silent = true } = {}) => {
        try {
            if (!Notification.isSupported()) {
                console.warn('Native notification is not supported on this system.');
                return { success: false, error: 'Native notifications are not supported on this system.' };
            }

            console.log('Showing native notification:', {
                title: String(title || '').trim() || 'Korcul Video Editor',
                body: String(body || '').trim(),
                silent: !!silent
            });

            const notification = new Notification({
                title: String(title || '').trim() || 'Korcul Video Editor',
                body: String(body || '').trim(),
                silent: !!silent
            });

            const senderWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
            notification.on('click', () => {
                try {
                    if (senderWindow) {
                        if (senderWindow.isMinimized()) {
                            senderWindow.restore();
                        }
                        senderWindow.show();
                        senderWindow.focus();
                    }
                } catch (focusError) {
                    console.warn('notification focus error:', focusError);
                }
            });

            notification.show();
            console.log('Native notification show() called successfully.');
            return { success: true };
        } catch (error) {
            console.error('show-native-notification error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('window-is-focused', async (event) => {
        try {
            const senderWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
            const focusedWindow = BrowserWindow.getFocusedWindow();
            const focused = !!(senderWindow && focusedWindow && senderWindow.id === focusedWindow.id);
            return { success: true, focused };
        } catch (error) {
            return { success: false, focused: true, error: error.message };
        }
    });

    ipcMain.handle('flash-window-attention', async (event, { durationMs = 6000 } = {}) => {
        try {
            const senderWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
            if (!senderWindow || senderWindow.isDestroyed()) {
                return { success: false, error: 'window_not_found' };
            }

            senderWindow.flashFrame(true);
            setTimeout(() => {
                try {
                    if (!senderWindow.isDestroyed()) {
                        senderWindow.flashFrame(false);
                    }
                } catch (error) {
                    console.warn('flash-window-attention stop failed:', error);
                }
            }, Math.max(1000, Number(durationMs) || 6000));

            return { success: true };
        } catch (error) {
            console.error('flash-window-attention error:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = { setupIpcHandlers };
