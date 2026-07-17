'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const MAC_HELPER_NAME = 'EvdMacAudioCapture';
const WINDOWS_HELPER_NAME = 'EvdProcessLoopbackCapture.exe';
const MAC_MINIMUM_VERSION = '14.2';
const EVD_MAC_BUNDLE_IDS = [
    'com.engelsiz.videoeditor',
    'com.engelsiz.videoeditor.helper',
    'com.engelsiz.videoeditor.helper.Renderer',
    'com.engelsiz.videoeditor.helper.GPU',
    'com.engelsiz.videoeditor.helper.Plugin',
    'com.engelsiz.videoeditor.helper.EH',
    'com.engelsiz.videoeditor.helper.NP',
    'com.engelsiz.instantvoicetranslation',
    'com.engelsiz.instantvoicetranslation.helper',
    'com.engelsiz.instantvoicetranslation.helper.Renderer',
    'com.engelsiz.instantvoicetranslation.helper.GPU'
];

function resolveNativeAudioHelperPath() {
    const resourcesPath = process.resourcesPath || '';
    const cwd = process.cwd();
    if (process.platform === 'darwin') {
        const candidates = [
            resourcesPath ? path.join(resourcesPath, 'native-audio', MAC_HELPER_NAME) : '',
            path.join(cwd, 'build', 'native-audio', 'mac-arm64', MAC_HELPER_NAME),
            path.join(cwd, 'tools', 'EvdMacAudioCapture', '.build', 'arm64-apple-macosx', 'release', MAC_HELPER_NAME),
            path.join(cwd, 'tools', 'EvdMacAudioCapture', '.build', 'release', MAC_HELPER_NAME)
        ];
        return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
    }
    if (process.platform !== 'win32') return '';
    const candidates = [
        resourcesPath ? path.join(resourcesPath, 'native-audio', WINDOWS_HELPER_NAME) : '',
        resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'tools', 'EvdProcessLoopbackCapture', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', WINDOWS_HELPER_NAME) : '',
        path.join(cwd, 'tools', 'EvdProcessLoopbackCapture', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', WINDOWS_HELPER_NAME),
        path.join(cwd, 'tools', 'EvdProcessLoopbackCapture', 'bin', 'Release', 'net8.0-windows', 'win-x64', WINDOWS_HELPER_NAME),
        path.join(cwd, 'tools', 'EvdProcessLoopbackCapture', 'bin', 'Release', 'net8.0-windows', WINDOWS_HELPER_NAME),
        path.join(cwd, 'tools', 'EvdProcessLoopbackCapture', 'bin', 'Debug', 'net8.0-windows', WINDOWS_HELPER_NAME)
    ];
    return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}
function describeExecError(error) {
    return {
        message: error?.message || String(error),
        code: error?.code ?? '',
        signal: error?.signal || '',
        killed: error?.killed === true,
        stderr: String(error?.stderr || '').trim()
    };
}

function primaryExecError(diagnostics) {
    return diagnostics.stderr
        || diagnostics.message
        || (diagnostics.code ? String(diagnostics.code) : '')
        || 'native_audio_helper_failed';
}


function getStaticCapabilities() {
    const helperPath = resolveNativeAudioHelperPath();
    if (process.platform === 'win32') {
        return {
            success: true,
            supported: !!helperPath,
            helperAvailable: !!helperPath,
            systemAudio: !!helperPath,
            applicationAudio: !!helperPath,
            microphone: !!helperPath,
            sessionVolume: !!helperPath,
            websocket: !!helperPath,
            sourceList: true
        };
    }
    if (process.platform === 'darwin') {
        return {
            success: true,
            supported: !!helperPath,
            helperAvailable: !!helperPath,
            minimumSystemVersion: MAC_MINIMUM_VERSION,
            systemAudio: !!helperPath,
            applicationAudio: !!helperPath,
            microphone: false,
            sessionVolume: false,
            websocket: !!helperPath,
            sourceList: !!helperPath
        };
    }
    return {
        success: true,
        supported: false,
        helperAvailable: !!helperPath,
        minimumSystemVersion: MAC_MINIMUM_VERSION,
        systemAudio: false,
        applicationAudio: false,
        microphone: false,
        sessionVolume: false,
        websocket: false,
        sourceList: false
    };
}

async function getNativeAudioCapabilities() {
    const fallback = getStaticCapabilities();
    const helperPath = resolveNativeAudioHelperPath();
    if (process.platform !== 'darwin') return fallback;
    if (!helperPath) {
        console.warn('[NativeAudio] helper missing', {
            resourcesPath: process.resourcesPath || '',
            cwd: process.cwd()
        });
        return {
            ...fallback,
            probeSuccess: false,
            probeError: 'native_audio_helper_missing'
        };
    }
    try {
        const { stdout } = await execFileAsync(helperPath, ['--capabilities'], {
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 256 * 1024
        });
        return {
            ...fallback,
            ...JSON.parse(String(stdout || '').trim()),
            helperAvailable: true,
            probeSuccess: true,
            probeError: ''
        };
    } catch (error) {
        const diagnostics = describeExecError(error);
        console.warn('[NativeAudio] capability probe failed', { helperPath, ...diagnostics });
        return {
            ...fallback,
            probeSuccess: false,
            probeError: primaryExecError(diagnostics),
            probeDiagnostics: diagnostics
        };
    }
}

async function listNativeAudioSources() {
    const helperPath = resolveNativeAudioHelperPath();
    if (process.platform !== 'darwin' || !helperPath) {
        return { success: false, sources: [], error: 'native_audio_helper_missing' };
    }
    try {
        const { stdout } = await execFileAsync(helperPath, ['--list-sources'], {
            encoding: 'utf8',
            timeout: 8000,
            maxBuffer: 1024 * 1024
        });
        const parsed = JSON.parse(String(stdout || '').trim());
        return { success: parsed?.success !== false, sources: Array.isArray(parsed?.sources) ? parsed.sources : [] };
    } catch (error) {
        const diagnostics = describeExecError(error);
        console.warn('[NativeAudio] source list failed', { helperPath, ...diagnostics });
        return {
            success: false,
            sources: [],
            error: primaryExecError(diagnostics),
            diagnostics
        };
    }
}

function appendMacSelfExclusions(args) {
    if (process.platform !== 'darwin') return args;
    for (const bundleId of EVD_MAC_BUNDLE_IDS) args.push('--exclude-bundle-id', bundleId);
    return args;
}

function buildCaptureArgs({ captureMode = 'native-system-audio', targetProcessId = 0, targetBundleId = '', includeSelfExclusion = false, wsUrl = '' } = {}) {
    let args;
    if (captureMode === 'native-microphone') {
        args = ['--microphone'];
    } else if (captureMode === 'native-window-audio') {
        if (process.platform === 'darwin' && String(targetBundleId || '').trim()) {
            args = ['--bundle-id', String(targetBundleId).trim(), '--include-tree'];
        } else {
            const pid = Number(targetProcessId || 0);
            if (!Number.isFinite(pid) || pid <= 0) throw new Error('target_process_id_required');
            args = ['--pid', String(Math.trunc(pid)), '--include-tree'];
        }
    } else {
        args = ['--output-loopback'];
    }
    if (process.platform === 'darwin' && (includeSelfExclusion || captureMode === 'native-system-audio')) {
        args.push('--pid', String(process.pid), '--exclude-tree');
        appendMacSelfExclusions(args);
    }
    if (wsUrl) args.push('--ws-url', String(wsUrl));
    return args;
}

module.exports = {
    MAC_HELPER_NAME,
    WINDOWS_HELPER_NAME,
    resolveNativeAudioHelperPath,
    getNativeAudioCapabilities,
    listNativeAudioSources,
    buildCaptureArgs,
    appendMacSelfExclusions
};
