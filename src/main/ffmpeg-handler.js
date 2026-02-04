const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

// FFmpeg ve FFprobe yollarını belirle (production ve development için)
function getFFmpegPaths() {
    // Varsayılan: development modunda @ffmpeg-installer'dan al
    let ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    let ffprobePath = require('@ffprobe-installer/ffprobe').path;

    // Eğer asar arşivi içindeyse, unpacked klasörüne yönlendir
    if (ffmpegPath.includes('app.asar')) {
        ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    }
    if (ffprobePath.includes('app.asar')) {
        ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');
    }

    // Dosyaların var olup olmadığını kontrol et
    if (!fs.existsSync(ffmpegPath)) {
        console.error('FFmpeg bulunamadı:', ffmpegPath);
    }
    if (!fs.existsSync(ffprobePath)) {
        console.error('FFprobe bulunamadı:', ffprobePath);
    }

    console.log('FFmpeg yolu:', ffmpegPath);
    console.log('FFprobe yolu:', ffprobePath);

    return { ffmpegPath, ffprobePath };
}

const { ffmpegPath, ffprobePath } = getFFmpegPaths();

// FFmpeg yollarını ayarla
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

/**
 * Video metadata bilgilerini al
 */
function getVideoMetadata(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                reject(err);
                return;
            }

            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

            resolve({
                duration: metadata.format.duration,
                durationFormatted: formatTime(metadata.format.duration),
                width: videoStream ? videoStream.width : 0,
                height: videoStream ? videoStream.height : 0,
                frameRate: videoStream ? eval(videoStream.r_frame_rate) : 0,
                codec: videoStream ? videoStream.codec_name : 'unknown',
                audioCodec: audioStream ? audioStream.codec_name : null,
                audioSampleRate: audioStream ? parseInt(audioStream.sample_rate) : 44100,
                bitrate: metadata.format.bit_rate,
                size: metadata.format.size,
                filename: path.basename(filePath)
            });
        });
    });
}

/**
 * Belirtilen zamandan önceki en yakın keyframe zamanını bul
 * @param {string} filePath 
 * @param {number} targetTime 
 * @returns {Promise<number|null>} Keyframe zamanı (saniye) veya null
 */
async function findPreviousKeyframe(filePath, targetTime) {
    const { exec } = require('child_process');

    // Aramaya targetTime'dan daha geriden başla ki kesin bulalım
    // Keyframe aralığı (GOP) genelde 0.5 - 5 sn arasındadır. 
    // 30 sn geriden bakmak güvenlidir.
    const searchDuration = 40;
    const seekStart = Math.max(0, targetTime - 20);

    // ffprobe komutu: Keyframe'lerin zaman damgalarını (PTS Time) csv formatında dök
    // -read_intervals start%+duration
    // Not: Windows'ta path tırnak içinde olmalı.
    const cmd = `"${ffprobePath}" -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pkt_pts_time -read_intervals ${seekStart}%+${searchDuration} -of csv=p=0 "${filePath}"`;

    return new Promise((resolve) => {
        exec(cmd, { timeout: 5000 }, (error, stdout) => {
            if (error) {
                console.warn('Keyframe bulma hatası (ignoring):', error.message);
                resolve(null);
                return;
            }

            try {
                // Zamanları parse et
                const times = stdout.trim().split(/\r?\n/)
                    .map(line => parseFloat(line.trim()))
                    .filter(t => !isNaN(t) && t <= targetTime) // Hedef zamandan öncekiler
                    .sort((a, b) => b - a); // Büyükten küçüğe sırala (en yakını en başta)

                if (times.length > 0) {
                    // console.log(`Keyframe bulundu: ${targetTime}s -> ${times[0]}s`);
                    resolve(times[0]);
                } else {
                    console.warn(`Keyframe bulunamadı (Target: ${targetTime}, Search: ${seekStart}-${seekStart + searchDuration})`);
                    resolve(null);
                }
            } catch (e) {
                console.warn('Keyframe parse hatası:', e);
                resolve(null);
            }
        });
    });
}

// Global GPU encoder cache
let _detectedGpuEncoder = null;
let _gpuDetectionDone = false;

/**
 * GPU encoder tespit et (NVENC, QSV, VideoToolbox)
 * @returns {Promise<string|null>} Encoder adı veya null
 */
async function detectGpuEncoder() {
    if (_gpuDetectionDone) {
        return _detectedGpuEncoder;
    }

    const os = require('os');
    const { execSync } = require('child_process');
    const platform = os.platform();

    // Platform bazlı encoder listesi
    const encoders = [];
    if (platform === 'win32') {
        encoders.push('h264_nvenc', 'h264_qsv', 'h264_amf');
    } else if (platform === 'darwin') {
        encoders.push('h264_videotoolbox');
    } else {
        encoders.push('h264_nvenc', 'h264_vaapi', 'h264_qsv');
    }

    for (const encoder of encoders) {
        try {
            // Encoder'ı test et
            execSync(`"${ffmpegPath}" -f lavfi -i nullsrc=s=256x256:d=1 -c:v ${encoder} -f null -`, {
                timeout: 5000,
                stdio: 'pipe'
            });
            console.log(`GPU Encoder bulundu: ${encoder}`);
            _detectedGpuEncoder = encoder;
            _gpuDetectionDone = true;
            return encoder;
        } catch (e) {
            // Bu encoder çalışmadı, sonrakini dene
        }
    }

    console.log('GPU encoder bulunamadı, CPU (libx264) kullanılacak');
    _gpuDetectionDone = true;
    return null;
}

/**
 * Video kesme işlemi (GPU hızlandırmalı, hızlı preset)
 * @param {string} inputPath - Giriş dosyası
 * @param {string} outputPath - Çıkış dosyası
 * @param {number} startTime - Başlangıç zamanı
 * @param {number} endTime - Bitiş zamanı
 * @param {Function} onProgress - İlerleme callback
 * @param {Function} onLog - Log callback
 */
async function cutVideo(inputPath, outputPath, startTime, endTime, onProgress, options = {}, onLog = null) {
    // Argument shifting: If options is function, it's onLog
    if (typeof options === 'function') {
        onLog = options;
        options = {};
    }
    const duration = endTime - startTime;

    // GPU encoder tespit et
    const gpuEncoder = await detectGpuEncoder();
    const videoCodec = gpuEncoder || 'libx264';
    const sampleRate = options.sampleRate || 44100;

    // Codec'e göre output options
    let outputOptions = [];
    if (gpuEncoder) {
        // GPU encoding - çok hızlı
        if (gpuEncoder.includes('nvenc')) {
            outputOptions = [
                '-preset', 'p4',  // NVENC preset (p1=en hızlı, p7=en kaliteli)
                '-rc', 'vbr',
                '-cq', '23',
                '-ar', String(sampleRate),
                '-ac', '2',
                '-avoid_negative_ts', 'make_zero'
            ];
        } else if (gpuEncoder.includes('qsv')) {
            outputOptions = [
                '-preset', 'veryfast',
                '-global_quality', '23',
                '-ar', String(sampleRate),
                '-ac', '2',
                '-avoid_negative_ts', 'make_zero'
            ];
        } else if (gpuEncoder.includes('videotoolbox')) {
            outputOptions = [
                '-q:v', '65',  // VideoToolbox kalite (0-100)
                '-ar', String(sampleRate),
                '-ac', '2',
                '-avoid_negative_ts', 'make_zero'
            ];
        } else {
            outputOptions = [
                '-preset', 'veryfast',
                '-crf', '23',
                '-ar', String(sampleRate),
                '-ac', '2',
                '-avoid_negative_ts', 'make_zero'
            ];
        }
    } else {
        // CPU encoding - hızlı preset
        outputOptions = [
            '-preset', 'veryfast',  // 'fast' yerine 'veryfast' (~2x hızlı)
            '-crf', '23',
            '-ar', String(sampleRate),
            '-ac', '2',
            '-avoid_negative_ts', 'make_zero'
        ];
    }

    console.log(`Video kesme: ${videoCodec} kullanılıyor (GPU: ${gpuEncoder ? 'EVET' : 'HAYIR'})`);

    // Output seeking for precision (forces decoding)
    // -ss ve -t output options olarak verildiğinde frame-exact kesim yapar.
    // Ancak çok yavaştır. Input seeking (-ss inputtan önce) + Output seeking kombinasyonu en iyisidir.
    // ffmpeg-fluent setStartTime input'a ekler.

    // Strateji: Input seeking ile yakınına git, sonra output seeking ile ince ayar yap?
    // Fluent ffmpeg bunu otomatik yapmayabilir.
    // Basit çözüm: Re-encode yapıyoruz, yani input seeking yeterince hassas olmalı çünkü decoder çalışıyor.
    // "1 sn tekrar" sorunu genelde "Copy" modunda olur. CutVideo re-encode yapıyor.
    // Eğer tekrar varsa, duration hesabı yanlıştır veya safe mode concat sorunu vardır.

    // Hızlandırma: Preset -> ultrafast

    // CPU options update
    if (!gpuEncoder) {
        outputOptions = [
            '-preset', 'ultrafast',  // HIZLI OLMASI İÇİN
            '-crf', '28', // Biraz kalite düşebilir ama hız artar
            '-ar', String(sampleRate),
            '-ac', '2',
            '-avoid_negative_ts', 'make_zero'
        ];
    }

    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(duration)
            .videoCodec(videoCodec)
            .audioCodec('aac')
            .audioFilters([
                `afade=t=in:st=0:d=0.01`,
                `afade=t=out:st=${Math.max(0, duration - 0.01)}:d=0.01`
            ])
            .outputOptions(outputOptions)
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('stderr', (line) => {
                if (onLog) onLog(line);
            })
            .on('end', () => resolve(outputPath))
            .on('error', (err) => {
                // GPU encoding başarısız olursa CPU'ya fallback
                if (gpuEncoder) {
                    console.warn('GPU encoding başarısız, CPU ile deneniyor:', err.message);
                    cutVideoWithCpu(inputPath, outputPath, startTime, endTime, onProgress, options, onLog)
                        .then(resolve)
                        .catch(reject);
                } else {
                    reject(err);
                }
            })
            .run();
    });
}

/**
 * CPU ile video kesme (fallback)
 */
function cutVideoWithCpu(inputPath, outputPath, startTime, endTime, onProgress, options = {}, onLog = null) {
    const duration = endTime - startTime;
    const sampleRate = options.sampleRate || 44100;
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(duration)
            .videoCodec('libx264')
            .audioCodec('aac')
            .audioFilters([
                `afade=t=in:st=0:d=0.01`,
                `afade=t=out:st=${Math.max(0, duration - 0.01)}:d=0.01`
            ])
            .outputOptions([
                '-preset', 'ultrafast', // Fallback'te de hızlı olsun
                '-crf', '28',
                '-ar', String(sampleRate),
                '-ac', '2',
                '-avoid_negative_ts', 'make_zero'
            ])
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('stderr', (line) => {
                if (onLog) onLog(line);
            })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * Hızlı video kesme işlemi (stream copy - re-encode YOK)
 * Çok hızlı ama kesim noktaları keyframe'lere snap olabilir
 * @param {string} inputPath - Giriş dosyası
 * @param {string} outputPath - Çıkış dosyası
 * @param {number} startTime - Başlangıç zamanı (saniye)
 * @param {number} endTime - Bitiş zamanı (saniye)
 * @param {Function} onProgress - İlerleme callback
 */
function cutVideoFast(inputPath, outputPath, startTime, endTime, onProgress) {
    const duration = endTime - startTime;
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            // -ss inputtan önce = daha hızlı seek (keyframe'e snap olabilir)
            .inputOptions([`-ss ${startTime}`])
            .setDuration(duration)
            // Stream copy - re-encode yapmadan kopyala
            .videoCodec('copy')
            .audioCodec('copy')
            .outputOptions([
                '-avoid_negative_ts', 'make_zero',
                '-movflags', '+faststart'
            ])
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => resolve(outputPath))
            .on('error', (err) => {
                console.error('cutVideoFast hatası, re-encode ile deneniyor:', err.message);
                // Stream copy başarısız olursa normal kesime fallback
                cutVideo(inputPath, outputPath, startTime, endTime, onProgress)
                    .then(resolve)
                    .catch(reject);
            })
            .run();
    });
}

/**
 * SMART CUT - Sadece kesim noktalarını re-encode et
 * 
 * Strateji:
 * 1. Başlangıç kesim noktası etrafında (~2 sn) re-encode
 * 2. Ortadaki kısım stream copy (çok hızlı)
 * 3. Bitiş kesim noktası etrafında (~2 sn) re-encode
 * 4. Üç parçayı birleştir
 * 
 * Bu sayede 145 dakikalık videodan 5 saniye kesmek için
 * sadece ~4 saniyelik kısım re-encode edilir, geri kalan stream copy.
 * 
 * @param {string} inputPath - Giriş dosyası
 * @param {string} outputPath - Çıkış dosyası
 * @param {number} startTime - Başlangıç zamanı
 * @param {number} endTime - Bitiş zamanı
 * @param {Object} options - { reencodeMargin: saniye }
 * @param {Function} onProgress - İlerleme callback
 */
/**
 * PRECISE SMART CUT
 * Kesin Keyframe Tespiti ile Hatasız Kesim
 */
async function cutVideoSmart(inputPath, outputPath, startTime, endTime, options = {}, onProgress, onLog = null) {
    const fs = require('fs');
    const duration = endTime - startTime;

    // Minimum güvenli süre (Çok kısa videolarda fallback)
    if (duration < 5) {
        return cutVideo(inputPath, outputPath, startTime, endTime, onProgress);
    }

    const tempDir = path.dirname(outputPath);
    const timestamp = Date.now();
    const tempFiles = [];

    // Margin: Re-encode edilecek güvenlik payı (saniye)
    const margin = 5;

    try {
        // 1. Metadata ve Sample Rate
        const inputMeta = await getVideoMetadata(inputPath);
        const sampleRate = inputMeta.audioSampleRate || 44100;
        const encodeOptions = { sampleRate };

        console.log(`Smart Cut (Precise): ${startTime}-${endTime} (Süre: ${duration}s) | SampleRate: ${sampleRate}`);

        // 2. Kritik Nokta: P2 (Copy) parçasının başlangıcını belirleyecek KEYFRAME'i bul
        const targetPart2Start = startTime + margin;

        // Keyframe'i bul (targetPart2Start'tan önceki en son keyframe)
        const keyframeTime = await findPreviousKeyframe(inputPath, targetPart2Start);

        // Eğer keyframe bulunamazsa veya çok gerideyse fallback yap
        // (Örneğin keyframe yoksa veya start'tan bile gerideyse)
        if (keyframeTime === null || keyframeTime < startTime) {
            console.log('Uygun keyframe bulunamadı, tam re-encode yapılıyor.');
            return cutVideo(inputPath, outputPath, startTime, endTime, onProgress);
        }

        // --- PLANLAMA ---
        // P1 (Re-encode): startTime -> keyframeTime
        // P2 (Copy): keyframeTime -> targetPart2End (targetPart2End = endTime - margin)
        // P3 (Re-encode): targetPart2End -> endTime

        const targetPart2End = endTime - margin;
        // Eğer keyframe, bitişe çok yakınsa P2 oluşturmaya değmez, P1+P3 birleşebilir veya direkt re-encode.
        if (keyframeTime >= targetPart2End) {
            console.log('Keyframe bitişe çok yakın, tam re-encode.');
            return cutVideo(inputPath, outputPath, startTime, endTime, onProgress);
        }

        // --- PART 1: BAŞLANGIÇ (Re-encode) ---
        // startTime'dan keyframeTime'a kadar.
        const part1Path = path.join(tempDir, `sc_p1_${timestamp}.mp4`);
        // Eğer keyframeTime ile startTime çok yakınsa (0.1sn), P1'e gerek yok
        if (keyframeTime - startTime > 0.1) {
            console.log(`Smart Cut P1: ${startTime} -> ${keyframeTime} (Re-encode)`);
            if (onProgress) onProgress(p * 0.15);
        }, encodeOptions, onLog);
        tempFiles.push(part1Path);
    }

        // --- PART 2: ORTA (Stream Copy) ---
        // keyframeTime'dan targetPart2End'e kadar.
        // Copy olduğu için start (keyframeTime) tam oturacak.
        const part2Duration = targetPart2End - keyframeTime;
    const part2Path = path.join(tempDir, `sc_p2_${timestamp}.mp4`);
    console.log(`Smart Cut P2: ${keyframeTime} -> ${targetPart2End} (Copy, ${part2Duration.toFixed(2)}s)`);

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .inputOptions([`-ss ${keyframeTime}`]) // Keyframe'e tam seek yapar (çünkü keyframe zamanını veriyoruz)
            .inputOptions([`-t ${part2Duration}`]) // Süre kadar al
            .videoCodec('copy')
            .audioCodec('copy')
            .output(part2Path)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
    tempFiles.push(part2Path);

    // --- PART 3: BİTİŞ (Re-encode) ---
    // targetPart2End'den endTime'a kadar.
    // P2 şurada bitti: keyframeTime + part2Duration = targetPart2End.
    // Yani P3 tam buradan başlamalı.
    const part3Path = path.join(tempDir, `sc_p3_${timestamp}.mp4`);
    if (endTime - targetPart2End > 0.1) {
        console.log(`Smart Cut P3: ${targetPart2End} -> ${endTime} (Re-encode)`);
        await cutVideo(inputPath, part3Path, targetPart2End, endTime, (p) => {
            if (onProgress) onProgress(80 + p * 0.15);
        }, encodeOptions, onLog);
        tempFiles.push(part3Path);
    }

    // --- BİRLEŞTİRME ---
    console.log(`Smart Cut: ${tempFiles.length} parça birleştiriliyor...`);
    await concatenateVideosFast(tempFiles, outputPath, (p) => {
        if (onProgress) onProgress(95 + p * 0.05);
    });

    // Temizlik
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
    return outputPath;

} catch (error) {
    console.error('Smart Cut hatası:', error.message);
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
    // Fallback
    return cutVideo(inputPath, outputPath, startTime, endTime, onProgress);
}
}

/**
 * Timeline segmentleri için optimize edilmiş kesim
 * Her zaman yeni Adaptive Smart Cut kullanır (en güvenilir ve hızlı yöntem)
 */
async function cutVideoOptimized(inputPath, outputPath, startTime, endTime, isFirstSegment, isLastSegment, onProgress) {
    // Yeni Adaptive Smart Cut her durumu (başlangıç, bitiş, orta) otomatik halleder
    // Çünkü neresi re-encode gerektiriyorsa orayı re-encode eder, gerisini kopyalar
    return cutVideoSmart(inputPath, outputPath, startTime, endTime, {}, onProgress);
}

/**
 * Sadece başlangıcı re-encode eden smart cut
 */
async function smartCutStart(inputPath, outputPath, startTime, endTime, margin, onProgress) {
    const fs = require('fs');
    const tempDir = path.dirname(outputPath);
    const timestamp = Date.now();
    const tempFiles = [];

    try {
        const inputMeta = await getVideoMetadata(inputPath);
        const sampleRate = inputMeta.audioSampleRate || 44100;
        const encodeOptions = { sampleRate };

        // P2 (Copy) başlangıcı için keyframe bul
        const targetP2Start = startTime + margin;
        const keyframeTime = await findPreviousKeyframe(inputPath, targetP2Start);

        if (keyframeTime === null || keyframeTime < startTime) {
            // Keyframe yoksa normal kes
            return cutVideo(inputPath, outputPath, startTime, endTime, onProgress);
        }

        // P1: Re-encode (Start -> Keyframe)
        const part1Path = path.join(tempDir, `sc_start_${timestamp}.mp4`);
        if (keyframeTime > startTime + 0.1) {
            await cutVideo(inputPath, part1Path, startTime, keyframeTime, (p) => {
                if (onProgress) onProgress(p * 0.3);
            }, encodeOptions);
            tempFiles.push(part1Path);
        }

        // P2: Copy (Keyframe -> End)
        // Süre: endTime - keyframeTime
        const part2Duration = endTime - keyframeTime;
        if (part2Duration > 0.5) {
            const part2Path = path.join(tempDir, `sc_rest_${timestamp}.mp4`);
            await new Promise((resolve, reject) => {
                ffmpeg(inputPath)
                    .inputOptions([`-ss ${keyframeTime}`]) // Keyframe seek
                    .inputOptions([`-t ${part2Duration}`])
                    .videoCodec('copy')
                    .audioCodec('copy')
                    .output(part2Path)
                    .on('progress', (p) => { if (onProgress) onProgress(30 + (p.percent || 0) * 0.5); })
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
            tempFiles.push(part2Path);
        }

        // Birleştir (Eğer sadece P2 varsa da sorun değil)
        if (tempFiles.length === 0) return cutVideo(inputPath, outputPath, startTime, endTime, onProgress);

        await concatenateVideosFast(tempFiles, outputPath, (p) => {
            if (onProgress) onProgress(80 + p * 0.2);
        });

        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
        return outputPath;
    } catch (e) {
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e2) { } });
        return cutVideo(inputPath, outputPath, startTime, endTime, onProgress);
    }
}


/**
 * Sadece bitişi re-encode eden smart cut
 */
async function smartCutEnd(inputPath, outputPath, startTime, endTime, margin, onProgress) {
    const fs = require('fs');
    const tempDir = path.dirname(outputPath);
    const timestamp = Date.now();
    const tempFiles = [];
    const gapDuration = 0.5; // Frame tekrarını önlemek için (keyframe aralığından büyük)

    try {
        const inputMeta = await getVideoMetadata(inputPath);
        const sampleRate = inputMeta.audioSampleRate || 44100;
        const encodeOptions = { sampleRate };

        const part1End = endTime - margin - gapDuration;

        // Parça 1: Başlangıç (stream copy)
        if (part1End > startTime + 0.1) {
            const part1Path = path.join(tempDir, `sc_first_${timestamp}.mp4`);
            await new Promise((resolve, reject) => {
                ffmpeg(inputPath)
                    .setStartTime(startTime)
                    .setDuration(part1End - startTime)
                    .videoCodec('copy')
                    .audioCodec('copy')
                    .outputOptions([
                        '-avoid_negative_ts', 'make_zero',
                        '-fflags', '+genpts'
                    ])
                    .output(part1Path)
                    .on('progress', (p) => { if (onProgress) onProgress((p.percent || 0) * 0.5); })
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
            tempFiles.push(part1Path);
        }

        // Parça 2: Bitiş (re-encode)
        const part2Start = tempFiles.length > 0 ? part1End + gapDuration : startTime;
        const part2Path = path.join(tempDir, `sc_end_${timestamp}.mp4`);
        await cutVideo(inputPath, part2Path, part2Start, endTime, (p) => {
            if (onProgress) onProgress(50 + p * 0.3);
        }, encodeOptions);
        tempFiles.push(part2Path);

        // Birleştir
        await concatenateVideosFast(tempFiles, outputPath, (p) => {
            if (onProgress) onProgress(80 + p * 0.2);
        });

        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
        return outputPath;
    } catch (e) {
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e2) { } });
        return cutVideo(inputPath, outputPath, startTime, endTime, onProgress);
    }
}

/**

 * Videoları birleştir (farklı özellikleri normalize ederek)
 * Tüm videoları aynı çözünürlük, fps, codec'e dönüştürüp birleştirir
 */
function concatenateVideos(inputPaths, outputPath, onProgress, onLog = null) {
    return new Promise(async (resolve, reject) => {
        try {
            const fs = require('fs');
            const tempDir = path.dirname(outputPath);
            const timestamp = Date.now();

            // Hedef özellikler (ilk videodan al veya varsayılan kullan)
            let targetWidth = 1920;
            let targetHeight = 1080;
            let targetFps = 30;

            // İlk videonun özelliklerini al
            try {
                const firstMeta = await getVideoMetadata(inputPaths[0]);
                if (firstMeta) {
                    targetWidth = firstMeta.width || 1920;
                    targetHeight = firstMeta.height || 1080;
                    targetFps = firstMeta.frameRate || 30;
                }
            } catch (e) {
                console.log('İlk video metadata alınamadı, varsayılan değerler kullanılacak');
            }

            console.log(`Birleştirme hedef özellikleri: ${targetWidth}x${targetHeight} @ ${targetFps}fps`);

            // Her videoyu normalize et
            const normalizedPaths = [];

            // GPU encoder tespiti (Daha önce yapılmadıysa)
            const gpuEncoder = await detectGpuEncoder();
            const videoCodec = gpuEncoder || 'libx264';

            // Codec options
            let outputOpts = [];
            if (gpuEncoder) {
                if (gpuEncoder.includes('nvenc')) {
                    outputOpts = ['-preset', 'p2', '-rc', 'vbr', '-cq', '28']; // Hızlı preset
                } else if (gpuEncoder.includes('qsv')) {
                    outputOpts = ['-preset', 'veryfast', '-global_quality', '28'];
                } else if (gpuEncoder.includes('videotoolbox')) {
                    outputOpts = ['-q:v', '60'];
                }
            } else {
                // CPU
                outputOpts = ['-preset', 'ultrafast', '-crf', '28'];
            }

            // Audio & Filter options
            outputOpts = outputOpts.concat([
                '-r', String(targetFps),
                '-vf', `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
                '-ar', '44100',
                '-ac', '2'
            ]);

            for (let i = 0; i < inputPaths.length; i++) {
                const inputPath = inputPaths[i];
                const normalizedPath = path.join(tempDir, `normalized_${i}_${timestamp}.mp4`);

                await new Promise((res, rej) => {
                    ffmpeg(inputPath)
                        .videoCodec(videoCodec)
                        .audioCodec('aac')
                        .outputOptions(outputOpts)
                        .output(normalizedPath)
                        .on('end', () => {
                            console.log(`Video ${i + 1}/${inputPaths.length} normalize edildi`);
                            res();
                        })
                        .on('error', (err) => {
                            console.error(`Video ${i + 1} normalize hatası:`, err);
                            rej(err);
                        })
                        .on('stderr', (line) => {
                            if (onLog) onLog(line);
                        })
                        .run();
                });

                normalizedPaths.push(normalizedPath);

                if (onProgress) {
                    onProgress((i + 1) / (inputPaths.length + 1) * 80);
                }
            }

            // Concat demuxer için dosya listesi oluştur
            const listPath = path.join(tempDir, `concat_list_${timestamp}.txt`);
            const listContent = normalizedPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
            fs.writeFileSync(listPath, listContent);

            console.log('Concat listesi oluşturuldu:', listPath);

            // Concat demuxer ile birleştir
            await new Promise((res, rej) => {
                ffmpeg()
                    .input(listPath)
                    .inputOptions(['-f', 'concat', '-safe', '0'])
                    .outputOptions(['-c', 'copy'])
                    .output(outputPath)
                    .on('progress', (progress) => {
                        if (onProgress) onProgress(80 + (progress.percent || 0) * 0.2);
                    })
                    .on('end', () => {
                        console.log('Birleştirme tamamlandı:', outputPath);

                        // Geçici dosyaları temizle
                        try {
                            fs.unlinkSync(listPath);
                            normalizedPaths.forEach(p => {
                                try { fs.unlinkSync(p); } catch (e) { }
                            });
                        } catch (e) { }

                        res();
                    })
                    .on('error', rej)
                    .on('stderr', (line) => {
                        if (onLog) onLog(line);
                    })
                    .run();
            });

            resolve(outputPath);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Hızlı video birleştirme (stream copy - re-encode YOK)
 * Tüm videolar aynı codec ve özelliklerde olmalı
 * Çok hızlı - büyük dosyalar için ideal
 */
function concatenateVideosFast(inputPaths, outputPath, onProgress, onLog = null) {
    return new Promise(async (resolve, reject) => {
        // --- CHUNKING STRATEGY (Optimization for 50+ segments) ---
        // Çok sayıda (örn: 100+) parçayı tek seferde birleştirmek bellek ve dosya limiti sorunlarına
        // yol açabildiği için, güvenli bir "böl ve yönet" (chunking) stratejisi uyguluyoruz.
        const CHUNK_SIZE = 25;
        if (inputPaths.length > CHUNK_SIZE) {
            // Sadece bu scope'ta geçerli değişkenler
            let chunkFiles = [];
            const fs = require('fs'); // Scope içinde require

            try {
                console.log(`[Smart Merge] Yüksek parça sayısı tespit edildi (${inputPaths.length}). Güvenli parçalı birleştirme uygulanıyor...`);
                const tempDir = path.dirname(outputPath);
                const timestamp = Date.now();

                // 1. Listeyi ufak gruplara böl ve her birini birleştir (Recursive)
                for (let i = 0; i < inputPaths.length; i += CHUNK_SIZE) {
                    const chunk = inputPaths.slice(i, i + CHUNK_SIZE);
                    const chunkIndex = Math.floor(i / CHUNK_SIZE) + 1;
                    const chunkPath = path.join(tempDir, `temp_chunk_${timestamp}_${chunkIndex}.mp4`);

                    // İlerleme takibi
                    const startPercent = (i / inputPaths.length) * 100;
                    const endPercent = ((i + chunk.length) / inputPaths.length) * 100;

                    // Recursive çağrı: Grubu birleştir
                    await concatenateVideosFast(chunk, chunkPath, (p) => {
                        const currentTotal = startPercent + (p * (endPercent - startPercent) / 100);
                        if (onProgress) onProgress(currentTotal);
                    });

                    chunkFiles.push(chunkPath);
                }

                // 2. Oluşan ara parçalar listesini (chunkFiles) son birleştirmeye sok
                console.log(`[Smart Merge] ${chunkFiles.length} ara parça birleştiriliyor...`);
                await concatenateVideosFast(chunkFiles, outputPath, (p) => {
                    // Son aşama çok hızlıdır, %99'da tutabilir veya direkt bitirebiliriz
                    if (onProgress) onProgress(99);
                });

                // 3. Başarılı oldu, ara dosyaları temizle
                chunkFiles.forEach(f => {
                    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { }
                });

                console.log('[Smart Merge] Parçalı birleştirme başarıyla tamamlandı.');
                resolve(outputPath);
                return; // Standart akışı atla

            } catch (chunkError) {
                console.warn('[Smart Merge] Parçalı işlemde hata, standart yönteme (tek seferde) geri dönülüyor:', chunkError.message);

                // Ara dosyaları temizle
                if (chunkFiles && chunkFiles.length > 0) {
                    chunkFiles.forEach(f => {
                        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { }
                    });
                }

                // Hata durumunda aşağıdaki standart akışa devam et (fallback)
            }
        }
        // -------------------------------------------------------------

        try {
            const fs = require('fs');
            const tempDir = path.dirname(outputPath);
            const timestamp = Date.now();
            const listPath = path.join(tempDir, `concat_list_${timestamp}.txt`);

            // concat demuxer için dosya listesi oluştur
            const listContent = inputPaths
                .map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
                .join('\n');

            fs.writeFileSync(listPath, listContent);
            console.log('Hızlı Concat list:', listPath);

            // Stream copy ile birleştir
            await new Promise((res, rej) => {
                ffmpeg()
                    .input(listPath)
                    .inputOptions(['-f', 'concat', '-safe', '0'])
                    .videoCodec('copy')
                    .audioCodec('copy')
                    .outputOptions(['-movflags', '+faststart'])
                    .output(outputPath)
                    .on('progress', (progress) => {
                        if (onProgress) onProgress(progress.percent || 0);
                    })
                    .on('end', () => {
                        console.log('Hızlı birleştirme tamamlandı:', outputPath);
                        try { fs.unlinkSync(listPath); } catch (e) { }
                        res();
                    })
                    .on('error', (err) => {
                        console.error('Hızlı birleştirme hatası:', err.message);
                        try { fs.unlinkSync(listPath); } catch (e) { }
                        rej(err);
                    })
                    .on('stderr', (line) => {
                        if (onLog) onLog(line);
                    })
                    .run();
            });

            resolve(outputPath);
        } catch (error) {
            console.error('concatenateVideosFast hatası, normal birleştirmeye fallback:', error.message);
            // Hata olursa normal birleştirmeye düş
            try {
                await concatenateVideos(inputPaths, outputPath, onProgress, onLog);
                resolve(outputPath);
            } catch (fallbackError) {
                reject(fallbackError);
            }
        }
    });
}

/**
 * Videoyu döndür

 */
function rotateVideo(inputPath, outputPath, degrees, onProgress) {
    return new Promise((resolve, reject) => {
        let transpose;
        switch (degrees) {
            case 90:
                transpose = 'transpose=1'; // Saat yönünde
                break;
            case -90:
            case 270:
                transpose = 'transpose=2'; // Saat yönü tersine
                break;
            case 180:
                transpose = 'transpose=1,transpose=1'; // 180 derece
                break;
            default:
                reject(new Error('Geçersiz döndürme açısı'));
                return;
        }

        ffmpeg(inputPath)
            .videoFilters(transpose)
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * Sadece ses çıkar
 */
function extractAudio(inputPath, outputPath, onProgress) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .noVideo()
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * Sadece video çıkar (sessiz)
 */
function extractVideo(inputPath, outputPath, onProgress) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .noAudio()
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * Ses ekle/karıştır
 */
function mixAudio(videoPath, audioPath, outputPath, videoVolume, audioVolume, onProgress) {
    return new Promise((resolve, reject) => {
        // 1. Önce videonun ses özelliklerini (Sample Rate) öğren
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                return reject(new Error('Video analizi başarısız: ' + err.message));
            }

            // Ses akışı ve sample rate
            const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
            const hasAudio = !!audioStream;
            // Varsayılan 48000, varsa videonunkini al
            const sampleRate = audioStream ? parseInt(audioStream.sample_rate) : 48000;

            console.log(`Mix işlemi: Video Sample Rate tespit edildi: ${sampleRate}Hz`);

            const command = ffmpeg().input(videoPath).input(audioPath);

            if (hasAudio) {
                // Video sesi varsa: Mix yap
                command
                    .complexFilter([
                        `[0:a]volume=${videoVolume},aformat=sample_rates=${sampleRate}[a0]`,
                        `[1:a]volume=${audioVolume},aresample=${sampleRate},aformat=sample_rates=${sampleRate}[a1]`,
                        `[a0][a1]amix=inputs=2:duration=first:dropout_transition=2,volume=2[aout]`
                    ])
                    .outputOptions([
                        '-map', '0:v',
                        '-map', '[aout]',
                        '-c:v', 'copy',
                        '-c:a', 'aac',
                        '-ar', String(sampleRate),
                        '-shortest'
                    ]);
            } else {
                // Video sesi yoksa: Sadece yeni sesi ekle ama sample rate'i yine de ayarla
                command
                    .outputOptions([
                        '-map', '0:v',
                        '-map', '1:a',
                        '-c:v', 'copy',
                        '-c:a', 'aac',
                        '-ar', String(sampleRate),
                        '-shortest'
                    ]);

                let audioFilters = [];
                if (audioVolume !== 1.0) audioFilters.push(`volume=${audioVolume}`);
                audioFilters.push(`aresample=${sampleRate}`);

                if (audioFilters.length > 0) {
                    command.audioFilters(audioFilters);
                }
            }

            command
                .output(outputPath)
                .on('progress', (progress) => {
                    if (onProgress) onProgress(progress.percent);
                })
                .on('end', () => resolve(outputPath))
                .on('error', (err) => {
                    console.error('Mix hatası:', err);
                    reject(new Error('Birleştirme hatası: ' + err.message));
                })
                .run();
        });
    });
}

/**
 * Altyazı yak
 */
function burnSubtitles(videoPath, subtitlePath, outputPath, onProgress) {
    return new Promise((resolve, reject) => {
        // Windows için yol düzeltmesi
        const escapedSubPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');

        ffmpeg(videoPath)
            .videoCodec('libx264')
            .audioCodec('aac')
            .videoFilters(`subtitles='${escapedSubPath}'`)
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * Metin overlay ekle (gelişmiş)
 */
function addTextOverlay(videoPath, outputPath, text, options, onProgress) {
    return new Promise((resolve, reject) => {
        const {
            font = 'arial',
            fontSize = 48,
            fontColor = 'white',
            background = 'none',
            position = 'bottom',
            transition = 'none',
            startTime = 0,
            endTime = null
        } = options;

        // Font dosyası yolu (Windows)
        const fontFiles = {
            arial: 'C\\:/Windows/Fonts/arial.ttf',
            times: 'C\\:/Windows/Fonts/times.ttf',
            verdana: 'C\\:/Windows/Fonts/verdana.ttf',
            georgia: 'C\\:/Windows/Fonts/georgia.ttf',
            tahoma: 'C\\:/Windows/Fonts/tahoma.ttf'
        };
        const fontFile = fontFiles[font] || fontFiles.arial;

        // Konum hesapla (x ve y)
        let x, y;
        const padding = 30;

        // Varsayılan değerler
        if (!position) position = 'bottom-center';

        // Eski tip 'top', 'bottom', 'center' uyumluluğu
        if (position === 'top') position = 'top-center';
        if (position === 'bottom') position = 'bottom-center';

        // Y ekseni (Dikey)
        if (position.startsWith('top')) {
            y = padding;
        } else if (position.startsWith('middle') || position === 'center' || position.startsWith('center')) {
            y = '(h-th)/2';
        } else { // bottom
            y = `h-th-${padding}`;
        }

        // X ekseni (Yatay)
        if (position.endsWith('left')) {
            x = padding;
        } else if (position.endsWith('right')) {
            x = `w-tw-${padding}`;
        } else { // center
            x = '(w-tw)/2';
        }

        // Metni escape et (özel karakterler ve yeni satırlar)
        const safeText = (text || '').toString();
        const escapedText = safeText
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "'\\'")
            .replace(/:/g, '\\:')
            .replace(/\n/g, '\\n');

        // Drawtext filtresi oluştur
        let drawtextFilter = `drawtext=text='${escapedText}':fontfile='${fontFile}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${x}:y=${y}`;

        // Arka plan (box) ekle
        if (background !== 'none') {
            let boxColor;
            switch (background) {
                case 'black': // Tam siyah
                    boxColor = 'black';
                    break;
                case 'black@0.5': // Yarı saydam siyah
                    boxColor = 'black@0.5';
                    break;
                case 'white': // Tam beyaz
                    boxColor = 'white';
                    break;
                case 'white@0.5': // Yarı saydam beyaz
                    boxColor = 'white@0.5';
                    break;
                default:
                    boxColor = null;
            }
            if (boxColor) {
                drawtextFilter += `:box=1:boxcolor=${boxColor}:boxborderw=10`;
            }
        }

        // Gölge (shadow) ekle
        const shadow = options.shadow || 'none';
        if (shadow !== 'none') {
            let shadowOffset = 0;
            switch (shadow) {
                case 'small': shadowOffset = 2; break;
                case 'medium': shadowOffset = 4; break;
                case 'large': shadowOffset = 7; break;
            }
            if (shadowOffset > 0) {
                drawtextFilter += `:shadowx=${shadowOffset}:shadowy=${shadowOffset}:shadowcolor=black@0.8`;
            }
        }

        // Zamanlama (enable)
        if (endTime !== null && endTime > startTime) {
            if (transition === 'fade') {
                // Fade in/out efekti - alpha ile
                const fadeInEnd = startTime + 0.5;
                const fadeOutStart = endTime - 0.5;
                drawtextFilter += `:alpha='if(lt(t\\,${startTime})\\,0\\,if(lt(t\\,${fadeInEnd})\\,(t-${startTime})/0.5\\,if(lt(t\\,${fadeOutStart})\\,1\\,if(lt(t\\,${endTime})\\,(${endTime}-t)/0.5\\,0))))'`;
            } else {
                // Anında görün/kaybol
                drawtextFilter += `:enable='between(t,${startTime},${endTime})'`;
            }
        }

        console.log('Drawtext filter:', drawtextFilter);

        // Önce videonun ses özelliklerini kontrol et
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                console.error('Probe Hatası:', err);
                // Probe hatası olsa bile varsayılan deneme yapalım (ses varmış gibi)
                runFfmpeg(true);
                return;
            }

            const hasAudio = metadata.streams.some(s => s.codec_type === 'audio');
            console.log('Video Audio Durumu:', hasAudio ? 'Ses Var' : 'Ses Yok');

            runFfmpeg(hasAudio);
        });

        // TTS İşlemleri ve FFmpeg Çalıştırma
        const runFfmpeg = async (hasAudio) => {
            let command = ffmpeg(videoPath);
            const complexFilters = [];

            // Video filtresi: [0:v] -> drawtext -> [outv]
            complexFilters.push(`[0:v]${drawtextFilter}[outv]`);

            let audioOutputMap = null;
            // Eğer TTS yoksa ve ses varsa, orijinal sesi kullan
            if (!options.ttsEnabled && hasAudio) {
                audioOutputMap = '0:a';
            }

            let ttsTempPath = null;

            // TTS aktifse
            if (options.ttsEnabled) {
                try {
                    const ttsHandler = require('./tts-handler');
                    const ttsText = text; // Seslendirilecek metin
                    const ttsVoice = options.ttsVoice || null;
                    const ttsSpeed = options.ttsSpeed || 1.0;
                    const ttsVolume = (options.ttsVolume !== undefined) ? options.ttsVolume * 100 : 100; // 0-100 arası
                    const mixVideoVol = (options.videoVolume !== undefined) ? options.videoVolume : 1.0;

                    console.log('TTS Generasyon Başlıyor:', { ttsText, ttsVoice, ttsSpeed, ttsVolume });

                    ttsTempPath = ttsHandler.getTempWavPath();
                    await ttsHandler.textToWav(ttsText, ttsVoice, ttsSpeed, ttsTempPath, ttsVolume);

                    // TTS sesini input olarak ekle (Input 1)
                    command.input(ttsTempPath);

                    const startTimeMs = Math.round(startTime * 1000);

                    if (hasAudio) {
                        // Video sesi var, TTS ile karıştır
                        // [0:a] -> volume -> [original_a]
                        // [1:a] -> adelay -> [tts_a]
                        // [original_a][tts_a] -> amix -> [outa]

                        let audioFilter = `[0:a]volume=${mixVideoVol}[original_a];[1:a]adelay=${startTimeMs}|${startTimeMs}[tts_a];[original_a][tts_a]amix=inputs=2:duration=first:dropout_transition=0,volume=2[outa]`;
                        complexFilters.push(audioFilter);
                        audioOutputMap = '[outa]';
                    } else {
                        // Video sesi yok, sadece TTS sesi
                        // [1:a] -> adelay -> [outa]

                        let audioFilter = `[1:a]adelay=${startTimeMs}|${startTimeMs}[outa]`;
                        complexFilters.push(audioFilter);
                        audioOutputMap = '[outa]';
                    }

                } catch (err) {
                    console.error("TTS Mix Hatası (yoksayılıyor, orijinal ses kullanılacak):", err);
                    if (ttsTempPath) { try { require('fs').unlinkSync(ttsTempPath); } catch (e) { } }
                    ttsTempPath = null;

                    // Fallback: TTS başarısızsa ve ses varsa orijinali kullan
                    if (hasAudio) audioOutputMap = '0:a';
                }
            }

            command.complexFilter(complexFilters);

            // Mapping işlemleri - outputOptions ile daha güvenli
            const outputMaps = ['-map', '[outv]']; // Video her zaman var

            if (audioOutputMap) {
                outputMaps.push('-map', audioOutputMap);
            }

            command.outputOptions(outputMaps);

            command
                .videoCodec('libx264')
                .audioCodec('aac')
                .output(outputPath)
                .on('start', (cmd) => console.log('FFmpeg cmd (Final):', cmd))
                .on('progress', (progress) => {
                    if (onProgress) onProgress(progress.percent);
                })
                .on('end', () => {
                    console.log('İşlem tamamlandı.');
                    if (ttsTempPath) {
                        try { require('fs').unlinkSync(ttsTempPath); } catch (e) { }
                    }
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('FFmpeg Hatası:', err);
                    if (ttsTempPath) {
                        try { require('fs').unlinkSync(ttsTempPath); } catch (e) { }
                    }
                    reject(err);
                })
                .run();
        };
    });
}

/**
 * Görsel(ler)den video oluştur
 */
function createVideoFromImages(imagePaths, outputPath, duration, onProgress) {
    return new Promise((resolve, reject) => {
        // Geçici dosya listesi oluştur
        const listPath = path.join(path.dirname(outputPath), 'images.txt');
        const listContent = imagePaths.map(img =>
            `file '${img.replace(/\\/g, '/')}'\nduration ${duration}`
        ).join('\n');

        fs.writeFileSync(listPath, listContent);

        ffmpeg()
            .input(listPath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions(['-pix_fmt', 'yuv420p'])
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => {
                fs.unlinkSync(listPath); // Geçici dosyayı sil
                resolve(outputPath);
            })
            .on('error', (err) => {
                fs.unlinkSync(listPath);
                reject(err);
            })
            .run();
    });
}

/**
 * Videoya ses dosyası mixle (belirli bir zamanda)
 */
function mixAudio({ videoPath, audioPath, outputPath, videoVolume = 1.0, audioVolume = 1.0, insertTime = 0, audioTrimStart = 0, audioTrimEnd = 0, loopAudio = false }, onProgress) {
    return new Promise((resolve, reject) => {
        // Önce videonun ses akışı var mı kontrol et
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) return reject(err);

            const hasAudio = metadata.streams.some(s => s.codec_type === 'audio');
            const videoDuration = metadata.format.duration;
            const insertTimeMs = Math.round(insertTime * 1000);

            let command = ffmpeg()
                .input(videoPath)
                .input(audioPath);

            const complexFilters = [];

            // Ses işleme
            // [1:a] -> trim/loop/volume -> [processed_audio]
            // loop durumunda stream_loop kullanılır ama amix ile sorun olabilir,
            // basit trim ve volume işlemlerini yapalım.

            // Eğer audio trim gerekliyse veya loop varsa input options kullanmak daha iyidir ama
            // complex filter ile de yapılabilir.

            // Basit implementasyon:
            // [1:a] -> adelay -> volume -> [delayed_audio]
            // [0:a] -> volume -> [video_audio]
            // [video_audio][delayed_audio] -> amix -> [outa]

            // NOT: adelay filtresi ms cinsinden değer alır.
            // Ayrıca adelay eğer input mono ise tek parametre, stereo ise "L|R" şeklinde parametre alabilir.
            // Güvenli olması için: adelay=TIMEOUT|TIMEOUT

            // Audio trim işlemleri (Eğer varsa)
            // atrim filtresi kullanılabilir: [1:a]atrim=start=X:end=Y,asetpts=PTS-STARTPTS[trimmed]

            let inputAudioLabel = '1:a';

            // Trim varsa
            if (audioTrimStart > 0 || audioTrimEnd > 0) {
                let trimFilter = `[${inputAudioLabel}]atrim=start=${audioTrimStart}`;
                if (audioTrimEnd > 0 && audioTrimEnd > audioTrimStart) {
                    trimFilter += `:end=${audioTrimEnd}`;
                }
                trimFilter += `,asetpts=PTS-STARTPTS[trimmed]`;
                complexFilters.push(trimFilter);
                inputAudioLabel = 'trimmed';
            }

            // Loop varsa (ffmpeg -stream_loop input option daha iyidir ama duration kısıtı gerekir)
            // Şimdilik loop'u atlıyoruz veya basitçe aloop filtresi (ffmpeg 4.x+) kullanıyoruz
            // [trimmed]aloop=loop=-1:size=2e+09[looped]
            if (loopAudio) {
                complexFilters.push(`[${inputAudioLabel}]aloop=loop=-1:size=2147483647[looped]`);
                inputAudioLabel = 'looped';
            }

            // Delay ve Volume
            complexFilters.push(`[${inputAudioLabel}]adelay=${insertTimeMs}|${insertTimeMs},volume=${audioVolume}[delayed_audio]`);

            let audioOutputMap = '';

            if (hasAudio) {
                // Video sesi var, mixle
                complexFilters.push(`[0:a]volume=${videoVolume}[video_audio]`);
                // duration=first: Video süresince. dropout_transition=0: ses kesilmelerinde yumuşak geçiş olmasın
                complexFilters.push(`[video_audio][delayed_audio]amix=inputs=2:duration=first:dropout_transition=0,volume=2[outa]`);
                audioOutputMap = '[outa]';
            } else {
                // Video sesi yok, sadece yeni ses (ama video süresince kesilmeli)
                // apad ile video sonuna kadar uzatılabilir veya atrim ile kesilebilir.
                // Basitçe [delayed_audio] verelim, codec süreyi videoya uydurur mu?
                // Genelde video süresi kadar encode eder.
                audioOutputMap = '[delayed_audio]';
            }

            command.complexFilter(complexFilters);

            const outputMaps = ['-map', '0:v']; // Görüntüyü 0'dan al
            if (audioOutputMap) {
                outputMaps.push('-map', audioOutputMap);
            }
            // Eğer mix yoksa ve orijinal ses yoksa, ama yeni ses varsa onu ekledik.

            command.outputOptions(outputMaps)
                .videoCodec('copy') // Video encode etme (HIZLI) - Sadece ses ekliyoruz
                // ANCAK: Eğer videoCodec copy dersek, video stream 0'dan kopyalanır.
                // complex filter kullanırken bazen re-encode gerekebilir ama audio için
                // sadece audio codec aac yeterlidir, video copy olabilir.
                // FAKAT: Eğer videoda değişiklik yoksa copy çalışır. 
                // Biz sadece ses ekliyoruz.

                // .videoCodec('libx264') // Güvenli olması için re-encode (yavaş ama garanti)
                // Kullanıcı HIZ istiyorsa copy denenebilir. Ama "Video sonuna kadar" gibi durumlar video stream'i etkilemez.
                // Ses codec'i aac olmalı.
                .audioCodec('aac')
                .output(outputPath)
                .on('start', (cmd) => console.log('FFmpeg Mix Audio:', cmd))
                .on('progress', (progress) => {
                    if (onProgress) onProgress(progress.percent);
                })
                .on('end', () => resolve({ success: true, outputPath }))
                .on('error', (err) => {
                    console.error('Mix Audio Hatası:', err);
                    reject(err);
                })
                .run();
        });
    });
}

/**
 * Belirli bir kareyi çıkar (thumbnail)
 */
function extractFrame(videoPath, outputPath, timeInSeconds) {
    return new Promise((resolve, reject) => {
        // Negatif zamanı engelle
        const startTime = Math.max(0, timeInSeconds);

        ffmpeg(videoPath)
            .inputOptions([`-ss ${startTime}`])
            .frames(1)
            .size('640x?') // AI için boyutu küçült (kota ve hız için)
            .output(outputPath)
            .on('end', () => {
                // Dosyanın gerçekten oluştuğunu kontrol et
                if (fs.existsSync(outputPath)) {
                    resolve(outputPath);
                } else {
                    reject(new Error(`Kare çıkarılamadı: ${outputPath}`));
                }
            })
            .on('error', (err) => {
                console.error('extractFrame hatası:', err);
                reject(err);
            })
            .run();
    });
}

/**
 * Zaman formatla (saniye -> HH:MM:SS.mmm)
 */
function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/**
 * Zaman parse et (HH:MM:SS.mmm -> saniye)
 */
function parseTime(timeString) {
    const parts = timeString.split(':');
    let seconds = 0;

    if (parts.length === 3) {
        seconds += parseFloat(parts[0]) * 3600; // saat
        seconds += parseFloat(parts[1]) * 60;   // dakika
        seconds += parseFloat(parts[2]);         // saniye
    } else if (parts.length === 2) {
        seconds += parseFloat(parts[0]) * 60;   // dakika
        seconds += parseFloat(parts[1]);         // saniye
    } else {
        seconds = parseFloat(parts[0]);          // sadece saniye
    }

    return seconds;
}

/**
 * Video dönüştürme (çözünürlük, kare hızı, codec, bitrate)
 * @param {string} inputPath - Giriş dosyası
 * @param {string} outputPath - Çıkış dosyası
 * @param {Object} options - Dönüştürme seçenekleri
 * @param {Function} onProgress - İlerleme callback
 */
function convertVideo(inputPath, outputPath, options, onProgress) {
    return new Promise((resolve, reject) => {
        const command = ffmpeg(inputPath);

        // Çözünürlük
        if (options.width && options.height) {
            command.size(`${options.width}x${options.height}`);
        }

        // Kare hızı
        if (options.fps && options.fps !== 'original') {
            command.fps(parseFloat(options.fps));
        }

        // Video codec - her zaman bir codec belirle
        let ffmpegCodec = 'libx264'; // varsayılan
        if (options.codec && options.codec !== 'original') {
            const codecMap = {
                'h264': 'libx264',
                'h265': 'libx265',
                'hevc': 'libx265',
                'vp9': 'libvpx-vp9',
                'av1': 'libaom-av1',
                'prores': 'prores_ks'
            };
            ffmpegCodec = codecMap[options.codec.toLowerCase()] || 'libx264';
        }

        command.videoCodec(ffmpegCodec);

        // Codec-specific ayarlar
        if (ffmpegCodec === 'libx264' || ffmpegCodec === 'libx265') {
            command.outputOptions(['-preset', 'medium']);
        } else if (ffmpegCodec === 'libaom-av1') {
            command.outputOptions(['-cpu-used', '4']);
        } else if (ffmpegCodec === 'prores_ks') {
            command.outputOptions(['-profile:v', '3']); // ProRes HQ
        }

        // Bitrate
        if (options.bitrate) {
            command.videoBitrate(`${options.bitrate}k`);
        }

        // Ses codec'ini koru
        command.audioCodec('aac');
        command.audioBitrate('192k');

        console.log('FFmpeg dönüştürme başlıyor:', inputPath, '->', outputPath);

        command
            .output(outputPath)
            .on('start', (commandLine) => {
                console.log('FFmpeg komutu:', commandLine);
            })
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => {
                console.log('FFmpeg dönüştürme tamamlandı:', outputPath);
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error('FFmpeg hatası:', err);
                reject(err);
            })
            .run();
    });
}
/**
 * Gelişmiş ses karıştırma
 * @param {Object} options - Karıştırma seçenekleri
 * @param {Function} onProgress - İlerleme callback
 */
function mixAudioAdvanced(options, onProgress) {
    return new Promise((resolve, reject) => {
        const {
            videoPath,
            audioPath,
            outputPath,
            videoVolume = 1,
            audioVolume = 1,
            insertTime = 0,
            audioTrimStart = 0,
            audioTrimEnd = 0,
            loopAudio = false
        } = options;

        console.log('mixAudioAdvanced başlıyor:', options);

        // Video metadata'sını al
        ffmpeg.ffprobe(videoPath, (err, videoMeta) => {
            if (err) {
                reject(err);
                return;
            }

            const videoDuration = videoMeta.format.duration;
            const remainingDuration = videoDuration - insertTime;

            // Video'da ses var mı kontrol et
            const hasVideoAudio = videoMeta.streams.some(s => s.codec_type === 'audio');

            const delayMs = Math.round(insertTime * 1000);

            // Filtre array oluştur
            let filters = [];

            // 1. Video ses kaynağı [0:a] -> [a0]
            // Formatı stereo'ya zorla ki mixing düzgün olsun
            if (hasVideoAudio) {
                filters.push(`[0:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${videoVolume}[a0]`);
            } else {
                // Video sessizse, video süresi kadar sessizlik oluştur
                filters.push(`anullsrc=r=44100:cl=stereo,atrim=0:${videoDuration}[a0]`);
            }

            // 2. Eklenen ses kaynağı [1:a] -> [a1]
            // Önce temel filtreler (Trim -> Normalize -> Volume)
            let audioFilters = [];

            // Trim (Kırpma) - Eğer belirtilmişse
            // Eğer trimEnd 0 veya trimStart'tan küçükse sonuna kadar kabul et (end parametresini koyma)
            if (audioTrimStart > 0 || (audioTrimEnd > audioTrimStart)) {
                let trimPart = `atrim=start=${audioTrimStart}`;
                if (audioTrimEnd > audioTrimStart) {
                    trimPart += `:end=${audioTrimEnd}`;
                }
                audioFilters.push(trimPart);
                audioFilters.push('asetpts=PTS-STARTPTS'); // Zaman damgasını sıfırla
            }

            // Stereo formatla
            audioFilters.push('aformat=sample_rates=44100:channel_layouts=stereo');

            // Ses seviyesi
            audioFilters.push(`volume=${audioVolume}`);

            // Delay veya Loop
            if (loopAudio) {
                // Loop: Videonun kalan süresi kadar döngü
                // aloop filtresi buffer sorunu çıkarabilir, bu yüzden size parametresi önemli
                audioFilters.push(`aloop=loop=-1:size=2e+09`);
                // Kalan süre kadar kes
                audioFilters.push(`atrim=0:${remainingDuration}`);
            } else if (delayMs > 0) {
                // Delay: Başlangıç zamanına kadar beklet
                // Stereo için her iki kanalı geciktir (pipe | ile)
                audioFilters.push(`adelay=${delayMs}|${delayMs}`);
            }

            // Filtre zincirini birleştir
            const audioChain = audioFilters.join(',');
            filters.push(`[1:a]${audioChain}[a1]`);

            // 3. Mix [a0][a1] -> [aout]
            // volume=2: amix giriş sayısına bölerek sesi kısar, bunu telafi etmek için.
            filters.push(`[a0][a1]amix=inputs=2:duration=first:dropout_transition=0,volume=2[aout]`);

            console.log('Filters:', filters);

            ffmpeg()
                .input(videoPath)
                .input(audioPath)
                .complexFilter(filters)
                .outputOptions([
                    '-map', '0:v',
                    '-map', '[aout]',
                    '-c:v', 'copy', // Video stream copy (hızlı)
                    '-c:a', 'aac',
                    '-b:a', '192k'
                ])
                .output(outputPath)
                .on('start', (cmd) => console.log('FFmpeg cmd:', cmd))
                .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
                .on('end', () => {
                    console.log('Karıştırma OK:', outputPath);
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('Mix hatası:', err);
                    reject(err);
                })
                .run();
        });
    });
}



/**
 * Sessiz alanları tespit et
 * @param {string} inputPath - Giriş dosyası
 * @param {number} minDuration - Minimum sessizlik süresi (saniye)
 * @param {number} threshold - Sessizlik eşiği (dB)
 */
function detectSilence(inputPath, minDuration = 0.5, threshold = -30) {
    return new Promise((resolve, reject) => {
        const silences = [];
        let currentSilence = null;

        ffmpeg(inputPath)
            .audioFilters(`silencedetect=n=${threshold}dB:d=${minDuration}`)
            .format('null')
            .output('-')
            .on('stderr', (line) => {
                // [silencedetect @ 0000021c1f4c6080] silence_start: 11.123
                // [silencedetect @ 0000021c1f4c6080] silence_end: 14.567 | silence_duration: 3.444
                const startMatch = line.match(/silence_start: ([\d.]+)/);
                const endMatch = line.match(/silence_end: ([\d.]+)/);

                if (startMatch) {
                    currentSilence = { start: parseFloat(startMatch[1]) };
                } else if (endMatch && currentSilence) {
                    currentSilence.end = parseFloat(endMatch[1]);
                    currentSilence.duration = currentSilence.end - currentSilence.start;
                    silences.push(currentSilence);
                    currentSilence = null;
                }
            })
            .on('end', () => {
                console.log(`${silences.length} adet sessiz alan tespit edildi`);
                resolve(silences);
            })
            .on('error', (err) => {
                console.error('Sessizlik tespiti hatası:', err);
                reject(err);
            })
            .run();
    });
}

/**
 * Belirli bir aralığı kesip yeni bir video dosyası oluştur
 */
function cutVideoClip(inputPath, outputPath, startTime, duration) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(duration)
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .run();
    });
}

/**
 * Görsel overlay ekle
 */
function addImageOverlay(videoPath, imagePath, outputPath, options, onProgress) {
    return new Promise((resolve, reject) => {
        const {
            x = 0,
            y = 0,
            width = -1, // -1: orantılı, -2: scale yok
            height = -1,
            opacity = 1.0,
            startTime = 0,
            endTime = null
        } = options;

        const ffmpeg = require('fluent-ffmpeg');

        // Filtre zinciri oluştur
        let filterChain = [];

        // 1. Görüntüyü hazırla (Scale -> Opacity)
        let filters = [];

        // Boyutlandırma
        // -2: scale yok (kullanıcı UI'da yok ama kodda var)
        // -1: orijinal veya auto. Eğer her ikisi de -1 ise scale filtresine gerek yok.
        if (width !== -2 && height !== -2) {
            if (width !== -1 || height !== -1) {
                filters.push(`scale=${width}:${height}`);
            }
        }

        // Opaklık
        if (opacity < 1.0) {
            filters.push(`format=rgba,colorchannelmixer=aa=${opacity}`);
        }

        let overlayInput = '[1:v]';

        if (filters.length > 0) {
            // Filtreleri uygula ve [img] olarak etiketle
            const filterString = filters.join(',');
            filterChain.push(`[1:v]${filterString}[img]`);
            overlayInput = '[img]';
        }

        // 2. Overlay
        let overlayOptions = [`x=${x}`, `y=${y}`];
        if (endTime && endTime > startTime) {
            overlayOptions.push(`enable='between(t,${startTime},${endTime})'`);
        }

        // Overlay options ':' ile birleşir (x=10:y=20:enable=...)
        const overlayString = overlayOptions.join(':');
        filterChain.push(`[0:v]${overlayInput}overlay=${overlayString}[outv]`);

        ffmpeg(videoPath)
            .input(imagePath)
            .complexFilter(filterChain)
            .outputOptions([
                '-map', '[outv]',  // Video çıkışı complex filter'dan
                '-map', '0:a?',    // Ses çıkışı orijinal videodan (varsa)
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-c:a', 'copy'     // Sesi encode etmeden kopyala
            ])
            .output(outputPath)
            .on('start', (cmd) => console.log('FFmpeg Image Overlay cmd:', cmd))
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * İki görseli birleştir (AI analizi için)
 */
function compositeImage(baseImagePath, overlayImagePath, outputPath, options) {
    return new Promise((resolve, reject) => {
        const { x = 0, y = 0, width = -1, height = -1, opacity = 1.0 } = options;
        const ffmpeg = require('fluent-ffmpeg');

        let filterChain = [];

        // Overlay hazırlığı (Scale ve Opacity)
        let inputs = '[1:v]';
        let filters = [];

        if (width !== -1 || height !== -1) {
            // Sadece belirtilmişse scale et
            let w = width === -1 ? -1 : width;
            let h = height === -1 ? -1 : height;
            // scale filtresi -1 kabul eder (keep aspect ratio)
            filters.push(`scale=${w}:${h}`);
        }

        if (opacity < 1.0) {
            filters.push(`format=rgba,colorchannelmixer=aa=${opacity}`);
        }

        if (filters.length > 0) {
            filterChain.push(`${inputs}${filters.join(',')}[ovr]`);
            inputs = '[ovr]';
        }

        // Overlay işlemi
        filterChain.push(`[0:v]${inputs}overlay=x=${x}:y=${y}[out]`);

        ffmpeg(baseImagePath)
            .input(overlayImagePath)
            .complexFilter(filterChain, 'out')
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => {
                console.error('Composite Image Error:', err);
                reject(err);
            })
            .run();
    });
}

/**
 * Video geçiş efekti uygula
 * @param {string} videoPath - Video dosyası
 * @param {string} outputPath - Çıkış dosyası
 * @param {Object} options - Geçiş seçenekleri
 * @param {Function} onProgress - İlerleme callback
 */
function addTransition(videoPath, outputPath, options, onProgress) {
    return new Promise(async (resolve, reject) => {
        const {
            transitionType = 'fade',
            time: timeRaw = 0,
            duration: durationRaw = 0.5,
            useSfx = true,
            customSfxPath = null
        } = options;

        const time = parseFloat(timeRaw);
        const duration = parseFloat(durationRaw);

        console.log(`Geçiş uygulanıyor: ${transitionType} @${time}s, ${duration}s süre, sfx: ${useSfx}`);

        try {
            // 1. Video Filtresi Hazırla
            const halfDur = duration / 2;
            const fadeOutStart = Math.max(0, time - halfDur);
            const fadeInStart = time;
            const baseVf = "setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p";
            let vf = '';

            // Video filtre mantığı (Existing logic)
            switch (transitionType) {
                case 'fade_in':
                    vf = `${baseVf},fade=t=in:st=0:d=${duration}`;
                    break;
                case 'fade_out':
                    const fadeOutExpr = `'if(between(t,${time},${time + duration}), (${time}-t)/${duration}, if(gt(t,${time + duration}), -1, 0))'`;
                    vf = `${baseVf},eq=brightness=${fadeOutExpr}:eval=frame`;
                    break;
                case 'dip_white':
                    const whiteEnd = time + halfDur;
                    const whiteExpr = `'if(between(t,${fadeOutStart},${time}), (t-${fadeOutStart})/${halfDur}, if(between(t,${time},${whiteEnd}), (${whiteEnd}-t)/${halfDur}, 0))'`;
                    vf = `${baseVf},eq=brightness=${whiteExpr}:eval=frame`;
                    break;
                default:
                    const eqEnd = time + halfDur;
                    const eqExpr = `'if(between(t,${fadeOutStart},${time}), (t-${fadeOutStart})/${halfDur}*-1, if(between(t,${time},${eqEnd}), (${eqEnd}-t)/${halfDur}*-1, 0))'`;
                    vf = `${baseVf},eq=brightness=${eqExpr}:eval=frame`;
            }

            // 0. Video ses kontrolü
            let hasAudio = false;
            try {
                const meta = await getVideoMetadata(videoPath);
                hasAudio = !!meta.audioCodec;
                console.log('Video Audio Durumu:', hasAudio);
            } catch (e) {
                console.warn('Metadata alınamadı, ses yok varsayılıyor:', e);
            }

            const ffmpeg = require('fluent-ffmpeg');
            let command = ffmpeg(videoPath);
            let complexFilters = [vf + '[v]']; // Video çıkışı [v] olarak etiketle
            let outputMap = ['-map', '[v]']; // Video map'i
            let shouldEncodeAudio = false;

            // 2. Ses Efekti (SFX) Ekleme Mantığı
            if (useSfx) {
                let sfxPath;

                // Öncelik 1: Özel ses dosyası
                if (customSfxPath && fs.existsSync(customSfxPath)) {
                    sfxPath = customSfxPath;
                    console.log('Özel SFX kullanılacak:', sfxPath);
                }
                // Öncelik 2: Varsayılan sesler
                else {
                    // Geçiş tipine göre ses dosyasını belirle
                    let sfxFileName = 'cross_dissolve.wav'; // Varsayılan
                    switch (transitionType) {
                        case 'fade_in':
                        case 'fade_out':
                            sfxFileName = 'fade.wav';
                            break;
                        case 'dip_white':
                        case 'dip_black':
                        case 'dipToBlack':
                        case 'dipToWhite':
                            sfxFileName = 'dip_to_black.wav';
                            break;
                        case 'chapterBreak':
                        case 'chapter_break':
                            sfxFileName = 'chapter_break.wav';
                            break;
                        case 'wipeLeft':
                        case 'wipeRight':
                            sfxFileName = 'cross_dissolve.wav';
                            break;
                        default:
                            sfxFileName = 'cross_dissolve.wav';
                    }

                    // Yol bulma mantığı - Daha güvenilir sıralama
                    const possiblePaths = [];

                    // 1. Özel sfx path (eğer varsa)
                    if (customSfxPath) possiblePaths.push(customSfxPath);

                    // 2. Production resources path
                    if (process.resourcesPath) {
                        possiblePaths.push(path.join(process.resourcesPath, 'assets', 'sfx', sfxFileName));
                    }

                    // 3. Development CWD path (En güvenilir dev yolu)
                    possiblePaths.push(path.join(process.cwd(), 'src', 'renderer', 'assets', 'sfx', sfxFileName));

                    // 4. Development relative path (Yedek)
                    possiblePaths.push(path.resolve(__dirname, '../renderer/assets/sfx', sfxFileName));

                    // 5. Legacy path
                    let legacyName = 'Cross Dissolve.wav';
                    if (sfxFileName === 'fade.wav') legacyName = 'Fade in   Out.wav';
                    if (sfxFileName === 'dip_to_black.wav') legacyName = 'Deep to Black.wav';
                    if (sfxFileName === 'chapter_break.wav') legacyName = 'Bölüm ayırıcı.wav';
                    possiblePaths.push(path.join(process.cwd(), 'Geçiş Sesleri', legacyName));
                    possiblePaths.push(path.resolve(__dirname, '../../Geçiş Sesleri', legacyName));

                    // 7. Executable Path (Taşınabilir Sürüm İçin Kritik)
                    // .exe dosyasının yanına bakar
                    if (process.execPath) {
                        const exeDir = path.dirname(process.execPath);
                        possiblePaths.push(path.join(exeDir, 'Geçiş Sesleri', legacyName));
                        possiblePaths.push(path.join(exeDir, 'resources', 'Geçiş Sesleri', legacyName));
                        possiblePaths.push(path.join(exeDir, 'resources', 'assets', 'sfx', sfxFileName));
                        // Mac App Bundle içi
                        possiblePaths.push(path.join(exeDir, '../Resources', 'assets', 'sfx', sfxFileName));
                    }

                    // 8. Generic Fallback (transition.wav)
                    possiblePaths.push(path.join(process.cwd(), 'resources', 'assets', 'sounds', 'transition.wav'));
                    if (process.execPath) {
                        possiblePaths.push(path.join(path.dirname(process.execPath), 'resources', 'assets', 'sounds', 'transition.wav'));
                    }

                    const originalFs = require('original-fs');

                    // İlk bulunan yolu seç
                    for (const p of possiblePaths) {
                        try {
                            if (p && originalFs.existsSync(p)) {
                                sfxPath = p;
                                break;
                            }
                        } catch (e) {
                            console.error(`Error checking path ${p}:`, e);
                        }
                    }
                } // Else (defaults) sonu

                console.log('Kullanılacak SFX Yolu:', sfxPath);

                if (sfxPath && fs.existsSync(sfxPath)) {
                    command.input(sfxPath);
                    console.log('SFX input eklendi.');

                    // Video filtresini güncelle: [0:v] inputunu açıkça belirt
                    complexFilters[0] = `[0:v]${complexFilters[0]}`;

                    // SFX Filtresi:
                    const delayMs = Math.round(time * 1000);
                    complexFilters.push(`[1:a]aformat=channel_layouts=stereo,adelay=${delayMs}|${delayMs},apad[sfx]`);

                    if (hasAudio) {
                        // Orijinal ses var, mix yap
                        complexFilters.push(`[0:a][sfx]amix=inputs=2:duration=first:dropout_transition=0,volume=2[a]`);
                        outputMap.push('-map', '[a]');
                    } else {
                        // Orijinal ses yok, sadece SFX kullan
                        // [sfx] -> [a] olarak kullanabiliriz ama süreyi video ile eşleştirmek gerekir.
                        // apad zaten sonsuza kadar uzatır. output'ta -shortest kullanmak gerekebilir ama
                        // transition süresi video süresiyle aynı (addTransition tüm videoyu işler).
                        // Basitçe sfxi map et.
                        outputMap.push('-map', '[sfx]');
                    }
                    shouldEncodeAudio = true;

                } else {
                    console.warn('SFX dosyası bulunamadı, sessiz geçilecek.');
                    // SFX yok.
                    if (hasAudio) {
                        complexFilters[0] = `[0:v]${complexFilters[0]}`;
                        outputMap.push('-map', '0:a');
                        shouldEncodeAudio = true;
                    }
                }
            } else {
                // SFX Kullanma
                if (hasAudio) {
                    outputMap.push('-map', '0:a');
                    shouldEncodeAudio = true;
                }
            }

            const outputOptions = [
                '-c:v', 'libx264',
                '-preset', 'medium',
                ...outputMap
            ];

            if (shouldEncodeAudio) {
                outputOptions.push('-c:a', 'aac');
            }

            command
                .complexFilter(complexFilters)
                .outputOptions(outputOptions)
                .on('start', (commandLine) => {
                    console.log('--- FFmpeg İşlemi Başlatıldı ---');
                    console.log('Komut:', commandLine);
                })
                .output(outputPath)
                .on('progress', (progress) => {
                    if (onProgress) onProgress(progress.percent);
                })
                .on('end', () => resolve(outputPath))
                .on('error', (err) => reject(new Error('Geçiş hatası: ' + err.message)));

            command.run();

        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Concat text dosyasından ses dosyası oluştur
 * @param {string} concatFilePath - .txt formatında dosya listesi
 * @param {string} outputPath - Çıktı .wav dosyası
 * @param {function} onProgress
 */
function createAudioFromConcat(concatFilePath, outputPath, onProgress) {
    const ffmpeg = require('fluent-ffmpeg');
    return new Promise((resolve, reject) => {
        const command = ffmpeg()
            .input(concatFilePath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions([
                '-c:a', 'pcm_s16le', // WAV formatı
                '-ar', '48000',      // 48kHz Standardı
                '-ac', '2'           // Stereo
            ])
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(new Error('Concat hatası: ' + err.message)));

        command.run();
    });
}

/**
 * Sessizlik dosyası oluştur
 */
/**
 * Sessizlik dosyası oluştur
 */
function generateSilence(duration, outputPath) {
    const ffmpeg = require('fluent-ffmpeg');
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input('anullsrc=channel_layout=stereo:sample_rate=48000')
            .inputFormat('lavfi')
            .duration(duration)
            .outputOptions([
                '-c:a', 'pcm_s16le',
                '-ac', '2',
                '-ar', '48000'
            ])
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * Birden fazla ses dosyasını belirli zamanlara (offset) yerleştirerek mixle.
 * Concat yerine Mix+Delay yöntemiyle KESİN senkron sağlar.
 * @param {Array<{path: string, offset: number}>} audioSegments
 * @param {string} outputPath
 */
function createAudioFromMix(audioSegments, outputPath, onProgress) {
    const ffmpeg = require('fluent-ffmpeg');
    return new Promise((resolve, reject) => {
        if (!audioSegments || audioSegments.length === 0) {
            // Hiç ses yoksa boş sessizlik oluştur (1 sn)
            return generateSilence(1, outputPath).then(resolve).catch(reject);
        }

        const command = ffmpeg();
        const complexFilter = [];
        const mixInputs = [];

        // Girdileri ekle ve filtreleri oluştur
        audioSegments.forEach((seg, index) => {
            command.input(seg.path);

            // Offset milisaniye cinsinden tam sayı olmalı
            const delayMs = Math.round(seg.offset * 1000);

            // adelay filtresi: sesi geciktirir (Stereo için iki kanal: delay|delay)
            // [0:a]adelay=1000|1000[a0]
            complexFilter.push(`[${index}:a]adelay=${delayMs}|${delayMs}[a${index}]`);
            mixInputs.push(`[a${index}]`);
        });

        // Hepsini karıştır (amix)
        // inputs=N, duration=longest (en son biten sese kadar sürsün)
        complexFilter.push(`${mixInputs.join('')}amix=inputs=${audioSegments.length}:duration=longest:dropout_transition=0,volume=${audioSegments.length}[out]`);

        // Not: amix sesi böler, o yüzden volume ile tekrar yükseltiyoruz (basit bir normalizasyon)
        // Daha güvenlisi normalize filtresi kullanmak ama şimdilik bu yeterli.

        command
            .complexFilter(complexFilter)
            .outputOptions([
                '-map', '[out]',
                '-c:a', 'pcm_s16le',
                '-ar', '48000',
                '-ac', '2'
            ])
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => resolve(outputPath))
            .on('error', (err) => {
                console.error('Mix Delay hatası:', err);
                // Komut satırı çok uzun hatası olabilir, bunu yakalamak lazım
                reject(new Error('Mix hatası: ' + err.message));
            })
            .run();
    });
}

/**
 * Fade In efekti (video başında)
 */
function applyFadeIn(videoPath, outputPath, duration, onProgress) {
    const ffmpeg = require('fluent-ffmpeg');
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .videoFilters(`fade=t=in:st=0:d=${duration}`)
            .outputOptions(['-c:v', 'libx264', '-preset', 'fast', '-c:a', 'copy'])
            .output(outputPath)
            .on('start', (cmd) => console.log('FFmpeg Fade In:', cmd))
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * Fade Out efekti (belirtilen noktadan itibaren)
 */
function applyFadeOut(videoPath, outputPath, startTime, duration, onProgress) {
    const ffmpeg = require('fluent-ffmpeg');
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .videoFilters(`fade=t=out:st=${startTime}:d=${duration}`)
            .outputOptions(['-c:v', 'libx264', '-preset', 'fast', '-c:a', 'copy'])
            .output(outputPath)
            .on('start', (cmd) => console.log('FFmpeg Fade Out:', cmd))
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * Belirli bir noktada fade efekti (fade out + fade in)
 */
function applyFadeAtPoint(videoPath, outputPath, time, duration, onProgress) {
    const ffmpeg = require('fluent-ffmpeg');
    return new Promise((resolve, reject) => {
        const halfDur = duration / 2;
        const fadeOutStart = Math.max(0, time - halfDur);
        const fadeInStart = time;
        const videoFilter = `fade=t=out:st=${fadeOutStart}:d=${halfDur},fade=t=in:st=${fadeInStart}:d=${halfDur}`;
        ffmpeg(videoPath)
            .videoFilters(videoFilter)
            .outputOptions(['-c:v', 'libx264', '-preset', 'fast', '-c:a', 'copy'])
            .output(outputPath)
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * Dip to Black/White geçişi
 */
function applyDipTransition(videoPath, outputPath, time, duration, color, onProgress) {
    const ffmpeg = require('fluent-ffmpeg');
    return new Promise((resolve, reject) => {
        const halfDur = duration / 2;
        const fadeOutStart = Math.max(0, time - halfDur);
        const fadeInStart = time;
        const colorValue = color === 'white' ? 'FFFFFF' : '000000';
        const videoFilter = `fade=t=out:st=${fadeOutStart}:d=${halfDur}:c=${colorValue},fade=t=in:st=${fadeInStart}:d=${halfDur}:c=${colorValue}`;
        ffmpeg(videoPath)
            .videoFilters(videoFilter)
            .outputOptions(['-c:v', 'libx264', '-preset', 'fast', '-c:a', 'copy'])
            .output(outputPath)
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * Wipe geçişi (video bölme ve xfade ile)
 */
function applyWipeTransition(videoPath, outputPath, time, duration, wipeType, onProgress) {
    return new Promise(async (resolve, reject) => {
        const fs = require('fs');
        const path = require('path');
        const ffmpeg = require('fluent-ffmpeg');
        try {
            const tempDir = path.dirname(outputPath);
            const timestamp = Date.now();
            const part1Path = path.join(tempDir, `part1_${timestamp}.mp4`);
            const part2Path = path.join(tempDir, `part2_${timestamp}.mp4`);

            // Metadata ve Sample Rate al
            const metadata = await getVideoMetadata(videoPath);
            const sampleRate = metadata.audioSampleRate || 44100;
            const smartOptions = { sampleRate };

            // cutVideoSmart kullanarak HIZLI ve KESİN kesim yap
            // İmza: (input, output, start, end, options, onProgress)
            await cutVideoSmart(videoPath, part1Path, 0, time, smartOptions, (p) => {
                if (onProgress) onProgress(p * 0.4);
            });

            await cutVideoSmart(videoPath, part2Path, time, metadata.duration, smartOptions, (p) => {
                if (onProgress) onProgress(40 + p * 0.4);
            });

            if (onProgress) onProgress(80);
            const xfadeOffset = time - duration;

            ffmpeg()
                .input(part1Path)
                .input(part2Path)
                .complexFilter([
                    `[0:v][1:v]xfade=transition=${wipeType}:duration=${duration}:offset=${xfadeOffset}[v]`,
                    `[0:a][1:a]acrossfade=d=${duration}[a]`
                ])
                .outputOptions([
                    '-map', '[v]',
                    '-map', '[a]',
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-c:a', 'aac',
                    '-ar', String(sampleRate) // Sample rate koru
                ])
                .output(outputPath)
                .on('progress', (p) => { if (onProgress) onProgress(80 + (p.percent || 0) * 0.2); })
                .on('end', () => {
                    try { fs.unlinkSync(part1Path); } catch (e) { }
                    try { fs.unlinkSync(part2Path); } catch (e) { }
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    try { fs.unlinkSync(part1Path); } catch (e) { }
                    try { fs.unlinkSync(part2Path); } catch (e) { }
                    reject(err);
                })
                .run();
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Bölüm ayırıcı (siyah kare ekle)
 */
function applyChapterBreak(videoPath, outputPath, time, duration, onProgress) {
    return new Promise(async (resolve, reject) => {
        const fs = require('fs');
        const path = require('path');
        const ffmpeg = require('fluent-ffmpeg');
        try {
            const tempDir = path.dirname(outputPath);
            const timestamp = Date.now();
            const part1Path = path.join(tempDir, `part1_${timestamp}.mp4`);
            const part2Path = path.join(tempDir, `part2_${timestamp}.mp4`);
            const blackPath = path.join(tempDir, `black_${timestamp}.mp4`);

            const metadata = await getVideoMetadata(videoPath);
            const width = metadata.width || 1920;
            const height = metadata.height || 1080;
            const fps = metadata.frameRate || 30;
            const sampleRate = metadata.audioSampleRate || 44100;
            const smartOptions = { sampleRate };

            // SmartCut kullan
            await cutVideoSmart(videoPath, part1Path, 0, time, smartOptions);
            await cutVideoSmart(videoPath, part2Path, time, metadata.duration, smartOptions);

            await new Promise((res, rej) => {
                ffmpeg()
                    .input(`color=c=black:s=${width}x${height}:r=${fps}:d=${duration}`)
                    .inputOptions(['-f', 'lavfi'])
                    .input(`anullsrc=channel_layout=stereo:sample_rate=${sampleRate}`)
                    .inputOptions(['-f', 'lavfi', '-t', String(duration)])
                    .outputOptions([
                        '-c:v', 'libx264',
                        '-preset', 'fast',
                        '-c:a', 'aac',
                        '-ar', String(sampleRate),
                        '-shortest'
                    ])
                    .output(blackPath)
                    .on('end', res)
                    .on('error', rej)
                    .run();
            });

            // Normal concatenation (re-encode gerektirebilir çünkü black clip farklı param olabilir 
            // ama SmartCut sonuçları düzgün formatlı olmalı...
            // concatenateVideos fonksiyonu zaten normalize ediyor.
            await concatenateVideos([part1Path, blackPath, part2Path], outputPath, (p) => {
                if (onProgress) onProgress(65 + p * 0.35);
            });

            try { fs.unlinkSync(part1Path); } catch (e) { }
            try { fs.unlinkSync(part2Path); } catch (e) { }
            try { fs.unlinkSync(blackPath); } catch (e) { }
            resolve(outputPath);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Legacy SFX Helper
 */
function addTransitionSfx(videoPath, outputPath, time, duration, transitionType, onProgress, customSfxPath = null) {
    const fs = require('fs');
    try {
        fs.copyFileSync(videoPath, outputPath);
        return Promise.resolve(outputPath);
    } catch (e) { return Promise.reject(e); }
}

/**
 * Video kesme işlemi (AI Analizi için - Basitleştirilmiş ve Güvenli)
 * Karmaşık filtreler yok, sadece kesip alır.
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {number} startTime
 * @param {number} duration (Saniye cinsinden SÜRE)
 */
function cutVideoClip(inputPath, outputPath, startTime, duration, onProgress) {
    const ffmpeg = require('fluent-ffmpeg');
    return new Promise((resolve, reject) => {
        // Önce ses akışı var mı kontrol et
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) {
                console.error('Probe Error (cutVideoClip):', err);
                return reject(err);
            }

            const hasAudio = metadata.streams.some(s => s.codec_type === 'audio');

            // Eğer süre negatif veya geçersizse düzelt
            if (duration <= 0) {
                return reject(new Error('Geçersiz süre (duration): ' + duration));
            }

            console.log(`cutVideoClip: Start=${startTime}, Duration=${duration}, Audio=${hasAudio}`);

            const command = ffmpeg(inputPath)
                .setStartTime(startTime)
                .setDuration(duration)
                .videoCodec('libx264')
                .outputOptions([
                    '-preset', 'ultrafast', // AI için hız önemli
                    '-crf', '28',
                    '-avoid_negative_ts', 'make_zero'
                ]);

            if (hasAudio) {
                command
                    .audioCodec('aac')
                    .outputOptions(['-ac', '2', '-ar', '44100']);
            } else {
                command.noAudio();
            }

            command
                .output(outputPath)
                .on('progress', (progress) => {
                    if (onProgress) onProgress(progress.percent);
                })
                .on('end', () => resolve(outputPath))
                .on('error', (err) => {
                    console.error('cutVideoClip Error:', err);
                    reject(err);
                })
                .run();
        });
    });
}

module.exports = {
    getVideoMetadata,
    cutVideo,
    concatenateVideos,
    rotateVideo,
    extractAudio,
    extractVideo,
    getVideoMetadata,
    cutVideo,
    cutVideoClip,
    mixAudio,
    mixAudioAdvanced,
    burnSubtitles,
    addTextOverlay,
    addImageOverlay,
    addTransition,
    createVideoFromImages,
    extractFrame,
    compositeImage,
    convertVideo,
    detectSilence,
    formatTime,
    parseTime,
    createAudioFromConcat,
    generateSilence,
    createAudioFromMix,

    // Legacy Helpers
    applyFadeIn,
    applyFadeOut,
    applyFadeAtPoint,
    applyDipTransition,
    applyWipeTransition,
    applyChapterBreak,
    addTransitionSfx,
    mixAudio,
    safeConvertVideo,

    // Smart Cut fonksiyonları
    cutVideoOptimized
};

/**
 * Güvenli Video Dönüştürme (Web ve Electron uyumlu)
 */
function safeConvertVideo(inputPath, outputPath, options, onProgress) {
    const ffmpeg = require('fluent-ffmpeg');
    return new Promise((resolve, reject) => {
        const command = ffmpeg(inputPath);

        // -- Video Codec ve Format --
        command.videoCodec('libx264');
        command.audioCodec('aac');

        // KRİTİK AYARLAR: yuv420p ve movflags
        const outputOpts = [
            '-preset', 'medium',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart'
        ];

        command.outputOptions(outputOpts);

        // -- Opsiyonel Ayarlar --
        if (options && options.width && options.height) {
            command.size(`${options.width}x${options.height}`);
        }

        if (options && options.fps && options.fps !== 'original') {
            command.fps(parseFloat(options.fps));
        }

        if (options && options.bitrate) {
            command.videoBitrate(`${options.bitrate}k`);
        }

        console.log('Safe Convert Start:', inputPath, '->', outputPath);

        command
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => {
                console.log('Safe Convert Completed');
                resolve({ success: true, outputPath });
            })
            .on('error', (err) => {
                console.error('Safe Convert Error:', err);
                reject(err);
            })
            .run();
    });
}

// Module exports
module.exports = {
    getFFmpegPaths,
    getVideoMetadata,
    cutVideo,
    concatenateVideos,
    rotateVideo,
    extractAudio,
    extractVideo,
    mixAudio,
    burnSubtitles,
    addTextOverlay,
    createVideoFromImages,
    extractFrame,
    formatTime,
    parseTime,
    convertVideo,
    mixAudioAdvanced,
    detectSilence,
    cutVideoClip,
    addImageOverlay,
    compositeImage,
    addTransition,
    createAudioFromConcat,
    generateSilence,
    createAudioFromMix,
    applyFadeIn,
    applyFadeOut,
    applyFadeAtPoint,
    safeConvertVideo,
    // Hızlı export fonksiyonları
    cutVideoFast,
    cutVideoSmart,
    concatenateVideosFast,
    applyTransitionsSmart,
    // GPU encoding
    detectGpuEncoder
};

/**
 * Akıllı Geçiş Uygulama (Smart Transitions)
 * Videoyu sadece geçiş noktalarında re-encode eder, kalan kısımları kopyalar.
 * 
 * @param {string} videoPath - Kaynak video
 * @param {string} outputPath - Hedef video
 * @param {Array} transitions - Geçiş listesi [{type, time, duration, useSfx, customSfxPath}]
 * @param {Function} onProgress - İlerleme
 */
async function applyTransitionsSmart(videoPath, outputPath, transitions, onProgress) {
    const fs = require('fs');
    const path = require('path');
    console.log(`Smart Transition Başlıyor. Toplam ${transitions.length} geçiş.`);

    if (!transitions || transitions.length === 0) {
        return new Promise((resolve, reject) => {
            fs.copyFile(videoPath, outputPath, (err) => {
                if (err) reject(err); else resolve(outputPath);
            });
        });
    }

    const tempDir = path.dirname(outputPath);
    const timestamp = Date.now();
    const tempFiles = [];

    try {
        // 1. Videonun toplam süresini ve ses durumunu al
        const meta = await getVideoMetadata(videoPath);
        const totalDuration = meta.duration;
        const hasAudio = !!meta.audioCodec;

        // 2. Geçişleri zamana göre sırala
        const sortedTrans = [...transitions].sort((a, b) => a.time - b.time);

        // 3. Geçişleri "Kümeler" (Cluster) halinde grupla
        // Birbirine çok yakın veya çakışan geçişleri tek bir re-encode bloğu yapacağız.
        const clusters = [];
        const padding = 1.0; // Geçişin öncesine/sonrasına eklenecek güvenli pay (saniye)

        let currentCluster = null;

        for (const t of sortedTrans) {
            const tStart = Math.max(0, t.time - (t.duration / 2) - padding);
            const tEnd = Math.min(totalDuration, t.time + (t.duration / 2) + padding);

            if (!currentCluster) {
                currentCluster = {
                    start: tStart,
                    end: tEnd,
                    transitions: [t]
                };
            } else {
                // Eğer bu geçiş, mevcut kümeyle çakışıyor veya çok yakınsa birleştir
                if (tStart <= currentCluster.end + 0.5) { // 0.5s tolerans
                    currentCluster.end = Math.max(currentCluster.end, tEnd);
                    currentCluster.transitions.push(t);
                } else {
                    clusters.push(currentCluster);
                    currentCluster = {
                        start: tStart,
                        end: tEnd,
                        transitions: [t]
                    };
                }
            }
        }
        if (currentCluster) clusters.push(currentCluster);

        console.log(`Smart Transition: ${clusters.length} küme oluşturuldu.`);

        // 4. Parçaları İşle (Temiz - Kirli - Temiz - Kirli ...)
        let currentTime = 0;
        let fileIndex = 0;

        for (const cluster of clusters) {
            // A. Temiz Alan (Gap) - Varsa
            if (cluster.start > currentTime + 0.1) {
                const gapDuration = cluster.start - currentTime;
                // Minik boşlukları atlama
                if (gapDuration > 0.5) {
                    const cleanPath = path.join(tempDir, `st_clean_${fileIndex++}_${timestamp}.mp4`);
                    console.log(`Smart Trans: Temiz Alan ${currentTime.toFixed(2)} - ${cluster.start.toFixed(2)}`);

                    // cutVideoSmart kullanarak temiz alanı al (zaten smart copy yapar)
                    await cutVideoSmart(videoPath, cleanPath, currentTime, cluster.start, {}, null);
                    tempFiles.push(cleanPath);
                } else {
                    // Boşluk çok küçükse, cluster başlangıcını geriye çek
                    // Ancak şimdilik basit tutalım, boşluk 0.5s altındaysa görmezden geliniyor
                    // ve cluster o noktadan başlıyor (küçük bir parça kaybedilebilir mi? Hayır, 
                    // cluster.start currentTime'dan ileride olsa da işlem currentTime'dan devam etmeli
                    // O yüzden currentTime'ı güncellemeden devam etse daha iyi olurdu ama
                    // cluster kendi start'ını kullanıyor.
                    // Düzeltme: Eğer gap atlanıyorsa, cluster başlangıcı currentTime olmalı VEYA
                    // processTransitionCluster fonksiyonuna currentTime start olarak verilmeli.
                    // Fakat cluster objesini değiştirmek daha kolay.
                    cluster.start = currentTime;
                }
            }

            // B. Kirli Alan (Cluster) - Re-encode
            const dirtyPath = path.join(tempDir, `st_dirty_${fileIndex++}_${timestamp}.mp4`);
            console.log(`Smart Trans: Efekt Alanı ${cluster.start.toFixed(2)} - ${cluster.end.toFixed(2)} (${cluster.transitions.length} geçiş)`);

            await processTransitionCluster(videoPath, dirtyPath, cluster, hasAudio);
            tempFiles.push(dirtyPath);

            currentTime = cluster.end;
        }

        // C. Son Temiz Alan (Kalan)
        if (currentTime < totalDuration - 0.5) {
            const lastPath = path.join(tempDir, `st_last_${fileIndex++}_${timestamp}.mp4`);
            console.log(`Smart Trans: Son Temiz Alan ${currentTime.toFixed(2)} - ${totalDuration.toFixed(2)}`);
            await cutVideoSmart(videoPath, lastPath, currentTime, totalDuration, {}, null);
            tempFiles.push(lastPath);
        }

        // 5. Birleştir
        console.log('Smart Trans: Birleştiriliyor...');
        await concatenateVideosFast(tempFiles, outputPath, (p) => {
            if (onProgress) onProgress(p);
        });

        // Temizlik
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
        return outputPath;

    } catch (error) {
        console.error('Smart Transition Hatası:', error);
        // Hata durumunda temizlik
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
        throw error;
    }
}

/**
 * Bir transition kümesini işler ve re-encode eder
 */
function processTransitionCluster(videoPath, outputPath, cluster, hasAudio) {
    return new Promise((resolve, reject) => {
        const { start, end, transitions } = cluster;
        const duration = end - start;
        const ffmpeg = require('fluent-ffmpeg');

        let command = ffmpeg(videoPath)
            .setStartTime(start)
            .setDuration(duration);

        // Filtre Zinciri Hazırla
        let complexFilters = [];
        let videoInputLabel = '[0:v]';
        let audioInputLabel = hasAudio ? '[0:a]' : null;

        // == VİDEO FİLTRELERİ ==
        const baseVf = "setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p";
        let vfChain = [baseVf];

        // Her geçiş için filtre ekle
        for (const t of transitions) {
            // Geçiş zamanını bu parçanın yerel zamanına çevir
            const localT = t.time - start;
            const tDur = t.duration;
            const halfDur = tDur / 2;
            const fadeOutStart = Math.max(0, localT - halfDur);

            // Filtre mantığı
            switch (t.transitionType) {
                case 'fade_in':
                    vfChain.push(`fade=t=in:st=${Math.max(0, localT - tDur / 2)}:d=${tDur}`);
                    break;
                case 'fade_out':
                    const foExpr = `'if(between(t,${localT},${localT + tDur}), (${localT}-t)/${tDur}, if(gt(t,${localT + tDur}), -1, 0))'`;
                    vfChain.push(`eq=brightness=${foExpr}:eval=frame`);
                    break;
                case 'dip_white':
                case 'dip_black':
                default:
                    const eqStart = fadeOutStart;
                    const eqMid = localT;
                    const eqEnd = localT + halfDur;
                    const eqExpr = `'if(between(t,${eqStart},${eqMid}), (t-${eqStart})/${halfDur}*-1, if(between(t,${eqMid},${eqEnd}), (${eqEnd}-t)/${halfDur}*-1, 0))'`;
                    vfChain.push(`eq=brightness=${eqExpr}:eval=frame`);
                    break;
            }
        }

        const fullVf = vfChain.join(',');
        complexFilters.push(`${videoInputLabel}${fullVf}[outv]`);

        // == SES EFEKTLERİ ==
        let audioMixIndex = 0;
        let currentAudioState = null;

        // Video Audio Handling (Sample Rate Fix)
        if (hasAudio) {
            // Videonun sesini 44100Hz'e zorla
            complexFilters.push(`[0:a]aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo[a0_resampled]`);
            currentAudioState = '[a0_resampled]';
        }

        // SFX kullananları bul
        const sfxItems = transitions.filter(t => t.useSfx !== false);

        if (sfxItems.length > 0) {
            let inputIdx = 1;

            for (const t of sfxItems) {
                const sfxPath = findSfxPath(t.transitionType, t.customSfxPath);

                if (sfxPath) {
                    command.input(sfxPath);
                    const sfxInputLabel = `[${inputIdx}:a]`;
                    inputIdx++;

                    const localT = t.time - start;
                    const delayMs = Math.round(localT * 1000);

                    // SFX hazırla (Resample ekle)
                    const sfxPrepLabel = `[sfx${audioMixIndex}]`;
                    complexFilters.push(`${sfxInputLabel}aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo,adelay=${delayMs}|${delayMs},apad${sfxPrepLabel}`);

                    // Mixle
                    const nextAudioState = `[amix${audioMixIndex}]`;
                    if (currentAudioState) {
                        complexFilters.push(`${currentAudioState}${sfxPrepLabel}amix=inputs=2:duration=first:dropout_transition=0,volume=2${nextAudioState}`);
                    } else {
                        // Hiç ses yoktu, bu ilk ses
                        complexFilters.push(`${sfxPrepLabel}volume=1${nextAudioState}`);
                    }

                    currentAudioState = nextAudioState;
                    audioMixIndex++;
                }
            }
        }

        // Çıktı Haritası
        const outputMaps = ['-map', '[outv]'];
        let hasOutputAudio = false;

        if (currentAudioState) {
            outputMaps.push('-map', currentAudioState);
            hasOutputAudio = true;
        }

        const outputOptions = [
            '-c:v', 'libx264',
            '-preset', 'medium',
            ...outputMaps
        ];

        if (hasOutputAudio) {
            outputOptions.push('-c:a', 'aac');
            outputOptions.push('-ar', '44100'); // Sample rate'i sabitle
        }

        command
            .complexFilter(complexFilters)
            .outputOptions(outputOptions)
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(new Error('Process Cluster Hatası: ' + err.message)))
            .run();
    });
}

/**
 * Yardımcı: SFX Yolu Bul
 */
function findSfxPath(transitionType, customSfxPath) {
    const path = require('path');
    const fs = require('fs');
    if (customSfxPath && fs.existsSync(customSfxPath)) return customSfxPath;

    let sfxFileName = 'cross_dissolve.wav';
    switch (transitionType) {
        case 'fade_in': case 'fade_out': sfxFileName = 'fade.wav'; break;
        case 'dip_white': case 'dip_black': sfxFileName = 'dip_to_black.wav'; break;
        case 'chapterBreak': sfxFileName = 'chapter_break.wav'; break;
    }

    const possiblePaths = [];
    if (process.resourcesPath) possiblePaths.push(path.join(process.resourcesPath, 'assets', 'sfx', sfxFileName));
    possiblePaths.push(path.join(process.cwd(), 'src', 'renderer', 'assets', 'sfx', sfxFileName));
    possiblePaths.push(path.resolve(__dirname, '../renderer/assets/sfx', sfxFileName));

    if (process.execPath) {
        const exeDir = path.dirname(process.execPath);
        possiblePaths.push(path.join(exeDir, 'Geçiş Sesleri', sfxFileName === 'fade.wav' ? 'Fade in   Out.wav' : (sfxFileName === 'dip_to_black.wav' ? 'Deep to Black.wav' : 'Cross Dissolve.wav')));
        possiblePaths.push(path.join(exeDir, 'resources', 'assets', 'sfx', sfxFileName));
    }

    const originalFs = require('original-fs');
    for (const p of possiblePaths) {
        try { if (p && originalFs.existsSync(p)) return p; } catch (e) { }
    }
    return null;
}

/**
 * Ses Senkronizayonu ve Değiştirme
 */
function replaceAudio(videoPath, audioPath, offsetMs, muteOriginal, outputPath, onProgress) {
    return new Promise((resolve, reject) => {
        const ffmpeg = require('fluent-ffmpeg');

        // Temel komut
        let command = ffmpeg(videoPath);

        // Audio input with seek if negative offset
        if (offsetMs < 0) {
            const startSec = Math.abs(offsetMs) / 1000.0;
            command.input(audioPath).inputOptions(['-ss', startSec.toString()]);
        } else {
            command.input(audioPath);
        }

        let complexFilters = [];
        let newAudioLabel = '1:a';

        // Offset > 0 Handle via Filter (Delay)
        if (offsetMs > 0) {
            const delay = Math.round(offsetMs);
            complexFilters.push(`[1:a]adelay=${delay}|${delay}[delayed]`);
            newAudioLabel = '[delayed]';
        }

        let outputMaps = [];

        if (muteOriginal) {
            // Sadece videoyu al, orijinal sesi alma, yeni sesi al
            // -map 0:v -map [newAudio]
            // Video copy (en hızlı)
            outputMaps = ['-map', '0:v', '-map', newAudioLabel];
        } else {
            // Mix
            complexFilters.push(`[0:a]${newAudioLabel}amix=inputs=2:duration=first:dropout_transition=0[mixed]`);
            outputMaps = ['-map', '0:v', '-map', '[mixed]'];
        }

        if (complexFilters.length > 0) {
            command.complexFilter(complexFilters);
        }

        command
            .outputOptions(['-c:v', 'copy', '-c:a', 'aac', ...outputMaps])
            .output(outputPath)
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .run();
    });
}

// Module export extension
if (typeof module !== 'undefined' && module.exports) {
    module.exports.replaceAudio = replaceAudio;
}

/**
 * Video Katmanı Ekle (Picture-in-Picture / Overlay)
 * Bir video üzerine başka bir video yerleştirir
 * 
 * @param {Object} params
 * @param {string} params.mainVideoPath - Ana video dosyası
 * @param {string} params.layerVideoPath - Katman video dosyası (üste yerleşecek)
 * @param {string} params.outputPath - Çıktı dosyası
 * @param {Object} params.position - { x, y } piksel cinsinden konum
 * @param {Object} params.size - { width, height } piksel cinsinden boyut
 * @param {number} params.startTime - Katmanın başlayacağı zaman (saniye)
 * @param {number} params.endTime - Katmanın biteceği zaman (saniye, 0=video sonu)
 * @param {number} params.layerVolume - Katman ses seviyesi (0-200)
 * @param {number} params.mainVolume - Ana video ses seviyesi (0-200)
 * @param {boolean} params.muteLayer - Katmanın sesini kapat
 * @param {boolean} params.keepAspect - En-boy oranını koru
 * @param {number} params.syncOffset - Senkronizasyon offset'i (ms, pozitif = katman geç başlar)
 * @param {Array} params.cutRegions - Kesilecek bölgeler [{start, end}, ...]
 * @param {Function} onProgress - İlerleme callback
 */
async function addVideoLayer(params, onProgress) {
    const {
        mainVideoPath,
        layerVideoPath,
        outputPath,
        position = { x: 0, y: 0 },
        size = { width: 480, height: 270 },
        startTime = 0,
        endTime = 0,
        layerVolume = 0,
        mainVolume = 100,
        muteLayer = true,
        keepAspect = true,
        syncOffset = 0,  // ms cinsinden offset
        cutRegions = []  // Kesilecek bölgeler
    } = params;

    return new Promise(async (resolve, reject) => {
        try {
            // Ana video metadata'sını al
            const mainMeta = await getVideoMetadata(mainVideoPath);
            const layerMeta = await getVideoMetadata(layerVideoPath);

            const mainWidth = mainMeta.width;
            const mainHeight = mainMeta.height;
            const mainDuration = mainMeta.duration;

            // Bitiş zamanını hesapla
            const effectiveEndTime = endTime > 0 ? Math.min(endTime, mainDuration) : mainDuration;
            const effectiveStartTime = Math.max(0, startTime);

            // Overlay boyutlarını hesapla
            let overlayWidth = size.width;
            let overlayHeight = size.height;

            if (keepAspect && layerMeta.width && layerMeta.height) {
                const layerAspect = layerMeta.width / layerMeta.height;
                // Genişliğe göre yüksekliği ayarla
                overlayHeight = Math.round(overlayWidth / layerAspect);
            }

            // Konum değerlerini sınırla
            const posX = Math.max(0, Math.min(position.x, mainWidth - overlayWidth));
            const posY = Math.max(0, Math.min(position.y, mainHeight - overlayHeight));

            // Complex filter oluştur
            let complexFilters = [];

            // Senkronizasyon offset'ini saniyeye çevir
            const syncOffsetSec = syncOffset / 1000;

            // Kesme bölgeleri varsa select filter oluştur
            // Bu, overlay video ve audio'dan belirtilen bölgeleri çıkarır
            let cutSelectFilter = '';
            if (cutRegions && cutRegions.length > 0) {
                // select filtresi için: not(between(t,start1,end1)+between(t,start2,end2)+...)
                // Bu, kesilecek bölgeler DIŞINDAKİ kareleri seçer
                const betweenParts = cutRegions.map(r => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`);
                cutSelectFilter = `select='not(${betweenParts.join('+')})',setpts=N/FRAME_RATE/TB`;
                console.log('Cut select filter:', cutSelectFilter);
            }

            // Overlay video'yu ölçeklendir ve offset uygula
            let overlayVideoFilter = `scale=${overlayWidth}:${overlayHeight}`;

            // Kesme filtresi varsa ekle
            if (cutSelectFilter) {
                overlayVideoFilter = cutSelectFilter + ',' + overlayVideoFilter;
            }

            // Offset varsa setpts ile zamanlamayı kaydır
            if (syncOffsetSec !== 0) {
                overlayVideoFilter += `,setpts=PTS+${syncOffsetSec}/TB`;
            }

            complexFilters.push(`[1:v]${overlayVideoFilter}[overlay_scaled]`);

            // Overlay uygula (enable ile zamanlama)
            // Offset varsa enable zamanlamasını da ayarla
            const adjustedStartTime = effectiveStartTime + (syncOffsetSec > 0 ? syncOffsetSec : 0);
            const adjustedEndTime = effectiveEndTime;

            if (adjustedStartTime > 0 || adjustedEndTime < mainDuration) {
                // Belirli zaman aralığında göster
                complexFilters.push(`[0:v][overlay_scaled]overlay=${posX}:${posY}:enable='between(t,${adjustedStartTime},${adjustedEndTime})'[outv]`);
            } else {
                // Tüm video boyunca
                complexFilters.push(`[0:v][overlay_scaled]overlay=${posX}:${posY}[outv]`);
            }

            // Ses miksajı
            const mainVolumeNorm = mainVolume / 100;
            const layerVolumeNorm = layerVolume / 100;

            const hasMainAudio = !!mainMeta.audioCodec;
            const hasLayerAudio = !!layerMeta.audioCodec;
            let hasOutputAudio = false;

            // Kesme bölgeleri için audio select filter
            let cutAudioFilter = '';
            if (cutRegions && cutRegions.length > 0) {
                const betweenParts = cutRegions.map(r => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`);
                cutAudioFilter = `aselect='not(${betweenParts.join('+')})',asetpts=N/SR/TB`;
            }

            if (muteLayer || layerVolume === 0 || !hasLayerAudio) {
                // Sadece ana video sesi (varsa)
                if (hasMainAudio) {
                    complexFilters.push(`[0:a]volume=${mainVolumeNorm}[outa]`);
                    hasOutputAudio = true;
                }
            } else {
                // Katman sesi açık ve mevcut

                // Katman audio filtresi hazırla
                let layerAudioFilter = '';

                // Önce kesme filtresi (varsa)
                if (cutAudioFilter) {
                    layerAudioFilter = cutAudioFilter + ',';
                }

                // Katman audio için offset uygula
                if (syncOffset > 0) {
                    layerAudioFilter += `adelay=${syncOffset}|${syncOffset},volume=${layerVolumeNorm}`;
                } else if (syncOffset < 0) {
                    const trimSec = Math.abs(syncOffsetSec);
                    layerAudioFilter += `atrim=start=${trimSec},asetpts=PTS-STARTPTS,volume=${layerVolumeNorm}`;
                } else {
                    layerAudioFilter += `volume=${layerVolumeNorm}`;
                }

                // Ana video sesi varsa miksle, yoksa sadece katmanı kullan
                if (hasMainAudio) {
                    complexFilters.push(`[0:a]volume=${mainVolumeNorm}[a0]`);
                    complexFilters.push(`[1:a]${layerAudioFilter}[a1]`);
                    complexFilters.push(`[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[outa]`);
                    hasOutputAudio = true;
                } else {
                    // Sadece katman sesi
                    complexFilters.push(`[1:a]${layerAudioFilter}[outa]`);
                    hasOutputAudio = true;
                }
            }

            // GPU encoder tespit et
            const gpuEncoder = await detectGpuEncoder();
            const videoCodec = gpuEncoder || 'libx264';

            let outputOptions = [];
            if (gpuEncoder) {
                if (gpuEncoder.includes('nvenc')) {
                    outputOptions = ['-preset', 'p4', '-rc', 'vbr', '-cq', '23'];
                } else if (gpuEncoder.includes('videotoolbox')) {
                    outputOptions = ['-q:v', '65'];
                } else {
                    outputOptions = ['-preset', 'veryfast', '-crf', '23'];
                }
            } else {
                outputOptions = ['-preset', 'fast', '-crf', '23'];
            }

            console.log(`Video Katmanı Ekleniyor: ${videoCodec} (GPU: ${gpuEncoder ? 'EVET' : 'HAYIR'})`);
            console.log(`Konum: ${posX},${posY} | Boyut: ${overlayWidth}x${overlayHeight}`);
            console.log(`Zaman: ${effectiveStartTime}s - ${effectiveEndTime}s`);

            ffmpeg(mainVideoPath)
                .input(layerVideoPath)
                .complexFilter(complexFilters)
                .outputOptions([
                    '-map', '[outv]',
                    ...(hasOutputAudio ? ['-map', '[outa]'] : []),
                    '-c:v', videoCodec,
                    '-c:a', 'aac',
                    '-ar', '44100',
                    ...outputOptions
                ])
                .output(outputPath)
                .on('progress', (progress) => {
                    if (onProgress && progress.percent) {
                        onProgress(progress.percent);
                    }
                })
                .on('end', () => {
                    console.log('Video katmanı ekleme tamamlandı:', outputPath);
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('Video katmanı ekleme hatası:', err);
                    reject(err);
                })
                .run();

        } catch (error) {
            reject(error);
        }
    });
}

/**
 * CTA Overlay Ekle (Animasyonlu, Opaklık, Fade)
 * @param {Object} params
 * @param {string} params.mainVideoPath
 * @param {string} params.ctaPath
 * @param {string} params.outputPath
 * @param {string} params.position - 'bottom-right', 'bottom-left', 'top-right', 'top-left', 'center', 'bottom-center'
 * @param {number} params.scale - 0.1 to 2.0 (1.0 = original size relative to video? No, relative to itself usually, but consistent sizing is better. Let's say relative to main video width)
 * @param {number} params.opacity - 0.0 to 1.0
 * @param {number} params.duration - Duration in seconds
 * @param {boolean} params.fade - Enable fade in/out
 * @param {Function} onProgress
 */
async function addCtaOverlay(params, onProgress) {
    const {
        mainVideoPath,
        ctaPath,
        outputPath,
        position = 'bottom-center',
        scale = 0.3, // Ekran genişliğinin %30'u
        opacity = 1.0,
        duration = 5,
        fade = true,
        startTime = 0 // Videonun neresinde başlayacak
    } = params;

    const ffmpeg = require('fluent-ffmpeg');
    const path = require('path');
    const fs = require('fs');

    // Göreli yolları mutlak yola çevir
    let resolvedCtaPath = ctaPath;
    if (!path.isAbsolute(ctaPath)) {
        // Uygulamanın çalıştığı dizine göre çöz
        const possiblePaths = [
            path.join(__dirname, '..', 'renderer', ctaPath),
            path.join(__dirname, '..', '..', 'src', 'renderer', ctaPath),
            path.join(process.cwd(), 'src', 'renderer', ctaPath),
            path.join(process.cwd(), ctaPath)
        ];

        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                resolvedCtaPath = p;
                console.log('CTA dosyası bulundu:', resolvedCtaPath);
                break;
            }
        }
    }

    return new Promise(async (resolve, reject) => {
        try {
            // Metadata al
            const mainMeta = await getVideoMetadata(mainVideoPath);
            const ctaMeta = await getVideoMetadata(resolvedCtaPath);

            const mainWidth = mainMeta.width;
            const mainHeight = mainMeta.height;
            const mainDuration = mainMeta.duration;

            // Efektif süre (video süresini aşamaz)
            const effectiveDuration = Math.min(duration, mainDuration - startTime);

            // 1. Ölçekleme Filtresi
            // CTA'yi ana videonun genişliğine oranla ölçekle
            // scale parametresi 1 üzerinden (0.3 = %30 genişlik)
            // Aspect ratio korunmalı
            const targetWidth = Math.round(mainWidth * scale);
            // -1 for height maintains aspect ratio
            let filterChain = `[1:v]scale=${targetWidth}:-1`;

            // 2. Opaklık
            if (opacity < 1.0) {
                filterChain += `,format=rgba,colorchannelmixer=aa=${opacity}`;
            }

            // 3. Fade In / Out (Overlay akışına uygula)
            if (fade) {
                const fadeDur = 0.5; // Yarım saniye fade
                // Fade In
                filterChain += `,fade=t=in:st=0:d=${fadeDur}:alpha=1`;
                // Fade Out (Bitişten önce)
                // CTA videosunun kendi süresi veya istenen süre
                const fadeOutStart = effectiveDuration - fadeDur;
                if (fadeOutStart > 0) {
                    filterChain += `,fade=t=out:st=${fadeOutStart}:d=${fadeDur}:alpha=1`;
                }
            }

            filterChain += `[cta_processed];`;

            // 4. Konumlandırma
            let overlayX = "(W-w)/2"; // Center default
            let overlayY = "(H-h)/2";
            const margin = 20;

            switch (position) {
                case 'bottom-right':
                    overlayX = `W-w-${margin}`;
                    overlayY = `H-h-${margin}`;
                    break;
                case 'bottom-left':
                    overlayX = `${margin}`;
                    overlayY = `H-h-${margin}`;
                    break;
                case 'top-right':
                    overlayX = `W-w-${margin}`;
                    overlayY = `${margin}`;
                    break;
                case 'top-left':
                    overlayX = `${margin}`;
                    overlayY = `${margin}`;
                    break;
                case 'bottom-center':
                    overlayX = `(W-w)/2`;
                    overlayY = `H-h-${margin}`;
                    break;
                case 'center':
                    overlayX = `(W-w)/2`;
                    overlayY = `(H-h)/2`;
                    break;
            }

            // 5. Overlay Uygula (Zamanlı)
            // enable='between(t, START, END)'
            const endTime = startTime + effectiveDuration;
            filterChain += `[0:v][cta_processed]overlay=x=${overlayX}:y=${overlayY}:enable='between(t,${startTime},${endTime})'[outv]`;

            // 6. FFmpeg Komutunu Hazırla ve Girdileri Yönet
            const command = ffmpeg(mainVideoPath)
                .input(resolvedCtaPath); // Input 1 (CTA Video)

            // Ses Kaynağını Belirle
            const soundParam = params.sound || 'embedded';
            let audioInputIndex = null;
            let outputMaps = ['-map', '[outv]'];

            if (soundParam === 'embedded' && !!ctaMeta.audioCodec) {
                audioInputIndex = 1; // CTA videosunun kendi sesi
            } else if (soundParam && soundParam !== 'none' && soundParam !== 'embedded') {
                // Ses dosyası yolunu çöz
                let resolvedSoundPath = soundParam;
                if (!path.isAbsolute(soundParam)) {
                    const possibleSoundPaths = [
                        path.join(__dirname, '..', 'renderer', soundParam),
                        path.join(__dirname, '..', '..', 'src', 'renderer', soundParam),
                        path.join(process.cwd(), 'src', 'renderer', soundParam),
                        path.join(process.cwd(), soundParam)
                    ];

                    for (const p of possibleSoundPaths) {
                        if (fs.existsSync(p)) {
                            resolvedSoundPath = p;
                            console.log('Ses dosyası bulundu:', resolvedSoundPath);
                            break;
                        }
                    }
                }
                command.input(resolvedSoundPath); // Input 2 (Harici Ses Dosyası)
                audioInputIndex = 2;
            }

            // Ses Filtrelerini Oluştur
            if (audioInputIndex !== null) {
                const delayMs = Math.round(startTime * 1000);
                // [src]atrim=0:DURATION[trimmed]; [trimmed]adelay=START[delayed]; [0:a][delayed]amix[outa]
                // Not: atrim filtresi output stream'in timestamp'lerini sıfırlamaz, bu yüzden adelay düzgün çalışması için
                // sesin 0'dan başladığını varsayarız ya da asetpts=PTS-STARTPTS kullanırız.
                // Basitçe: atrim -> asetpts -> adelay

                const audioSource = `${audioInputIndex}:a`;
                const audioFilter = `[${audioSource}]atrim=0:${effectiveDuration},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[delayed_snd];[0:a][delayed_snd]amix=inputs=2:duration=first[outa]`;

                filterChain += `;${audioFilter}`;
                outputMaps.push('-map', '[outa]');
            } else {
                outputMaps.push('-map', '0:a');
            }

            command.complexFilter(filterChain);

            // GPU encoder
            const gpuEncoder = await detectGpuEncoder();
            const videoCodec = gpuEncoder || 'libx264';
            const outputOpts = gpuEncoder ?
                (gpuEncoder.includes('nvenc') ? ['-preset', 'p4'] : ['-preset', 'veryfast']) :
                ['-preset', 'fast'];

            console.log(`Adding CTA Overlay: ${position}, Scale: ${scale}, Opacity: ${opacity}, Duration: ${duration}s`);

            command
                .outputOptions([
                    '-c:v', videoCodec,
                    '-c:a', 'aac',
                    '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart',
                    ...outputOpts,
                    ...outputMaps
                ])
                .output(outputPath)
                .on('progress', (p) => {
                    if (onProgress) onProgress(p.percent);
                })
                .on('end', () => resolve(outputPath))
                .on('error', (err) => reject(err))
                .run();

        } catch (e) {
            reject(e);
        }
    });
}

// Export video layer function
if (typeof module !== 'undefined' && module.exports) {
    module.exports.addVideoLayer = addVideoLayer;
    module.exports.addCtaOverlay = addCtaOverlay;
}


/**
 * Ses dosyası kesme (Video yok)
 */
function cutAudio(inputPath, outputPath, startTime, endTime, onProgress) {
    const duration = endTime - startTime;
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(duration)
            .noVideo()
            .output(outputPath)
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('end', () => resolve(outputPath))
            .on('error', (err) => {
                console.error("Cut audio error:", err);
                reject(err);
            })
            .run();
    });
}

/**
 * Ses dosyalarını birleştir (Video yok)
 */
function concatenateAudios(inputPaths, outputPath, onProgress) {
    const fs = require('fs');
    const tempDir = path.dirname(outputPath);
    const timestamp = Date.now();
    const listPath = path.join(tempDir, `concat_audio_list_${timestamp}.txt`);

    // Create concat list
    const listContent = inputPaths.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(listPath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions(['-c', 'copy'])
            .output(outputPath)
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('end', () => {
                try { fs.unlinkSync(listPath); } catch (e) { }
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error("Concat audio error:", err);
                try { fs.unlinkSync(listPath); } catch (e) { }
                reject(err);
            })
            .run();
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports.cutAudio = cutAudio;
    module.exports.concatenateAudios = concatenateAudios;
}
