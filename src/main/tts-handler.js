/**
 * TTS (Text-to-Speech) Handler
 * Windows TTS API wrapper - say.js for speak, PowerShell for export
 */

const say = require('say');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec, execSync } = require('child_process');

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
            // Windows (PowerShell)
            const psScript = `
Add-Type -AssemblyName System.Speech
try {
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voices = $synth.GetInstalledVoices()
    foreach ($v in $voices) {
        if ($v.Enabled) {
            Write-Output $v.VoiceInfo.Name
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
            // Windows Implementasyonu (PowerShell SAPI)
            const rate = Math.round((speed - 1) * 10);
            const clampedRate = Math.max(-10, Math.min(10, rate));
            const clampedVolume = Math.max(0, Math.min(100, volume));

            let psScript = `
$ErrorActionPreference = "Stop"
try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object -ComObject SAPI.SpVoice
    $synth.Rate = ${clampedRate}
    $synth.Volume = ${clampedVolume}
`;
            if (voice && voice !== 'Varsayılan') {
                psScript += `
    $voices = $synth.GetVoices()
    foreach ($v in $voices) {
        if ($v.Description -eq "${voice}") {
            $synth.Voice = $v
            break
        }
    }
`;
            }

            const safeText = text.replace(/'/g, "''").replace(/"/g, "'");
            psScript += `
    $stream = New-Object -ComObject SAPI.SpFileStream
    $stream.Open("${outputPath.replace(/\\/g, '\\\\')}", 3)
    $synth.AudioOutputStream = $stream
    $synth.Speak('${safeText}')
    $stream.Close()
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
                if (err) reject(new Error('TTS hatası: ' + (stderr || stdout || err.message)));
                else resolve(outputPath);
            });
        }
    });
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
    $voices = $synth.GetVoices()
    foreach ($v in $voices) {
        if ($v.Description -eq "${voice}") {
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
    textToWav,
    speak,
    stop,
    getTempWavPath
};
