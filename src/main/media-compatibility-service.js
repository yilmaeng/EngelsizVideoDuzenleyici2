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

            // Rotation Logic - Comprehensive Check
            let width = videoStream ? videoStream.width : 0;
            let height = videoStream ? videoStream.height : 0;
            let rotation = 0;

            // Helper: Case-insensitive tag search
            const getTagValue = (tags, key) => {
                if (!tags) return null;
                const foundKey = Object.keys(tags).find(k => k.toLowerCase() === key.toLowerCase());
                return foundKey ? tags[foundKey] : null;
            };

            // 1. Check Stream Tags (Most common)
            if (videoStream && videoStream.tags) {
                const rot = getTagValue(videoStream.tags, 'rotate');
                if (rot) rotation = parseInt(rot);
            }

            // 2. Check Container/Format Tags (Apple/QuickTime often puts it here)
            if (rotation === 0 && metadata.format && metadata.format.tags) {
                const rot = getTagValue(metadata.format.tags, 'rotate');
                if (rot) rotation = parseInt(rot);
            }

            // 3. Check Side Data (Display Matrix)
            if (rotation === 0 && videoStream && videoStream.side_data_list) {
                const displayMatrix = videoStream.side_data_list.find(sd => sd.side_data_type === 'Display Matrix');
                if (displayMatrix && displayMatrix.rotation) {
                    rotation = parseInt(displayMatrix.rotation);
                }
            }

            // 4. Check Direct Property (Some ffprobe versions)
            if (rotation === 0 && videoStream && videoStream.rotation) {
                rotation = parseInt(videoStream.rotation);
            }

            console.log(`Probe: ${path.basename(filePath)} - Raw Size: ${width}x${height}, Detected Rotation: ${rotation}°`);

            // Swap if 90 or 270 (or -90, -270)
            if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
                const temp = width;
                width = height;
                height = temp;
                console.log(`Probe: Swapping dimensions due to rotation -> ${width}x${height}`);
            } else if (rotation === 0 && width < height) {
                // No rotation tag found, but width < height. 
                // This usually means the file is physically encoded as vertical (common in some exports or apps).
                // We should accept this as "Vertical" without swapping.
                // Nothing to do here, width is already < height.
                console.log(`Probe: No rotation tag, but file is physically vertical (${width}x${height}).`);
            } else if (rotation === 0 && width > height) {
                // FALLBACK: Could it be a "YUV420P" raw stream where rotation is hidden deeper?
                // Or maybe it's 1920x1080 but the user SWEARS it's vertical.
                // We can't auto-guess this without risk of breaking horizontal videos.
                // BUT, if it's the "Carpenter" video (Görme engelli marangoz), user says it IS vertical but shows 1920x1080 in probe logs.
                // This implies the video IS encoded as 1920x1080 and plays "sideways".
                // In that case, we need to DETECT that it's sideways. But how?
                // Only a human can tell if "down" is "left".
                // UNLESS there's valid metadata we missed.
            }

            const result = {
                filePath,
                container: path.extname(filePath).toLowerCase().slice(1),
                duration: metadata.format.duration || 0,
                size: metadata.format.size || 0,
                bitrate: metadata.format.bit_rate || 0,

                video: videoStream ? {
                    codec: (videoStream.codec_name || '').toLowerCase(),
                    codecTag: (videoStream.codec_tag_string || '').toLowerCase(),
                    width: width,
                    height: height,
                    rotation: rotation,
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

    // AUDIO ONLY Check
    const isAudioFile = !probe.video && probe.audio;
    const commonAudioExtensions = ['mp3', 'wav', 'aac', 'flac', 'ogg', 'wma', 'm4a'];
    const ext = path.extname(filePath).toLowerCase().replace('.', '');

    if (isAudioFile || commonAudioExtensions.includes(ext)) {
        return {
            strategy: 'AUDIO_TO_VIDEO',
            reason: 'Ses dosyası görselleştirilecek',
            estimatedTime: Math.max(2, Math.ceil(probe.duration * 0.1)), // Very fast
            probe,
            details: {
                fromContainer: probe.container,
                toContainer: 'mp4',
                targetVideoCodec: 'h264 (black)',
                targetAudioCodec: 'aac'
            }
        };
    }

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
                '-map 0:v',          // Sadece video stream'ini al
                '-map 0:a?',         // Sadece audio stream'ini al (varsa)
                '-c:v', 'copy',      // Video codec kopyala
                '-c:a', 'copy',      // Audio codec kopyala
                '-movflags', '+faststart'  // Web için optimize
            ])
            .output(outputPath)
            .on('start', (cmd) => console.log('Remux komutu:', cmd))
            .on('stderr', (stderrLine) => {
                // Hata ayıklama için stderr çıktısını logla (sadece hata durumunda veya verbose modda)
                if (stderrLine.includes('Error') || stderrLine.includes('fail')) {
                    console.error('FFmpeg Stderr:', stderrLine);
                }
            })
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
            .on('error', (err, stdout, stderr) => {
                console.error('Remux hatası:', err);
                console.error('FFmpeg Stderr Dump:', stderr); // Tüm stderr çıktısını logla
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

                let playbackResult;
                let finalStrategy = 'QUICK_REMUX';

                try {
                    playbackResult = await quickRemux(filePath, onProgress);
                } catch (remuxError) {
                    console.warn('Quick remux failed, falling back to transcode:', remuxError);
                    notify('transcoding', 'Hızlı dönüşüm başarısız, tam dönüşüm yapılıyor...', {
                        estimatedTime: Math.max(5, Math.ceil(analysis.probe.duration * 0.5))
                    });

                    // Fallback to transcode
                    playbackResult = await transcode(filePath, {}, onProgress);
                    finalStrategy = 'TRANSCODE';
                }

                notify('ready', finalStrategy === 'QUICK_REMUX' ? 'Hızlı dönüşüm tamamlandı' : 'Dönüştürme tamamlandı', {
                    strategy: finalStrategy,
                    playbackPath: playbackResult.outputPath,
                    originalPath: filePath,
                    cached: playbackResult.cached,
                    probe: analysis.probe
                });

                return {
                    success: true,
                    strategy: finalStrategy,
                    playbackPath: playbackResult.outputPath,
                    originalPath: filePath,
                    cached: playbackResult.cached,
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

            case 'AUDIO_TO_VIDEO':
                notify('transcoding', 'Ses dosyası video formatına dönüştürülüyor...', {
                    estimatedTime: analysis.estimatedTime
                });

                const audioResult = await convertAudioToVideo(filePath, onProgress);

                notify('ready', 'Ses dosyası hazır', {
                    strategy: 'AUDIO_TO_VIDEO',
                    playbackPath: audioResult.outputPath,
                    originalPath: filePath,
                    cached: audioResult.cached,
                    probe: analysis.probe
                });

                return {
                    success: true,
                    strategy: 'AUDIO_TO_VIDEO',
                    playbackPath: audioResult.outputPath,
                    originalPath: filePath,
                    cached: audioResult.cached,
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
 * Ses dosyasını siyah ekranlı videoya çevir
 */
function convertAudioToVideo(inputPath, onProgress) {
    return new Promise((resolve, reject) => {
        const fileHash = getFileHash(inputPath);
        const outputPath = path.join(TRANSCODE_DIR, `${fileHash}_audio_viz.mp4`);

        // Cache hit
        if (fs.existsSync(outputPath)) {
            console.log('AudioViz cache hit:', outputPath);
            return resolve({
                success: true,
                outputPath,
                cached: true
            });
        }

        console.log('Audio->Video conversion starting:', inputPath);

        ffmpeg(inputPath)
            .input('color=c=black:s=1280x720')
            .inputFormat('lavfi')
            .outputOptions([
                '-c:v', 'libx264',
                '-tune', 'stillimage',
                '-pix_fmt', 'yuv420p',
                '-shortest',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-movflags', '+faststart'
            ])
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress({
                    percent: progress.percent || 0,
                    stage: 'audio_convert'
                });
            })
            .on('end', () => {
                console.log('Audio conversion complete:', outputPath);
                resolve({
                    success: true,
                    outputPath,
                    cached: false
                });
            })
            .on('error', (err) => {
                console.error('Audio conversion error:', err);
                reject(err);
            })
            .run();
    });
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
