const DEFAULT_PAD_COLOR = 'black';

function getVisualOrientation(width, height) {
    const safeWidth = Number(width || 0);
    const safeHeight = Number(height || 0);
    if (!(safeWidth > 0) || !(safeHeight > 0)) return 'unknown';
    if (safeWidth === safeHeight) return 'square';
    return safeWidth > safeHeight ? 'landscape' : 'portrait';
}

function buildFitPadFilter(targetWidth, targetHeight, color = DEFAULT_PAD_COLOR) {
    return `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:${color},setsar=1`;
}

function buildCropFillFilter(targetWidth, targetHeight, cropXExpr = '(iw-ow)/2', cropYExpr = '(ih-oh)/2') {
    return `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}:${cropXExpr}:${cropYExpr},setsar=1`;
}

function buildBlurFillFilter(targetWidth, targetHeight, color = DEFAULT_PAD_COLOR) {
    return `split[bgsrc][fgsrc];[bgsrc]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},boxblur=18:10,eq=brightness=-0.04[bg];[fgsrc]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;
}

function buildSmartStillImagePlacementFilter(options = {}) {
    const {
        fillFrame,
        visualFitMode,
        sourceWidth,
        sourceHeight,
        targetWidth,
        targetHeight,
        padColor = DEFAULT_PAD_COLOR
    } = options;

    const fitFilter = buildFitPadFilter(targetWidth, targetHeight, padColor);
    const resolvedMode = ['blur', 'crop', 'fit'].includes(visualFitMode)
        ? visualFitMode
        : (fillFrame ? 'blur' : 'fit');

    if (resolvedMode === 'fit') {
        return fitFilter;
    }

    if (resolvedMode === 'blur') {
        return buildBlurFillFilter(targetWidth, targetHeight, padColor);
    }

    return buildCropFillFilter(targetWidth, targetHeight);
}

function buildVerticalPlacementFilter(options = {}) {
    const {
        targetWidth,
        targetHeight,
        method = 'blur',
        settings = {}
    } = options;

    if (method === 'crop') {
        const focus = settings.focus || 'center';
        const shiftPercent = Number.isFinite(settings.x) ? settings.x : 0;
        const focusExpr = focus === 'left'
            ? '0'
            : focus === 'right'
                ? '(iw-ow)'
                : '(iw-ow)/2';
        const shiftExpr = shiftPercent === 0
            ? focusExpr
            : `${focusExpr}+(((iw-ow)/2)*${(shiftPercent / 50).toFixed(4)})`;
        const cropXExpr = `max(0,min(iw-ow,${shiftExpr}))`;

        return [
            `[0:v]${buildCropFillFilter(targetWidth, targetHeight, cropXExpr, '(ih-oh)/2')}[outv]`
        ];
    }

    if (method === 'letterbox') {
        const color = settings.color || DEFAULT_PAD_COLOR;
        return [
            `color=c=${color}:s=${targetWidth}x${targetHeight}[bg]`,
            `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease[fg]`,
            `[bg][fg]overlay=(W-w)/2:(H-h)/2[outv]`
        ];
    }

    const sigma = Math.max(0, Number.isFinite(settings.sigma) ? settings.sigma : 18);
    const brightnessPercent = Number.isFinite(settings.brightness) ? settings.brightness : 100;
    const brightnessValue = ((brightnessPercent - 100) / 100).toFixed(2);
    const centerScale = Number.isFinite(settings.scale) ? settings.scale : 100;
    const fgWidth = Math.max(64, Math.round(targetWidth * (centerScale / 100)));
    const fgHeight = Math.max(64, Math.round(targetHeight * (centerScale / 100)));

    return [
        `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},boxblur=${sigma}:10,eq=brightness=${brightnessValue}[bg]`,
        `[0:v]scale=${fgWidth}:${fgHeight}:force_original_aspect_ratio=decrease[fg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2[outv]`
    ];
}

module.exports = {
    getVisualOrientation,
    buildFitPadFilter,
    buildCropFillFilter,
    buildBlurFillFilter,
    buildSmartStillImagePlacementFilter,
    buildVerticalPlacementFilter
};
