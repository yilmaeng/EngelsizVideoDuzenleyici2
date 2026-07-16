/* =========================================
   RESTORED FUNCTIONS FROM BACKUP
   ========================================= */

/**
 * Ses Senkronizayonu ve Değiştirme (Backup'tan)
 */
function replaceAudio(videoPath, audioPath, offsetMs, muteOriginal, outputPath, onProgress) {
    return new Promise((resolve, reject) => {
        const ffmpeg = require('fluent-ffmpeg');
        // Fluent ffmpeg instance
        const cmd = ffmpeg(videoPath);

        // Audio input with seek if negative offset
        if (offsetMs < 0) {
            const startSec = Math.abs(offsetMs) / 1000.0;
            cmd.input(audioPath).inputOptions(['-ss', startSec.toString()]);
        } else {
            cmd.input(audioPath);
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
            outputMaps = ['-map', '0:v', '-map', newAudioLabel];
        } else {
            // Mix
            complexFilters.push(`[0:a]${newAudioLabel}amix=inputs=2:duration=first:dropout_transition=0[mixed]`);
            outputMaps = ['-map', '0:v', '-map', '[mixed]'];
        }

        if (complexFilters.length > 0) {
            cmd.complexFilter(complexFilters);
        }

        cmd.outputOptions(['-c:v', 'copy', '-c:a', 'aac', ...outputMaps])
            .output(outputPath)
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .run();
    });
}

/**
 * Video Katmanı Ekle (Picture-in-Picture / Overlay) - Backup'tan Restorasyon
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

    const ffmpeg = require('fluent-ffmpeg');

    return new Promise(async (resolve, reject) => {
        try {
            // Ana video metadata'sını al
            const mainMeta = await _getVideoMetadata(mainVideoPath);
            const layerMeta = await _getVideoMetadata(layerVideoPath);

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
            let cutSelectFilter = '';
            if (cutRegions && cutRegions.length > 0) {
                const betweenParts = cutRegions.map(r => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`);
                cutSelectFilter = `select='not(${betweenParts.join('+')})',setpts=N/FRAME_RATE/TB`;
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
            const adjustedStartTime = effectiveStartTime + (syncOffsetSec > 0 ? syncOffsetSec : 0);
            const adjustedEndTime = effectiveEndTime;

            if (adjustedStartTime > 0 || adjustedEndTime < mainDuration) {
                complexFilters.push(`[0:v][overlay_scaled]overlay=${posX}:${posY}:enable='between(t,${adjustedStartTime},${adjustedEndTime})'[outv]`);
            } else {
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
                let layerAudioFilter = '';
                if (cutAudioFilter) {
                    layerAudioFilter = cutAudioFilter + ',';
                }

                if (syncOffset > 0) {
                    layerAudioFilter += `adelay=${syncOffset}|${syncOffset},volume=${layerVolumeNorm}`;
                } else if (syncOffset < 0) {
                    const trimSec = Math.abs(syncOffsetSec);
                    layerAudioFilter += `atrim=start=${trimSec},asetpts=PTS-STARTPTS,volume=${layerVolumeNorm}`;
                } else {
                    layerAudioFilter += `volume=${layerVolumeNorm}`;
                }

                if (hasMainAudio) {
                    complexFilters.push(`[0:a]volume=${mainVolumeNorm}[a0]`);
                    complexFilters.push(`[1:a]${layerAudioFilter}[a1]`);
                    complexFilters.push(`[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[outa]`);
                    hasOutputAudio = true;
                } else {
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

            console.log(`Video Katmanı Ekleniyor: ${videoCodec}`);

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
                    if (onProgress && progress.percent) onProgress(progress.percent);
                })
                .on('end', () => resolve(outputPath))
                .on('error', (err) => reject(err))
                .run();

        } catch (error) {
            reject(error);
        }
    });
}

/**
 * CTA Overlay Ekle (Backup'tan Restorasyon)
 */
async function addCtaOverlay(params, onProgress) {
    const {
        mainVideoPath, ctaPath, outputPath,
        position = 'bottom-center', scale = 0.3, opacity = 1.0,
        duration = 5, fade = true, startTime = 0, sound = 'embedded'
    } = params;

    const ffmpeg = require('fluent-ffmpeg');
    const path = require('path');
    const fs = require('fs');

    let resolvedCtaPath = ctaPath;
    if (!path.isAbsolute(ctaPath)) {
        const possiblePaths = [
            path.join(__dirname, '..', 'renderer', ctaPath),
            path.join(process.cwd(), 'src', 'renderer', ctaPath),
            path.join(process.cwd(), ctaPath)
        ];
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                resolvedCtaPath = p;
                break;
            }
        }
    }

    return new Promise(async (resolve, reject) => {
        try {
            const mainMeta = await _getVideoMetadata(mainVideoPath);
            const ctaMeta = await _getVideoMetadata(resolvedCtaPath);

            const mainWidth = mainMeta.width;
            const effectiveDuration = Math.min(duration, mainMeta.duration - startTime);
            const targetWidth = Math.round(mainWidth * scale);

            let filterChain = `[1:v]scale=${targetWidth}:-1`;
            if (opacity < 1.0) filterChain += `,format=rgba,colorchannelmixer=aa=${opacity}`;

            if (fade) {
                const fadeDur = 0.5;
                filterChain += `,fade=t=in:st=0:d=${fadeDur}:alpha=1`;
                const fadeOutStart = effectiveDuration - fadeDur;
                if (fadeOutStart > 0) filterChain += `,fade=t=out:st=${fadeOutStart}:d=${fadeDur}:alpha=1`;
            }
            filterChain += `[cta_processed];`;

            let overlayX = "(W-w)/2";
            let overlayY = "(H-h)/2";
            const margin = 20;

            switch (position) {
                case 'bottom-right': overlayX = `W-w-${margin}`; overlayY = `H-h-${margin}`; break;
                case 'bottom-left': overlayX = `${margin}`; overlayY = `H-h-${margin}`; break;
                case 'top-right': overlayX = `W-w-${margin}`; overlayY = `${margin}`; break;
                case 'top-left': overlayX = `${margin}`; overlayY = `${margin}`; break;
                case 'bottom-center': overlayX = `(W-w)/2`; overlayY = `H-h-${margin}`; break;
            }

            const endT = startTime + effectiveDuration;
            filterChain += `[0:v][cta_processed]overlay=x=${overlayX}:y=${overlayY}:enable='between(t,${startTime},${endT})'[outv]`;

            const cmd = ffmpeg(mainVideoPath).input(resolvedCtaPath);
            let outputMaps = ['-map', '[outv]'];

            // Ses Ayarları
            if (sound === 'embedded' && ctaMeta.audioCodec) {
                const delayMs = Math.round(startTime * 1000);
                filterChain += `;[1:a]atrim=0:${effectiveDuration},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[delayed_snd];[0:a][delayed_snd]amix=inputs=2:duration=first[outa]`;
                outputMaps.push('-map', '[outa]');
            } else if (sound && sound !== 'none' && sound !== 'embedded' && fs.existsSync(sound)) {
                cmd.input(sound);
                const delayMs = Math.round(startTime * 1000);
                filterChain += `;[2:a]atrim=0:${effectiveDuration},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[delayed_snd];[0:a][delayed_snd]amix=inputs=2:duration=first[outa]`;
                outputMaps.push('-map', '[outa]');
            } else {
                outputMaps.push('-map', '0:a');
            }

            const gpuEncoder = await detectGpuEncoder();
            const videoCodec = gpuEncoder || 'libx264';

            cmd.complexFilter(filterChain)
                .outputOptions([
                    '-c:v', videoCodec,
                    '-c:a', 'aac',
                    '-preset', 'ultrafast',
                    ...outputMaps
                ])
                .output(outputPath)
                .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
                .on('end', () => resolve(outputPath))
                .on('error', (err) => reject(err))
                .run();

        } catch (e) { reject(e); }
    });
}

/**
 * Concat Audio implementation for missing function
 */
async function createAudioFromConcat(concatFilePath, outputPath, onProgress) {
    const ffmpeg = require('fluent-ffmpeg');
    return new Promise((resolve, reject) => {
        ffmpeg().input(concatFilePath).inputOptions(['-f', 'concat', '-safe', '0'])
            .output(outputPath).outputOptions('-c copy')
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('end', () => resolve(outputPath)).on('error', reject).run();
    });
}

async function generateSilence(duration, outputPath) {
    const ffmpeg = require('fluent-ffmpeg');
    return new Promise((r, j) => {
        ffmpeg('anullsrc=r=44100:cl=stereo').inputFormat('lavfi').duration(duration).output(outputPath).on('end', r).on('error', j).run();
    });
}

// === EXPORTS ===
module.exports = {
    setupFFmpeg,
    getVideoMetadata: _getVideoMetadata,
    extractAudio: _extractAudio,
    extractVideo: _extractVideo,
    mixAudio: _mixAudioAdvanced,
    mixAudioAdvanced: _mixAudioAdvanced,
    createAudioFromMix: _createAudioFromMix,
    previewAudioSegment: _previewAudio,
    burnSubtitles: _burnSubtitles,
    addTextOverlay: _addTextOverlay,
    addImageOverlay: _overlayImageToVideo,
    addTransition: _addTransition,

    // Restored functions
    addVideoLayer: addVideoLayer,
    addCtaOverlay: addCtaOverlay,
    replaceAudio: replaceAudio,
    createAudioFromConcat: createAudioFromConcat,
    generateSilence: generateSilence,

    // Existing internal functions
    applyTransitionsSmart: _applyTransitionsWithBreaks,
    safeConvertVideo: _safeConvertVideo,
    detectSilence: _detectSilence,
    formatTime: formatTime,
    createVideoFromImages: _convertImageToVideo,
    cutVideo: cutVideo,
    cutVideoSmart: cutVideoSmart,
    concatenateVideos: concatenateVideos,
    concatenateVideosFast: concatenateVideosFast,
    detectGpuEncoder: detectGpuEncoder,

    // Stubs for features likely not used or missing
    createVerticalVideo: async () => { throw new Error("Feature unavailable."); },
    createVerticalVideoPreview: async () => { throw new Error("Feature unavailable."); },
    applyCtaOverlaysSmart: async () => { throw new Error("Feature unavailable."); }
};
