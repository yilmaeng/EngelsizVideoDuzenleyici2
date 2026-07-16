const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { buildVerticalPlacementFilter } = require('./media-placement');

/* =========================================
   DIAGNOSTIC & UTILS (V61 AUDIO MIXER REVIVAL)
   ========================================= */

function setupFFmpeg() {
    let ffmpegPath, ffprobePath;
    try { ffmpegPath = require('ffmpeg-static'); } catch (e) { }
    if (!ffmpegPath) try { ffmpegPath = require('@ffmpeg-installer/ffmpeg').path; } catch (e) { }
    try { ffprobePath = require('@ffprobe-installer/ffprobe').path; } catch (e) { }
    if (ffmpegPath && ffmpegPath.includes('app.asar')) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    if (ffprobePath && ffprobePath.includes('app.asar')) ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');
    if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
    if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);
    return { ffmpegPath, ffprobePath };
}
const { ffmpegPath, ffprobePath } = setupFFmpeg();
const getVideoMetadata = _getVideoMetadata; // Alias for backup helpers

const formatTime = (s) => {
    if (!s || isNaN(s)) return "00:00:00";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
};

function _getSafePath(p) {
    if (!p) return null;
    let s = (typeof p === 'string') ? p : (p.path || p.filePath || p.src || p.imagePath || p.resolvedPath || p.url || p.assetPath || '');
    if (!s || typeof s !== 'string') return null;
    try {
        if (s.startsWith('http')) return s;
        s = decodeURIComponent(s).trim();
        s = s.replace(/^file:\/\/\//, '').replace(/^local-resource:\/\//, '');
        if (process.platform === 'win32' && /^\/[A-Z]:/i.test(s)) s = s.substring(1);

        // Handle app.asar paths for external binaries like FFmpeg
        if (s.includes('app.asar')) {
            const unpackedPath = s.replace('app.asar', 'app.asar.unpacked');
            if (fs.existsSync(unpackedPath)) {
                return path.normalize(unpackedPath);
            }
        }

        return path.normalize(s);
    } catch (e) { return s; }
}

function cleanArgs(args) {
    const a = Array.from(args);
    if (a[0] && typeof a[0] === 'object' && (a[0].sender || a[0].constructor.name === 'IpcMainInvokeEvent')) {
        return a.slice(1);
    }
    return a;
}

function _isImageFile(p) {
    if (!p || typeof p !== 'string') return false;
    const ext = path.extname(p).toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.bmp', '.webp'].includes(ext);
}

function _parseTimemarkToSeconds(timemark) {
    if (!timemark || typeof timemark !== 'string') return null;
    const parts = timemark.split(':');
    if (parts.length !== 3) return null;
    const hours = parseFloat(parts[0]);
    const minutes = parseFloat(parts[1]);
    const seconds = parseFloat(parts[2]);
    if (![hours, minutes, seconds].every(v => Number.isFinite(v))) return null;
    return (hours * 3600) + (minutes * 60) + seconds;
}

function _getVerticalFormatConfig(format) {
    switch (format) {
        case '4:5':
            return { width: 1080, height: 1350 };
        case '1:1':
            return { width: 1080, height: 1080 };
        case '9:16':
        default:
            return { width: 1080, height: 1920 };
    }
}

function _getVerticalOutputOptions(options = {}, isPreview = false) {
    const codec = options.videoCodec || 'libx264';
    const quality = options.quality || 'balanced';

    if (isPreview) {
        return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart'];
    }

    if (codec === 'libx265') {
        const crf = quality === 'high' ? '24' : quality === 'fast' ? '30' : '27';
        const preset = quality === 'high' ? 'medium' : quality === 'fast' ? 'veryfast' : 'fast';
        return ['-c:v', 'libx265', '-preset', preset, '-crf', crf, '-c:a', 'aac', '-movflags', '+faststart'];
    }

    const crf = quality === 'high' ? '18' : quality === 'fast' ? '28' : '23';
    const preset = quality === 'high' ? 'slow' : quality === 'fast' ? 'veryfast' : 'medium';
    return ['-c:v', 'libx264', '-preset', preset, '-crf', crf, '-c:a', 'aac', '-movflags', '+faststart'];
}

function _isKnownColorValue(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return Boolean(normalized)
        && normalized !== 'unknown'
        && normalized !== 'unspecified'
        && normalized !== 'reserved';
}

function _getVideoColorMetadata(metadata = {}) {
    const videoStream = Array.isArray(metadata.streams)
        ? metadata.streams.find((stream) => stream.codec_type === 'video')
        : null;
    if (!videoStream) {
        return {};
    }
    return {
        colorRange: _isKnownColorValue(videoStream.color_range) ? String(videoStream.color_range).trim() : '',
        colorSpace: _isKnownColorValue(videoStream.color_space) ? String(videoStream.color_space).trim() : '',
        colorPrimaries: _isKnownColorValue(videoStream.color_primaries) ? String(videoStream.color_primaries).trim() : '',
        colorTransfer: _isKnownColorValue(videoStream.color_transfer) ? String(videoStream.color_transfer).trim() : ''
    };
}

function _buildColorMetadataOutputOptions(metadata = {}, buildOptions = {}) {
    const color = metadata.colorMetadata || _getVideoColorMetadata(metadata);
    const defaultToBt709 = Boolean(buildOptions.defaultToBt709);
    const forceBt709 = Boolean(buildOptions.forceBt709);
    const options = [];
    const colorRange = forceBt709 ? 'tv' : (_isKnownColorValue(color.colorRange) ? color.colorRange : '');
    if (_isKnownColorValue(colorRange)) {
        options.push('-color_range', colorRange);
    }
    const colorSpace = forceBt709 ? 'bt709' : (_isKnownColorValue(color.colorSpace) ? color.colorSpace : (defaultToBt709 ? 'bt709' : ''));
    const colorPrimaries = forceBt709 ? 'bt709' : (_isKnownColorValue(color.colorPrimaries) ? color.colorPrimaries : (defaultToBt709 ? 'bt709' : ''));
    const colorTransfer = forceBt709 ? 'bt709' : (_isKnownColorValue(color.colorTransfer) ? color.colorTransfer : (defaultToBt709 ? 'bt709' : ''));
    if (_isKnownColorValue(colorSpace)) {
        options.push('-colorspace', colorSpace);
    }
    if (_isKnownColorValue(colorPrimaries)) {
        options.push('-color_primaries', colorPrimaries);
    }
    if (_isKnownColorValue(colorTransfer)) {
        options.push('-color_trc', colorTransfer);
    }
    return options;
}

function _isHdrVideoMetadata(metadata = {}) {
    const color = metadata.colorMetadata || _getVideoColorMetadata(metadata);
    const transfer = String(color.colorTransfer || '').toLowerCase();
    const primaries = String(color.colorPrimaries || '').toLowerCase();
    const space = String(color.colorSpace || '').toLowerCase();
    const videoStream = Array.isArray(metadata.streams)
        ? metadata.streams.find((stream) => stream.codec_type === 'video')
        : null;
    const sideData = Array.isArray(videoStream?.side_data_list) ? videoStream.side_data_list : [];
    return transfer.includes('smpte2084')
        || transfer.includes('arib-std-b67')
        || transfer.includes('hlg')
        || primaries.includes('bt2020')
        || space.includes('bt2020')
        || sideData.some((item) => String(item?.side_data_type || '').toLowerCase().includes('dovi'));
}

function _buildHdrToSdrFilter(metadata = {}) {
    if (!_isHdrVideoMetadata(metadata)) {
        return '';
    }
    return 'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p';
}

function _buildProcessedVideoColorOutputOptions(metadata = {}) {
    return _buildColorMetadataOutputOptions(metadata, {
        defaultToBt709: true,
        forceBt709: _isHdrVideoMetadata(metadata)
    });
}

function _joinVideoFilters(...filters) {
    return filters
        .flat()
        .map((filter) => String(filter || '').trim())
        .filter(Boolean)
        .join(',');
}

function _buildAtempoFilterChain(tempo) {
    let remainingTempo = Math.max(0.5, Math.min(2, Number(tempo || 1)));
    const filters = [];
    while (remainingTempo > 2) {
        filters.push('atempo=2');
        remainingTempo /= 2;
    }
    while (remainingTempo < 0.5) {
        filters.push('atempo=0.5');
        remainingTempo /= 0.5;
    }
    if (Math.abs(remainingTempo - 1) > 0.03) {
        filters.push(`atempo=${remainingTempo.toFixed(3)}`);
    }
    return filters;
}

function _buildVerticalFilterGraph(options = {}) {
    const { width, height } = _getVerticalFormatConfig(options.format);
    const method = options.method || 'blur';
    const settings = options.settings || {};
    return buildVerticalPlacementFilter({
        targetWidth: width,
        targetHeight: height,
        method,
        settings
    });
}

function _applyVerticalTrim(command, options = {}, isPreview = false) {
    const clip = options.clip || {};
    const hasStart = Number.isFinite(clip.startTime) && clip.startTime >= 0;
    const hasEnd = Number.isFinite(clip.endTime) && clip.endTime > (clip.startTime ?? 0);
    const requestedDuration = Number.isFinite(options.duration) ? options.duration : null;

    if (hasStart) {
        command.setStartTime(clip.startTime);
    }

    let duration = null;
    if (hasStart && hasEnd) {
        duration = Math.max(0.1, clip.endTime - clip.startTime);
    }

    if (isPreview) {
        if (requestedDuration) {
            duration = duration ? Math.min(duration, requestedDuration) : requestedDuration;
        } else if (!duration) {
            duration = 5;
        }
    }

    if (duration) {
        command.setDuration(duration);
    }
}

function _runVerticalVideoJob(inputPath, outputPath, options = {}, onProgress = null, isPreview = false) {
    return new Promise((resolve, reject) => {
        const safeInput = _getSafePath(inputPath);
        const safeOutput = _getSafePath(outputPath);
        if (!safeInput || !safeOutput) {
            reject(new Error('Vertical video input or output path is missing.'));
            return;
        }

        if (path.resolve(safeInput) === path.resolve(safeOutput)) {
            reject(new Error('Vertical video output path cannot be the same as the source file.'));
            return;
        }

        const outputDir = path.dirname(safeOutput);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const stderrLines = [];
        const command = ffmpeg(safeInput);

        _applyVerticalTrim(command, options, isPreview);

        command
            .complexFilter(_buildVerticalFilterGraph(options))
            .outputOptions(['-y'])
            .outputOptions(_getVerticalOutputOptions(options, isPreview))
            .outputOptions(['-map', '[outv]', '-map', '0:a?'])
            .output(safeOutput)
            .on('start', (commandLine) => {
                console.log('[VerticalVideo] FFmpeg started:', commandLine);
            })
            .on('stderr', (line) => {
                const text = String(line || '').trim();
                if (!text) return;
                stderrLines.push(text);
                if (stderrLines.length > 24) {
                    stderrLines.shift();
                }
            })
            .on('progress', (progress) => {
                if (onProgress && typeof onProgress === 'function') {
                    onProgress(progress.percent || 0);
                }
            })
            .on('end', () => resolve({ success: true, outputPath: safeOutput }))
            .on('error', (error) => {
                const stderrSummary = stderrLines.slice(-6).join(' | ');
                console.error('[VerticalVideo] FFmpeg failed:', {
                    input: safeInput,
                    output: safeOutput,
                    isPreview,
                    options,
                    error: error?.message || String(error),
                    stderrSummary
                });
                reject(new Error(stderrSummary ? `${error.message} | ${stderrSummary}` : error.message));
            })
            .run();
    });
}

async function _createVerticalVideo(inputPath, outputPath, options = {}, onProgress = null) {
    return _runVerticalVideoJob(inputPath, outputPath, options, onProgress, false);
}

async function _createVerticalVideoPreview(inputPath, outputPath, options = {}) {
    return _runVerticalVideoJob(inputPath, outputPath, options, null, true);
}

// V61: Restore Audio Mixing Capability
async function _mixAudioAdvanced(options, onProgress) {
    console.log('[MixAudio V61] Starting...', options);

    // safe paths
    const videoPath = _getSafePath(options.videoPath);
    const audioPath = _getSafePath(options.audioPath);
    const outputPath = _getSafePath(options.outputPath);

    if (!videoPath || !audioPath || !outputPath) {
        throw new Error("Missing paths for audio mix");
    }

    const videoVolume = options.videoVolume !== undefined ? options.videoVolume : 1.0;
    const audioVolume = options.audioVolume !== undefined ? options.audioVolume : 1.0;
    const insertTime = options.insertTime || 0;
    const audioTrimStart = options.audioTrimStart || 0;
    const audioTrimEnd = options.audioTrimEnd || 0; // 0 means no end trim usually
    const loopAudio = options.loopAudio || false;

    return new Promise((resolve, reject) => {
        // First get metadata for duration
        ffmpeg.ffprobe(videoPath, (err, videoMeta) => {
            if (err) return reject(err);

            const videoDuration = videoMeta.format.duration;
            const remainingDuration = videoDuration - insertTime;
            const hasVideoAudio = videoMeta.streams.some(s => s.codec_type === 'audio');
            const delayMs = Math.round(insertTime * 1000);

            // Filter Chain Construction
            let filters = [];

            // 1. Prepare Video Audio [0:a] -> [a0]
            if (hasVideoAudio) {
                filters.push(`[0:a]aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp,volume=${videoVolume}[a0]`);
            } else {
                // Generate silence matching video duration if no audio
                filters.push(`anullsrc=r=44100:cl=stereo,atrim=0:${videoDuration}[a0]`);
            }

            // 2. Prepare External Audio [1:a] -> [a1]
            let audioFilters = [];

            // Trim
            if (audioTrimStart > 0 || (audioTrimEnd > audioTrimStart)) {
                let trimPart = `atrim=start=${audioTrimStart}`;
                if (audioTrimEnd > audioTrimStart) trimPart += `:end=${audioTrimEnd}`;
                audioFilters.push(trimPart);
                audioFilters.push('asetpts=PTS-STARTPTS');
            }

            // Standardize
            audioFilters.push('aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp');
            audioFilters.push(`volume=${audioVolume}`);

            // Delay or Loop
            if (loopAudio) {
                audioFilters.push(`aloop=loop=-1:size=2e+09`);
                audioFilters.push(`atrim=0:${remainingDuration}`);
                // If delayed loop needed, we might need adelay after or complex calc. 
                // Assuming simple loop for now as per backup. 
                if (delayMs > 0) audioFilters.push(`adelay=${delayMs}|${delayMs}`);
            } else if (delayMs > 0) {
                audioFilters.push(`adelay=${delayMs}|${delayMs}`);
            }

            const audioChain = audioFilters.join(',');
            // apad ekle (kısa audio yüzünden kesilmesin)
            filters.push(`[1:a]${audioChain},apad[a1]`);

            // 3. Mix [a0][a1] -> [aout]
            // amix yerine amerge+pan kullanıyoruz (ses kaybını önlemek için)
            filters.push(`[a0][a1]amerge=inputs=2[merged]`);
            filters.push(`[merged]pan=stereo|c0=c0+c2|c1=c1+c3[aout]`);

            ffmpeg(videoPath)
                .input(audioPath)
                .complexFilter(filters)
                .outputOptions([
                    '-map 0:v',     // Keep original video
                    '-map [aout]',  // Use mixed audio
                    '-c:v copy',    // Copy video stream (FAST)
                    '-c:a aac',     // Encode audio
                    '-b:a 320k',    // High Quality Audio
                    '-shortest'
                ])
                .output(outputPath)
                .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
                .on('end', () => resolve(outputPath))
                .on('error', (e) => reject(e))
                .run();
        });
    });
}

/**
 * Multiple Audio Segments Mixing (e.g. TTS Chunks)
 */
async function _createAudioFromMix(segments, outputPath, onProgress) {
    // segments: [{ path, offset }]
    console.log(`[AudioMixComplex] Creating mix from ${segments.length} segments`);
    if (!segments || segments.length === 0) throw new Error("No segments provided");
    const preparedSegments = await Promise.all(segments.map(async (segment) => {
        const safePath = _getSafePath(segment.path);
        let dubDuration = 0;
        try {
            const metadata = await _getVideoMetadata(safePath);
            dubDuration = Number(metadata?.duration || metadata?.format?.duration || 0) || 0;
        } catch (_error) {}
        const sourceDuration = Math.max(0, Number(segment.sourceDuration || 0) || 0);
        let tempo = 1;
        if (sourceDuration >= 1 && dubDuration >= 0.5) {
            const desiredDuration = Math.max(0.5, sourceDuration * 0.9);
            tempo = Math.max(0.72, Math.min(1.28, dubDuration / desiredDuration));
        }
        return {
            ...segment,
            path: safePath,
            tempo
        };
    }));

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg();

        // Inputs
        preparedSegments.forEach(seg => {
            cmd.input(seg.path);
        });

        // Filters
        let filterChain = [];
        let mixInputs = [];

        preparedSegments.forEach((seg, i) => {
            const delayMs = Math.round((seg.offset || 0) * 1000);
            const lbl = `a${i}`;
            // aformat: Ensure consistent format before filter
            // adelay: Delay start time
            // volume: Keep original volume (1.0)
            let f = `[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp`;
            const tempoFilters = _buildAtempoFilterChain(seg.tempo);
            if (tempoFilters.length) {
                f += `,${tempoFilters.join(',')}`;
            }
            if (delayMs > 0) {
                f += `,adelay=${delayMs}|${delayMs}`;
            }
            f += `[${lbl}]`;

            filterChain.push(f);
            mixInputs.push(`[${lbl}]`);
        });

        // Amix Strategy
        // Keep the filter chain compatible with older FFmpeg builds.
        // Some installations do not support amix normalize=0.
        const N = segments.length;
        const mixCompensation = Math.max(1, Math.min(64, N));
        filterChain.push(`${mixInputs.join('')}amix=inputs=${N}:dropout_transition=0,volume=${mixCompensation},alimiter=limit=0.95[aout]`);

        cmd.complexFilter(filterChain)
            .outputOptions([
                '-map [aout]',
                '-c:a', 'pcm_s16le', // Output standard WAV
                '-ar', '44100',
                '-ac', '2'
            ])
            .output(outputPath)
            .on('progress', p => {
                if (onProgress && p.percent) onProgress(p.percent);
            })
            .on('end', () => {
                console.log(`[AudioMixComplex] Done: ${outputPath}`);
                resolve({ success: true, outputPath });
            })
            .on('error', (err) => {
                console.error(`[AudioMixComplex] Error:`, err);
                reject(err);
            })
            .run();
    });
}

async function _addSeparateAudioTrack(videoPath, segments, outputPath, options = {}, onProgress) {
    const safeVideoPath = _getSafePath(videoPath);
    const safeOutputPath = _getSafePath(outputPath);
    const safeSegments = (Array.isArray(segments) ? segments : [])
        .map((segment) => ({
            path: segment?.path,
            offset: Math.max(0, Number(segment?.offset || 0)),
            sourceDuration: Math.max(0, Number(segment?.sourceDuration || 0))
        }))
        .filter((segment) => segment.path && fs.existsSync(segment.path));
    if (!safeSegments.length) {
        throw new Error('No valid dubbing segments were found.');
    }

    const tempDubPath = path.join(os.tmpdir(), `evd_dub_track_${Date.now()}.wav`);
    await _createAudioFromMix(safeSegments, tempDubPath, (percent) => {
        if (onProgress) onProgress(Math.min(45, Math.max(0, Number(percent || 0) * 0.45)));
    });

    const metadata = await _getVideoMetadata(safeVideoPath).catch(() => ({}));
    const audioStreamCount = Array.isArray(metadata?.streams)
        ? metadata.streams.filter((stream) => stream.codec_type === 'audio').length
        : 0;
    const hasOriginalAudio = audioStreamCount > 0;
    const dubAudioIndex = Math.max(0, audioStreamCount);
    const trackTitle = String(options?.trackTitle || 'Dublaj + Özgün').trim() || 'Dublaj + Özgün';
    const originalUnderVolume = Math.max(0, Math.min(1, Number(options?.originalUnderVolume ?? 0.18)));
    const dubVolume = Math.max(0.1, Math.min(24, Number(options?.dubVolume ?? 1)));
    const videoDuration = Number(metadata?.format?.duration || metadata?.duration || 0) || 0;
    const dubVoiceTail = videoDuration > 0
        ? `,apad,atrim=0:${Math.max(0.1, videoDuration).toFixed(3)},asetpts=PTS-STARTPTS`
        : '';

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(safeVideoPath).input(tempDubPath);
        const filters = [
            `[1:a]volume=${dubVolume},dynaudnorm=f=150:g=15:m=20,alimiter=limit=0.95,aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp${dubVoiceTail}[dubvoice]`
        ];
        if (hasOriginalAudio && originalUnderVolume > 0) {
            filters.push(
                `[0:a:0]volume=${originalUnderVolume},aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp[origlow]`,
                '[origlow][dubvoice]amix=inputs=2:duration=first:dropout_transition=0,volume=1.25[dubmix]'
            );
        }
        cmd.complexFilter(filters);

        const outputOptions = [
                '-map', '0:v?',
                '-map', '0:a?',
                '-map', hasOriginalAudio && originalUnderVolume > 0 ? '[dubmix]' : '[dubvoice]',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                `-metadata:s:a:${dubAudioIndex}`, `title=${trackTitle}`,
                '-disposition:a:0', '0',
                `-disposition:a:${dubAudioIndex}`, 'default',
                '-max_muxing_queue_size', '9999'
        ];

        cmd.outputOptions(outputOptions)
            .output(safeOutputPath)
            .on('progress', (progress) => {
                if (onProgress) {
                    onProgress(45 + Math.min(55, Math.max(0, Number(progress.percent || 0) * 0.55)));
                }
            })
            .on('end', () => {
                try { fs.unlinkSync(tempDubPath); } catch (_error) {}
                resolve({ success: true, outputPath: safeOutputPath });
            })
            .on('error', (error) => {
                try { fs.unlinkSync(tempDubPath); } catch (_cleanupError) {}
                reject(error);
            })
            .run();
    });
}

async function _addSeparateAudioTrackFromAudio(videoPath, audioPath, outputPath, options = {}, onProgress) {
    const safeVideoPath = _getSafePath(videoPath);
    const safeAudioPath = _getSafePath(audioPath);
    const safeOutputPath = _getSafePath(outputPath);
    if (!safeVideoPath || !fs.existsSync(safeVideoPath)) {
        throw new Error('source_video_missing');
    }
    if (!safeAudioPath || !fs.existsSync(safeAudioPath)) {
        throw new Error('separate_audio_missing');
    }

    const metadata = await _getVideoMetadata(safeVideoPath).catch(() => ({}));
    const audioStreamCount = Array.isArray(metadata?.streams)
        ? metadata.streams.filter((stream) => stream.codec_type === 'audio').length
        : 0;
    const hasOriginalAudio = audioStreamCount > 0;
    const newAudioIndex = Math.max(0, audioStreamCount);
    const trackTitle = String(options?.trackTitle || 'Canlı Çeviri').trim() || 'Canlı Çeviri';
    const originalUnderVolume = Math.max(0, Math.min(1, Number(options?.originalUnderVolume ?? 0.06)));
    const dubVolume = Math.max(0.1, Math.min(24, Number(options?.dubVolume ?? 10)));
    const videoDuration = Number(metadata?.format?.duration || metadata?.duration || 0) || 0;
    const interpVoiceTail = videoDuration > 0
        ? `,apad,atrim=0:${Math.max(0.1, videoDuration).toFixed(3)},asetpts=PTS-STARTPTS`
        : '';

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(safeVideoPath).input(safeAudioPath);
        const filters = [
            `[1:a]volume=${dubVolume},dynaudnorm=f=150:g=15:m=20,alimiter=limit=0.95,aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp${interpVoiceTail}[interpvoice]`
        ];
        if (hasOriginalAudio && originalUnderVolume > 0) {
            filters.push(
                `[0:a:0]volume=${originalUnderVolume},aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp[origlow]`,
                '[origlow][interpvoice]amix=inputs=2:duration=first:dropout_transition=0,volume=1.25,alimiter=limit=0.95[interpmix]'
            );
        }
        cmd.complexFilter(filters);
        cmd.outputOptions([
            '-map', '0:v?',
            '-map', '0:a?',
            '-map', hasOriginalAudio && originalUnderVolume > 0 ? '[interpmix]' : '[interpvoice]',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            `-metadata:s:a:${newAudioIndex}`, `title=${trackTitle}`,
            '-disposition:a:0', 'default',
            `-disposition:a:${newAudioIndex}`, '0',
            '-max_muxing_queue_size', '9999'
        ])
            .output(safeOutputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(Math.max(0, Math.min(100, Number(progress.percent || 0))));
            })
            .on('end', () => resolve({ success: true, outputPath: safeOutputPath }))
            .on('error', reject)
            .run();
    });
}

async function _createSingleDubbedRecording(videoPath, segments, outputPath, options = {}, onProgress) {
    const safeVideoPath = _getSafePath(videoPath);
    const safeOutputPath = _getSafePath(outputPath);
    const safeSegments = (Array.isArray(segments) ? segments : [])
        .map((segment) => ({
            path: segment?.path,
            offset: Math.max(0, Number(segment?.offset || 0)),
            sourceDuration: Math.max(0, Number(segment?.sourceDuration || 0))
        }))
        .filter((segment) => segment.path && fs.existsSync(segment.path));
    if (!safeSegments.length) {
        throw new Error('No valid dubbing segments were found.');
    }

    const tempDubPath = path.join(os.tmpdir(), `evd_single_dub_${Date.now()}.wav`);
    await _createAudioFromMix(safeSegments, tempDubPath, (percent) => {
        if (onProgress) onProgress(Math.min(45, Math.max(0, Number(percent || 0) * 0.45)));
    });

    const metadata = await _getVideoMetadata(safeVideoPath).catch(() => ({}));
    const hasOriginalAudio = Array.isArray(metadata?.streams)
        ? metadata.streams.some((stream) => stream.codec_type === 'audio')
        : false;
    const trackTitle = String(options?.trackTitle || 'Dublaj + Özgün').trim() || 'Dublaj + Özgün';
    const originalUnderVolume = Math.max(0, Math.min(1, Number(options?.originalUnderVolume ?? 0.18)));
    const dubVolume = Math.max(0.1, Math.min(24, Number(options?.dubVolume ?? 1)));
    const videoDuration = Number(metadata?.format?.duration || metadata?.duration || 0) || 0;
    const dubVoiceTail = videoDuration > 0
        ? `,apad,atrim=0:${Math.max(0.1, videoDuration).toFixed(3)},asetpts=PTS-STARTPTS`
        : '';

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(safeVideoPath).input(tempDubPath);
        const filters = [
            `[1:a]volume=${dubVolume},dynaudnorm=f=150:g=15:m=20,alimiter=limit=0.95,aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp${dubVoiceTail}[dubvoice]`
        ];
        if (hasOriginalAudio && originalUnderVolume > 0) {
            filters.push(
                `[0:a:0]volume=${originalUnderVolume},aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp[origlow]`,
                '[origlow][dubvoice]amix=inputs=2:duration=first:dropout_transition=0,volume=1.25[dubmix]'
            );
        }
        cmd.complexFilter(filters);

        const outputOptions = [
            '-map', '0:v?',
            '-map', hasOriginalAudio && originalUnderVolume > 0 ? '[dubmix]' : '[dubvoice]',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-metadata:s:a:0', `title=${trackTitle}`,
            '-max_muxing_queue_size', '9999'
        ];

        cmd.outputOptions(outputOptions)
            .output(safeOutputPath)
            .on('progress', (progress) => {
                if (onProgress) {
                    onProgress(45 + Math.min(55, Math.max(0, Number(progress.percent || 0) * 0.55)));
                }
            })
            .on('end', () => {
                try { fs.unlinkSync(tempDubPath); } catch (_error) {}
                resolve({ success: true, outputPath: safeOutputPath });
            })
            .on('error', (error) => {
                try { fs.unlinkSync(tempDubPath); } catch (_cleanupError) {}
                reject(error);
            })
            .run();
    });
}

async function _createSingleDubbedRecordingFromAudio(videoPath, dubAudioPath, outputPath, options = {}, onProgress) {
    const safeVideoPath = _getSafePath(videoPath);
    const safeDubAudioPath = _getSafePath(dubAudioPath);
    const safeOutputPath = _getSafePath(outputPath);
    if (!safeVideoPath || !fs.existsSync(safeVideoPath)) {
        throw new Error('source_video_missing');
    }
    if (!safeDubAudioPath || !fs.existsSync(safeDubAudioPath)) {
        throw new Error('dubbed_audio_missing');
    }
    const metadata = await _getVideoMetadata(safeVideoPath).catch(() => ({}));
    const hasOriginalAudio = Array.isArray(metadata?.streams)
        ? metadata.streams.some((stream) => stream.codec_type === 'audio')
        : false;
    const trackTitle = String(options?.trackTitle || 'Dublaj + Özgün').trim() || 'Dublaj + Özgün';
    const originalUnderVolume = Math.max(0, Math.min(1, Number(options?.originalUnderVolume ?? 0.06)));
    const dubVolume = Math.max(0.1, Math.min(24, Number(options?.dubVolume ?? 10)));
    const shouldTranscodeVideo = ['.webm', '.mkv'].includes(path.extname(safeVideoPath).toLowerCase());
    const videoDuration = Number(metadata?.format?.duration || metadata?.duration || 0) || 0;
    const dubVoiceTail = videoDuration > 0
        ? `,apad,atrim=0:${Math.max(0.1, videoDuration).toFixed(3)},asetpts=PTS-STARTPTS`
        : '';

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(safeVideoPath).input(safeDubAudioPath);
        const filters = [
            `[1:a]volume=${dubVolume},dynaudnorm=f=150:g=15:m=20,alimiter=limit=0.95,aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp${dubVoiceTail}[dubvoice]`
        ];
        if (hasOriginalAudio && originalUnderVolume > 0) {
            filters.push(
                `[0:a:0]volume=${originalUnderVolume},aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp[origlow]`,
                '[origlow][dubvoice]amix=inputs=2:duration=first:dropout_transition=0,volume=1.25,alimiter=limit=0.95[dubmix]'
            );
        }
        cmd.complexFilter(filters);

        cmd.outputOptions([
            '-y',
            '-map', '0:v?',
            '-map', hasOriginalAudio && originalUnderVolume > 0 ? '[dubmix]' : '[dubvoice]',
            '-c:v', shouldTranscodeVideo ? 'libx264' : 'copy',
            ...(shouldTranscodeVideo ? [
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-preset', 'veryfast',
                '-crf', '23',
                '-pix_fmt', 'yuv420p'
            ] : []),
            '-c:a', 'aac',
            '-b:a', '192k',
            '-metadata:s:a:0', `title=${trackTitle}`,
            '-max_muxing_queue_size', '9999'
        ])
            .output(safeOutputPath)
            .on('progress', (progress) => {
                if (onProgress) {
                    onProgress(Math.max(0, Math.min(100, Number(progress.percent || 0))));
                }
            })
            .on('end', () => resolve({ success: true, outputPath: safeOutputPath }))
            .on('error', reject)
            .run();
    });
}

function _buildRebalancedDubbedAudioFilters(options = {}) {
    const originalAudioIndex = Math.max(0, Number(options?.originalAudioIndex ?? 0) || 0);
    const dubAudioIndex = Math.max(0, Number(options?.dubAudioIndex ?? 1) || 1);
    const originalVolume = Math.max(0, Math.min(1, Number(options?.originalVolume ?? 0.06)));
    const dubVolume = Math.max(0.1, Math.min(24, Number(options?.dubVolume ?? 10)));
    const originalRemovalVolume = Math.max(0, Math.min(1, Number(options?.originalRemovalVolume ?? 0.12)));
    const cancelVolume = originalRemovalVolume * dubVolume;
    return [
        `[0:a:${dubAudioIndex}]volume=${dubVolume},aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp[dubsrc]`,
        `[0:a:${originalAudioIndex}]volume=-${cancelVolume},aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp[origcancel]`,
        '[dubsrc][origcancel]amix=inputs=2:duration=first:dropout_transition=0,dynaudnorm=f=150:g=15:m=20,alimiter=limit=0.95[dubclean]',
        `[0:a:${originalAudioIndex}]volume=${originalVolume},aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp[origlow]`,
        '[origlow][dubclean]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[outa]'
    ];
}

async function _previewRebalancedDubbedRecording(videoPath, outputPath, options = {}, onProgress) {
    const safeVideoPath = _getSafePath(videoPath);
    const safeOutputPath = _getSafePath(outputPath);
    const startTime = Math.max(0, Number(options?.startTime || 0) || 0);
    const duration = Math.max(3, Math.min(60, Number(options?.duration || 20) || 20));
    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(safeVideoPath);
        if (startTime > 0) {
            cmd.inputOptions(['-ss', String(startTime)]);
        }
        cmd.complexFilter(_buildRebalancedDubbedAudioFilters(options))
            .outputOptions([
                '-map', '[outa]',
                '-t', String(duration),
                '-c:a', 'aac',
                '-b:a', '192k'
            ])
            .output(safeOutputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(Math.max(0, Math.min(100, Number(progress.percent || 0))));
            })
            .on('end', () => resolve({ success: true, outputPath: safeOutputPath }))
            .on('error', reject)
            .run();
    });
}

async function _createRebalancedDubbedRecording(videoPath, outputPath, options = {}, onProgress) {
    const safeVideoPath = _getSafePath(videoPath);
    const safeOutputPath = _getSafePath(outputPath);
    const trackTitle = String(options?.trackTitle || 'Dublaj + Özgün').trim() || 'Dublaj + Özgün';
    return new Promise((resolve, reject) => {
        ffmpeg(safeVideoPath)
            .complexFilter(_buildRebalancedDubbedAudioFilters(options))
            .outputOptions([
                '-map', '0:v?',
                '-map', '[outa]',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-metadata:s:a:0', `title=${trackTitle}`,
                '-max_muxing_queue_size', '9999'
            ])
            .output(safeOutputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(Math.max(0, Math.min(100, Number(progress.percent || 0))));
            })
            .on('end', () => resolve({ success: true, outputPath: safeOutputPath }))
            .on('error', reject)
            .run();
    });
}

async function _convertImageToVideo(imgInput, vidOutput, duration) {
    const sIn = _getSafePath(imgInput);
    console.log(`[ImageTransformer] Converting ${path.basename(sIn)} to video (${duration}s)`);
    return new Promise((resolve, reject) => {
        ffmpeg(sIn)
            .loop(duration)
            .outputOptions([
                '-c:v', 'libx264',
                '-t', duration,
                '-pix_fmt', 'yuv420p',
                '-preset', 'ultrafast',
                '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
                '-shortest'
            ])
            .output(vidOutput)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
}

async function _overlayImageToVideo(videoInput, imageInput, output, options = {}) {
    const vidPath = _getSafePath(videoInput);
    const imgPath = _getSafePath(imageInput);
    console.log(`[OverlayMiniMark] Video: ${vidPath}, Image: ${imgPath}`);

    const tempOutput = path.join(os.tmpdir(), `ov_mini_${Date.now()}.mp4`);

    let totalDuration = 0;
    let mainW = 1920;
    let sourceMetadata = {};
    try {
        sourceMetadata = await _getVideoMetadata(vidPath);
        totalDuration = sourceMetadata.duration || 0;
        mainW = sourceMetadata.width || 1920;
    } catch (e) { console.warn('[OverlayMiniMark] Metadata error:', e); }

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(vidPath);
        cmd.input(imgPath).inputOption('-loop 1');

        let x = options.x;
        let y = options.y;

        if (x === undefined && y === undefined && options.position) {
            const p = options.position;
            const pad = 20;
            switch (p) {
                case 'top-left': x = pad; y = pad; break;
                case 'top-right': x = `W-w-${pad}`; y = pad; break;
                case 'bottom-left': x = pad; y = `H-h-${pad}`; break;
                case 'bottom-right': x = `W-w-${pad}`; y = `H-h-${pad}`; break;
                case 'center': x = '(W-w)/2'; y = '(H-h)/2'; break;
                case 'top-center': x = '(W-w)/2'; y = pad; break;
                case 'bottom-center': x = '(W-w)/2'; y = `H-h-${pad}`; break;
                case 'center-left': x = pad; y = '(H-h)/2'; break;
                case 'center-right': x = `W-w-${pad}`; y = '(H-h)/2'; break;
                default: x = 10; y = 10;
            }
        }

        if (x === undefined) x = 10;
        if (y === undefined) y = 10;

        // V115: Scale support
        let targetW = options.width || -1;
        let targetH = options.height || -1;
        if (options.scale && parseFloat(options.scale) > 0) {
            targetW = Math.round(mainW * (parseFloat(options.scale) / 100));
            targetH = -1;
        }

        if (targetW === -1 && targetH === -1) {
            targetW = 300; // Default fallback
        }

        let filterParts = [];
        filterParts.push(`[0:v]${_joinVideoFilters(_buildHdrToSdrFilter(sourceMetadata), 'format=yuv420p')}[v_clean]`);
        filterParts.push('[1:v]format=rgba[img_raw]');
        let currentImgLabel = '[img_raw]';

        if (targetW !== -1 || targetH !== -1) {
            filterParts.push(`${currentImgLabel}scale=${targetW}:${targetH}[img_scaled]`);
            currentImgLabel = '[img_scaled]';
        }

        filterParts.push(`[v_clean]${currentImgLabel}overlay=x=${x}:y=${y}:shortest=1[outv]`);

        cmd.complexFilter(filterParts.join(';'))
            .outputOptions([
                '-map [outv]', '-map 0:a?', '-c:v libx264', '-preset ultrafast', '-c:a copy', '-pix_fmt yuv420p', '-max_muxing_queue_size 9999',
                ..._buildProcessedVideoColorOutputOptions(sourceMetadata)
            ]);

        if (totalDuration > 0) {
            cmd.outputOption(`-t ${totalDuration}`);
        }

        cmd.output(tempOutput)
            .on('end', () => {
                try {
                    if (fs.existsSync(output)) fs.unlinkSync(output);
                    fs.copyFileSync(tempOutput, output);
                    fs.unlinkSync(tempOutput);
                    resolve({ success: true, outputPath: output });
                } catch (err) { reject(err); }
            })
            .on('error', reject)
            .run();
    });
}

async function _addTextOverlay(videoPath, output, text, options) {
    const sIn = _getSafePath(videoPath);
    console.log(`[TextOverlay] Adding text (SVG Method): ${text}`);

    try {
        const sharp = require('sharp');
        const { fontSize = 48, fontColor = 'white', background = 'none', position = 'bottom', startTime = 0, endTime = null } = options || {};

        // 1. Get Video Metadata
        const meta = await _getVideoMetadata(sIn);
        const width = meta.width || 1920;
        const height = meta.height || 1080;

        // 2. Determine Position (SVG Coordinates)
        const p = 40; // padding
        let x = width / 2;
        let y = height - p;
        let anchor = 'middle';

        // Parse Position string
        let pos = (position || 'bottom').toLowerCase();

        if (pos === 'custom') {
            x = options.customX !== undefined ? options.customX : width / 2;
            y = options.customY !== undefined ? options.customY : height / 2;
            anchor = 'start'; // Özel koordinatlarda başlangıcın x,y olmasını varsayıyoruz (klasik)
        } else {
            if (pos === 'center') pos = 'middle-center';

            // Horizontal
            if (pos.includes('left')) { x = p; anchor = 'start'; }
            else if (pos.includes('right')) { x = width - p; anchor = 'end'; }
            else { x = width / 2; anchor = 'middle'; }

            const safeText = (text || '').toString()
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');

            const lines = safeText.split('\n');
            const numLines = lines.length;
            const totalHeight = fontSize + (numLines - 1) * (fontSize * 1.2);

            // Vertical
            if (pos.includes('top')) { y = p + fontSize; }
            else if (pos.includes('middle')) { y = (height / 2) - (totalHeight / 2) + fontSize; }
            else { y = height - p - (totalHeight - fontSize); }
        }

        // Setup multiline text (eğer özel koordinat kullanılsa bile SVG tspan için gerekli)
        const safeText = (text || '').toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        const lines = safeText.split('\n');

        // Shadow for readability
        const shadowStyle = `text-shadow: 2px 2px 4px rgba(0,0,0,0.8);`;

        // Create tspan elements
        const tspanText = lines.map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : 1.2}em">${line}</tspan>`).join('');

        const svg = `
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <style>
                .txt { 
                    font-family: Arial, sans-serif; 
                    font-weight: bold; 
                    fill: ${fontColor}; 
                    font-size: ${fontSize}px; 
                    ${shadowStyle}
                }
            </style>
            <text x="${x}" y="${y}" text-anchor="${anchor}" class="txt">${tspanText}</text>
        </svg>`;

        // 4. Generate Temp Overlay Image
        const tempImg = path.join(os.tmpdir(), `txt_ovl_${Date.now()}.png`);
        await sharp(Buffer.from(svg)).png().toFile(tempImg);

        // 5. Apply Overlay using FFmpeg
        return new Promise((resolve, reject) => {
            let cmd = ffmpeg(sIn)
                .input(tempImg)
                .outputOptions([
                    '-c:v', 'libx264',
                    '-c:a', 'copy',
                    '-preset', 'ultrafast',
                    '-max_muxing_queue_size', '9999',
                    ..._buildProcessedVideoColorOutputOptions(meta)
                ]);

            // Simple overlay filter
            // Note: Use enable if timeline specified
            const baseFilter = _buildHdrToSdrFilter(meta);
            if (endTime !== null && endTime > startTime) {
                cmd.complexFilter(baseFilter
                    ? `[0:v]${baseFilter}[basev];[basev][1:v]overlay=0:0:enable='between(t,${startTime},${endTime})'`
                    : `[0:v][1:v]overlay=0:0:enable='between(t,${startTime},${endTime})'`);
            } else {
                cmd.complexFilter(baseFilter
                    ? `[0:v]${baseFilter}[basev];[basev][1:v]overlay=0:0`
                    : `[0:v][1:v]overlay=0:0`);
            }

            cmd.output(output)
                .on('end', () => {
                    try { fs.unlinkSync(tempImg); } catch (e) { }
                    resolve({ success: true, outputPath: output });
                })
                .on('error', (err) => {
                    try { fs.unlinkSync(tempImg); } catch (e) { }
                    console.error('[TextOverlay] FFmpeg Error:', err);
                    reject(err);
                })
                .run();
        });

    } catch (error) {
        console.error('[TextOverlay] Error:', error);
        throw error; // Propagate error
    }
}

async function _addTransition(videoPath, output, options) {
    const sIn = _getSafePath(videoPath);
    const sourceMetadata = await _getVideoMetadata(sIn).catch(() => ({}));
    return new Promise((resolve, reject) => {
        ffmpeg(sIn)
            .videoFilters(_joinVideoFilters(_buildHdrToSdrFilter(sourceMetadata), 'fade=t=in:st=0:d=1,fade=t=out:st=duration-1:d=1'))
            .output(output).outputOptions([
                '-c:v', 'libx264',
                '-c:a', 'copy',
                ..._buildProcessedVideoColorOutputOptions(sourceMetadata)
            ])
            .on('end', () => resolve({ success: true, outputPath: output }))
            .on('error', reject).run();
    });
}

async function _getVideoMetadata(file) {
    const safePath = _getSafePath(file);
    return new Promise((resolve, reject) => {
        if (!safePath) return reject(new Error(`Invalid Metadata Path: ${file}`));
        if (_isImageFile(safePath)) {
            return resolve({
                duration: 10, durationFormatted: "00:00:10", width: 1920, height: 1080, rotation: 0,
                frameRate: 30, codec: 'png', audioSampleRate: 44100, bitrate: 0, filename: path.basename(safePath), tags: {},
                size: fs.existsSync(safePath) ? fs.statSync(safePath).size : 0
            });
        }
        ffmpeg.ffprobe(safePath, (err, md) => {
            if (err) return reject(err);
            const v = md.streams.find(s => s.codec_type === 'video');
            const a = md.streams.find(s => s.codec_type === 'audio');
            let w = v ? v.width : 0; let h = v ? v.height : 0; let r = 0;
            const getT = (t, k) => { if (!t) return null; let f = Object.keys(t).find(x => x.toLowerCase() === k.toLowerCase()); return f ? t[f] : null; };

            // 0. Direct property check (v.rotation) - Bazı FFmpeg sürümleri/parserlar buraya koyar
            if (v && v.rotation !== undefined) r = parseFloat(v.rotation) || 0;

            // 1. Stream Tags
            if (r === 0 && v && v.tags) r = parseFloat(getT(v.tags, 'rotate')) || 0;

            // 2. Format Tags
            if (r === 0 && md.format.tags) r = parseFloat(getT(md.format.tags, 'rotate')) || 0;

            if (v && r === 0 && v.side_data_list) {
                const sd = v.side_data_list.find(x => x.side_data_type === 'Display Matrix');
                if (sd && sd.rotation) r = parseFloat(sd.rotation);
            }

            console.log(`[VideoMetadata] File=${path.basename(safePath)} RawW=${w} RawH=${h} Rotation=${r}`);

            if (Math.abs(Math.round(r)) === 90 || Math.abs(Math.round(r)) === 270) {
                let t = w; w = h; h = t;
                console.log(`[VideoMetadata] Swapped dimensions: ${w}x${h}`);
            }
            resolve({
                duration: md.format.duration, durationFormatted: formatTime(md.format.duration), width: w, height: h, rotation: r,
                frameRate: v && v.avg_frame_rate ? eval(v.avg_frame_rate) : 24, codec: v ? v.codec_name : 'unknown',
                audioSampleRate: a ? parseInt(a.sample_rate) : 44100, bitrate: parseInt(md.format.bit_rate) || 0,
                colorMetadata: _getVideoColorMetadata(md),
                filename: path.basename(safePath), tags: md.format.tags || {},
                hasAudio: !!a, streams: md.streams, size: md.format.size || (fs.existsSync(safePath) ? fs.statSync(safePath).size : 0)
            });
        });
    });
}


function _findDeepFilter() {
    // 1. Try process.resourcesPath (Production Build - extraResources)
    if (process.resourcesPath) {
        const prodPath = path.join(process.resourcesPath, 'deepfilter', 'deep-filter.exe');
        if (fs.existsSync(prodPath)) return prodPath;

        // Alternative structure in some Electron builds
        const prodPathAlt = path.join(process.resourcesPath, 'src', 'resources', 'deepfilter', 'deep-filter.exe');
        if (fs.existsSync(prodPathAlt)) return prodPathAlt;
    }

    // 2. Try Relative from __dirname (Development)
    const relPath = path.join(__dirname, '../resources/deepfilter/deep-filter.exe');
    if (fs.existsSync(relPath)) return relPath;

    // 3. Fallback to Project Root Relative
    const rootPath = path.join(process.cwd(), 'src', 'resources', 'deepfilter', 'deep-filter.exe');
    if (fs.existsSync(rootPath)) return rootPath;

    // 4. Fallback to Hardcoded (Last Resort - User specific)
    return 'c:\\Users\\engin\\OneDrive\\Belgeler\\KorculVideoEditor\\src\\resources\\deepfilter\\deep-filter.exe';
}

function _buildDeepFilterArgs(inputFile, outputDir, noiseReduction = {}) {
    const level = noiseReduction?.level || 'medium';
    const customValue = Number.isFinite(noiseReduction?.custom) ? noiseReduction.custom : 50;

    const attenMap = {
        low: 25,
        medium: 55,
        high: 85
    };

    const attenLimDb = level === 'custom'
        ? Math.max(0, Math.min(100, Math.round(customValue)))
        : (attenMap[level] ?? attenMap.medium);

    const args = ['-o', outputDir, '--atten-lim-db', String(attenLimDb)];

    if (attenLimDb >= 70) {
        args.push('--pf');
        args.push('--pf-beta', attenLimDb >= 90 ? '0.06' : '0.04');
    }

    args.push(inputFile);

    return args;
}

async function _cutVideoDeepFilter(input, output, start, end, onProgress, noiseReduction = { enabled: true, level: 'medium', custom: 50 }) {
    const sIn = _getSafePath(input); const dur = end - start; const tD = path.dirname(output); const b = path.basename(output, path.extname(output));
    const tV = path.join(tD, `${b}_v.mp4`); const tA = path.join(tD, `${b}_a.wav`); const tC = path.join(tD, `${b}_c.wav`);

    const report = (p) => { if (onProgress && typeof onProgress === 'function') onProgress(p); };
    report(1);

    try {
        // 1. Video stream extract (Hızlı)
        await new Promise((r, j) => ffmpeg(sIn).setStartTime(start).setDuration(dur).videoCodec('libx264').outputOptions('-preset ultrafast').output(tV).on('end', r).on('error', j).run());
        report(20);

        // 2. Audio stream extract for DF (PCM 48k)
        await new Promise((r, j) => ffmpeg(sIn).setStartTime(start).setDuration(dur).noVideo().audioCodec('pcm_s16le').audioFrequency(48000).output(tA).on('end', r).on('error', j).run());
        report(30);

        // 3. DeepFilter Execution
        let dfExe = _findDeepFilter(); let processed = false;
        if (fs.existsSync(dfExe)) {
            const outD = path.join(tD, `dfrun_${Date.now()}`);
            const dfArgs = _buildDeepFilterArgs(tA, outD, noiseReduction);
            // DF progress is hard to parse reliably without cluttering, so we assume it takes the chunk of time.
            await new Promise((r, j) => spawn(dfExe, dfArgs, { cwd: path.dirname(dfExe) }).on('close', c => c === 0 ? r() : j(new Error('DF exit code ' + c))));

            const gen = fs.readdirSync(outD).find(f => f.endsWith('.wav'));
            if (gen) { try { fs.renameSync(path.join(outD, gen), tC); processed = true; } catch (e) { fs.copyFileSync(path.join(outD, gen), tC); processed = true; } }
            try { fs.rmSync(outD, { recursive: true }); } catch (e) { }
        }
        report(90);

        // 4. Merge back
        await new Promise((r, j) => ffmpeg().input(tV).input(processed ? tC : tA).outputOptions(['-c:v copy', '-c:a aac', '-map 0:v', '-map 1:a']).output(output).on('end', r).on('error', j).run());
        report(100);

        [tV, tA, tC].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { } });
        return { success: true };
    } catch (e) { [tV, tA, tC].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (ex) { } }); throw e; }
}

async function _processSegmentWithOverlays(input, output, start, duration, overlays, onProgress) {
    const sIn = _getSafePath(input);
    console.log(`[ProcessSegmentWithOverlays] START. Input: ${sIn}, Duration: ${duration}`);

    // V115: Get main video dimensions for scale calculation
    let mainW = 1920; let mainH = 1080;
    let sourceMetadata = {};
    try {
        const md = await _getVideoMetadata(sIn);
        sourceMetadata = md || {};
        mainW = md.width || 1920;
        mainH = md.height || 1080;
    } catch (e) {
        console.warn('[ProcessSegmentWithOverlays] Metadata error, defaulting to 1080p:', e);
    }

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg()
            .input(sIn)
            .inputOptions([`-ss ${start}`, `-t ${duration}`]);

        let filters = []; let lastV = '0:v'; let subInputs = []; let currentInputIdx = 1;
        const hdrToSdrFilter = _buildHdrToSdrFilter(sourceMetadata);
        if (hdrToSdrFilter) {
            filters.push(`[0:v]${hdrToSdrFilter}[hdr_base]`);
            lastV = 'hdr_base';
        }

        const resolveAsset = (p) => {
            if (!p) return null;
            if (path.isAbsolute(p)) return p;
            const candidates = [
                path.join(process.cwd(), 'src', 'renderer', p),
                path.join(process.cwd(), 'resources', p),
                path.join(__dirname, '../renderer', p),
                path.join(__dirname, '../../renderer', p),
                path.join(process.cwd(), p)
            ];
            for (const c of candidates) { if (fs.existsSync(c)) return c; }
            return p;
        };

        overlays.forEach((ov, i) => {
            let s = _getSafePath(ov.assetPath || ov);
            s = resolveAsset(s);
            if (s && s.endsWith('.webm')) { const p = s.replace('.webm', '.png'); if (fs.existsSync(p)) s = p; }
            if (s && fs.existsSync(s)) {
                const isImage = s.toLowerCase().endsWith('.png') || s.toLowerCase().endsWith('.jpg') || s.toLowerCase().endsWith('.jpeg');
                if (isImage) cmd.input(s).inputOption('-loop 1'); else cmd.input(s);
                subInputs.push({ type: 'video', index: currentInputIdx, obj: ov, isImage, path: s, id: i }); currentInputIdx++;
            } else {
                console.warn(`[ProcessSegmentWithOverlays] Overlay path not found: ${s}`);
            }
            let soundPath = _getSafePath(ov.sound);
            soundPath = resolveAsset(soundPath);
            if (soundPath && fs.existsSync(soundPath)) {
                cmd.input(soundPath); subInputs.push({ type: 'audio', index: currentInputIdx, obj: ov, relStart: (ov.startTime || 0) - start, id: i }); currentInputIdx++;
            }
        });

        subInputs.forEach((item) => {
            const relStart = Math.max(0, (item.obj.startTime || 0) - start);
            const relEnd = relStart + (item.obj.duration || duration);
            const i = item.id;

            if (item.type === 'video') {
                const scaled = `s${i}`; const delayed = `d${i}`; const oved = `o${i}`;

                // V115: Priority Scaling logic (Scale > Width/Height)
                // Expanded V118: Robust Size Parsing (Handle %, px, aliases like size/zoom)

                let targetW = -1;
                let targetH = -1;

                // 1. Helper for size parsing (similar to coord parsing but returns number if possible)
                const parseSize = (val, totalDim) => {
                    if (val === undefined || val === null) return undefined;
                    if (typeof val === 'number') return val;
                    const s = String(val).trim();
                    if (s.endsWith('%')) {
                        const p = parseFloat(s);
                        if (!isNaN(p)) return Math.round(totalDim * (p / 100));
                    }
                    if (s.toLowerCase().endsWith('px')) {
                        const n = parseFloat(s);
                        if (!isNaN(n)) return Math.round(n);
                    }
                    const f = parseFloat(s);
                    if (!isNaN(f) && isFinite(f)) return Math.round(f);
                    return undefined;
                };

                // 2. Check Explicit Width/Height
                const wVal = parseSize(item.obj.width, mainW);
                const hVal = parseSize(item.obj.height, mainH);

                if (wVal !== undefined) targetW = wVal;
                if (hVal !== undefined) targetH = hVal;

                // 3. Check Scale/Size/Zoom (Priority over Width/Height if present)
                let scaleRaw = item.obj.scale;
                if (scaleRaw === undefined) scaleRaw = item.obj.size; // Alias
                if (scaleRaw === undefined) scaleRaw = item.obj.zoom; // Alias

                if (scaleRaw !== undefined) {
                    let sVal = parseFloat(scaleRaw);
                    // Handle "50%" scale string
                    if (typeof scaleRaw === 'string' && scaleRaw.endsWith('%')) {
                        sVal = parseFloat(scaleRaw);
                    }
                    // HEURISTIC: Handle 0.0 - 2.0 as multiplier (0.5 -> 50%)
                    else if (sVal <= 2 && sVal > 0) {
                        // If value is 1, treat as 100%. If 0.5, treat as 50%.
                        // (Assumption: Nobody sets scale to 1% or 2% intentionally on a slide usually)
                        sVal = sVal * 100;
                    }

                    if (!isNaN(sVal) && sVal > 0) {
                        targetW = Math.round(mainW * (sVal / 100));
                        targetH = -1; // Maintain aspect ratio
                        console.log(`[ProcessSegmentWithOverlays] Scaling by %${sVal} (Raw: ${scaleRaw}) -> ${targetW}px`);
                    }
                }

                // V119: Force Even Dimensions (prevent odd-size errors) & Min Size
                if (targetW !== -1) {
                    if (targetW < 2) targetW = 2; // Min width 2px
                    if (targetW % 2 !== 0) targetW += 1;
                }
                if (targetH !== -1 && targetH !== -2) { // -1/-2 are ffmpeg constants
                    if (targetH < 2) targetH = 2;
                    if (targetH % 2 !== 0) targetH += 1;
                }

                // FILTER CHAIN CONSTRUCTION
                // 1. Format as RGBA (Preserve Alpha) & Loop for Images
                // V120: Force Loop via Filter - REMOVED, relying on input -loop 1
                // "Option not found" error implies build version might have issues with loop filter params
                // Removing format=rgba as well to reduce potential 'Option not found' surface area (overlay handles format usually)
                let preFilters = [];
                /*
                if (item.isImage) {
                     preFilters.push('loop=loop=-1:size=2:start=0');
                }
                */

                const formatted = `fmt${i}`;
                if (preFilters.length > 0) {
                    filters.push(`[${item.index}:v]${preFilters.join(',')}[${formatted}]`);
                } else {
                    // If no pre-filters, just map input to formatted label (null filter)
                    // or skip formatted step?
                    // Easiest is to just use 'null' filter or alias.
                    // filters.push(`[${item.index}:v]null[${formatted}]`);
                    // actually, let's just make 'currentStream' point to input if no prefilters.
                }

                let currentStream = preFilters.length > 0 ? formatted : `${item.index}:v`;
                if (preFilters.length > 0) {
                    // Add the filter line if we have filters
                    // Note: preFilters logic block above needs to generate this line
                    // But wait, I commented out the logic but not the push.
                }

                // Let's rewrite this block safely.

                if (preFilters.length > 0) {
                    filters.push(`[${item.index}:v]${preFilters.join(',')}[${formatted}]`);
                    currentStream = formatted;
                } else {
                    currentStream = `${item.index}:v`;
                }

                // 2. Scale (if needed)
                if (targetW !== -1 || targetH !== -1) {
                    const scaled = `s${i}`;
                    // Use scale=-1:targetH or targetW:-1 appropriately
                    // If targetW is set and targetH is -1, it maintains aspect ratio.
                    filters.push(`[${currentStream}]scale=${targetW}:${targetH}[${scaled}]`);
                    currentStream = scaled;
                }

                // 3. Time Delay (PTS) for Video Files (Not Images) - Images use full loop
                // Images are looped infinitely, so 'enable' handles visibility.
                if (!item.isImage && relStart > 0) {
                    const delayed = `d${i}`;
                    filters.push(`[${currentStream}]setpts=PTS+${relStart}/TB[${delayed}]`);
                    currentStream = delayed;
                }

                // V117: Robust Coordinate Parsing (Support %, px, left/top alias)
                let x = item.obj.x !== undefined ? item.obj.x : item.obj.left;
                let y = item.obj.y !== undefined ? item.obj.y : item.obj.top;

                const parseCoord = (val, dim) => {
                    if (val === undefined || val === null) return undefined;
                    if (typeof val === 'number') return val;
                    const s = String(val).trim();
                    if (s.endsWith('%')) {
                        const p = parseFloat(s);
                        if (!isNaN(p)) return `(${dim}*${p}/100)`;
                    }
                    if (s.toLowerCase().endsWith('px')) {
                        const n = parseFloat(s);
                        if (!isNaN(n)) return n;
                    }
                    if (!isNaN(parseFloat(s)) && isFinite(s)) return parseFloat(s);
                    return s; // Return as expression
                };

                x = parseCoord(x, 'W');
                y = parseCoord(y, 'H');

                if (x === undefined && y === undefined && item.obj.position) {
                    const p = item.obj.position;
                    const pad = 20;
                    switch (p) {
                        case 'top-left': x = pad; y = pad; break;
                        case 'top-right': x = `W-w-${pad}`; y = pad; break;
                        case 'bottom-left': x = pad; y = `H-h-${pad}`; break;
                        case 'bottom-right': x = `W-w-${pad}`; y = `H-h-${pad}`; break;
                        case 'center': x = '(W-w)/2'; y = '(H-h)/2'; break;
                        case 'top-center': x = '(W-w)/2'; y = pad; break;
                        case 'bottom-center': x = '(W-w)/2'; y = `H-h-${pad}`; break;
                        case 'center-left': x = pad; y = '(H-h)/2'; break;
                        case 'center-right': x = `W-w-${pad}`; y = '(H-h)/2'; break;
                        default: x = 0; y = 0;
                    }
                }

                if (x === undefined) x = 0;
                if (y === undefined) y = 0;

                console.log(`[ProcessSegmentWithOverlays] Overlaying ${item.path} at x=${x}, y=${y}, W=${targetW}`);
                filters.push(`[${lastV}][${currentStream}]overlay=x=${x}:y=${y}:enable='between(t,${relStart},${relEnd})'[${oved}]`);
                lastV = oved;
            } else if (item.type === 'audio') {
                const delayMs = Math.floor(relStart * 1000);
                const audPad = `aud_${item.index}`;
                const filterStr = `[${item.index}:a]aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp,adelay=${delayMs}|${delayMs},apad[${audPad}]`;
                filters.push(filterStr);
            }
        });
        const audios = subInputs.filter(x => x.type === 'audio');
        if (audios.length > 0) {
            filters.push(`[0:a]aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp[v_aud]`);
            let inputs = ['[v_aud]'];
            audios.forEach(x => inputs.push(`[aud_${x.index}]`));

            const N = inputs.length;
            let lefts = [];
            let rights = [];
            for (let k = 0; k < N; k++) {
                lefts.push(`c${k * 2}`);
                rights.push(`c${k * 2 + 1}`);
            }
            filters.push(`${inputs.join('')}amerge=inputs=${N}[merged]`);
            filters.push(`[merged]pan=stereo|c0=${lefts.join('+')}|c1=${rights.join('+')}[aout]`);
        }

        // V114 FIX: Ensure output has standard SAR, even dimensions (for H.264), and YUV420P format.
        // This prevents black screens and "file size drop" issues caused by odd resolutions.
        if (filters.length > 0) {
            filters.push(`[${lastV}]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p[v_final]`);
            lastV = 'v_final';
            cmd.complexFilter(filters);
        }

        const mapV = filters.length > 0 ? `[${lastV}]` : '0:v'; const mapA = (filters.length > 0 && audios.length > 0) ? '[aout]' : '0:a';

        // V114 FIX: Added explicit -t ${duration} to output to prevent hangs.
        // Also ensured CRF 23 and ultrafast are used for reliable export.
        cmd.outputOptions([
            '-map', mapV,
            '-map', mapA,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '23',
            '-c:a', 'aac',
            '-t', duration.toString(),
            '-shortest',
            ..._buildProcessedVideoColorOutputOptions(sourceMetadata)
        ]);

        if (typeof onProgress === 'function') {
            cmd.on('progress', (progress) => {
                if (progress.timemark) {
                    const parts = progress.timemark.split(':');
                    const secs = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
                    const percent = Math.min(99, Math.round((secs / duration) * 100)); // Keep at 99 until end
                    onProgress(percent);
                } else if (progress.percent) {
                    onProgress(Math.min(99, Math.round(progress.percent)));
                }
            });
        }

        cmd.output(output).on('end', () => {
            console.log('[ProcessSegmentWithOverlays] Finished.');
            if (typeof onProgress === 'function') onProgress(100);
            resolve();
        }).on('error', (err) => {
            console.error('[ProcessSegmentWithOverlays] Error:', err);
            reject(err);
        }).run();
    });
}

async function _previewAudio(input, output, start, duration, settings, onStatus) {
    const sIn = _getSafePath(input);
    const tA = path.join(path.dirname(output), 'pa_' + Date.now() + '.wav');

    // Settings defaults
    const s = settings || {};
    const volume = (s.volume !== undefined) ? s.volume : 100;
    const muted = !!s.muted;
    const channelMode = s.channelMode === 'mono' || s.channelMode === 'stereo' ? s.channelMode : 'source';
    const noiseReduction = s.noiseReduction || { enabled: false };
    const audioEffects = s.audioEffects || { echo: false, reverb: false, phone: false };

    console.log(`[PreviewAudio] Start=${start}, Dur=${duration}, Vol=${volume}, Muted=${muted}, NR=${noiseReduction.enabled}`);
    console.log(`[PreviewAudio] Effects: echo=${audioEffects.echo}, reverb=${audioEffects.reverb}, phone=${audioEffects.phone}`);

    try {
        // Step 1: Extract raw audio segment from video
        await new Promise((r, j) => ffmpeg(sIn)
            .setStartTime(start)
            .setDuration(duration)
            .noVideo()
            .audioCodec('pcm_s16le')
            .audioFrequency(48000)
            .output(tA)
            .on('end', r)
            .on('error', j)
            .run()
        );

        let currentFile = tA;

        // Step 2: Apply DeepFilter ONLY if noise reduction is explicitly enabled
        if (noiseReduction.enabled) {
            console.log('[PreviewAudio] Noise Reduction is ENABLED. Applying DeepFilter...');
            let df = _findDeepFilter();
            if (fs.existsSync(df)) {
                if (onStatus) onStatus('processing');
                const oD = path.join(path.dirname(output), `dfp_${Date.now()}`);
                try {
                    const dfArgs = _buildDeepFilterArgs(currentFile, oD, noiseReduction);
                    await new Promise((r, j) => spawn(df, dfArgs, { cwd: path.dirname(df) })
                        .on('close', c => c === 0 ? r() : j(new Error(`DeepFilter exit code: ${c}`))));
                    const g = fs.readdirSync(oD).find(f => f.endsWith('.wav'));
                    if (g) {
                        const dfOut = path.join(path.dirname(output), `pa_df_${Date.now()}.wav`);
                        fs.copyFileSync(path.join(oD, g), dfOut);
                        currentFile = dfOut;
                        console.log('[PreviewAudio] DeepFilter applied successfully.');
                    }
                    try { fs.rmSync(oD, { recursive: true }); } catch (e) { }
                } catch (dfErr) {
                    console.warn('[PreviewAudio] DeepFilter failed, continuing without NR:', dfErr.message);
                    try { fs.rmSync(oD, { recursive: true }); } catch (e) { }
                }
            } else {
                console.warn('[PreviewAudio] DeepFilter binary not found, skipping NR.');
            }
        } else {
            console.log('[PreviewAudio] Noise Reduction is DISABLED. Skipping DeepFilter.');
        }

        // Step 3: Apply volume and audio effects via FFmpeg filters
        const needsFiltering = (volume !== 100) || muted || audioEffects.echo || audioEffects.reverb || audioEffects.phone || channelMode !== 'source';

        if (needsFiltering) {
            console.log('[PreviewAudio] Applying audio filters (volume/effects)...');
            const filteredFile = path.join(path.dirname(output), `pa_filtered_${Date.now()}.wav`);
            const filterParts = [];

            // Volume adjustment
            if (muted) {
                filterParts.push('volume=0');
            } else if (volume !== 100) {
                const volFlt = (volume / 100).toFixed(2);
                filterParts.push(`volume=${volFlt}`);
            }

            // Audio Effects
            if (audioEffects.echo) {
                // Echo: 0.8 gain, 0.88 decay, 60ms delay, 0.4 decay factor
                filterParts.push('aecho=0.8:0.88:60:0.4');
            }
            if (audioEffects.reverb) {
                // Simulate reverb with multiple echoes
                filterParts.push('aecho=0.8:0.9:100|200:0.3|0.25');
            }
            if (audioEffects.phone) {
                // Telephone effect: bandpass 300-3400 Hz + slight distortion
                filterParts.push('highpass=f=300,lowpass=f=3400');
            }

            if (channelMode === 'mono') {
                filterParts.push('aformat=channel_layouts=mono');
            } else if (channelMode === 'stereo') {
                filterParts.push('aformat=channel_layouts=stereo');
            }

            if (filterParts.length > 0) {
                const filterStr = filterParts.join(',');
                console.log(`[PreviewAudio] Filter chain: ${filterStr}`);
                await new Promise((r, j) => ffmpeg(currentFile)
                    .audioFilters(filterStr)
                    .audioCodec('pcm_s16le')
                    .audioFrequency(48000)
                    .noVideo()
                    .output(filteredFile)
                    .on('end', r)
                    .on('error', j)
                    .run()
                );

                // Clean up intermediate if different from tA
                if (currentFile !== tA) {
                    try { fs.unlinkSync(currentFile); } catch (e) { }
                }
                currentFile = filteredFile;
            }
        } else {
            console.log('[PreviewAudio] No filters needed (volume=100, no effects).');
        }

        // Step 4: Move final result to output
        if (currentFile !== output) {
            if (fs.existsSync(output)) fs.unlinkSync(output);
            fs.copyFileSync(currentFile, output);
        }

        // Cleanup temp files
        if (currentFile !== tA && fs.existsSync(currentFile)) {
            try { fs.unlinkSync(currentFile); } catch (e) { }
        }
        if (fs.existsSync(tA)) {
            try { fs.unlinkSync(tA); } catch (e) { }
        }

        console.log('[PreviewAudio] Done:', output);
        return { success: true };

    } catch (e) {
        console.error('[PreviewAudio] Error:', e.message);
        try { if (fs.existsSync(tA)) fs.unlinkSync(tA); } catch (x) { }
        throw e;
    }
}

async function _extractAudio(inputPath, outputPath, onProgress) {
    const sIn = _getSafePath(inputPath);
    return new Promise((resolve, reject) => {
        ffmpeg(sIn)
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

async function _extractVideo(inputPath, outputPath, onProgress) {
    const sIn = _getSafePath(inputPath);
    return new Promise((resolve, reject) => {
        ffmpeg(sIn)
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

async function _detectSilence(inputPath, minDuration = 0.5, threshold = -30, onProgress) {
    const sIn = _getSafePath(inputPath);

    // Video süresini al (ilerleme hesabı için)
    let totalDuration = 0;
    try {
        const metadata = await _getVideoMetadata(sIn);
        totalDuration = metadata.duration || 0;
    } catch (e) {
        console.warn('[DetectSilence] Could not get duration for progress calculation');
    }

    return new Promise((resolve, reject) => {
        const silences = [];
        let currentSilence = null;
        let lastProgressUpdate = 0;

        ffmpeg(sIn)
            .noVideo()
            .audioFilters(`silencedetect=n=${threshold}dB:d=${minDuration}`)
            .outputOptions('-map 0:a:0?')
            .outputOptions('-max_muxing_queue_size 9999')
            .format('null')
            .output('-')
            .on('stderr', (line) => {
                // Sessizlik tespiti
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

                // İlerleme hesabı - time= satırını parse et
                if (totalDuration > 0 && onProgress) {
                    const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
                    if (timeMatch) {
                        const hours = parseInt(timeMatch[1]);
                        const minutes = parseInt(timeMatch[2]);
                        const seconds = parseInt(timeMatch[3]);
                        const centiseconds = parseInt(timeMatch[4]);
                        const currentTime = hours * 3600 + minutes * 60 + seconds + centiseconds / 100;

                        const percent = Math.min(99, Math.round((currentTime / totalDuration) * 100));

                        // Sadece değişiklik olunca güncelle (performans için)
                        if (percent > lastProgressUpdate) {
                            lastProgressUpdate = percent;
                            onProgress(percent);
                        }
                    }
                }
            })
            .on('end', () => {
                if (onProgress) onProgress(100);
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
 * Videoyu döndür (90°, -90°/270°, 180°)
 */
function _rotateVideo(inputPath, outputPath, degrees, onProgress) {
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
            return Promise.reject(new Error('Geçersiz döndürme açısı'));
    }

    const sIn = _getSafePath(inputPath);
    return _getVideoMetadata(sIn).catch(() => ({})).then((metadata) => new Promise((resolve, reject) => {
        ffmpeg(sIn)
            .videoFilters(_joinVideoFilters(_buildHdrToSdrFilter(metadata), transpose))
            .outputOptions([
                '-map', '0:v:0',
                '-map', '0:a?',
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'copy',
                '-movflags', '+faststart',
                ..._buildProcessedVideoColorOutputOptions(metadata)
            ])
            .output(outputPath)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    }));
}

function _normalizeVideoRotation(inputPath, outputPath, onProgress) {
    const sIn = _getSafePath(inputPath);
    const sOut = _getSafePath(outputPath);
    return _getVideoMetadata(sIn).catch(() => ({})).then((metadata) => new Promise((resolve, reject) => {
        const cmd = ffmpeg(sIn);
        const hdrToSdrFilter = _buildHdrToSdrFilter(metadata);
        if (hdrToSdrFilter) {
            cmd.videoFilters(hdrToSdrFilter);
        }
        cmd
            .outputOptions([
                '-map', '0:v:0',
                '-map', '0:a?',
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'copy',
                '-movflags', '+faststart',
                '-metadata:s:v:0', 'rotate=0',
                ..._buildProcessedVideoColorOutputOptions(metadata)
            ])
            .output(sOut)
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => resolve(sOut))
            .on('error', reject)
            .run();
    }));
}


module.exports = {
    extractAudio: async function () { const args = cleanArgs(arguments); return _extractAudio(args[0], args[1], args[2]); },
    extractVideo: async function () { const args = cleanArgs(arguments); return _extractVideo(args[0], args[1], args[2]); },
    detectSilence: async function () { const args = cleanArgs(arguments); return _detectSilence(args[0], args[1], args[2], args[3]); },
    rotateVideo: async function () { const args = cleanArgs(arguments); return _rotateVideo(args[0], args[1], args[2], args[3]); },
    normalizeVideoRotation: async function () { const args = cleanArgs(arguments); return _normalizeVideoRotation(args[0], args[1], args[2]); },
    getFFmpegPaths: setupFFmpeg,
    formatTime: formatTime,

    getVideoMetadata: async function () { return _getVideoMetadata(cleanArgs(arguments)[0]); },
    extractFrameBase64: async function () {
        try {
            const args = cleanArgs(arguments);
            let [v, t] = args;
            if ((typeof v === 'number' || !v) && typeof t === 'string') { const temp = v; v = t; t = temp; }
            const safePath = _getSafePath(v);
            const tp = path.join(os.tmpdir(), `ai_f_${Date.now()}.jpg`);
            await new Promise((r, j) => ffmpeg(safePath).screenshots({ timestamps: [t || 0], filename: path.basename(tp), folder: path.dirname(tp) }).on('end', r).on('error', j));
            const b64 = fs.readFileSync(tp).toString('base64');
            try { fs.unlinkSync(tp) } catch (e) { }
            return b64;
        } catch (e) { throw e; }
    },
    extractFrame: async function () {
        try {
            const args = cleanArgs(arguments); let [v, t, o] = args;
            if (typeof t === 'string' && typeof o === 'number') { const x = t; t = o; o = x; } else if (typeof v === 'number' && typeof t === 'string') { const x = v; v = t; t = x; }
            const sIn = _getSafePath(v);
            return new Promise((r, j) => ffmpeg(sIn).screenshots({ timestamps: [t], filename: path.basename(o), folder: path.dirname(o) }).on('end', () => r(o)).on('error', j));
        } catch (e) { throw e; }
    },
    previewAudioSegment: async function () { return _previewAudio.apply(null, cleanArgs(arguments)); },

    // V106: Timeline render - chunk-based processing ile
    // Optional options object support added for Fast Export
    renderTimeline: async function () {
        const args = cleanArgs(arguments);
        const options = args[4] || {};
        return module.exports.renderTimeline_Internal(args[0], args[1], args[2], args[3], options);
    },

    renderTimeline_Internal: async function (inp, segs, out, onP, options = {}) {
        const threshold = 50;
        const smartConcatRiskThreshold = 80;
        // Check segment length OR forced smart cut mode
        const useSmartCut = segs.length > threshold || (options && options.forceSmartCut);
        const useSafeSinglePass = segs.length > smartConcatRiskThreshold;

        if (useSafeSinglePass) {
            console.log(`[Render Switch] Using Safe Single-Pass Mode for high segment count. Segs=${segs.length}, Forced=${!!(options && options.forceSmartCut)}`);
            return module.exports._renderTimeline_SinglePass(inp, segs, out, onP);
        } else if (useSmartCut) {
            console.log(`[Render Switch] Using Chunked/Smart Mode. Segs=${segs.length}, Forced=${!!(options && options.forceSmartCut)}`);
            return module.exports._renderTimeline_Chunked(inp, segs, out, onP);
        } else {
            console.log(`[Render Switch] Using Single-Pass Mode. Segs=${segs.length}`);
            return module.exports._renderTimeline_SinglePass(inp, segs, out, onP);
        }
    },

    // V110: Chunked Mode for High Segment Counts (>50)
    // 25 segmentlik gruplar halinde işler (Batch Size: 25)
    // Her batch kendi içinde dikişsizdir (complex filter). Sonuçta batch dosyaları birleştirilir.
    _renderTimeline_Chunked: async function (inp, segs, out, onP) {
        if (module.exports._renderInProgress) {
            console.warn('[Render Chunked] Render already in progress');
            return { success: false, error: 'Render zaten devam ediyor' };
        }
        module.exports._renderInProgress = true;

        console.log(`[Render BackupLogic] Smart Cut Mode Active. Total Segments: ${segs.length}`);

        const tempFiles = []; // Concat edilecek dosyalar
        const intermediateTemps = []; // Ara işlem dosyaları (Hata durumunda silmek için)

        // V114: Hızlı Dışa Aktar için Hedef Çözünürlük (En Uzun Süreli Videodan)
        let targetW = 1920;
        let targetH = 1080;
        let resolutionSet = false;

        // En uzun videodan çözünürlük al
        try {
            let maxDur = -1;
            let bestMeta = null;

            for (const s of segs) {
                const src = s.sourceFile || inp;
                if (!_isImageFile(src)) {
                    try {
                        const m = await _getVideoMetadata(src);
                        if (m && m.duration > maxDur) {
                            maxDur = m.duration;
                            bestMeta = m;
                        }
                    } catch (e) { }
                }
            }

            if (bestMeta && bestMeta.width && bestMeta.height) {
                targetW = bestMeta.width;
                targetH = bestMeta.height;
                resolutionSet = true;
                console.log(`[SmartCut V114] Target Resolution (from longest): ${targetW}x${targetH}`);
            }
        } catch (e) { console.warn('[SmartCut V114] Resolution check warning:', e.message); }

        try {
            // 1. Segment Hazırlığı (Smart Cut)
            for (let i = 0; i < segs.length; i++) {
                const seg = segs[i];
                let cSrc = seg.sourceFile || inp;

                let s = parseFloat(seg.start || 0);
                let e = parseFloat(seg.end || 0);
                if (isNaN(s)) s = 0;
                if (isNaN(e)) e = 10;
                if (e <= s + 0.01) {
                    console.warn(`[Render BackupLogic] Segment ${i} skipped because duration is too short or invalid (${s} -> ${e}).`);
                    if (onP) onP({ operation: 'render-timeline', percent: ((i + 1) / segs.length) * 90, current: i + 1, total: segs.length, stage: 'segment' });
                    continue;
                }
                let relDur = Math.max(0.1, e - s);

                // --- V117: Hız Ayarı ve Fon Sesi (Bağımsız Pre-Process) ---
                if ((seg.speed && seg.speed !== 1.0) || seg.speedBgAudio) {
                    const applySpeed = seg.speed && seg.speed !== 1.0;
                    const speedMultiplier = applySpeed ? seg.speed : 1.0;
                    const targetDur = relDur / speedMultiplier;
                    const speedTemp = path.join(path.dirname(out), `sc_speed_${i}_${Date.now()}.mp4`);
                    intermediateTemps.push(speedTemp);
                    const vPts = applySpeed ? `(PTS-STARTPTS)/${speedMultiplier}` : 'PTS-STARTPTS';

                    let atempoStr = '';
                    if (applySpeed) {
                        let tempSpeed = speedMultiplier;
                        while (tempSpeed > 2.0) {
                            atempoStr += 'atempo=2.0,';
                            tempSpeed /= 2.0;
                        }
                        while (tempSpeed < 0.5 && tempSpeed > 0) {
                            atempoStr += 'atempo=0.5,';
                            tempSpeed /= 0.5;
                        }
                        if (tempSpeed !== 1.0) {
                            atempoStr += `atempo=${tempSpeed}`;
                        } else if (atempoStr.endsWith(',')) {
                            atempoStr = atempoStr.slice(0, -1);
                        }
                    }

                    await new Promise((resolve, reject) => {
                        let cmd = ffmpeg(cSrc);

                        if (seg.speedBgAudio) {
                            // Fon sesi varsa, loop ile inputa al
                            cmd.inputOptions([
                                '-ss', s.toString(),
                                '-t', relDur.toString()
                            ]);
                            cmd.input(seg.speedBgAudio).inputOptions([
                                '-stream_loop', '-1'
                            ]);

                            // Video ve Audio ayarları için complex_filter
                            // Videonun hızını ayarla, Fon sesini sürece yay
                            cmd.complexFilter([
                                `[0:v]setpts=${vPts}[outv]`,
                                `[1:a]asetpts=PTS-STARTPTS,atrim=0:${targetDur},aformat=sample_rates=44100:channel_layouts=stereo,volume=1.0[outa]`
                            ]);

                            cmd.outputOptions([
                                '-map', '[outv]',
                                '-map', '[outa]',
                                '-c:v', 'libx264',
                                '-preset', 'fast',
                                '-c:a', 'aac'
                            ]);
                        } else {
                            cmd.inputOptions([
                                '-ss', s.toString(),
                                '-t', relDur.toString()
                            ])
                                .outputOptions([
                                    '-vf', `setpts=${vPts}`,
                                    '-c:v', 'libx264',
                                    '-preset', 'fast'
                                ]);

                            if (atempoStr) {
                                let aFilters = atempoStr;
                                if (seg.isMuted) aFilters += ',volume=0';
                                cmd.outputOptions(['-filter:a', aFilters, '-c:a', 'aac']);
                            } else if (seg.isMuted) {
                                cmd.outputOptions(['-filter:a', 'volume=0', '-c:a', 'aac']);
                            }
                        }

                        cmd.output(speedTemp)
                            .on('end', resolve)
                            .on('error', (err, stdout, stderr) => {
                                console.error('[Speed Processing Error]:', err.message);
                                console.error('FFmpeg stderr:', stderr);
                                reject(err);
                            })
                            .run();
                    });

                    cSrc = speedTemp;
                    s = 0;
                    relDur = targetDur;
                    e = relDur;

                    // Fon sesi işlendiği için bir daha muting ve speed'e gerek kalmadı
                    seg.speed = 1.0;
                    seg.isMuted = false;
                    seg.speedBgAudio = null;
                }

                // Çözünürlük Kontrolü (Smart Cut için kritik)
                let needsRescale = false;
                try {
                    if (resolutionSet && !_isImageFile(cSrc)) {
                        const m = await _getVideoMetadata(cSrc);
                        if (m && (m.width !== targetW || m.height !== targetH)) {
                            needsRescale = true;
                            console.log(`[SmartCut V112] Segment ${i} resolution mismatch (${m.width}x${m.height} != ${targetW}x${targetH}). Force re-encode.`);
                        }
                    }
                } catch (x) { }

                // V113: Eğer çözünürlük farklıysa, efektlerden (overlay/nr) ÖNCE scale et.
                // Böylece overlay doğru koordinata oturur ve output bozulmaz.
                if (needsRescale) {
                    const scaledTemp = path.join(path.dirname(out), `sc_scaled_${i}_${Date.now()}.mp4`);
                    intermediateTemps.push(scaledTemp);
                    // cutVideo fonksiyonuna width/height göndererek scale ediyoruz
                    // start/end kullanılabilir veya 0-duration, ama burada bütün dosyayı scale edip cSrc yapmak daha güvenli.
                    // Fakat cutVideo start/end ister. O anki s/e değerlerini kullanırsak, videoyu KESMİŞ oluruz.
                    // Sonraki adımlarda s=0, e=dur yapmalıyız.

                    await cutVideo(cSrc, scaledTemp, s, e, null, { width: targetW, height: targetH });

                    cSrc = scaledTemp; // Artık kaynağımız bu scale edilmiş (ve kesilmiş) dosya
                    s = 0; // Dosya kesildiği için başı 0
                    e = relDur; // Sonu duration

                    // Artık scale edildiği için needsRescale false yapılmalı
                    needsRescale = false;
                }

                // --- PRE-PROCESS (Image, NR, Overlay) ---
                // Bu işlemler videoyu zaten işler ve keser (start/end uygular).
                // Eğer bu bloklardan biri çalışırsa, daha fazla kesme işlemine gerek yoktur.

                let processedSrc = cSrc;
                let processedStart = s;
                let processedEnd = e;

                // Overlay/NR process...
                // Şu an structure gereği onlara dokunmuyoruz (riski azaltmak için), sadece cutVideoSmart kısmına odaklanıyoruz.
                // İdealde NR/Overlay fonksiyonlarına da targetW/targetH göndermek gerekir.
                // Ancak kullanıcı "içine başka video ekledim" dediği senaryoda genellikle o farklı video temizdir (NR/Overlay yoktur).

                if (_isImageFile(cSrc)) {
                    const tVid = path.join(path.dirname(out), `sc_img_${i}_${Date.now()}.mp4`);
                    intermediateTemps.push(tVid);
                    await _convertImageToVideo(cSrc, tVid, relDur);
                    processedSrc = tVid; processedStart = 0; processedEnd = relDur;
                }
                else if (seg.noiseReduction?.enabled) {
                    const t = path.join(path.dirname(out), `sc_nr_${i}.mp4`);
                    intermediateTemps.push(t);
                    await _cutVideoDeepFilter(cSrc, t, s, e, undefined, seg.noiseReduction);
                    processedSrc = t; processedStart = 0; processedEnd = relDur;
                }
                else if (seg.overlays?.length > 0) {
                    const t = path.join(path.dirname(out), `sc_ov_${i}.mp4`);
                    intermediateTemps.push(t);
                    let segDur = relDur;
                    try { const m = await _getVideoMetadata(cSrc); if (m.duration) segDur = m.duration; } catch (x) { }
                    await _processSegmentWithOverlays(cSrc, t, s, segDur, seg.overlays);
                    processedSrc = t; processedStart = 0; processedEnd = relDur;
                }

                // --- SMART CUT MAIN ---
                // Ses seviyesi ayarı gerekiyorsa belirle
                const segVol = seg.audioVolume !== undefined ? seg.audioVolume : 100;
                const segMuted = !!seg.isMuted;
                const needsVolumeAdjust = segMuted || segVol !== 100;

                if (processedSrc !== cSrc) {
                    // OPTIMAL: Zaten işlem gördü.
                    // Volume ayarı gerekiyorsa uygula
                    if (needsVolumeAdjust) {
                        const volOut = path.join(path.dirname(out), `sc_vol_${i}_${Date.now()}.mp4`);
                        intermediateTemps.push(volOut);
                        const volVal = segMuted ? 0 : (segVol / 100);
                        await new Promise((r, j) => ffmpeg(processedSrc)
                            .outputOptions(['-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k'])
                            .audioFilters(`volume=${volVal.toFixed(2)}`)
                            .output(volOut)
                            .on('end', r).on('error', j).run()
                        );
                        tempFiles.push(volOut);
                    } else {
                        tempFiles.push(processedSrc);
                    }
                    // Progress'i manuel güncelle (İşlem bitti say)
                    if (onP) onP({ operation: 'render-timeline', percent: ((i + 1) / segs.length) * 90, current: i + 1, total: segs.length, stage: 'segment' });
                } else {
                    const segOut = path.join(path.dirname(out), `smart_seg_${i}_${Date.now()}.mp4`);
                    // cutVideoSmart kullanarak
                    // Progress hesabı: i. segment tamamlandı + (o anki segmentin % p'si)
                    const segmentLog = (line) => {
                        if (!line) return;
                        const trimmed = String(line).trim();
                        if (!trimmed) return;
                        console.log(`[Render BackupLogic][Segment ${i}] ${trimmed}`);
                    };

                    const progressCb = (p) => {
                        const totalP = ((i + (p / 100)) / segs.length) * 90;
                        if (onP) onP({ operation: 'render-timeline', percent: totalP, current: i + 1, total: segs.length, stage: 'segment' });
                    };

                    if (needsRescale) {
                        // Smart Cut yapma, direkt re-encode et ve scale uygula
                        await cutVideo(processedSrc, segOut, processedStart, processedEnd, progressCb, { width: targetW, height: targetH }, segmentLog);
                    } else {
                        await cutVideoSmart(processedSrc, segOut, processedStart, processedEnd, {}, progressCb, segmentLog);
                    }

                    // Volume ayarı gerekiyorsa uygula
                    if (needsVolumeAdjust) {
                        const volOut = path.join(path.dirname(out), `sc_vol_${i}_${Date.now()}.mp4`);
                        intermediateTemps.push(segOut); // orijinal segOut'u temizlemek için
                        const volVal = segMuted ? 0 : (segVol / 100);
                        await new Promise((r, j) => ffmpeg(segOut)
                            .outputOptions(['-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k'])
                            .audioFilters(`volume=${volVal.toFixed(2)}`)
                            .output(volOut)
                            .on('end', r).on('error', j).run()
                        );
                        tempFiles.push(volOut);
                    } else {
                        tempFiles.push(segOut);
                    }
                }
            }

            // 2. Birleştirme (25'li Chunk ile)
            console.log(`[Render BackupLogic] Concatenating ${tempFiles.length} segments...`);
            if (onP) onP({ operation: 'concat', percent: 90, current: 1, total: tempFiles.length, stage: 'segment' });
            await concatenateVideosFast(tempFiles, out, (p) => {
                const current = Math.min(tempFiles.length, Math.max(1, Math.round((Math.max(0, p || 0) / 100) * tempFiles.length)));
                if (onP) onP({ operation: 'concat', percent: 90 + (p * 0.1), current, total: tempFiles.length, stage: 'segment' });
            });

            // Temizlik
            // Concat sonrası tüm geçici dosyaları sil
            tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
            intermediateTemps.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });

            module.exports._renderInProgress = false;
            return { success: true, outputPath: out };

        } catch (e) {
            console.error('[Render BackupLogic] Fatal Error:', e.message);
            tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (x) { } });
            intermediateTemps.forEach(f => { try { fs.unlinkSync(f); } catch (x) { } });
            module.exports._renderInProgress = false;
            console.warn('[Render BackupLogic] Falling back to Single-Pass mode...');
            if (onP) onP({ operation: 'render-timeline', percent: 0 });
            return module.exports._renderTimeline_SinglePass(inp, segs, out, onP);
        }
    },


    // V109: Orijinal Single-Pass Render (NO CHUNKING)
    // 50 ve altı segmentler için kullanılır.
    _renderTimeline_SinglePass: async function (inp, segs, out, onP) {
        if (module.exports._renderInProgress) {
            console.warn('[Render V109] Render already in progress');
            return { success: false, error: 'Render zaten devam ediyor' };
        }
        module.exports._renderInProgress = true;

        console.log(`[Render V109] Start Single Pass. Total Segments: ${segs.length}`);
        const temps = [];

        // Varsayılan: 1920x1080
        let targetW = 1920;
        let targetH = 1080;
        let longestSourceDuration = -1;
        let estimatedOutputDuration = 0;
        try {
            if (segs.length > 0) {
                let bestMeta = null;

                // Tüm segmentleri tara, en uzun videoyu bul
                // Not: Çok fazla segment varsa bu işlem biraz sürebilir ama doğru sonuç için gerekli.
                for (const s of segs) {
                    const src = s.sourceFile || inp;
                    if (!_isImageFile(src)) {
                        try {
                            const m = await _getVideoMetadata(src);
                            if (m && m.duration > longestSourceDuration) {
                                longestSourceDuration = m.duration;
                                bestMeta = m;
                            }
                        } catch (e) { }
                    }
                }

                if (bestMeta && bestMeta.width && bestMeta.height) {
                    targetW = bestMeta.width;
                    targetH = bestMeta.height;
                    console.log(`[Render V114] Determined output resolution from longest clip: ${targetW}x${targetH} (Duration: ${longestSourceDuration}s)`);
                } else {
                    // Video bulunamadıysa (sadece resim varsa) varsayılan kalır.
                    // İsteğe bağlı: Resimlerden birinin boyutunu al? Şu an 1920x1080.
                }
            }
        } catch (e) {
            console.warn('[Render V114] Could not determine source resolution, using default 1920x1080', e);
        }

        try {
            // V116: DeepFilter (Gürültü Temizleme) varsa hazırlık süresi çok daha uzun sürer.
            // Bu durumda ilerleme çubuğunu daha adil dağıtalım (%50 Hazırlık, %50 Render).
            let hasDeepFilter = segs.some(s => s.noiseReduction && s.noiseReduction.enabled);
            const PREP_WEIGHT = hasDeepFilter ? 50 : 10;
            console.log(`[Render V116] Has DeepFilter=${hasDeepFilter}, PrepWeight=${PREP_WEIGHT}%`);

            // 1. Hazırlık: Segmentleri işle (Overlay, Image, NR)
            const procs = [];
            for (let i = 0; i < segs.length; i++) {
                const seg = segs[i];
                let cSrc = seg.sourceFile || inp;
                let s = parseFloat(seg.start || 0);
                let e = parseFloat(seg.end || 0);
                if (isNaN(s)) s = 0;
                if (isNaN(e)) e = 10;
                if (e <= s + 0.01) {
                    console.warn(`[Render V109] Segment ${i} skipped because duration is too short or invalid (${s} -> ${e}).`);
                    if (onP) onP(((i + 1) / segs.length) * PREP_WEIGHT);
                    continue;
                }
                let relDur = Math.max(0.1, e - s);

                // Progress Calculation for this segment
                const segmentProgressStep = PREP_WEIGHT / segs.length;
                const segmentBaseProgress = (i / segs.length) * PREP_WEIGHT;

                const subProgress = (p) => {
                    if (onP) onP(segmentBaseProgress + (p / 100 * segmentProgressStep));
                };

                // --- V117: Hız Ayarı ve Fon Sesi (Bağımsız Pre-Process) ---
                if (seg.speedBgAudio) {
                    const applySpeed = seg.speed && seg.speed !== 1.0;
                    const speedMultiplier = applySpeed ? seg.speed : 1.0;
                    const targetDur = relDur / speedMultiplier;
                    const speedTemp = path.join(path.dirname(out), `sp_speedbg_${i}_${Date.now()}.mp4`);
                    temps.push(speedTemp);
                    const vPts = applySpeed ? `(PTS-STARTPTS)/${speedMultiplier}` : 'PTS-STARTPTS';

                    await new Promise((resolve, reject) => {
                        let cmd = ffmpeg(cSrc);

                        // Fon sesi varsa, loop ile inputa al
                        cmd.inputOptions([
                            '-ss', s.toString(),
                            '-t', relDur.toString()
                        ]);
                        cmd.input(seg.speedBgAudio).inputOptions([
                            '-stream_loop', '-1'
                        ]);

                        // Video ve Audio ayarları için complex_filter
                        // Videonun hızını ayarla, Fon sesini sürece yay
                        cmd.complexFilter([
                            `[0:v]setpts=${vPts}[outv]`,
                            `[1:a]asetpts=PTS-STARTPTS,atrim=0:${targetDur},aformat=sample_rates=44100:channel_layouts=stereo,volume=1.0[outa]`
                        ]);

                        cmd.outputOptions([
                            '-map', '[outv]',
                            '-map', '[outa]',
                            '-c:v', 'libx264',
                            '-preset', 'fast',
                            '-c:a', 'aac'
                        ]);

                        cmd.output(speedTemp)
                            .on('end', resolve)
                            .on('error', (err, stdout, stderr) => {
                                console.error('[SpeedBg Processing Error]:', err.message);
                                reject(err);
                            })
                            .run();
                    });

                    cSrc = speedTemp;
                    s = 0;
                    // Hedef süreyi yeni süreye dönüştürdü, ileride speed'in tekrar filterlara dahil olmasını önleyelim
                    seg.speed = 1.0;
                    seg.isMuted = false;
                    // Not: e ve relDur'u güncelleyelim.
                    e = targetDur;
                    relDur = targetDur;
                }

                // Pre-process (Image, NR, Overlay)
                if (_isImageFile(cSrc)) {
                    const tVid = path.join(path.dirname(out), `tmp_img_${i}_${Date.now()}.mp4`);
                    temps.push(tVid);
                    await _convertImageToVideo(cSrc, tVid, relDur);
                    cSrc = tVid; s = 0; e = relDur;
                }
                if (seg.noiseReduction?.enabled) {
                    const t = path.join(path.dirname(out), `tmp_nr_${i}.mp4`);
                    temps.push(t);
                    // Pass subProgress to updated function
                    await _cutVideoDeepFilter(cSrc, t, s, e, subProgress, seg.noiseReduction);
                    cSrc = t; s = 0; e = relDur;
                }
                if (seg.overlays?.length > 0) {
                    const t = path.join(path.dirname(out), `tmp_ov_${i}.mp4`);
                    temps.push(t);
                    let segDur = relDur;
                    try { const m = await _getVideoMetadata(cSrc); if (m.duration) segDur = m.duration; } catch (x) { }
                    await _processSegmentWithOverlays(cSrc, t, s, segDur, seg.overlays);
                    cSrc = t; s = 0; e = relDur;
                }

                // Audio Check
                let hasAudio = true;
                try {
                    const md = await _getVideoMetadata(cSrc);
                    if (md.streams) {
                        const aud = md.streams.find(st => st.codec_type === 'audio');
                        if (!aud) hasAudio = false;
                    }
                } catch (x) { hasAudio = true; }

                // Carry audioVolume, isMuted, and speed into procs for filter chain
                const segVol = seg.audioVolume !== undefined ? seg.audioVolume : 100;
                const segMuted = !!seg.isMuted;
                const speed = seg.speed || 1.0;
                estimatedOutputDuration += (relDur / speed);
                procs.push({ f: cSrc, s, e, hasAudio, dur: relDur, audioVolume: segVol, isMuted: segMuted, speed: speed, audioChannelMode: seg.audioChannelMode || 'source' });

                // Segment bitti, segment sonu progress'i gönder
                if (onP) onP({ operation: 'render-timeline', percent: ((i + 1) / segs.length) * PREP_WEIGHT });
            }

            if (onP) onP({ operation: 'render-timeline', percent: PREP_WEIGHT }); // Preparation complete

            // 2. Tek FFmpeg Komutu Oluştur
            console.log(`[Render V109] Building complex filter for ${procs.length} segments...`);

            const cmd = ffmpeg();
            const map = new Map();

            // Inputları ekle
            procs.forEach(p => {
                const sf = _getSafePath(p.f);
                if (!map.has(sf)) {
                    map.set(sf, map.size);
                    cmd.input(sf);
                }
            });

            // Filter zinciri oluştur
            let flt = [];
            procs.forEach((p, i) => {
                const idx = map.get(_getSafePath(p.f));

                const outDur = p.dur / p.speed;
                const vPts = p.speed !== 1.0 ? `(PTS-STARTPTS)/${p.speed}` : 'PTS-STARTPTS';

                // Video: Trim -> ResetPTS -> Scale/Pad -> SAR -> Format
                flt.push(`[${idx}:v]trim=${p.s}:${p.e},setpts=${vPts},scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`);

                if (p.hasAudio) {
                    // Audio: Trim -> ResetPTS -> Tempo -> APAD (Safe) -> Trim (Duration fix) -> Volume -> Format
                    let audioFilter = `[${idx}:a]atrim=${p.s}:${p.e},asetpts=PTS-STARTPTS`;
                    if (p.speed !== 1.0 && !p.isMuted) {
                        let atempoStr = '';
                        let tempSpeed = p.speed;
                        while (tempSpeed > 2.0) {
                            atempoStr += ',atempo=2.0';
                            tempSpeed /= 2.0;
                        }
                        while (tempSpeed < 0.5 && tempSpeed > 0) {
                            atempoStr += ',atempo=0.5';
                            tempSpeed /= 0.5;
                        }
                        if (tempSpeed !== 1.0) {
                            atempoStr += `,atempo=${tempSpeed}`;
                        }
                        audioFilter += atempoStr;
                    }
                    audioFilter += `,apad,atrim=0:${outDur}`;

                    // Apply volume adjustment
                    if (p.isMuted) {
                        audioFilter += ',volume=0';
                    } else if (p.audioVolume !== 100) {
                        const vol = (p.audioVolume / 100).toFixed(2);
                        audioFilter += `,volume=${vol}`;
                    }
                    const targetLayout = p.audioChannelMode === 'mono' ? 'mono' : 'stereo';
                    audioFilter += `,aformat=sample_rates=44100:channel_layouts=${targetLayout}[a${i}]`;
                    flt.push(audioFilter);
                } else {
                    // Silence Gen (Muted or no audio)
                    flt.push(`anullsrc=r=44100:cl=stereo:duration=${outDur}[a${i}]`);
                }
            });

            // Concat
            const complexStr = `${procs.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${procs.length}:v=1:a=1:unsafe=1[ov][oa]`;
            flt.push(complexStr);
            const filterScriptPath = path.join(path.dirname(out), `render_filter_${Date.now()}.txt`);
            fs.writeFileSync(filterScriptPath, flt.join(';\n'));
            temps.push(filterScriptPath);

            // 3. Çalıştır
            let finalizeNotified = false;
            await new Promise((resolve, reject) => {
                cmd.outputOptions([
                        '-filter_complex_script', filterScriptPath,
                        '-map', '[ov]',
                        '-map', '[oa]',
                        '-c:v', 'libx264', '-preset', 'fast',
                        '-c:a', 'aac', '-b:a', '320k', '-ar', '44100', // High Quality Audio
                        '-pix_fmt', 'yuv420p',
                        '-max_muxing_queue_size', '4096',
                        '-threads', '4'
                    ])
                    .output(out)
                    .on('progress', pk => {
                        // PREP_WEIGHT'ten %100'e kadar render
                        // Range: 100 - PREP_WEIGHT
                        const renderRange = 100 - PREP_WEIGHT;
                        let p = Number(pk.percent) || 0;

                        // Complex filter render'larda ffmpeg percent değeri erken doygunluğa ulaşabiliyor.
                        // Timemark varsa onu öncelikli kullan ki %99'a gereğinden erken vurmayalım.
                        if (pk.timemark && estimatedOutputDuration > 0) {
                            const parts = pk.timemark.split(':');
                            if (parts.length === 3) {
                                const s = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
                                const timemarkPercent = (s / estimatedOutputDuration) * 100;
                                if (isFinite(timemarkPercent) && timemarkPercent >= 0) {
                                    p = timemarkPercent;
                                }
                            }
                        }

                        // Scale p (0-100) to (PREP_WEIGHT - 99)
                        const finalP = Math.min(99, PREP_WEIGHT + (p * (renderRange / 100)));
                        if (onP) onP({ operation: 'render-timeline', percent: finalP });

                        if (!finalizeNotified && finalP >= 99) {
                            finalizeNotified = true;
                            if (onP) onP({ operation: 'finalize-export', percent: 99 });
                        }
                    })


                    .on('end', () => {
                        console.log('[Render V109] Successfully completed.');
                        resolve();
                    })
                    .on('error', (err, stdout, stderr) => {
                        console.error('[Render V109] FFmpeg Error:', err.message);
                        console.error(stderr);
                        reject(err);
                    })
                    .run();
            });

            console.log('[Render V109] Cleaning up...');
            temps.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
            module.exports._renderInProgress = false;

            if (onP) onP({ operation: 'finalize-export', percent: 100 }); // Now explicitly set 100% on completion
            return { success: true, outputPath: out };

        } catch (e) {
            console.error('[Render V109] Fatal Error:', e.message);
            module.exports._renderInProgress = false;
            temps.forEach(f => { try { fs.unlinkSync(f); } catch (x) { } });
            throw e;
        }
    },

    // V108: Timeline Render - Mini-Cluster Processing
    // Bellek hatasını önlemek için küçük modüller (Chunks of 5) halinde kusursuz birleştirme.
    // Bu yöntem, Segment-by-Segment (V107) ile Filter-Graph (V106) yaklaşımlarının hibritidir.
    renderTimeline_Internal_Removing: async function (inp, segs, out, onP) {
        if (module.exports._renderInProgress) {
            console.warn('[Render V108] Render already in progress');
            return { success: false, error: 'Render zaten devam ediyor' };
        }
        module.exports._renderInProgress = true;

        // V108: "Mini-Cluster" - 5'erli gruplar
        // Hem bellek taşmasını önler hem de 5'li gruplar içinde kusursuz geçiş sağlar.
        const CHUNK_SIZE = 5;

        console.log(`[Render V108] Start. Total Segments: ${segs.length}, ChunkSize: ${CHUNK_SIZE}`);
        const temps = [];
        const chunkFiles = [];

        try {
            // 1. Segment Hazırlığı (Overlay, Noise Reduction vb.)
            const procs = [];
            for (let i = 0; i < segs.length; i++) {
                const seg = segs[i];
                let cSrc = seg.sourceFile || inp;
                let s = parseFloat(seg.start || 0);
                let e = parseFloat(seg.end || 0);
                if (isNaN(s)) s = 0;
                if (isNaN(e)) e = 10;
                const relDur = Math.max(0.1, e - s);

                // Overlay, Resim vb. varsa önce onları render et (Pre-render)
                if (_isImageFile(cSrc)) {
                    const tVid = path.join(path.dirname(out), `tmp_img_${i}_${Date.now()}.mp4`);
                    temps.push(tVid);
                    await _convertImageToVideo(cSrc, tVid, relDur);
                    cSrc = tVid; s = 0; e = relDur;
                }
                if (seg.noiseReduction?.enabled) {
                    const t = path.join(path.dirname(out), `tmp_nr_${i}.mp4`);
                    temps.push(t);
                    await _cutVideoDeepFilter(cSrc, t, s, e, undefined, seg.noiseReduction);
                    cSrc = t; s = 0; e = relDur;
                }
                if (seg.overlays?.length > 0) {
                    const t = path.join(path.dirname(out), `tmp_ov_${i}.mp4`);
                    temps.push(t);
                    let segDur = relDur;
                    try { const m = await _getVideoMetadata(cSrc); if (m.duration) segDur = m.duration; } catch (x) { }
                    await _processSegmentWithOverlays(cSrc, t, s, segDur, seg.overlays);
                    cSrc = t; s = 0; e = relDur;
                }

                // Audio Check
                let hasAudio = true;
                try {
                    const md = await _getVideoMetadata(cSrc);
                    if (md.streams) {
                        const aud = md.streams.find(st => st.codec_type === 'audio');
                        if (!aud) hasAudio = false;
                    }
                } catch (x) { hasAudio = true; }
                const segVol = seg.audioVolume !== undefined ? seg.audioVolume : 100;
                const segMuted = !!seg.isMuted;
                const speed = seg.speed || 1.0;
                procs.push({ f: cSrc, s, e, hasAudio, dur: relDur, audioVolume: segVol, isMuted: segMuted, speed: speed, audioChannelMode: seg.audioChannelMode || 'source' });
                if (onP) onP((i / segs.length) * 15); // Hazırlık aşaması %0-15
            }

            // 2. Chunk İşleme (Filter Complex ile)
            const totalChunks = Math.ceil(procs.length / CHUNK_SIZE);
            console.log(`[Render V108] Total chunks: ${totalChunks}`);

            for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
                const startIdx = chunkIdx * CHUNK_SIZE;
                const endIdx = Math.min(startIdx + CHUNK_SIZE, procs.length);
                const chunkProcs = procs.slice(startIdx, endIdx);

                const chunkOutput = totalChunks === 1 ? out : path.join(path.dirname(out), `chunk_${chunkIdx}_${Date.now()}.mp4`);
                if (totalChunks > 1) chunkFiles.push(chunkOutput);

                const cmd = ffmpeg();
                const map = new Map();

                // Inputları ekle
                chunkProcs.forEach(p => {
                    const sf = _getSafePath(p.f);
                    if (!map.has(sf)) {
                        map.set(sf, map.size);
                        cmd.input(sf);
                        // V108: Input seek yerine filter trim kullanıyoruz (Daha güvenli frame-accuracy için)
                    }
                });

                let flt = [];
                chunkProcs.forEach((p, i) => {
                    const idx = map.get(_getSafePath(p.f));

                    const outDur = p.dur / (p.speed || 1.0);
                    const vPts = p.speed && p.speed !== 1.0 ? `(PTS-STARTPTS)/${p.speed}` : 'PTS-STARTPTS';

                    // Video Filtresi: Trim, Reset PTS, Scale, Pad, SAR, Format
                    flt.push(`[${idx}:v]trim=${p.s}:${p.e},setpts=${vPts},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`);

                    if (p.hasAudio) {
                        let audioFilter = `[${idx}:a]atrim=${p.s}:${p.e},asetpts=PTS-STARTPTS`;
                        if (p.speed && p.speed !== 1.0 && !p.isMuted) {
                            audioFilter += `,atempo=${p.speed}`;
                        }
                        audioFilter += `,apad,atrim=0:${outDur}`;

                        if (p.isMuted) {
                            audioFilter += ',volume=0';
                        } else if (p.audioVolume !== undefined && p.audioVolume !== 100) {
                            const vol = (p.audioVolume / 100).toFixed(2);
                            audioFilter += `,volume=${vol}`;
                        }
                        const targetLayout = p.audioChannelMode === 'mono' ? 'mono' : 'stereo';
                        audioFilter += `,aformat=sample_rates=44100:channel_layouts=${targetLayout}[a${i}]`;
                        flt.push(audioFilter);
                    } else {
                        // Ses yoksa: Sessizlik üret - duration parametresiyle
                        flt.push(`anullsrc=r=44100:cl=stereo:duration=${outDur}[a${i}]`);
                    }
                });

                // Concat filtresi
                const complexStr = `${chunkProcs.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${chunkProcs.length}:v=1:a=1:unsafe=1[ov][oa]`;
                flt.push(complexStr);

                console.log(`[Render V108] Chunk ${chunkIdx + 1} processing ${chunkProcs.length} segments...`);

                await new Promise((resolve, reject) => {
                    cmd.complexFilter(flt)
                        // V108: Bellek optimizasyonları
                        .outputOptions([
                            '-map', '[ov]',
                            '-map', '[oa]',
                            '-c:v', 'libx264', '-preset', 'fast',
                            '-c:a', 'aac', '-b:a', '320k', '-ar', '44100', // High Quality Audio
                            '-pix_fmt', 'yuv420p',
                            '-max_muxing_queue_size', '1024',
                            '-threads', '2'
                        ])
                        .output(chunkOutput)
                        .on('progress', pk => {
                            const chunkP = (pk.percent || 0) / 100;
                            const totalP = 15 + ((chunkIdx + chunkP) / totalChunks) * 80;
                            if (onP) onP(Math.min(95, totalP));
                        })
                        .on('end', () => {
                            console.log(`[Render V108] Chunk ${chunkIdx + 1}/${totalChunks} OK`);
                            resolve();
                        })
                        .on('error', (err, stdout, stderr) => {
                            console.error(`[Render V108] Chunk Error:`, err.message);
                            console.error(stderr);
                            reject(err);
                        })
                        .run();
                });
            }

            // 3. Final Merge (Eğer birden fazla chunk varsa)
            if (chunkFiles.length > 1) {
                console.log(`[Render V108] Merging ${chunkFiles.length} chunks...`);
                // Stream Copy ile hızlıca birleştir

                const concatListPath = path.join(path.dirname(out), `concat_final_${Date.now()}.txt`);
                const content = chunkFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
                fs.writeFileSync(concatListPath, content);
                temps.push(concatListPath);

                await new Promise((resolve, reject) => {
                    ffmpeg()
                        .input(concatListPath)
                        .inputOptions(['-f', 'concat', '-safe', '0'])
                        .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
                        .output(out)
                        .on('progress', pk => { if (onP) onP(95 + (pk.percent || 0) * 0.05); })
                        .on('end', resolve)
                        .on('error', reject)
                        .run();
                });

                // Chunk dosyalarını sil
                chunkFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
            }

            console.log('[Render V108] Success.');
            module.exports._renderInProgress = false;
            // Temp temizliği
            temps.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
            if (onP) onP(100);
            return { success: true, outputPath: out };

        } catch (e) {
            console.error('[Render V108] Error:', e.message);
            module.exports._renderInProgress = false;
            temps.forEach(f => { try { fs.unlinkSync(f); } catch (x) { } });
            // Hata durumunda chunk dosyalarını da sil
            chunkFiles.forEach(f => { try { fs.unlinkSync(f); } catch (x) { } });
            throw e;
        }
    },



    cutVideoDeepFilter: async function () { return _cutVideoDeepFilter.apply(null, cleanArgs(arguments)); },
    applyCtaOverlaysSmart: async function () {
        // V94 FIX: Argüman sırası düzeltildi - callback 4. argüman
        const [i, o, ovs, onP] = cleanArgs(arguments);
        // V93: Progress callback'i _processSegmentWithOverlays'a ilet
        try {
            const md = await _getVideoMetadata(i);
            const realDur = md.duration || 10;
            return _processSegmentWithOverlays(i, o, 0, realDur, ovs, onP);
        } catch (e) {
            return _processSegmentWithOverlays(i, o, 0, 30, ovs, onP);
        }
    },
    cutVideoClip: async function () {
        const [i, o, s, e, p, opt] = cleanArgs(arguments);
        try {
            const sIn = _getSafePath(i); let start = parseFloat(s); let end = parseFloat(e);
            if (start > end) { const temp = start; start = end; end = temp; }
            return new Promise((r, j) => ffmpeg(sIn).setStartTime(start).setDuration(end - start).output(o).outputOptions(['-c:v', 'libx264', '-an', '-preset', 'ultrafast']).on('end', () => r(o)).on('error', j).run());
        } catch (e) { throw e; }
    },
    createVerticalVideo: async function () {
        const [i, o, opt, onP] = cleanArgs(arguments);
        return _createVerticalVideo(i, o, opt, onP);
    },
    createVerticalVideoPreview: async function () {
        const [i, o, opt] = cleanArgs(arguments);
        return _createVerticalVideoPreview(i, o, opt);
    },
    createSlideshow: async function () {
        const [imgs, o, dur] = cleanArgs(arguments);
        return new Promise((resolve, reject) => {
            const listPath = path.join(os.tmpdir(), `slides_${Date.now()}.txt`);
            const fileContent = imgs.map(img => `file '${_getSafePath(img)}'\nduration ${dur || 3}`).join('\n');
            fs.writeFileSync(listPath, fileContent);
            ffmpeg().input(listPath).inputOptions(['-f', 'concat', '-safe', '0']).output(o).outputOptions(['-c:v', 'libx264', '-pix_fmt', 'yuv420p']).on('end', () => { try { fs.unlinkSync(listPath); } catch (e) { } resolve({ success: true, outputPath: o }); }).on('error', reject).run();
        });
    },
    overlayImageToVideo: async function () { const args = cleanArgs(arguments); return _overlayLayerJudge(args[0], args[1], args[2], args[3]); },
    addImageOverlay: async function () { const args = cleanArgs(arguments); return _overlayLayerJudge(args[0], args[1], args[2], args[3]); },
    addTextOverlay: async function () { const args = cleanArgs(arguments); return _addTextOverlay(args[0], args[1], args[2], args[3]); },
    addTransition: async function () { const args = cleanArgs(arguments); return _addTransition(args[0], args[1], args[2]); },
    safeConvertVideo: async function () {
        const args = cleanArgs(arguments);
        return _safeConvertVideo(args[0], args[1], args[2], args[3]);
    },
    applyTransitionsSmart: async function () { const args = cleanArgs(arguments); return _applyTransitionsSmart(args[0], args[1], args[2], args[3]); },
    cutVideo: async function () {
        const [i, o, s, e, p, opt] = cleanArgs(arguments);
        if (opt?.noiseReduction?.enabled) return _cutVideoDeepFilter(i, o, s, e, undefined, opt.noiseReduction);
        return new Promise((r, j) => ffmpeg(_getSafePath(i)).setStartTime(s).setDuration(e - s).output(o).on('end', () => r(o)).on('error', j).run());
    },
    cutVideoFast: async function () {
        const [i, o, s, e, p, opt] = cleanArgs(arguments);
        if (opt?.mode === 'lossless-expand') {
            return cutVideoFastLossless(i, o, s, e, p);
        }
        return cutVideoFast(i, o, s, e, p);
    },
    getCutVideoFastBounds: async function () {
        const [i, s, e] = cleanArgs(arguments);
        return getCutVideoFastBounds(i, s, e);
    },
    concatenateVideos: async function () {
        const [ip, op, pr] = cleanArgs(arguments);
        const tD = path.dirname(op); const ts = Date.now(); const ns = [];
        try {
            for (let i = 0; i < ip.length; i++) {
                const n = path.join(tD, `n_${i}_${ts}.mp4`);
                await new Promise((r, j) => ffmpeg(_getSafePath(ip[i])).size('1920x1080').fps(30).output(n).on('end', r).on('error', j).run());
                ns.push(n); if (pr) pr((i / ip.length) * 100);
            }
            await new Promise((r, j) => { const c = ffmpeg(); ns.forEach(p => c.input(p)); c.mergeToFile(op, tD).on('end', r).on('error', j); });
            ns.forEach(f => { try { fs.unlinkSync(f) } catch (e) { } }); return { success: true, outputPath: op };
        } catch (e) { ns.forEach(f => { try { fs.unlinkSync(f) } catch (x) { } }); throw e; }
    },

    // V61 Export:
    mixAudio: async function () {
        const args = cleanArgs(arguments);
        // Supports both single object param (ipc style) or separate
        if (args.length === 1 && typeof args[0] === 'object') return _mixAudioAdvanced(args[0]);
        if (args.length >= 2 && typeof args[0] === 'object') return _mixAudioAdvanced(args[0], args[1]); // with callback
        return _mixAudioAdvanced(args[0]);
    },
    createAudioFromMix: async function () {
        // V61 Revival: createAudioFromMix for TTS Chunks
        const args = cleanArgs(arguments);
        // Arg 1: segments array, Arg 2: outputPath, Arg 3: callback
        return _createAudioFromMix(args[0], args[1], args[2]);
    },
    addSeparateAudioTrack: async function () {
        const args = cleanArgs(arguments);
        return _addSeparateAudioTrack(args[0], args[1], args[2], args[3], args[4]);
    },
    createSingleDubbedRecordingFromAudio: async function () {
        const args = cleanArgs(arguments);
        return _createSingleDubbedRecordingFromAudio(args[0], args[1], args[2], args[3], args[4]);
    },
    previewRebalancedDubbedRecording: async function () {
        const args = cleanArgs(arguments);
        return _previewRebalancedDubbedRecording(args[0], args[1], args[2], args[3]);
    },
    createRebalancedDubbedRecording: async function () {
        const args = cleanArgs(arguments);
        return _createRebalancedDubbedRecording(args[0], args[1], args[2], args[3]);
    },
    mixAudioAdvanced: async function () {
        const args = cleanArgs(arguments);
        return _mixAudioAdvanced(args[0], args[1]);
    },
    replaceAudio: async function () {
        const args = cleanArgs(arguments);
        // replaceAudio(videoPath, audioPath, offsetMs, muteOriginal, outputPath, onProgress)
        return _replaceAudio(args[0], args[1], args[2], args[3], args[4], args[5]);
    },
    burnSubtitles: async function () {
        const args = cleanArgs(arguments);
        // burnSubtitles(videoPath, srtPath, outputPath, styleOptions, onProgress)
        return _burnSubtitles(args[0], args[1], args[2], args[3], args[4]);
    },
    // RESTORED FUNCTIONS
    addVideoLayer: async function () { const args = cleanArgs(arguments); return _addVideoLayer(args[0], args[1]); },
    addCtaOverlay: async function () { const args = cleanArgs(arguments); return addCtaOverlay(args[0], args[1]); },
    createAudioFromConcat: async function () { const args = cleanArgs(arguments); return createAudioFromConcat(args[0], args[1], args[2]); },
    generateSilence: async function () { const args = cleanArgs(arguments); return generateSilence(args[0], args[1]); }
};

async function _replaceAudio(videoPath, audioPath, offsetMs, muteOriginal, outputPath, onProgress) {
    const sVid = _getSafePath(videoPath);
    const sAud = _getSafePath(audioPath);
    console.log(`[ReplaceAudio] Vid: ${sVid}, Aud: ${sAud}, Offset: ${offsetMs}, Mute: ${muteOriginal}`);

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(sVid).input(sAud);

        let complex = [];
        let audioMap = ''; // Will hold the label of the audio to map

        // 1. Prepare New Audio (Input 1) with Offset
        // adelay takes milliseconds. If 0, we can skip or use anull, but adelay=0|0 works too.
        const delay = Math.max(0, parseInt(offsetMs) || 0);

        // Define Audio 1 Source
        if (delay > 0) {
            complex.push(`[1:a]adelay=${delay}|${delay}[aud_delayed]`);
        } else {
            complex.push(`[1:a]aformat=channel_layouts=stereo[aud_delayed]`);
        }

        // 2. Decide Output Audio
        if (muteOriginal) {
            // Completely replace: Just use the delayed new audio
            // Note: If video has no audio stream [0:a], this is safe.
            // We map the new audio directly.
            audioMap = '[aud_delayed]';
        } else {
            // Mix: We need [0:a]. 
            // Warning: If [0:a] does not exist, this will fail.
            // Ideally we check metadata, but for speed, let's assume video has audio if user didn't mute it.
            // If we want robustness, we can use 'amovie' or check 'streams'.
            // For now, assume [0:a] exists.

            complex.push(`[0:a]volume=1.0[aud_orig]`);
            complex.push(`[aud_orig][aud_delayed]amix=inputs=2:duration=first:dropout_transition=0[aud_mixed]`);
            audioMap = '[aud_mixed]';
        }

        // 3. Construct Command
        if (complex.length > 0) cmd.complexFilter(complex);

        cmd.outputOptions([
            '-map 0:v',          // Keep original video
            `-map ${audioMap}`,  // Use our calculated audio
            '-c:v copy',         // Fast copy video stream
            '-c:a aac',          // Encode audio to AAC
            '-b:a 320k',         // High Quality Audio
            '-shortest'          // End when the shortest stream (video) ends
        ])
            .output(outputPath)
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('end', () => resolve(outputPath))
            .on('error', (err) => {
                console.error("[ReplaceAudio] Error:", err.message);
                // Fallback: If map [0:a] failed (maybe video has no audio), retry with muteOriginal=true logic?
                // Too complex for now, just reject.
                reject(err);
            })
            .run();
    });
}

// V80 - FRESH START OVERLAY HANDLER
// This version uses fluent-ffmpeg (simplified) with heavy logging and duration protection.
async function _overlayLayerJudge(videoInput, imageInput, output, options = {}) {
    const vidPath = _getSafePath(videoInput);
    const imgPath = _getSafePath(imageInput);
    const isImage = (imgPath && ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif'].includes(path.extname(imgPath).toLowerCase()));

    const tempOutput = path.join(os.tmpdir(), `ov_judge_${Date.now()}.mp4`);
    console.log(`[OverlayLayerJudge V80] START. Video: ${vidPath}, Overlay: ${imgPath}`);

    let duration = 0;
    let sourceMetadata = {};
    try {
        sourceMetadata = await _getVideoMetadata(vidPath);
        duration = sourceMetadata.format.duration;
        console.log(`[OverlayLayerJudge V80] Metadata Duration: ${duration}`);
    } catch (e) {
        console.warn('[OverlayLayerJudge V80] Metadata Error:', e);
    }

    // Robust Option Parsing
    let w = parseInt(options.width);
    let h = parseInt(options.height);
    if (isNaN(w)) w = -1;
    if (isNaN(h)) h = -1;
    let x = parseInt(options.x);
    let y = parseInt(options.y);
    if (isNaN(x)) x = 0;
    if (isNaN(y)) y = 0;

    console.log(`[OverlayLayerJudge V80] Params: x=${x}, y=${y}, w=${w}, h=${h}`);

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(vidPath);

        if (isImage) {
            cmd.input(imgPath).inputOption('-loop 1');
            console.log(`[OverlayLayerJudge V80] Image Mode Activated.`);
        } else {
            cmd.input(imgPath);
            console.log(`[OverlayLayerJudge V80] Video Mode Activated.`);
        }

        const filterParts = [];
        let overlayInput = '1:v';
        if (w !== -1 || h !== -1) {
            filterParts.push(`[1:v]scale=${w}:${h}[scaled]`);
            overlayInput = 'scaled';
        }

        const overlayOpts = isImage ? ':shortest=1' : '';
        const baseFilter = _buildHdrToSdrFilter(sourceMetadata);
        const baseLabel = baseFilter ? 'basev' : '0:v';
        if (baseFilter) {
            filterParts.unshift(`[0:v]${baseFilter}[basev]`);
        }
        filterParts.push(`[${baseLabel}][${overlayInput}]overlay=x=${x}:y=${y}${overlayOpts}[outv]`);

        cmd.complexFilter(filterParts.join(';'))
            .outputOptions([
                '-map [outv]',
                '-map 0:a?',
                '-c:v libx264',
                '-preset ultrafast',
                '-c:a copy',
                '-pix_fmt yuv420p',
                ..._buildProcessedVideoColorOutputOptions(sourceMetadata)
            ]);

        // THE FIX: Force duration limit to match main video
        if (duration > 0) {
            cmd.outputOption(`-t ${duration}`);
            console.log(`[OverlayLayerJudge V80] Applied hard limit: -t ${duration}`);
        }

        cmd.output(tempOutput)
            .on('start', (commandLine) => {
                console.log('[OverlayLayerJudge V80] FFMPEG STARTED: ' + commandLine);
            })
            .on('progress', () => {})
            .on('end', () => {
                console.log('[OverlayLayerJudge V80] FFmpeg End Event Triggered.');
                try {
                    if (fs.existsSync(output)) fs.unlinkSync(output);
                    fs.copyFileSync(tempOutput, output);
                    fs.unlinkSync(tempOutput);
                    console.log('[OverlayLayerJudge V80] SUCCESS: File swapped.');
                    resolve({ success: true, outputPath: output });
                } catch (err) {
                    console.error('[OverlayLayerJudge V80] Finalize Error:', err);
                    reject(err);
                }
            })
            .on('error', (err) => {
                console.error('[OverlayLayerJudge V80] FATAL FFmpeg Error:', err);
                reject(err);
            })
            .run();
    });
}

async function _overlayLayerJudgeOld(videoInput, imageInput, output, options = {}) {
    const vidPath = _getSafePath(videoInput);
    const imgPath = _getSafePath(imageInput);

    // We need path and os, assume they are required at top level
    const isImage = (imgPath && ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif'].includes(path.extname(imgPath).toLowerCase()));

    console.log(`[OverlayLayerJudge] V70 Check. Video: ${vidPath}, Overlay: ${imgPath} (IsImage: ${isImage})`);

    const tempOutput = path.join(os.tmpdir(), `ov_judge_${Date.now()}.mp4`);

    let duration = 0;
    try {
        const meta = await _getVideoMetadata(vidPath);
        duration = meta.format.duration;
    } catch (e) {
        console.warn('[OverlayLayerJudge] Could not get video duration, proceeding without explicit limit.');
    }

    // V79: MANUAL SPAWN APPROACH
    // Replaces fluent-ffmpeg to fix persistent "stuck at 100%" issues.
    const ffmpegPath = require('ffmpeg-static') || require('@ffmpeg-installer/ffmpeg').path;

    // Parse options robustly
    let w = parseInt(options.width);
    let h = parseInt(options.height);
    if (isNaN(w)) w = -1;
    if (isNaN(h)) h = -1;

    let x = parseInt(options.x);
    let y = parseInt(options.y);
    if (isNaN(x)) x = 0;
    if (isNaN(y)) y = 0;

    console.log(`[OverlayLayerJudge V79] Video: ${vidPath}, Overlay: ${imgPath} (IsImage: ${isImage})`);
    console.log(`[OverlayLayerJudge V79] Target: w=${w}, h=${h}, x=${x}, y=${y}, duration=${duration}`);

    return new Promise((resolve, reject) => {
        const args = [];

        // Input 0: Main Video
        args.push('-i', vidPath);

        // Input 1: Overlay (Image loop or Video)
        if (isImage) {
            args.push('-loop', '1');
            args.push('-i', imgPath);
        } else {
            args.push('-i', imgPath);
        }

        // Filter Complex
        let filterParts = [];
        // [0:v] -> [v_clean]
        filterParts.push('[0:v]format=yuv420p[v_clean]');

        // [1:v] -> [img_raw] -> [img_scaled] (optional)
        filterParts.push('[1:v]format=rgba[img_raw]');
        let currentImgLabel = '[img_raw]';

        if (w !== -1 || h !== -1) {
            filterParts.push(`${currentImgLabel}scale=${w}:${h}[img_scaled]`);
            currentImgLabel = '[img_scaled]';
        }

        // Overlay: [v_clean] + [img_current] -> [outv]
        // Extras: shortest=1 only for image loops to prevent infinite loop
        let overlayExtras = isImage ? ':shortest=1' : '';
        filterParts.push(`[v_clean]${currentImgLabel}overlay=x=${x}:y=${y}${overlayExtras}[outv]`);

        args.push('-filter_complex', filterParts.join(';'));

        // Output Options
        args.push('-map', '[outv]');
        args.push('-map', '0:a?'); // Keep main audio if exists
        args.push('-c:v', 'libx264');
        args.push('-preset', 'ultrafast'); // Fast encoding for preview/judge
        args.push('-c:a', 'copy');
        // args.push('-pix_fmt', 'yuv420p'); // default for libx264 but good to explicitly set if needed

        // Duration Limit (Crucial for fix)
        if (duration > 0) {
            args.push('-t', duration.toString());
        }

        args.push('-y', tempOutput);

        console.log(`[OverlayLayerJudge V79] Spawning: ${ffmpegPath} ${args.join(' ')}`);

        const child = spawn(ffmpegPath, args);

        let stderrData = '';
        child.stderr.on('data', (d) => {
            // stderr output for logging if needed
            stderrData += d.toString();
        });

        child.on('close', (code) => {
            if (code === 0) {
                console.log('[OverlayLayerJudge V79] Success.');
                try {
                    if (fs.existsSync(output)) fs.unlinkSync(output);
                    fs.copyFileSync(tempOutput, output);
                    fs.unlinkSync(tempOutput);
                    resolve({ success: true, outputPath: output });
                } catch (err) {
                    reject(err);
                }
            } else {
                console.error(`[OverlayLayerJudge V79] FFmpeg exited with code ${code}`);
                // console.error(stderrData); // Uncomment for deep debug
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });

        child.on('error', (err) => {
            console.error('[OverlayLayerJudge V79] Spawn Error:', err);
            reject(err);
        });
    });
}

async function _applyTransitionsSmart(videoPath, outputPath, transitions, onProgress) {
    const sIn = _getSafePath(videoPath);
    console.log(`[SmartTransition V77] Applying ${transitions ? transitions.length : 0} transitions`);

    if (!transitions || transitions.length === 0) {
        return new Promise((r, j) => {
            fs.copyFile(sIn, outputPath, (err) => err ? j(err) : r({ success: true, outputPath }));
        });
    }

    transitions.sort((a, b) => a.time - b.time);

    // Route chapter breaks to dedicated handler
    const hasBreaks = transitions.some(t => ['chapter_break', 'chapterBreak', 'chapterbreak'].includes(t.type || t.transitionType));
    if (hasBreaks) {
        return _applyTransitionsWithBreaks(videoPath, outputPath, transitions, onProgress);
    }

    let videoMeta = { duration: 0, frameRate: 30 };
    try {
        videoMeta = await _getVideoMetadata(sIn);
    } catch (e) {
        console.warn('[SmartTransition] Metadata could not be read, using defaults.', e);
    }

    const videoDuration = Math.max(0, Number(videoMeta.duration) || 0);
    const frameRate = Math.max(1, Number(videoMeta.frameRate) || 30);
    const frameStep = 1 / frameRate;

    const normalizedTransitions = transitions.map((tr) => {
        const transitionType = tr.type || tr.transitionType;
        const originalTime = parseFloat(tr.time) || 0;
        const originalDuration = Math.max(frameStep, parseFloat(tr.duration) || 1.0);
        let safeTime = originalTime;
        let safeDuration = originalDuration;

        if (videoDuration > 0) {
            safeTime = Math.min(Math.max(0, originalTime), Math.max(0, videoDuration - frameStep));

            if (transitionType === 'fade_in') {
                safeDuration = Math.min(originalDuration, Math.max(frameStep, videoDuration - safeTime));
            } else if (transitionType === 'fade_out') {
                safeDuration = Math.min(originalDuration, Math.max(frameStep, videoDuration - safeTime));
            } else {
                const maxAroundTime = Math.min(safeTime, Math.max(0, videoDuration - safeTime)) * 2;
                safeDuration = Math.min(originalDuration, Math.max(frameStep, maxAroundTime || frameStep));
            }
        }

        return {
            ...tr,
            time: safeTime,
            duration: safeDuration
        };
    });

    // ======================================================================
    // V77: SIMPLE -vf APPROACH
    // Uses -vf (videoFilters) instead of -filter_complex.
    // - No labels, no mapping, no stream reference issues
    // - Audio passes through automatically with -c:a copy
    // - SFX mixed in a separate second pass if needed
    // - -crf 23 -preset medium for reasonable file size
    // ======================================================================

    // SFX Finder
    const _findSfx = (type) => {
        if (!type) return null;
        const nameMap = {
            'dip_white': 'dip_to_black.wav', 'flash': 'dip_to_black.wav',
            'dip_black': 'dip_to_black.wav', 'dipToBlack': 'dip_to_black.wav',
            'dip': 'dip_to_black.wav', 'dibtoblack': 'dip_to_black.wav',
            'fade_in': 'fade.wav', 'fade_out': 'fade.wav',
            'fade': 'cross_dissolve.wav', 'cross_dissolve': 'cross_dissolve.wav',
            'crossDissolve': 'cross_dissolve.wav', 'crossdissolve': 'cross_dissolve.wav',
            'wipeleft': 'cross_dissolve.wav', 'wiperight': 'cross_dissolve.wav',
            'wipeLeft': 'cross_dissolve.wav', 'wipeRight': 'cross_dissolve.wav'
        };
        const fileName = nameMap[type] || (type && nameMap[type.toLowerCase()]);
        if (!fileName) return null;
        const candidates = [
            path.join(process.cwd(), 'src', 'renderer', 'assets', 'sfx', fileName),
            path.join(process.cwd(), 'resources', 'assets', 'sfx', fileName),
            path.join(__dirname, '../renderer/assets/sfx', fileName),
            path.join(__dirname, '../../renderer/assets/sfx', fileName),
            path.join(process.cwd(), 'assets', 'sfx', fileName)
        ];
        for (const p of candidates) { if (fs.existsSync(p)) return p; }
        return null;
    };

    // Step 1: Build video filter chain (simple -vf, NOT -filter_complex)
    // V78 FIX: Use 'eq' filter for dip-to-black/white instead of 'fade'.
    // Reason: 'fade=t=out' permanently destroys video data (turns it black),
    // making subsequent 'fade=t=in' impossible on the same stream.
    // 'eq' brightness animation works perfectly for single-stream visibility control.
    const hdrToSdrFilter = _buildHdrToSdrFilter(videoMeta);
    const vfParts = [
        ...(_isKnownColorValue(hdrToSdrFilter) ? [hdrToSdrFilter] : []),
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        'format=yuv420p'
    ];

    normalizedTransitions.forEach((tr, index) => {
        const transitionType = tr.type || tr.transitionType;
        const time = parseFloat(tr.time);
        const dur = parseFloat(tr.duration) || 1.0;
        const half = dur / 2;
        const tStart = Math.max(0, time - half);
        const tMid = time;
        const tEnd = time + half;

        console.log(`[SmartTransition V78] #${index}: type=${transitionType}, time=${time}s, dur=${dur}s`);

        if (transitionType === 'dip_white' || transitionType === 'flash') {
            // Flash: Brightness 0 -> 1 -> 0
            const bOut = `(t-${tStart})/${half}`;     // 0 to 1
            const bIn = `1-(t-${tMid})/${half}`;      // 1 to 0
            vfParts.push(`eq=brightness='if(between(t,${tStart},${tMid}),${bOut},if(between(t,${tMid},${tEnd}),${bIn},0))':eval=frame`);
        } else if (transitionType && (transitionType.includes('black') || transitionType === 'dip' || transitionType === 'dipToBlack' || transitionType === 'dibtoblack')) {
            // Dip to Black: Brightness 0 -> -1 -> 0
            const bOut = `(t-${tStart})/${half}*-1`;  // 0 to -1
            const bIn = `-1+(t-${tMid})/${half}`;     // -1 to 0
            vfParts.push(`eq=brightness='if(between(t,${tStart},${tMid}),${bOut},if(between(t,${tMid},${tEnd}),${bIn},0))':eval=frame`);
        } else if (transitionType === 'fade_in') {
            // Fade In from Black (Start of video)
            vfParts.push(`fade=t=in:st=${time}:d=${dur}`);
        } else if (transitionType === 'fade_out') {
            // Fade Out to Black (End of video)
            vfParts.push(`fade=t=out:st=${time}:d=${dur}`);
        } else if (['fade', 'cross_dissolve', 'crossDissolve', 'crossdissolve'].includes(transitionType)) {
            // Cross Dissolve Simulation on Single Stream: Quick Dip to Black
            // (Real cross dissolve requires 2 streams, impossible on single pass without cut)
            const shortHalf = half * 0.5;
            const tS = time - shortHalf;
            const tE = time + shortHalf;
            const bOut = `(t-${tS})/${shortHalf}*-1`;
            const bIn = `-1+(t-${time})/${shortHalf}`;
            vfParts.push(`eq=brightness='if(between(t,${tS},${time}),${bOut},if(between(t,${time},${tE}),${bIn},0))':eval=frame`);
        } else if (transitionType === 'wiperight' || transitionType === 'wipeRight') {
            const tS = tStart.toFixed(3); const tM = tMid.toFixed(3);
            const tE = tEnd.toFixed(3); const h = half.toFixed(3);
            vfParts.push(`drawbox=x=0:y=0:w='min(iw,iw*(t-${tS})/${h})':h=ih:color=black:t=fill:enable='between(t,${tS},${tM})'`);
            vfParts.push(`drawbox=x='min(iw,iw*(t-${tM})/${h})':y=0:w='max(0,iw-iw*(t-${tM})/${h})':h=ih:color=black:t=fill:enable='between(t,${tM},${tE})'`);
        } else if (transitionType === 'wipeleft' || transitionType === 'wipeLeft') {
            const tS = tStart.toFixed(3); const tM = tMid.toFixed(3);
            const tE = tEnd.toFixed(3); const h = half.toFixed(3);
            vfParts.push(`drawbox=x='max(0,iw-iw*(t-${tS})/${h})':y=0:w='min(iw,iw*(t-${tS})/${h})':h=ih:color=black:t=fill:enable='between(t,${tS},${tM})'`);
            vfParts.push(`drawbox=x=0:y=0:w='max(0,iw-iw*(t-${tM})/${h})':h=ih:color=black:t=fill:enable='between(t,${tM},${tE})'`);
        } else if (['chapter_break', 'chapterBreak', 'chapterbreak'].includes(transitionType)) {
            const tS = Math.max(0, time - (dur / 2)); const tE = time + (dur / 2);
            vfParts.push(`drawbox=color=black:t=fill:enable='between(t,${tS},${tE})'`);
        }
        // 'cut' and unknown: no visual effect
    });

    // Step 2: Find SFX files for second pass
    const sfxFiles = [];
    normalizedTransitions.forEach(tr => {
        const transType = tr.type || tr.transitionType;
        let file = null;
        if (tr.customSfxPath && fs.existsSync(tr.customSfxPath)) {
            file = tr.customSfxPath;
        } else if (tr.useSfx !== false) {
            file = _findSfx(transType);
        }
        if (file) sfxFiles.push({ file, time: parseFloat(tr.time), duration: parseFloat(tr.duration) || 1.0 });
    });

    const needsSfxMix = sfxFiles.length > 0;
    const tempDir = path.dirname(outputPath);
    const ts = Date.now();
    const videoTarget = needsSfxMix ? path.join(tempDir, `st_vf_${ts}.mp4`) : outputPath;

    try {
        // Step 3: Apply video transitions with -vf, audio copy
        await new Promise((resolve, reject) => {
            ffmpeg(sIn)
                .videoFilters(vfParts)
                .outputOptions([
                    '-map', '0:v:0',
                    '-map', '0:a:0?',
                    '-c:v', 'libx264',
                    '-preset', 'medium',
                    '-crf', '18',
                    '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac',
                    '-b:a', '320k',
                    '-af', 'aresample=async=1:first_pts=0',
                    '-max_muxing_queue_size', '9999',
                    ..._buildProcessedVideoColorOutputOptions(videoMeta)
                ])
                .output(videoTarget)
                .on('start', (cl) => console.log(`[SmartTransition V77] FFmpeg: ${cl}`))
                .on('progress', p => { if (onProgress) onProgress(needsSfxMix ? p.percent * 0.8 : p.percent); })
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        // Step 4: Mix SFX in separate pass if needed
        if (needsSfxMix) {
            console.log(`[SmartTransition V77] Mixing ${sfxFiles.length} SFX files...`);
            await new Promise((resolve, reject) => {
                const cmd = ffmpeg(videoTarget);
                sfxFiles.forEach(s => cmd.input(s.file));

                const filters = [];
                filters.push('[0:a]aformat=sample_rates=44100[a_orig]');
                const amixIn = ['[a_orig]'];

                sfxFiles.forEach((s, i) => {
                    const delayMs = Math.round(Math.max(0, (s.time - s.duration * 0.25) * 1000));
                    const lbl = `sfx_${i}`;
                    // Simplify options: Remove explicit channel layout/fmt to avoid "Option not found"
                    filters.push(`[${i + 1}:a]aformat=sample_rates=44100,adelay=${delayMs}|${delayMs},volume=0.5,apad[${lbl}]`);
                    amixIn.push(`[${lbl}]`);
                });

                // Simplify amix options but restore volume
                // amix defaults to normalize=1 (1/N scaling), so we multiply by N to restore
                const N = amixIn.length;
                filters.push(`${amixIn.join('')}amix=inputs=${N}:duration=first,volume=${N}[a_out]`);

                cmd.complexFilter(filters)
                    .outputOptions([
                        '-map', '0:v',
                        '-c:v', 'copy',
                        '-map', '[a_out]',
                        '-c:a', 'aac',
                        '-max_muxing_queue_size', '9999'
                    ])
                    .output(outputPath)
                    .on('progress', p => { if (onProgress) onProgress(80 + p.percent * 0.2); })
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
            try { fs.unlinkSync(videoTarget); } catch (e) { }
        }

        console.log('[SmartTransition V77] Success.');
        return { success: true, outputPath };
    } catch (error) {
        console.error('[SmartTransition V77] Error:', error.message);
        if (needsSfxMix) { try { fs.unlinkSync(videoTarget); } catch (e) { } }
        throw error;
    }
}

// V117: Chapter Break Support - Video Pause/Insert Logic
async function _applyTransitionsWithBreaks(videoPath, outputPath, transitions, onProgress) {
    console.log('[SmartTransition] Chapter Break detected. Using Segment-Concat mode.');
    const sIn = _getSafePath(videoPath);

    // Metadata for resolution matching
    let meta = { duration: 0, width: 1920, height: 1080 };
    try {
        meta = await _getVideoMetadata(sIn);
    } catch (e) { console.warn('Metadata error, using defaults', e); }

    const duration = meta.duration || 10;
    // Fix odd resolution for libx264
    let width = meta.width || 1920;
    let height = meta.height || 1080;
    if (width % 2 !== 0) width--;
    if (height % 2 !== 0) height--;
    const hdrToSdrFilter = _buildHdrToSdrFilter(meta);

    // Helper for SFX (Scoped)
    const _findSfxV2 = (type) => {
        if (!type) return null;
        const nameMap = {
            'dip_white': 'dip_to_black.wav', 'flash': 'dip_to_black.wav',
            'dip_black': 'dip_to_black.wav', 'dipToBlack': 'dip_to_black.wav', 'dip': 'dip_to_black.wav', 'dibtoblack': 'dip_to_black.wav',
            'fade_in': 'fade.wav', 'fade_out': 'fade.wav',
            'fade': 'cross_dissolve.wav', 'cross_dissolve': 'cross_dissolve.wav', 'crossDissolve': 'cross_dissolve.wav', 'crossdissolve': 'cross_dissolve.wav',
            'wipeleft': 'cross_dissolve.wav', 'wiperight': 'cross_dissolve.wav', 'wipeLeft': 'cross_dissolve.wav', 'wipeRight': 'cross_dissolve.wav',
            'chapter_break': 'chapter_break.wav', 'chapterBreak': 'chapter_break.wav', 'chapterbreak': 'chapter_break.wav'
        };
        const fileName = nameMap[type] || nameMap[type.toLowerCase()];
        if (!fileName) return null;

        const candidates = [
            path.join(process.cwd(), 'src', 'renderer', 'assets', 'sfx', fileName),
            path.join(process.cwd(), 'resources', 'assets', 'sfx', fileName),
            path.join(__dirname, '../renderer/assets/sfx', fileName),
            path.join(__dirname, '../../renderer/assets/sfx', fileName),
            path.join(process.cwd(), 'assets', 'sfx', fileName)
        ];
        for (const p of candidates) { if (fs.existsSync(p)) return p; }
        return null;
    };

    transitions.sort((a, b) => a.time - b.time);

    const cmd = ffmpeg(sIn);

    const segments = [];
    let currentTime = 0;

    // Separate breaks from others
    const breaks = transitions.filter(t => ['chapter_break', 'chapterBreak', 'chapterbreak'].includes(t.type || t.transitionType));

    for (const brk of breaks) {
        const bTime = parseFloat(brk.time);
        const bDur = parseFloat(brk.duration) || 1.0;

        // Content Segment
        if (bTime > currentTime) {
            const segTrans = transitions.filter(t => {
                const type = t.type || t.transitionType;
                if (['chapter_break', 'chapterBreak', 'chapterbreak'].includes(type)) return false;
                return t.time >= currentTime && t.time <= bTime;
            });
            segments.push({ type: 'content', start: currentTime, end: bTime, transitions: segTrans });
        }

        // Break Segment
        let sfx = null;
        if (brk.useSfx !== false) {
            if (brk.customSfxPath && fs.existsSync(brk.customSfxPath)) sfx = brk.customSfxPath;
            else sfx = _findSfxV2(brk.type || brk.transitionType);
        }
        segments.push({ type: 'break', duration: bDur, sfx: sfx });

        currentTime = bTime;
    }

    // Tail Content
    if (currentTime < duration) {
        const segTrans = transitions.filter(t => {
            const type = t.type || t.transitionType;
            if (['chapter_break', 'chapterBreak', 'chapterbreak'].includes(type)) return false;
            return t.time >= currentTime;
        });
        segments.push({ type: 'content', start: currentTime, end: duration, transitions: segTrans });
    }

    // Build Chains
    const filterChain = [];
    const concatParts = [];
    let sfxInputCount = 1; // 0 is video

    segments.forEach((seg, i) => {
        if (seg.type === 'content') {
            // Trim and Transitions
            let vfChain = `[0:v]trim=${seg.start}:${seg.end},setpts=PTS-STARTPTS`;
            if (hdrToSdrFilter) {
                vfChain += `,${hdrToSdrFilter}`;
            }

            // Collect SFX for this content segment
            const segSfxItems = [];

            // Apply other transitions logic
            seg.transitions.forEach((tr) => {
                const type = tr.type || tr.transitionType;
                const dur = parseFloat(tr.duration) || 1.0;
                const half = dur / 2;
                const relTime = parseFloat(tr.time) - seg.start;
                const tStart = relTime - half;

                let vf = '';
                if (['fade', 'cross_dissolve', 'crossDissolve'].includes(type) || (type && type.includes('cross'))) {
                    const short = half * 0.4;
                    vf = `fade=t=out:st=${relTime - short}:d=${short},fade=t=in:st=${relTime}:d=${short}`;
                } else if (['wiperight', 'wipeRight', 'wipeleft', 'wipeLeft'].includes(type)) {
                    // FIX: Map Wipe to Cross Dissolve (Safe Mode) to avoid black screen issues
                    const short = half * 0.4;
                    vf = `fade=t=out:st=${relTime - short}:d=${short},fade=t=in:st=${relTime}:d=${short}`;
                } else if (type === 'fade_in') {
                    vf = `fade=t=in:st=${relTime}:d=${dur}`;
                } else if (type === 'fade_out') {
                    vf = `fade=t=out:st=${relTime}:d=${dur}`;
                } else if (type && (type.includes('dip') || type.includes('flash') || type.includes('black'))) {
                    const color = (type.includes('white') || type.includes('flash')) ? 'white' : 'black';
                    vf = `fade=t=out:st=${tStart}:d=${half}:c=${color},fade=t=in:st=${relTime}:d=${half}:c=${color}`;
                }

                if (vf) vfChain += `,${vf}`;

                // SFX for this transition
                if (tr.useSfx !== false) {
                    let sfxFile = null;
                    if (tr.customSfxPath && fs.existsSync(tr.customSfxPath)) {
                        sfxFile = tr.customSfxPath;
                    } else if (tr.customSfxPath) {
                        // Relative path resolution
                        const candidates = [
                            path.join(process.cwd(), 'src', 'renderer', tr.customSfxPath),
                            path.join(process.cwd(), 'resources', tr.customSfxPath),
                            path.join(__dirname, '../renderer', tr.customSfxPath),
                            path.join(__dirname, '../../renderer', tr.customSfxPath)
                        ];
                        for (const p of candidates) {
                            if (fs.existsSync(p)) { sfxFile = p; break; }
                        }
                    }
                    if (!sfxFile) {
                        sfxFile = _findSfxV2(type);
                    }
                    if (sfxFile) {
                        const startTime = Math.max(0, relTime - (dur / 2) + (dur * 0.25));
                        segSfxItems.push({ file: sfxFile, delayMs: Math.round(startTime * 1000) });
                    }
                }
            });

            vfChain += `,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`;

            filterChain.push(vfChain);

            // Audio: base trim
            const baseAudioLabel = `a_base_${i}`;
            filterChain.push(`[0:a]atrim=${seg.start}:${seg.end},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp[${baseAudioLabel}]`);

            if (segSfxItems.length > 0) {
                // Mix SFX into content audio using amerge+pan
                const segDur = seg.end - seg.start;
                const sfxLabels = [];

                segSfxItems.forEach((sfxItem, j) => {
                    cmd.input(sfxItem.file);
                    const idx = sfxInputCount++;
                    const lbl = `sfx_c${i}_${j}`;
                    filterChain.push(`[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp,adelay=${sfxItem.delayMs}|${sfxItem.delayMs},volume=0.5,apad,atrim=0:${segDur}[${lbl}]`);
                    sfxLabels.push(`[${lbl}]`);
                });

                // amerge all (base + sfx inputs)
                const allInputs = [`[${baseAudioLabel}]`, ...sfxLabels];
                const N = allInputs.length;
                let lefts = [], rights = [];
                for (let k = 0; k < N; k++) {
                    lefts.push(`c${k * 2}`);
                    rights.push(`c${k * 2 + 1}`);
                }
                filterChain.push(`${allInputs.join('')}amerge=inputs=${N}[merged_${i}]`);
                filterChain.push(`[merged_${i}]pan=stereo|c0=${lefts.join('+')}|c1=${rights.join('+')}[a${i}]`);
                console.log(`[BreakMode] Content segment ${i}: mixed ${segSfxItems.length} SFX`);
            } else {
                // No SFX - just rename the label
                filterChain.push(`[${baseAudioLabel}]acopy[a${i}]`);
            }

            concatParts.push({ v: `[v${i}]`, a: `[a${i}]` });

        } else if (seg.type === 'break') {
            const vf = `color=c=black:s=${width}x${height}:d=${seg.duration}:r=30,format=yuv420p[v${i}]`;
            filterChain.push(vf);

            let af = '';
            if (seg.sfx) {
                cmd.input(seg.sfx);
                const idx = sfxInputCount++;
                af = `[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp,apad,atrim=0:${seg.duration}[a${i}]`;
            } else {
                af = `anullsrc=r=44100:cl=stereo:d=${seg.duration},aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp[a${i}]`;
            }
            filterChain.push(af);
            concatParts.push({ v: `[v${i}]`, a: `[a${i}]` });
        }
    });

    // Concat
    const n = concatParts.length;
    const con = concatParts.map(p => `${p.v}${p.a}`).join('') + `concat=n=${n}:v=1:a=1[outv][outa]`;
    filterChain.push(con);

    return new Promise((resolve, reject) => {
        cmd.complexFilter(filterChain)
            // Quality and Bitrate Fix
            .outputOptions([
                '-map [outv]',
                '-map [outa]',
                '-c:v libx264',
                '-c:a aac',
                '-preset ultrafast',
                '-crf 18',
                '-b:a 320k',
                '-af aresample=async=1:first_pts=0',
                '-max_muxing_queue_size 9999',
                '-shortest',
                ..._buildProcessedVideoColorOutputOptions(meta)
            ])
            .output(outputPath)
            .on('progress', p => { if (onProgress) onProgress(p.percent); })
            .on('end', () => resolve({ success: true, outputPath }))
            .on('error', reject)
            .run();
    });
}

async function _safeConvertVideo(videoPath, outputPath, options = {}, onProgress) {
    const sIn = _getSafePath(videoPath);
    const sOut = _getSafePath(outputPath);
    console.log(`[SafeConvert] V73 Converting ${path.basename(sIn)}...`);

    let totalDuration = 0;
    let sourceMetadata = {};
    try {
        sourceMetadata = await _getVideoMetadata(sIn);
        totalDuration = sourceMetadata.duration || 0;
    } catch (e) {
        console.warn('[SafeConvert] Duration metadata could not be read for progress fallback');
    }

    const ext = path.extname(outputPath).toLowerCase();
    const targetCodec = options?.codec || null;
    const targetBitrate = options?.bitrate ? Math.round(options.bitrate) : null;
    const targetFps = options?.fps ? Number(options.fps) : null;
    const targetWidth = options?.width ? Number(options.width) : null;
    const targetHeight = options?.height ? Number(options.height) : null;

    if (path.resolve(sIn) === path.resolve(sOut)) {
        throw new Error('Input and output files cannot be the same.');
    }

    let videoCodec = 'libx264';
    let audioCodec = 'aac';
    let extraOutputOptions = ['-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-ac', '2'];

    if (ext === '.webm') {
        videoCodec = targetCodec === 'vp8' ? 'libvpx' : 'libvpx-vp9';
        audioCodec = 'libopus';
        extraOutputOptions = ['-ac', '2'];
    } else if (ext === '.mov' || ext === '.mp4' || ext === '.m4v') {
        if (targetCodec === 'h265' || targetCodec === 'hevc') videoCodec = 'libx265';
        else videoCodec = 'libx264';
        audioCodec = 'aac';
    } else if (targetCodec) {
        if (targetCodec === 'h265' || targetCodec === 'hevc') videoCodec = 'libx265';
        else if (targetCodec === 'vp9') videoCodec = 'libvpx-vp9';
        else if (targetCodec === 'vp8') videoCodec = 'libvpx';
    }

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(sIn);
        const stderrLines = [];

        try {
            fs.mkdirSync(path.dirname(sOut), { recursive: true });
        } catch (e) { }

        const videoFilters = [];
        const hdrToSdrFilter = _buildHdrToSdrFilter(sourceMetadata);
        if (hdrToSdrFilter) {
            videoFilters.push(hdrToSdrFilter);
        }
        if (targetWidth && targetHeight) {
            videoFilters.push(`scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
        }
        if (videoFilters.length > 0) {
            cmd.videoFilters(_joinVideoFilters(videoFilters));
        }

        if (targetFps && !Number.isNaN(targetFps)) {
            cmd.outputOptions(['-r', String(targetFps)]);
        }

        const outputOptions = [
            '-map', '0:v:0',
            '-map', '0:a:0?',
            '-sn',
            '-dn',
            '-max_muxing_queue_size', '9999',
            '-c:v', videoCodec,
            '-preset', videoCodec.includes('libvpx') ? 'good' : 'ultrafast',
            ...(videoCodec.includes('libx265') ? ['-crf', '28'] : ['-crf', '23']),
            '-c:a', audioCodec,
            '-b:a', audioCodec === 'libopus' ? '160k' : '128k',
            ...(targetBitrate ? ['-b:v', `${targetBitrate}k`] : []),
            ...extraOutputOptions,
            ..._buildProcessedVideoColorOutputOptions(sourceMetadata)
        ];

        cmd.outputOptions(outputOptions)
            .output(sOut)
            .outputOptions('-y')
            .on('start', (commandLine) => {
                console.log('[SafeConvert] Command:', commandLine);
            })
            .on('progress', (p) => {
                if (onProgress && typeof onProgress === 'function') {
                    let percent = p.percent;
                    if ((!percent || percent <= 0) && totalDuration > 0 && p.timemark) {
                        const parts = p.timemark.split(':');
                        if (parts.length === 3) {
                            const secs = (+parts[0]) * 3600 + (+parts[1]) * 60 + parseFloat(parts[2]);
                            percent = (secs / totalDuration) * 100;
                        }
                    }
                    onProgress(Math.min(99, Math.max(0, Math.round(percent || 0))));
                }
            })
            .on('stderr', (line) => {
                if (line && line.trim()) stderrLines.push(line.trim());
            })
            .on('end', () => resolve({ success: true, outputPath: sOut }))
            .on('error', (err, stdout, stderr) => {
                console.error("[SafeConvert] Error:", err);
                if (stderr) {
                    stderr
                        .split(/\r?\n/)
                        .map((line) => line.trim())
                        .filter(Boolean)
                        .forEach((line) => stderrLines.push(line));
                }
                const lastRelevantLine = [...stderrLines].reverse().find((line) =>
                    !line.startsWith('frame=') &&
                    !line.startsWith('size=') &&
                    !line.startsWith('video:') &&
                    !line.startsWith('Press [q]')
                );
                if (lastRelevantLine) {
                    reject(new Error(`${err.message} ${lastRelevantLine}`));
                } else {
                    reject(err);
                }
            })
            .run();
    });
}

// ==========================================
// SRC YEDEK BACKUP HELPERS (SMART CUT LOGIC)
// ==========================================

// Global GPU State (Missing in previous step)
let _detectedGpuEncoder = null;
let _gpuDetectionDone = false;

async function findPreviousKeyframe(filePath, targetTime) {
    const { exec } = require('child_process');
    const searchDuration = 40;
    const seekStart = Math.max(0, targetTime - 20);
    const cmd = `"${ffprobePath}" -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pkt_pts_time -read_intervals ${seekStart}%+${searchDuration} -of csv=p=0 "${filePath}"`;

    return new Promise((resolve) => {
        exec(cmd, { timeout: 5000 }, (error, stdout) => {
            if (error) {
                console.warn('Keyframe bulma hatası (ignoring):', error.message);
                resolve(null);
                return;
            }
            try {
                const times = stdout.trim().split(/\r?\n/)
                    .map(line => parseFloat(line.trim()))
                    .filter(t => !isNaN(t) && t <= targetTime)
                    .sort((a, b) => b - a);
                if (times.length > 0) resolve(times[0]);
                else resolve(null);
            } catch (e) { resolve(null); }
        });
    });
}

async function detectGpuEncoder() {
    if (_gpuDetectionDone) return _detectedGpuEncoder;
    const platform = os.platform();
    const encoders = [];
    if (platform === 'win32') encoders.push('h264_nvenc', 'h264_qsv', 'h264_amf');
    else if (platform === 'darwin') encoders.push('h264_videotoolbox');
    else encoders.push('h264_nvenc', 'h264_vaapi', 'h264_qsv');

    for (const encoder of encoders) {
        try {
            const { execSync } = require('child_process');
            execSync(`"${ffmpegPath}" -f lavfi -i nullsrc=s=256x256:d=1 -c:v ${encoder} -f null -`, { timeout: 5000, stdio: 'pipe' });
            console.log(`GPU Encoder bulundu: ${encoder}`);
            _detectedGpuEncoder = encoder;
            _gpuDetectionDone = true;
            return encoder;
        } catch (e) { }
    }
    console.log('GPU encoder bulunamadı, CPU (libx264) kullanılacak');
    _gpuDetectionDone = true;
    return null;
}

async function cutVideo(inputPath, outputPath, startTime, endTime, onProgress, options = {}, onLog = null) {
    if (typeof options === 'function') { onLog = options; options = {}; }
    const duration = endTime - startTime;
    const gpuEncoder = await detectGpuEncoder();
    const videoCodec = gpuEncoder || 'libx264';
    const sampleRate = options.sampleRate || 44100;

    let outputOptions = [];
    if (gpuEncoder) {
        if (gpuEncoder.includes('nvenc')) outputOptions = ['-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-ar', String(sampleRate), '-ac', '2', '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '9999'];
        else if (gpuEncoder.includes('qsv')) outputOptions = ['-preset', 'veryfast', '-global_quality', '23', '-ar', String(sampleRate), '-ac', '2', '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '9999'];
        else if (gpuEncoder.includes('videotoolbox')) outputOptions = ['-q:v', '65', '-ar', String(sampleRate), '-ac', '2', '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '9999'];
    } else {
        outputOptions = ['-preset', 'veryfast', '-crf', '23', '-ar', String(sampleRate), '-ac', '2', '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '9999'];
    }

    // CPU fallback option handled in usage
    if (!gpuEncoder) {
        outputOptions = ['-preset', 'ultrafast', '-crf', '28', '-ar', String(sampleRate), '-ac', '2', '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '9999'];
    }

    const filters = [`afade=t=in:st=0:d=0.01`, `afade=t=out:st=${Math.max(0, duration - 0.01)}:d=0.01`];
    // V112: Scale Support
    if (options.width && options.height) {
        filters.push(`scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
    }

    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(duration)
            .videoCodec(videoCodec)
            .audioCodec('aac')
            .outputOptions(outputOptions)
            .output(outputPath)
            // .videoFilters(filters) // audioFilters ve videoFilters ayrı olmalı veya complexFilter kullanılmalı
            // create distinct filter calls
            .audioFilters(filters.filter(f => f.startsWith('afade')))
            .videoFilters(filters.filter(f => f.startsWith('scale')))
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('stderr', (l) => { if (onLog) onLog(l); })
            .on('end', () => resolve(outputPath))
            .on('error', (err) => {
                if (gpuEncoder) {
                    console.warn('GPU encoding failed, trying CPU fallback...');
                    try {
                        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    } catch (cleanupError) {
                        console.warn('GPU fallback cleanup warning:', cleanupError.message);
                    }
                    cutVideoWithCpu(inputPath, outputPath, startTime, endTime, onProgress, options, onLog).then(resolve).catch(reject);
                } else reject(err);
            })
            .run();
    });
}

function cutVideoWithCpu(inputPath, outputPath, startTime, endTime, onProgress, options = {}, onLog = null) {
    const duration = endTime - startTime;
    const sampleRate = options.sampleRate || 44100;
    const filters = [`afade=t=in:st=0:d=0.01`, `afade=t=out:st=${Math.max(0, duration - 0.01)}:d=0.01`];
    if (options.width && options.height) {
        filters.push(`scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
    }

    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(duration)
            .videoCodec('libx264')
            .audioCodec('aac')
            .audioFilters(filters.filter(f => f.startsWith('afade')))
            .videoFilters(filters.filter(f => f.startsWith('scale')))
            .outputOptions(['-preset', 'ultrafast', '-crf', '28', '-ar', String(sampleRate), '-ac', '2', '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '9999'])
            .output(outputPath)
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('stderr', (l) => { if (onLog) onLog(l); })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

async function cutVideoSmart(inputPath, outputPath, startTime, endTime, options = {}, onProgress, onLog = null) {
    const duration = endTime - startTime;
        if (duration < 5) return cutVideo(inputPath, outputPath, startTime, endTime, onProgress, options, onLog);

    const tempDir = path.dirname(outputPath);
    const timestamp = Date.now();
    const tempFiles = [];
    const margin = 5;

    try {
        const inputMeta = await getVideoMetadata(inputPath);
        const sampleRate = inputMeta.audioSampleRate || 44100;
        const encodeOptions = { sampleRate };
        const targetPart2Start = startTime + margin;
        const keyframeTime = await findPreviousKeyframe(inputPath, targetPart2Start);

        if (keyframeTime === null || keyframeTime < startTime) return cutVideo(inputPath, outputPath, startTime, endTime, onProgress, options, onLog);

        const targetPart2End = endTime - margin;
        if (keyframeTime >= targetPart2End) return cutVideo(inputPath, outputPath, startTime, endTime, onProgress, options, onLog);

        // P1: Re-encode
        const part1Path = path.join(tempDir, `sc_p1_${timestamp}.mp4`);
        if (keyframeTime - startTime > 0.1) {
            await cutVideo(inputPath, part1Path, startTime, keyframeTime, (p) => { if (onProgress) onProgress(p * 0.15); }, encodeOptions, onLog);
            tempFiles.push(part1Path);
        }

        // P2: Copy
        const part2Duration = targetPart2End - keyframeTime;
        const part2Path = path.join(tempDir, `sc_p2_${timestamp}.mp4`);
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .inputOptions([`-ss ${keyframeTime}`])
                .inputOptions([`-t ${part2Duration}`])
                .videoCodec('copy').audioCodec('copy')
                .output(part2Path)
                .on('stderr', (l) => { if (onLog) onLog(l); })
                .on('end', resolve).on('error', reject).run();
        });
        tempFiles.push(part2Path);

        // P3: Re-encode
        const part3Path = path.join(tempDir, `sc_p3_${timestamp}.mp4`);
        if (endTime - targetPart2End > 0.1) {
            await cutVideo(inputPath, part3Path, targetPart2End, endTime, (p) => { if (onProgress) onProgress(80 + p * 0.15); }, encodeOptions, onLog);
            tempFiles.push(part3Path);
        }

        await concatenateVideosFast(tempFiles, outputPath, (p) => { if (onProgress) onProgress(95 + p * 0.05); });
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
        return outputPath;

    } catch (error) {
        console.error('Smart Cut Error:', error.message);
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
        return cutVideo(inputPath, outputPath, startTime, endTime, onProgress, options, onLog);
    }
}

function concatenateVideosFast(inputPaths, outputPath, onProgress, onLog = null) {
    return new Promise(async (resolve, reject) => {
        // --- CHUNKING STRATEGY (Optimization for 50+ segments) ---
        const CHUNK_SIZE = 25;
        if (inputPaths.length > CHUNK_SIZE) {
            const CHUNK_BUILD_WEIGHT = 85;
            let chunkFiles = [];
            try {
                console.log(`[Smart Merge] Processing high segment count (${inputPaths.length}). Chunking...`);
                const tempDir = path.dirname(outputPath);
                const timestamp = Date.now();
                for (let i = 0; i < inputPaths.length; i += CHUNK_SIZE) {
                    const chunk = inputPaths.slice(i, i + CHUNK_SIZE);
                    const chunkPath = path.join(tempDir, `temp_chunk_${timestamp}_${Math.floor(i / CHUNK_SIZE) + 1}.mp4`);
                    await concatenateVideosFast(chunk, chunkPath, (p) => {
                        const processedShare = i / inputPaths.length;
                        const chunkShare = chunk.length / inputPaths.length;
                        const totalP = (processedShare + ((p / 100) * chunkShare)) * CHUNK_BUILD_WEIGHT;
                        if (onProgress) onProgress(totalP);
                    });
                    chunkFiles.push(chunkPath);
                }
                await concatenateVideosFast(chunkFiles, outputPath, (p) => {
                    const totalP = CHUNK_BUILD_WEIGHT + ((p / 100) * (100 - CHUNK_BUILD_WEIGHT));
                    if (onProgress) onProgress(totalP);
                });
                chunkFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { } });
                if (onProgress) onProgress(100);
                resolve(outputPath);
                return;
            } catch (chunkError) {
                console.warn('[Smart Merge] Chunking failed, reusing standard method:', chunkError.message);
                if (chunkFiles) chunkFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
            }
        }

        try {
            const validInputs = inputPaths.filter(p => !!p && fs.existsSync(p));
            if (validInputs.length === 0) {
                reject(new Error('Conversion failed!'));
                return;
            }
            let totalDuration = 0;
            for (const inputPath of validInputs) {
                try {
                    const meta = await getVideoMetadata(inputPath);
                    totalDuration += Number(meta?.duration || 0);
                } catch (metaError) {
                    console.warn('[Smart Merge] Duration probe warning:', metaError.message);
                }
            }
            const listPath = path.join(path.dirname(outputPath), `concat_list_${Date.now()}.txt`);
            const listContent = validInputs.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
            fs.writeFileSync(listPath, listContent);
            await new Promise((res, rej) => {
                ffmpeg().input(listPath).inputOptions(['-f', 'concat', '-safe', '0'])
                    .videoCodec('copy').audioCodec('copy').outputOptions(['-movflags', '+faststart'])
                    .output(outputPath)
                    .on('stderr', l => { if (onLog) onLog(l); })
                    .on('progress', p => {
                        if (!onProgress) return;
                        let percent = Number.isFinite(p.percent) ? p.percent : 0;
                        if ((!percent || percent <= 0) && totalDuration > 0 && p.timemark) {
                            const seconds = _parseTimemarkToSeconds(p.timemark);
                            if (Number.isFinite(seconds) && seconds >= 0) {
                                percent = Math.min(100, (seconds / totalDuration) * 100);
                            }
                        }
                        onProgress(percent || 0);
                    })
                    .on('end', () => { fs.unlinkSync(listPath); res(); })
                    .on('error', (e) => { try { fs.unlinkSync(listPath); } catch (x) { } rej(e); }).run();
            });
            const durationOk = await validateConcatOutputDuration(outputPath, totalDuration);
            if (!durationOk) {
                console.warn('[Smart Merge] Fast concat produced an unexpectedly short file. Retrying with safe re-encode.');
                await concatenateVideosSafeReencode(validInputs, outputPath, totalDuration, onProgress, onLog);
            }
            if (onProgress) onProgress(100);
            resolve(outputPath);
        } catch (error) {
            console.error('Fast concat failed, trying fallback...', error);
            // Fallback to normal if implemented, otherwise reject
            reject(error);
        }
    });
}

async function validateConcatOutputDuration(outputPath, expectedDuration) {
    const expected = Number(expectedDuration || 0);
    if (!expected || expected < 5) return true;
    try {
        const meta = await getVideoMetadata(outputPath);
        const actual = Number(meta?.duration || 0);
        if (!actual) return false;
        const missing = expected - actual;
        if (missing <= 2) return true;
        return actual >= expected * 0.75;
    } catch (error) {
        console.warn('[Smart Merge] Output duration validation warning:', error.message);
        return false;
    }
}

async function concatenateVideosSafeReencode(inputPaths, outputPath, expectedDuration, onProgress, onLog = null) {
    const listPath = path.join(path.dirname(outputPath), `concat_list_safe_${Date.now()}.txt`);
    const tempOutput = outputPath.replace(/(\.[^.]+)$/i, `_safe_${Date.now()}$1`);
    const listContent = inputPaths.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    try {
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(listPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions([
                    '-fflags', '+genpts',
                    '-avoid_negative_ts', 'make_zero',
                    '-c:v', 'libx264',
                    '-preset', 'veryfast',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-movflags', '+faststart'
                ])
                .output(tempOutput)
                .on('stderr', l => { if (onLog) onLog(l); })
                .on('progress', p => {
                    if (!onProgress) return;
                    let percent = Number.isFinite(p.percent) ? p.percent : 0;
                    if ((!percent || percent <= 0) && expectedDuration > 0 && p.timemark) {
                        const seconds = _parseTimemarkToSeconds(p.timemark);
                        if (Number.isFinite(seconds) && seconds >= 0) {
                            percent = Math.min(100, (seconds / expectedDuration) * 100);
                        }
                    }
                    onProgress(percent || 0);
                })
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        const durationOk = await validateConcatOutputDuration(tempOutput, expectedDuration);
        if (!durationOk) {
            throw new Error('safe_concat_duration_validation_failed');
        }
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) { }
        fs.renameSync(tempOutput, outputPath);
    } finally {
        try { fs.unlinkSync(listPath); } catch (e) { }
        try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch (e) { }
    }
}

function concatenateVideos(inputPaths, outputPath, onProgress) {
    // Fallback implementation if needed for SmartCut fallback
    return concatenateVideosFast(inputPaths, outputPath, onProgress);
}

function hexToAssBgr(hex, alphaHex = '00') {
    const normalized = String(hex || '').trim().replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
        return `&H${alphaHex}FFFFFF`;
    }
    const rr = normalized.slice(0, 2).toUpperCase();
    const gg = normalized.slice(2, 4).toUpperCase();
    const bb = normalized.slice(4, 6).toUpperCase();
    return `&H${alphaHex}${bb}${gg}${rr}`;
}

async function findNextKeyframe(filePath, targetTime) {
    const { exec } = require('child_process');
    const searchDuration = 40;
    const seekStart = Math.max(0, targetTime);
    const cmd = `"${ffprobePath}" -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pkt_pts_time -read_intervals ${seekStart}%+${searchDuration} -of csv=p=0 "${filePath}"`;

    return new Promise((resolve) => {
        exec(cmd, { timeout: 5000 }, (error, stdout) => {
            if (error) {
                console.warn('Sonraki keyframe bulma hatası (ignoring):', error.message);
                resolve(null);
                return;
            }
            try {
                const times = stdout.trim().split(/\r?\n/)
                    .map(line => parseFloat(line.trim()))
                    .filter(t => !isNaN(t) && t >= targetTime)
                    .sort((a, b) => a - b);
                if (times.length > 0) resolve(times[0]);
                else resolve(null);
            } catch (e) { resolve(null); }
        });
    });
}

async function getCutVideoFastBounds(inputPath, startTime, endTime) {
    const meta = await getVideoMetadata(inputPath);
    const duration = Number(meta?.duration || 0);
    const safeStart = Math.max(0, Number(startTime || 0));
    const safeEnd = Math.max(safeStart, Number(endTime || 0));

    const previousKeyframe = await findPreviousKeyframe(inputPath, safeStart);
    const nextKeyframe = await findNextKeyframe(inputPath, safeEnd);

    const adjustedStart = previousKeyframe !== null ? Math.max(0, previousKeyframe) : 0;
    const adjustedEnd = nextKeyframe !== null
        ? nextKeyframe
        : (duration > 0 ? duration : safeEnd);

    if (!(adjustedEnd > adjustedStart)) {
        throw new Error('Invalid keyframe bounds');
    }

    return {
        startTime: adjustedStart,
        endTime: adjustedEnd
    };
}

async function cutVideoFastLossless(inputPath, outputPath, startTime, endTime, onProgress) {
    const bounds = await getCutVideoFastBounds(inputPath, startTime, endTime);
    const duration = Math.max(0.01, bounds.endTime - bounds.startTime);

    return new Promise((resolve, reject) => {
        try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch (cleanupError) {
            console.warn('CPU fallback pre-cleanup warning:', cleanupError.message);
        }
        ffmpeg(inputPath)
            .inputOptions([`-ss ${bounds.startTime}`])
            .inputOptions([`-t ${duration}`])
            .videoCodec('copy')
            .audioCodec('copy')
            .output(outputPath)
            .on('progress', p => { if (onProgress) onProgress(p.percent || 0); })
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

async function _burnSubtitles(videoPath, srtPath, outputPath, styleOptions = null, onProgress) {
    const sIn = _getSafePath(videoPath);
    const sSrt = _getSafePath(srtPath);
    const sourceMetadata = await _getVideoMetadata(sIn).catch(() => ({}));

    // Windows Path Escaping for FFmpeg Filters
    // Colons in drive letters (C:) must be escaped as "\:".
    // Backslashes must be forward slashes or escaped backslashes.

    // 1. Convert backslashes to forward slashes
    let normalizedSrt = sSrt.replace(/\\/g, '/');

    // 2. Escape the colon after drive letter (e.g., C:/... -> C\:/...)
    normalizedSrt = normalizedSrt.replace(/^([a-zA-Z]):/, '$1\\:');

    // 3. Escape single quotes (important for filter string '...')
    normalizedSrt = normalizedSrt.replace(/'/g, "\\'");

    const layoutMode = styleOptions?.layoutMode || 'classic';
    let subtitleFilter = `subtitles='${normalizedSrt}'`;

    if (layoutMode !== 'classic') {
        const meta = sourceMetadata;
        const videoHeight = Math.max(240, Number(meta?.height || 1080));
        const videoWidth = Math.max(320, Number(meta?.width || 1920));
        const baseDimension = Math.max(320, Math.min(videoWidth, videoHeight));
        const sizeScale = Math.max(10, Math.min(140, Number(styleOptions?.sizeScale || 50))) / 100;
        const fontSize = Math.max(10, Math.min(28, Math.round(baseDimension * 0.026 * sizeScale)));
        const outline = Math.max(1, Math.round(fontSize * 0.08));
        const shadow = Math.max(1, Math.round(fontSize * 0.04));
        const marginV = Math.max(6, Math.round(videoHeight * 0.008));
        const backgroundMode = styleOptions?.backgroundMode || 'box';
        const backgroundOpacity = Math.max(0, Math.min(100, Number(styleOptions?.backgroundOpacity ?? 5)));
        const alpha = Math.round((100 - backgroundOpacity) * 2.55);
        const alphaHex = alpha.toString(16).padStart(2, '0').toUpperCase();
        const textColor = hexToAssBgr(styleOptions?.textColor || '#FFFFFF', '00');
        const backgroundColor = hexToAssBgr(styleOptions?.backgroundColor || '#000000', alphaHex);
        const subtitleStyleParts = [
            `Fontsize=${fontSize}`,
            `PrimaryColour=${textColor}`,
            'OutlineColour=&H00000000',
            'Alignment=2',
            `MarginV=${marginV}`
        ];

        if (backgroundMode === 'shadow-only') {
            subtitleStyleParts.push('BorderStyle=1');
            subtitleStyleParts.push(`Outline=${Math.max(1, Math.round(fontSize * 0.12))}`);
            subtitleStyleParts.push(`Shadow=${Math.max(1, Math.round(fontSize * 0.06))}`);
        } else {
            subtitleStyleParts.push(`BackColour=${backgroundColor}`);
            subtitleStyleParts.push('BorderStyle=3');
            subtitleStyleParts.push(`Outline=${outline}`);
            subtitleStyleParts.push(`Shadow=${shadow}`);
        }

        const subtitleStyle = subtitleStyleParts.join(',');
        subtitleFilter = `subtitles='${normalizedSrt}':original_size=${videoWidth}x${videoHeight}:force_style='${subtitleStyle}'`;
    }

    return new Promise((resolve, reject) => {
        ffmpeg(sIn)
            .videoFilters(_joinVideoFilters(_buildHdrToSdrFilter(sourceMetadata), subtitleFilter))
            .outputOptions([
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '18',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-max_muxing_queue_size', '9999',
                '-movflags', '+faststart',
                ..._buildProcessedVideoColorOutputOptions(sourceMetadata)
            ])
            .output(outputPath)
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('end', () => resolve({ success: true, outputPath }))
            .on('error', (err) => {
                console.error('[BurnSubtitles] Error:', err);
                reject(err);
            })
            .run();
    });
}

/* =========================================
   MISSING FUNCTIONS RESTORATION
   ========================================= */

async function addCtaOverlay(params, onProgress) {
    const {
        mainVideoPath, ctaPath, outputPath,
        position = 'bottom-center', scale = 0.3, opacity = 1.0,
        duration = 5, fade = true, startTime = 0, sound = 'embedded'
    } = params;

    const resolvedCtaPath = _getSafePath(ctaPath);
    const mainSafe = _getSafePath(mainVideoPath);

    return new Promise(async (resolve, reject) => {
        try {
            const mainMeta = await _getVideoMetadata(mainSafe);
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
            const hdrToSdrFilter = _buildHdrToSdrFilter(mainMeta);
            const mainVideoLabel = hdrToSdrFilter ? 'mainv' : '0:v';
            if (hdrToSdrFilter) {
                filterChain += `[0:v]${hdrToSdrFilter}[mainv];`;
            }
            filterChain += `[${mainVideoLabel}][cta_processed]overlay=x=${overlayX}:y=${overlayY}:enable='between(t,${startTime},${endT})'[outv]`;

            const cmd = ffmpeg(mainSafe).input(resolvedCtaPath);
            let outputMaps = ['-map', '[outv]'];

            // Ses Ayarları
            if (sound === 'embedded' && ctaMeta.audioCodec) {
                const delayMs = Math.round(startTime * 1000);
                filterChain += `;[1:a]atrim=0:${effectiveDuration},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[delayed_snd];[0:a][delayed_snd]amix=inputs=2:duration=first[outa]`;
                outputMaps.push('-map', '[outa]');
            } else if (sound && sound !== 'none' && sound !== 'embedded') {
                const sSound = _getSafePath(sound);
                if (fs.existsSync(sSound)) {
                    cmd.input(sSound);
                    const delayMs = Math.round(startTime * 1000);
                    filterChain += `;[2:a]atrim=0:${effectiveDuration},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[delayed_snd];[0:a][delayed_snd]amix=inputs=2:duration=first[outa]`;
                    outputMaps.push('-map', '[outa]');
                } else {
                    outputMaps.push('-map', '0:a');
                }
            } else {
                outputMaps.push('-map', '0:a');
            }

            // Encoder detection reuse or default
            let videoCodec = 'libx264';
            let preset = 'ultrafast';
            if (_detectedGpuEncoder) {
                videoCodec = _detectedGpuEncoder;
                if (videoCodec.includes('nvenc')) preset = 'p4';
            }

            cmd.complexFilter(filterChain)
                .outputOptions([
                    '-c:v', videoCodec,
                    '-preset', preset,
                    '-c:a', 'aac',
                    ...outputMaps,
                    ..._buildProcessedVideoColorOutputOptions(mainMeta)
                ])
                .output(outputPath)
                .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
                .on('end', () => resolve(outputPath))
                .on('error', (err) => reject(err))
                .run();

        } catch (e) { reject(e); }
    });
}

async function createAudioFromConcat(concatFilePath, outputPath, onProgress) {
    return new Promise((resolve, reject) => {
        ffmpeg().input(concatFilePath).inputOptions(['-f', 'concat', '-safe', '0'])
            .output(outputPath).outputOptions('-c copy')
            .on('progress', (p) => { if (onProgress) onProgress(p.percent); })
            .on('end', () => resolve(outputPath)).on('error', reject).run();
    });
}

async function generateSilence(duration, outputPath) {
    return new Promise((r, j) => {
        ffmpeg('anullsrc=r=44100:cl=stereo').inputFormat('lavfi').duration(duration).output(outputPath).on('end', r).on('error', j).run();
    });
}

/* =========================================
   VIDEO LAYER (PIP) & EXPORTS RESTORATION
   ========================================= */

async function _addVideoLayer(params, onProgress) {
    console.log('[AddVideoLayer] Params:', params);
    const { mainVideoPath, layerVideoPath, outputPath, x, y, width, height, scale, startTime, duration, opacity, audioVolume, loop } = params;

    const mainSafe = _getSafePath(mainVideoPath);
    const layerSafe = _getSafePath(layerVideoPath);

    if (!mainSafe || !layerSafe) {
        throw new Error("Missing video paths for layer");
    }

    // V115: Get metadata before starting to support percentage scale
    let mainW = 1920;
    let sourceMetadata = {};
    try {
        sourceMetadata = await _getVideoMetadata(mainSafe);
        mainW = sourceMetadata.width || 1920;
    } catch (e) {
        console.warn('[AddVideoLayer] Metadata fetch error, defaulting to 1920w:', e);
    }

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(mainSafe);
        cmd.input(layerSafe);

        // Check if layer is image using helper
        const isImage = _isImageFile(layerSafe) || (loop === true);
        if (isImage) {
            cmd.inputOption('-loop 1');
        }

        // Filter Chain
        const filters = [];

        // 1. Prepare Layer Video [1:v] -> [layerVal]
        let layerLabel = '[1:v]';

        // Scale Logic (V115: AI suggested scale support)
        let targetW = width;
        let targetH = height;
        if (scale && parseFloat(scale) > 0) {
            targetW = Math.round(mainW * (parseFloat(scale) / 100));
            targetH = -1;
            console.log(`[AddVideoLayer] Scale applied: ${scale}% -> ${targetW}px`);
        }

        if (targetW && targetH) {
            filters.push(`${layerLabel}scale=${targetW}:${targetH}[scaled]`);
            layerLabel = '[scaled]';
        }

        // Opacity / Transparency
        if (opacity !== undefined && opacity < 1.0) {
            filters.push(`${layerLabel}format=rgba,colorchannelmixer=aa=${opacity}[opaque]`);
            layerLabel = '[opaque]';
        }

        // Overlay command
        // enable='between(t,start,end)'
        let enableExpr = '';
        if (startTime !== undefined) {
            const endT = (duration !== undefined) ? (startTime + duration) : (startTime + 3600); // 1 hour fallback instead of 99999
            enableExpr = `:enable='between(t,${startTime},${endT})'`;
        }

        const posX = (x !== undefined) ? x : 0;
        const posY = (y !== undefined) ? y : 0;

        // Ensure main video is SDR/yuv420p for compatibility; HDR sources are tone-mapped first.
        filters.push(`[0:v]${_joinVideoFilters(_buildHdrToSdrFilter(sourceMetadata), 'format=yuv420p')}[mainv]`);
        filters.push(`[mainv]${layerLabel}overlay=x=${posX}:y=${posY}${enableExpr}[outv]`);

        // Audio Mixing (Simple)
        // If audioVolume > 0 and it's not an image (or we assume video has audio)
        const shouldMixAudio = !isImage && (audioVolume !== undefined && audioVolume > 0);

        if (shouldMixAudio) {
            // [1:a]volume=vol[a1]; [0:a][a1]amix...
            filters.push(`[1:a]volume=${audioVolume}[a1]`);
            // amix: inputs=2, duration=first (video length limits), dropout_transition=0
            filters.push(`[0:a][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
            cmd.outputOptions(['-map [outv]', '-map [aout]']);
        } else {
            // Keep main audio
            cmd.outputOptions(['-map [outv]', '-map 0:a']);
        }

        // Get duration for progress calculation
        _getVideoMetadata(mainSafe).then(meta => {
            const totalDuration = meta.duration || 0;

            cmd.complexFilter(filters)
                .outputOptions([
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-c:a', 'aac',
                    '-t', totalDuration.toString(), // Hard limit output duration
                    '-shortest',
                    ..._buildProcessedVideoColorOutputOptions(meta)
                ])
                .output(outputPath)
                .on('progress', (p) => {
                    let percent = p.percent;
                    if ((!percent || percent < 0) && totalDuration > 0 && p.timemark) {
                        const timeParts = p.timemark.split(':');
                        if (timeParts.length === 3) {
                            const seconds = (+timeParts[0]) * 3600 + (+timeParts[1]) * 60 + (+timeParts[2]);
                            percent = (seconds / totalDuration) * 100;
                        }
                    }
                    if (onProgress) onProgress(Math.min(99, Math.round(percent || 0)));
                })
                .on('end', () => {
                    console.log('[AddVideoLayer] Success.');
                    if (onProgress) onProgress(100);
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('[AddVideoLayer] FFmpeg Error:', err);
                    reject(err);
                })
                .run();
        }).catch(err => {
            console.error('[AddVideoLayer] Metadata fetch failed fallback.', err);
            // Fallback: run without manual duration calculation
            cmd.complexFilter(filters)
                .outputOptions([
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-c:a', 'aac',
                    '-shortest',
                    ..._buildProcessedVideoColorOutputOptions(sourceMetadata)
                ])
                .output(outputPath)
                .on('progress', (p) => { if (onProgress) onProgress(Math.min(99, Math.round(p.percent || 0))); })
                .on('end', () => {
                    if (onProgress) onProgress(100);
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('[AddVideoLayer] FFmpeg Error (fallback):', err);
                    reject(err);
                })
                .run();
        });
    });
}

async function _remuxVideo(inputPath, targetFormat) {
    const ext = targetFormat.startsWith('.') ? targetFormat : `.${targetFormat}`;
    const outputPath = inputPath.replace(path.extname(inputPath), ext);

    if (outputPath === inputPath) return { success: true, outputPath };

    console.log(`[Remux] ${inputPath} -> ${outputPath}`);

    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions(['-c', 'copy', '-map', '0'])
            .output(outputPath)
            .on('end', () => resolve({ success: true, outputPath }))
            .on('error', (err) => {
                console.error('[Remux] Error:', err);
                reject(err);
            })
            .run();
    });
}

// Module Exports - Restoring lost exports
const _legacy_exports = {
    setupFFmpeg,
    getVideoMetadata: _getVideoMetadata,
    buildColorMetadataOutputOptions: _buildColorMetadataOutputOptions,
    buildHdrToSdrFilter: _buildHdrToSdrFilter,
    buildProcessedVideoColorOutputOptions: _buildProcessedVideoColorOutputOptions,
    extractAudio: _extractAudio,
    extractVideo: _extractVideo,
    mixAudio: _mixAudioAdvanced, // Mapping mixAudio to mixAudioAdvanced
    mixAudioAdvanced: _mixAudioAdvanced,
    createAudioFromMix: _createAudioFromMix,
    addSeparateAudioTrack: _addSeparateAudioTrack,
    addSeparateAudioTrackFromAudio: _addSeparateAudioTrackFromAudio,
    createSingleDubbedRecording: _createSingleDubbedRecording,
    createSingleDubbedRecordingFromAudio: _createSingleDubbedRecordingFromAudio,
    previewRebalancedDubbedRecording: _previewRebalancedDubbedRecording,
    createRebalancedDubbedRecording: _createRebalancedDubbedRecording,
    previewAudioSegment: _previewAudio, // Helper for audio preview
    burnSubtitles: _burnSubtitles,
    addTextOverlay: _addTextOverlay,
    addImageOverlay: _overlayImageToVideo, // Helper for simple image overlay
    addTransition: _addTransition,

    // We bind applyTransitionsSmart to _applyTransitionsWithBreaks as it handles segments & breaks
    applyTransitionsSmart: _applyTransitionsWithBreaks,

    addVideoLayer: _addVideoLayer, // The new function
    safeConvertVideo: _safeConvertVideo,
    detectSilence: _detectSilence,
    formatTime: formatTime,

    remuxVideo: _remuxVideo, // NEW: Remux functionality

    createVideoFromImages: _convertImageToVideo, // Best effort mapping

    // Stubs for missing functions to prevent crashes
    createVerticalVideo: async () => { throw new Error("Function createVerticalVideo is missing/truncated."); },
    createVerticalVideoPreview: async () => { throw new Error("Function createVerticalVideoPreview is missing/truncated."); },
    addCtaOverlay: async () => { throw new Error("Function addCtaOverlay is missing/truncated."); },
    applyCtaOverlaysSmart: async () => { throw new Error("Function applyCtaOverlaysSmart is missing/truncated."); },
    generateSilence: async (d, o) => {
        // Simple silence generator using ffmpeg
        return new Promise((resolve, reject) => {
            ffmpeg().input('anullsrc=r=44100:cl=stereo').inputFormat('lavfi').duration(d).output(o).run();
        });
    },
    createAudioFromConcat: async () => { throw new Error("Function createAudioFromConcat is missing/truncated."); },
    replaceAudio: async () => { throw new Error("Function replaceAudio is missing/truncated."); },
};

// Merge exports: Base exports (from middle of file) take precedence over stubs/legacy list
// This ensures 'cutVideo' and others are preserved, while 'remuxVideo' is added.
module.exports = { ..._legacy_exports, ...module.exports };
module.exports.concatenateVideosFast = concatenateVideosFast;
module.exports.concatenateVideos = concatenateVideos;

