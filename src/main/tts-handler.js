/**
 * TTS (Text-to-Speech) Handler
 * Windows TTS API wrapper - say.js for speak, PowerShell for export
 */

const say = require('say');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec, execSync } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.korcul-video-editor');
const OPENAI_API_KEY_FILE = path.join(CONFIG_DIR, 'openai-api-key.enc');
const ELEVENLABS_API_KEY_FILE = path.join(CONFIG_DIR, 'elevenlabs-api-key.enc');

const OPENAI_VOICES = [
    'alloy',
    'ash',
    'ballad',
    'coral',
    'echo',
    'fable',
    'nova',
    'onyx',
    'sage',
    'shimmer'
];

function readStoredApiKey(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const encoded = fs.readFileSync(filePath, 'utf8');
        return Buffer.from(encoded, 'base64').toString('utf8').trim() || null;
    } catch (error) {
        console.error('TTS API anahtarı okunamadı:', error);
        return null;
    }
}

function normalizeTtsService(service) {
    const normalized = String(service || '').trim().toLowerCase();
    if (normalized === 'openai' || normalized === 'elevenlabs') {
        return normalized;
    }
    return 'system';
}

function normalizeOutputPathForService(outputPath, service) {
    const targetPath = outputPath || getTempWavPath();
    if (service === 'system') {
        return targetPath;
    }
    return targetPath.replace(/\.[^.]+$/, '.mp3');
}

/**
 * Yüklü TTS seslerini al
 * @returns {Promise<string[]>} Ses isimleri listesi
 */
/**
 * Yüklü TTS seslerini al
 * @returns {Promise<string[]>} Ses isimleri listesi
 */
function getVoices() {
    return new Promise((resolve) => {
        if (process.platform === 'darwin') {
            // Mac OS için 'say -v ?' komutu
            exec('say -v ?', (err, stdout, stderr) => {
                if (err) {
                    console.error('Mac TTS Voices hatası:', err);
                    resolve(['Varsayılan']);
                } else {
                    const voices = stdout.split('\n')
                        .map(line => line.split(/\s+/)[0]) // Sadece ilk kelimeyi (ses ismini) al
                        .filter(v => v && v.length > 0);
                    resolve(voices.length > 0 ? voices : ['Varsayılan']);
                }
            });
        } else {
            // Windows: SAPI ses aciklamalarini kullan
            // Boylese listede gorunen deger ile secim sirasinda eslesen deger ayni olur.
            const psScript = `
try {
    $synth = New-Object -ComObject SAPI.SpVoice
    $seen = @{}
    $voices = $synth.GetVoices()
    foreach ($v in $voices) {
        $desc = $v.GetDescription()
        if (-not [string]::IsNullOrWhiteSpace($desc) -and -not $seen.ContainsKey($desc)) {
            $seen[$desc] = $true
            Write-Output $desc
        }
    }
} catch {
    Write-Error $_.Exception.Message
}
`;
            const tempScriptPath = path.join(os.tmpdir(), `tts_voices_${Date.now()}.ps1`);
            fs.writeFileSync(tempScriptPath, psScript);

            exec(`powershell -ExecutionPolicy Bypass -File "${tempScriptPath}"`, { timeout: 10000 }, (err, stdout, stderr) => {
                try { fs.unlinkSync(tempScriptPath); } catch (e) { }

                if (err) {
                    console.error('TTS Voices PowerShell hatası:', err);
                    resolve(['Varsayılan']);
                } else {
                    const voices = stdout.split(/\r?\n/)
                        .map(v => v.trim())
                        .filter(v => v.length > 0);
                    resolve(voices.length > 0 ? voices : ['Varsayılan']);
                }
            });
        }
    });
}

function getSystemVoicesDetailed() {
    return new Promise((resolve) => {
        if (process.platform === 'darwin') {
            getVoices().then((voices) => {
                resolve(voices.map((name) => ({
                    name,
                    culture: '',
                    gender: '',
                    enabled: true
                })));
            }).catch(() => resolve([]));
            return;
        }

        const psScript = `
$ErrorActionPreference = "Stop"
try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voices = @()
    foreach ($installed in $synth.GetInstalledVoices()) {
        $info = $installed.VoiceInfo
        $voices += [pscustomobject]@{
            name = [string]$info.Name
            culture = [string]$info.Culture.Name
            gender = [string]$info.Gender
            enabled = [bool]$installed.Enabled
        }
    }
    $voices | ConvertTo-Json -Depth 3
} catch {
    [Console]::Error.WriteLine("TTS_ERROR: " + $_.Exception.ToString())
    exit 1
}
`;
        const tempScriptPath = path.join(os.tmpdir(), `tts_voices_detailed_${Date.now()}.ps1`);
        const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
        fs.writeFileSync(tempScriptPath, Buffer.concat([bom, Buffer.from(psScript, 'utf8')]));

        exec(`powershell -ExecutionPolicy Bypass -File "${tempScriptPath}"`, { timeout: 10000 }, (err, stdout) => {
            try { fs.unlinkSync(tempScriptPath); } catch (e) { }
            if (err) {
                console.error('Detailed TTS voices PowerShell hatası:', err);
                resolve([]);
                return;
            }
            try {
                const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
                const voices = Array.isArray(parsed) ? parsed : [parsed];
                resolve(voices
                    .map((voice) => ({
                        name: String(voice?.name || '').trim(),
                        culture: String(voice?.culture || '').trim(),
                        gender: String(voice?.gender || '').trim(),
                        enabled: voice?.enabled !== false
                    }))
                    .filter((voice) => voice.name));
            } catch (error) {
                console.error('Detailed TTS voices parse hatası:', error);
                resolve([]);
            }
        });
    });
}

async function getProviderVoices(service = 'system') {
    const normalizedService = normalizeTtsService(service);
    if (normalizedService === 'system') {
        return getVoices();
    }
    if (normalizedService === 'openai') {
        return OPENAI_VOICES.map((voice) => ({
            id: voice,
            name: voice
        }));
    }

    const apiKey = readStoredApiKey(ELEVENLABS_API_KEY_FILE);
    if (!apiKey) {
        throw new Error('elevenlabs_api_key_missing');
    }
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
        method: 'GET',
        headers: {
            'xi-api-key': apiKey,
            Accept: 'application/json'
        }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload?.detail?.message || payload?.message || `elevenlabs_voices_http_${response.status}`);
    }
    const voices = Array.isArray(payload?.voices) ? payload.voices : [];
    return voices
        .map((voice) => ({
            id: String(voice.voice_id || '').trim(),
            name: String(voice.name || voice.voice_id || '').trim()
        }))
        .filter((voice) => voice.id && voice.name);
}

/**
 * Metni ses dosyasına çevir (PowerShell SAPI kullanarak)
 * @param {string} text - Seslendirilecek metin
 * @param {string} voice - Ses ismi (null = varsayılan)
 * @param {number} speed - Konuşma hızı (0.5-2.0, 1.0 = normal)
 * @param {string} outputPath - Çıktı dosya yolu (.wav)
 * @returns {Promise<string>} Oluşturulan dosya yolu
 */
/**
 * Metni ses dosyasına çevir (PowerShell SAPI kullanarak)
 * @param {string} text - Seslendirilecek metin
 * @param {string} voice - Ses ismi (null = varsayılan)
 * @param {number} speed - Konuşma hızı (0.5-2.0, 1.0 = normal)
 * @param {string} outputPath - Çıktı dosya yolu (.wav)
 * @param {number} volume - Ses seviyesi (0-100, varsayılan 100)
 * @returns {Promise<string>} Oluşturulan dosya yolu
 */
function textToWav(text, voice, speed, outputPath, volume = 100) {
    return new Promise((resolve, reject) => {
        console.log('TTS başlıyor:', { platform: process.platform, text: text.substring(0, 50), voice, speed, volume });

        if (process.platform === 'darwin') {
            // Mac OS Implementasyonu ('say' komutu)
            const tempAiff = outputPath.replace('.wav', '.aiff');

            // Speed: Mac 'say -r' (rate), default around 175 wpm. Scale: 0.5 -> ~90, 2.0 -> ~350
            const rate = Math.round(175 * speed);

            let command = `say -o "${tempAiff}" --data-format=LEF32@44100 -r ${rate}`;
            if (voice && voice !== 'Varsayılan') {
                command += ` -v "${voice}"`;
            }
            // Metni escape et
            const safeText = text.replace(/"/g, '\\"');
            command += ` "${safeText}"`;

            exec(command, (err, stdout, stderr) => {
                if (err) {
                    console.error('Mac TTS hatası:', err);
                    return reject(err);
                }

                // AIFF -> WAV dönüştürme (ffmpeg ile)
                const ffmpeg = require('fluent-ffmpeg');
                ffmpeg(tempAiff)
                    .toFormat('wav')
                    .audioFrequency(44100)
                    .on('end', () => {
                        try { fs.unlinkSync(tempAiff); } catch (e) { }
                        resolve(outputPath);
                    })
                    .on('error', (ferr) => {
                        console.error('AIFF to WAV convert hatası:', ferr);
                        reject(ferr);
                    })
                    .save(outputPath);
            });

        } else {
            // Windows Implementasyonu (System.Speech). Modern Windows sesleri SAPI COM listesinde
            // her zaman görünmediği için dosya üretiminde SpeechSynthesizer kullanıyoruz.
            const rate = Math.round((speed - 1) * 10);
            const clampedRate = Math.max(-10, Math.min(10, rate));
            const clampedVolume = Math.max(0, Math.min(100, volume));
            const safeVoice = (voice || '').replace(/'/g, "''");

            let psScript = `
$ErrorActionPreference = "Stop"
try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.Rate = ${clampedRate}
    $synth.Volume = ${clampedVolume}
`;
            if (voice && voice !== 'Varsayılan') {
                psScript += `
    $targetVoice = '${safeVoice}'
    foreach ($installed in $synth.GetInstalledVoices()) {
        $info = $installed.VoiceInfo
        $matches = $info.Name -eq $targetVoice -or
            $info.Name -like "$targetVoice*" -or
            $targetVoice -like "$($info.Name)*" -or
            $info.Culture.Name -eq $targetVoice
        if ($matches) {
            $synth.SelectVoice($info.Name)
            break
        }
    }
`;
            }

            const safeText = text.replace(/'/g, "''").replace(/"/g, "'");
            psScript += `
    $synth.SetOutputToWaveFile("${outputPath.replace(/\\/g, '\\\\')}")
    $synth.Speak('${safeText}')
    $synth.SetOutputToNull()
    $synth.Dispose()
    Write-Host "OK"
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
`;
            const tempScriptPath = path.join(os.tmpdir(), `tts_script_${Date.now()}.ps1`);
            const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
            const content = Buffer.concat([bom, Buffer.from(psScript, 'utf8')]);
            fs.writeFileSync(tempScriptPath, content);

            exec(`powershell -ExecutionPolicy Bypass -File "${tempScriptPath}"`, { timeout: 60000 }, (err, stdout, stderr) => {
                try { fs.unlinkSync(tempScriptPath); } catch (e) { }
                const detail = String(stderr || stdout || err.message || '').trim().replace(/\s+/g, ' ');
                if (err) reject(new Error('TTS hatası: ' + (detail || 'unknown_error')));
                else resolve(outputPath);
            });
        }
    });
}

async function textToSpeechFile({ text, voice, speed = 1, outputPath, volume = 100, service = 'system' } = {}) {
    const normalizedService = normalizeTtsService(service);
    const finalOutputPath = normalizeOutputPathForService(outputPath, normalizedService);
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
        throw new Error('tts_text_missing');
    }

    if (normalizedService === 'system') {
        await textToWav(normalizedText, voice, speed, finalOutputPath, volume);
        return finalOutputPath;
    }

    if (normalizedService === 'openai') {
        const apiKey = readStoredApiKey(OPENAI_API_KEY_FILE);
        if (!apiKey) {
            throw new Error('openai_api_key_missing');
        }
        const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini-tts',
                voice: String(voice || 'alloy'),
                input: normalizedText,
                response_format: 'mp3',
                speed: Math.max(0.25, Math.min(4, Number(speed) || 1))
            })
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload?.error?.message || `openai_tts_http_${response.status}`);
        }
        fs.writeFileSync(finalOutputPath, Buffer.from(await response.arrayBuffer()));
        return finalOutputPath;
    }

    const apiKey = readStoredApiKey(ELEVENLABS_API_KEY_FILE);
    if (!apiKey) {
        throw new Error('elevenlabs_api_key_missing');
    }
    const voiceId = String(voice || 'JBFqnCBsd6RMkjVDRZzb');
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg'
        },
        body: JSON.stringify({
            text: normalizedText,
            model_id: 'eleven_flash_v2_5'
        })
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.detail?.message || payload?.message || `elevenlabs_tts_http_${response.status}`);
    }
    fs.writeFileSync(finalOutputPath, Buffer.from(await response.arrayBuffer()));
    return finalOutputPath;
}

/**
 * Metni seslendir (önizleme için) - say.js kullanarak
 * @param {string} text - Seslendirilecek metin
 * @param {string} voice - Ses ismi (null = varsayılan)
 * @param {number} speed - Konuşma hızı
 * @returns {Promise<void>}
 */
function speak(text, voice, speed) {
    return new Promise((resolve, reject) => {
        if (process.platform === 'darwin') {
            // Mac OS
            const rate = Math.round(175 * speed);
            let command = `say -r ${rate}`;
            if (voice && voice !== 'Varsayılan') command += ` -v "${voice}"`;
            const safeText = text.replace(/"/g, '\\"');
            command += ` "${safeText}"`;

            exec(command, (err) => {
                if (err) reject(err); else resolve();
            });
        } else {
            // Windows
            const rate = Math.round((speed - 1) * 10);
            const clampedRate = Math.max(-10, Math.min(10, rate));
            const safeVoice = (voice || '').replace(/'/g, "''");

            let psScript = `
$ErrorActionPreference = "Stop"
try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object -ComObject SAPI.SpVoice
    $synth.Rate = ${clampedRate}
    $synth.Volume = 100
`;
            if (voice && voice !== 'Varsayılan') {
                psScript += `
    $targetVoice = '${safeVoice}'
    $voices = $synth.GetVoices()
    foreach ($v in $voices) {
        $description = $v.GetDescription()
        $matches = $description -eq $targetVoice -or
            $description -like "$targetVoice*" -or
            $targetVoice -like "$description*" -or
            $v.Id -like "*$targetVoice*"
        if ($matches) {
            $synth.Voice = $v
            break
        }
    }
`;
            }
            const safeText = text.replace(/'/g, "''").replace(/"/g, "'");
            psScript += `
    $synth.Speak('${safeText}')
    Write-Host "OK"
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
`;
            const tempScriptPath = path.join(os.tmpdir(), `tts_speak_${Date.now()}.ps1`);
            const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
            const content = Buffer.concat([bom, Buffer.from(psScript, 'utf8')]);
            fs.writeFileSync(tempScriptPath, content);

            exec(`powershell -ExecutionPolicy Bypass -File "${tempScriptPath}"`, { timeout: 60000 }, (err) => {
                try { fs.unlinkSync(tempScriptPath); } catch (e) { }
                if (err) reject(err); else resolve();
            });
        }
    });
}

/**
 * Seslendirmeyi durdur
 */
function stop() {
    if (process.platform === 'darwin') {
        exec('killall say', () => { });
    } else {
        say.stop();
    }
}

/**
 * Geçici dosya yolu oluştur
 * @returns {string} Geçici .wav dosya yolu
 */
function getTempWavPath() {
    const tempDir = os.tmpdir();
    const filename = `tts_${Date.now()}.wav`;
    return path.join(tempDir, filename);
}

module.exports = {
    getVoices,
    getSystemVoicesDetailed,
    getProviderVoices,
    textToWav,
    textToSpeechFile,
    speak,
    stop,
    getTempWavPath
};
