/**
 * Media Compatibility Service
 * 
 * Video dosyalarının Chromium uyumluluğunu kontrol eder ve
 * en uygun oynatma/dönüştürme stratejisini belirler.
 * 
 * Stratejiler:
 * 1. DIRECT_PLAY: Chromium ile doğrudan oynat
 * 2. QUICK_REMUX: Container değiştir (codec aynı, hızlı)
 * 3. TRANSCODE: Codec dönüştür (yavaş ama garantili)
 */

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// FFmpeg yollarını ayarla
const { getFFmpegPaths } = require('./ffmpeg-handler');
const { ffmpegPath, ffprobePath } = getFFmpegPaths();
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Chromium destekli formatlar
const CHROMIUM_CONTAINERS = ['mp4', 'webm', 'ogg', 'ogv', 'm4v'];
const CHROMIUM_VIDEO_CODECS = ['h264', 'avc1', 'vp8', 'vp9', 'av1', 'theora'];
const CHROMIUM_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];

// Platform-specific HEVC desteği (Windows 10+ ve macOS 10.13+)
const PLATFORM_HEVC_SUPPORT = process.platform === 'darwin' ||
    (process.platform === 'win32' && parseFloat(os.release()) >= 10);

// Cache dizini
const CACHE_DIR = path.join(os.tmpdir(), 'EngelsizVideoEditor', 'cache');
const TRANSCODE_DIR = path.join(os.tmpdir(), 'EngelsizVideoEditor', 'transcode');

// Dizinleri oluştur
[CACHE_DIR, TRANSCODE_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

/**
 * Dosya hash'i hesapla (cache key için)
 */
function getFileHash(filePath) {
    const stats = fs.statSync(filePath);
    const hashInput = `${filePath}:${stats.size}:${stats.mtimeMs}`;
    return crypto.createHash('md5').update(hashInput).digest('hex').substring(0, 12);
}

/**
 * Video dosyasını probe et ve detaylı metadata al
 */
function probeVideo(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                return reject(err);
            }

            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

            const result = {
                filePath,
                container: path.extname(filePath).toLowerCase().slice(1),
                duration: metadata.format.duration || 0,
                size: metadata.format.size || 0,
                bitrate: metadata.format.bit_rate || 0,

                video: videoStream ? {
                    codec: (videoStream.codec_name || '').toLowerCase(),
                    codecTag: (videoStream.codec_tag_string || '').toLowerCase(),
                    width: videoStream.width,
                    height: videoStream.height,
                    fps: eval(videoStream.r_frame_rate) || 30,
                    pixelFormat: videoStream.pix_fmt
                } : null,

                audio: audioStream ? {
                    codec: (audioStream.codec_name || '').toLowerCase(),
                    channels: audioStream.channels,
                    sampleRate: audioStream.sample_rate
                } : null
            };

            resolve(result);
        });
    });
}

/**
 * Video codec'inin Chromium'da oynatılabilir olup olmadığını kontrol et
 */
function isCodecSupported(codec) {
    if (!codec) return false;

    const normalizedCodec = codec.toLowerCase();

    // Doğrudan desteklenen codec'ler
    if (CHROMIUM_VIDEO_CODECS.some(c => normalizedCodec.includes(c))) {
        return true;
    }

    // HEVC/H.265 için platform desteğini kontrol et
    if (normalizedCodec.includes('hevc') || normalizedCodec.includes('h265') || normalizedCodec.includes('hev1')) {
        return PLATFORM_HEVC_SUPPORT;
    }

    return false;
}

/**
 * Container'ın Chromium'da açılabilir olup olmadığını kontrol et
 */
function isContainerSupported(container) {
    if (!container) return false;
    return CHROMIUM_CONTAINERS.includes(container.toLowerCase());
}

/**
 * Audio codec'inin desteklenip desteklenmediğini kontrol et
 */
function isAudioCodecSupported(codec) {
    if (!codec) return true; // Ses yoksa sorun yok
    return CHROMIUM_AUDIO_CODECS.some(c => codec.toLowerCase().includes(c));
}

/**
 * Uyumluluk analizi yap ve strateji belirle
 * 
 * @returns {Object} {
 *   strategy: 'DIRECT_PLAY' | 'QUICK_REMUX' | 'TRANSCODE',
 *   reason: string,
 *   estimatedTime: number (seconds),
 *   details: object
 * }
 */
async function analyzeCompatibility(filePath) {
    const probe = await probeVideo(filePath);

    const containerOk = isContainerSupported(probe.container);
    const videoCodecOk = probe.video ? isCodecSupported(probe.video.codec) : true;
    const audioCodecOk = probe.audio ? isAudioCodecSupported(probe.audio.codec) : true;

    // Tüm koşullar uygunsa doğrudan oynat
    if (containerOk && videoCodecOk && audioCodecOk) {
        return {
            strategy: 'DIRECT_PLAY',
            reason: 'Dosya formatı tarayıcı ile uyumlu',
            estimatedTime: 0,
            probe,
            details: {
                container: probe.container,
                videoCodec: probe.video?.codec,
                audioCodec: probe.audio?.codec
            }
        };
    }

    // Video codec destekleniyorsa sadece container değişikliği yeterli (REMUX)
    if (videoCodecOk && audioCodecOk && !containerOk) {
        // Tahmini remux süresi (dosya boyutuna göre, yaklaşık 100MB/saniye)
        const estimatedTime = Math.max(1, Math.ceil(probe.size / (100 * 1024 * 1024)));

        return {
            strategy: 'QUICK_REMUX',
            reason: `${probe.container.toUpperCase()} formatı MP4'e dönüştürülecek (hızlı, kalite kaybı yok)`,
            estimatedTime,
            probe,
            details: {
                fromContainer: probe.container,
                toContainer: 'mp4',
                videoCodec: probe.video?.codec,
                audioCodec: probe.audio?.codec
            }
        };
    }

    // Codec dönüşümü gerekli (TRANSCODE)
    // Tahmini süre: video süresi * 0.5 (orta hızda encode varsayımı)
    const estimatedTime = Math.max(5, Math.ceil(probe.duration * 0.5));

    const unsupportedCodecs = [];
    if (!videoCodecOk && probe.video) unsupportedCodecs.push(probe.video.codec);
    if (!audioCodecOk && probe.audio) unsupportedCodecs.push(probe.audio.codec);

    return {
        strategy: 'TRANSCODE',
        reason: `${unsupportedCodecs.join(', ')} codec'i desteklenmiyor, dönüştürme gerekli`,
        estimatedTime,
        probe,
        details: {
            unsupportedCodecs,
            fromContainer: probe.container,
            toContainer: 'mp4',
            targetVideoCodec: 'h264',
            targetAudioCodec: 'aac'
        }
    };
}

/**
 * Hızlı remux (container değiştir, codec kopyala)
 * Çok hızlı çünkü yeniden encode yapmıyor
 */
function quickRemux(inputPath, onProgress) {
    return new Promise((resolve, reject) => {
        const fileHash = getFileHash(inputPath);
        const outputPath = path.join(CACHE_DIR, `${fileHash}_remux.mp4`);

        // Cache'de varsa direkt döndür
        if (fs.existsSync(outputPath)) {
            console.log('Remux cache hit:', outputPath);
            return resolve({
                success: true,
                outputPath,
                cached: true
            });
        }

        console.log('Quick remux başlıyor:', inputPath, '->', outputPath);

        ffmpeg(inputPath)
            .outputOptions([
                '-c:v', 'copy',      // Video codec kopyala
                '-c:a', 'copy',      // Audio codec kopyala
                '-movflags', '+faststart'  // Web için optimize
            ])
            .output(outputPath)
            .on('start', (cmd) => console.log('Remux komutu:', cmd))
            .on('progress', (progress) => {
                if (onProgress) onProgress({
                    percent: progress.percent || 0,
                    stage: 'remux'
                });
            })
            .on('end', () => {
                console.log('Remux tamamlandı:', outputPath);
                resolve({
                    success: true,
                    outputPath,
                    cached: false
                });
            })
            .on('error', (err) => {
                console.error('Remux hatası:', err);
                // Remux başarısız olursa transcode'a fallback
                reject(err);
            })
            .run();
    });
}

/**
 * Tam transcode (codec dönüştür)
 * Yavaş ama her formattan H.264/AAC'ye dönüştürür
 */
function transcode(inputPath, options = {}, onProgress) {
    return new Promise(async (resolve, reject) => {
        const fileHash = getFileHash(inputPath);
        const outputPath = path.join(TRANSCODE_DIR, `${fileHash}_transcoded.mp4`);

        // Cache'de varsa direkt döndür
        if (fs.existsSync(outputPath)) {
            console.log('Transcode cache hit:', outputPath);
            return resolve({
                success: true,
                outputPath,
                cached: true
            });
        }

        console.log('Transcode başlıyor:', inputPath, '->', outputPath);

        // Donanım hızlandırma tespiti
        const hwEncoder = await detectHardwareEncoder();
        const videoCodec = hwEncoder || 'libx264';

        const command = ffmpeg(inputPath);

        // Video codec ayarları
        command.videoCodec(videoCodec);

        if (videoCodec === 'libx264') {
            command.outputOptions(['-preset', 'fast', '-crf', '23']);
        } else if (videoCodec === 'h264_nvenc') {
            command.outputOptions(['-preset', 'p4', '-cq', '23']);
        } else if (videoCodec === 'h264_qsv') {
            command.outputOptions(['-preset', 'faster', '-global_quality', '23']);
        } else if (videoCodec === 'h264_videotoolbox') {
            command.outputOptions(['-q:v', '65']);
        }

        command
            .audioCodec('aac')
            .audioBitrate('192k')
            .outputOptions(['-movflags', '+faststart'])
            .output(outputPath)
            .on('start', (cmd) => console.log('Transcode komutu:', cmd))
            .on('progress', (progress) => {
                if (onProgress) onProgress({
                    percent: progress.percent || 0,
                    stage: 'transcode',
                    fps: progress.currentFps,
                    speed: progress.speed
                });
            })
            .on('end', () => {
                console.log('Transcode tamamlandı:', outputPath);
                resolve({
                    success: true,
                    outputPath,
                    cached: false,
                    encoder: videoCodec
                });
            })
            .on('error', (err) => {
                console.error('Transcode hatası:', err);
                reject(err);
            })
            .run();
    });
}

/**
 * Donanım encoder tespiti
 */
async function detectHardwareEncoder() {
    const encoders = [];

    if (process.platform === 'win32') {
        encoders.push('h264_nvenc', 'h264_qsv', 'h264_amf');
    } else if (process.platform === 'darwin') {
        encoders.push('h264_videotoolbox');
    } else {
        encoders.push('h264_vaapi');
    }

    for (const encoder of encoders) {
        try {
            await testEncoder(encoder);
            console.log('Donanım encoder bulundu:', encoder);
            return encoder;
        } catch {
            // Bu encoder çalışmıyor, diğerini dene
        }
    }

    console.log('Donanım encoder bulunamadı, CPU kullanılacak');
    return null;
}

/**
 * Encoder'ı test et
 */
function testEncoder(encoder) {
    return new Promise((resolve, reject) => {
        const { spawn } = require('child_process');

        const args = [
            '-f', 'lavfi',
            '-i', 'nullsrc=s=256x256:d=1',
            '-c:v', encoder,
            '-frames:v', '1',
            '-f', 'null',
            '-'
        ];

        const proc = spawn(ffmpegPath, args, { stdio: 'pipe' });

        proc.on('close', (code) => {
            if (code === 0) resolve(true);
            else reject(new Error(`Encoder ${encoder} başarısız`));
        });

        proc.on('error', reject);

        // 5 saniye timeout
        setTimeout(() => {
            proc.kill();
            reject(new Error('Timeout'));
        }, 5000);
    });
}

/**
 * Akıllı dosya açma - uyumluluk analizi yap ve gerekirse dönüştür
 */
async function smartOpen(filePath, onProgress, onStatusChange) {
    const notify = (status, message, data = {}) => {
        if (onStatusChange) onStatusChange({ status, message, ...data });
    };

    try {
        // 1. Uyumluluk analizi
        notify('analyzing', 'Dosya analiz ediliyor...');
        const analysis = await analyzeCompatibility(filePath);

        console.log('Uyumluluk analizi:', analysis);

        // 2. Stratejiye göre işlem
        switch (analysis.strategy) {
            case 'DIRECT_PLAY':
                notify('ready', 'Dosya doğrudan açılabilir', {
                    strategy: 'DIRECT_PLAY',
                    playbackPath: filePath,
                    originalPath: filePath,
                    probe: analysis.probe
                });
                return {
                    success: true,
                    strategy: 'DIRECT_PLAY',
                    playbackPath: filePath,
                    originalPath: filePath,
                    probe: analysis.probe
                };

            case 'QUICK_REMUX':
                notify('remuxing', analysis.reason, {
                    estimatedTime: analysis.estimatedTime
                });

                const remuxResult = await quickRemux(filePath, onProgress);

                notify('ready', 'Hızlı dönüşüm tamamlandı', {
                    strategy: 'QUICK_REMUX',
                    playbackPath: remuxResult.outputPath,
                    originalPath: filePath,
                    cached: remuxResult.cached,
                    probe: analysis.probe
                });

                return {
                    success: true,
                    strategy: 'QUICK_REMUX',
                    playbackPath: remuxResult.outputPath,
                    originalPath: filePath,
                    cached: remuxResult.cached,
                    probe: analysis.probe
                };

            case 'TRANSCODE':
                notify('transcoding', analysis.reason, {
                    estimatedTime: analysis.estimatedTime
                });

                const transcodeResult = await transcode(filePath, {}, onProgress);

                notify('ready', 'Dönüştürme tamamlandı', {
                    strategy: 'TRANSCODE',
                    playbackPath: transcodeResult.outputPath,
                    originalPath: filePath,
                    cached: transcodeResult.cached,
                    encoder: transcodeResult.encoder,
                    probe: analysis.probe
                });

                return {
                    success: true,
                    strategy: 'TRANSCODE',
                    playbackPath: transcodeResult.outputPath,
                    originalPath: filePath,
                    cached: transcodeResult.cached,
                    encoder: transcodeResult.encoder,
                    probe: analysis.probe
                };

            default:
                throw new Error('Bilinmeyen strateji: ' + analysis.strategy);
        }
    } catch (error) {
        notify('error', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Cache'i temizle
 */
function clearCache(olderThanDays = 7) {
    const maxAge = olderThanDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let cleared = 0;

    [CACHE_DIR, TRANSCODE_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) return;

        fs.readdirSync(dir).forEach(file => {
            const filePath = path.join(dir, file);
            const stats = fs.statSync(filePath);

            if (now - stats.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
                cleared++;
            }
        });
    });

    console.log(`Cache temizlendi: ${cleared} dosya silindi`);
    return cleared;
}

/**
 * Cache boyutunu al
 */
function getCacheSize() {
    let totalSize = 0;

    [CACHE_DIR, TRANSCODE_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) return;

        fs.readdirSync(dir).forEach(file => {
            const filePath = path.join(dir, file);
            const stats = fs.statSync(filePath);
            totalSize += stats.size;
        });
    });

    return totalSize;
}

module.exports = {
    probeVideo,
    analyzeCompatibility,
    quickRemux,
    transcode,
    smartOpen,
    clearCache,
    getCacheSize,
    isCodecSupported,
    isContainerSupported,
    CACHE_DIR,
    TRANSCODE_DIR
};
