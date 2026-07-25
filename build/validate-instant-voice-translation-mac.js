const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const root = path.resolve(__dirname, '..');
const locales = ['tr', 'en', 'de', 'es', 'fr'];
const required = ['start_with_shortcut', 'startup_intro_mac', 'hide_to_menu_bar', 'hide_to_menu_bar_status', 'hide_to_menu_bar_failed', 'mac_microphone_only_hint', 'mac_native_audio_ready_hint', 'mac_native_audio_probe_failed_hint', 'mac_native_audio_unavailable_hint', 'mac_microphone_capture_failed'];

function readUtf8(file) {
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
}
function collectStrings(value, prefix = '', output = []) {
    if (typeof value === 'string') output.push([prefix, value]);
    else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            collectStrings(child, prefix ? prefix + '.' + key : key, output);
        }
    }
    return output;
}

for (const locale of locales) {
    const file = path.join(root, 'src', 'locales', locale + '.json');
    const section = JSON.parse(readUtf8(file)).dialog.instant_voice_translation;
    for (const key of required) {
        if (!section[key]) throw new Error(locale + ': missing key ' + key);
    }
    if (!section.start_with_shortcut.includes('{shortcut}')) {
        throw new Error(locale + ': shortcut placeholder is missing');
    }
    const bad = collectStrings(section).filter((entry) => entry[1].includes('\uFFFD') || entry[1].includes('?'));
    if (bad.length) throw new Error(locale + ': suspicious encoding in ' + bad.map((entry) => entry[0]).join(', '));
}

const config = require('./instant-voice-translation-mac-builder.js');
const serialized = JSON.stringify(config);
for (const value of [config.productName, config.executableName, config.mac.artifactName]) {
    if (!/^[\x00-\x7F]+$/.test(value || '')) throw new Error('macOS internal names must remain ASCII');
}
if (serialized.includes('EvdProcessLoopbackCapture') || serialized.includes('net8.0-windows')) {
    throw new Error('Windows native audio helper leaked into macOS config');
}
if (config.mac.target[0].arch[0] !== 'arm64') throw new Error('arm64 target is missing');
if (config.mac.minimumSystemVersion !== '14.2') throw new Error('macOS 14.2 minimum is missing');
if (!serialized.includes('EvdMacAudioCapture') || !serialized.includes('native-audio')) {
    throw new Error('macOS native audio helper is missing from config');
}
if (!serialized.includes('NSAudioCaptureUsageDescription')) throw new Error('system audio permission is missing');
const entitlements = readUtf8(path.join(root, config.mac.entitlements));
if (!entitlements.includes('com.apple.security.device.audio-input')) {
    throw new Error('microphone entitlement is missing');
}

for (const locale of locales) {
    const file = path.join(root, 'build', 'macos-info-plist', locale + '.lproj', 'InfoPlist.strings');
    if (!readUtf8(file).includes('NSMicrophoneUsageDescription')) {
        throw new Error(locale + ': microphone permission text is missing');
    }
    if (!readUtf8(file).includes('NSAudioCaptureUsageDescription')) {
        throw new Error(locale + ': system audio permission text is missing');
    }
}
for (const locale of locales) {
    const file = path.join(root, 'build', 'macos-info-plist-evd', locale + '.lproj', 'InfoPlist.strings');
    if (!readUtf8(file).includes('NSAudioCaptureUsageDescription')) {
        throw new Error(locale + ': EVD system audio permission text is missing');
    }
}
const nativeAudioPlatformSource = readUtf8(path.join(root, 'src', 'main', 'native-audio-platform.js'));
for (const marker of ['probeSuccess', 'probeError', 'probeDiagnostics', '[NativeAudio] capability probe failed', '[NativeAudio] source list failed']) {
    if (!nativeAudioPlatformSource.includes(marker)) {
        throw new Error('native audio diagnostics marker is missing: ' + marker);
    }
}
const standaloneSource = readUtf8(path.join(root, 'src', 'renderer', 'scripts', 'instant-voice-translation-standalone.js'));
if (!standaloneSource.includes("result?.success === false") || !standaloneSource.includes('mac_native_audio_probe_failed_hint')) {
    throw new Error('renderer native audio diagnostics are missing');
}
const standaloneHtml = readUtf8(path.join(root, 'src', 'renderer', 'instant-voice-translation.html'));
if (!standaloneHtml.includes('id="instant-voice-translation-service" size="2"') || !standaloneHtml.includes('id="instant-voice-translation-source" size="3"')) {
    throw new Error('VoiceOver list boxes are missing');
}
const mainProcessSource = readUtf8(path.join(root, 'src', 'main', 'index.js'));
for (const marker of ['installInstantTranslationEditingShortcuts', "'paste'", "'copy'", "'cut'", "'selectAll'", "'redo'", "'undo'"]) {
    if (!mainProcessSource.includes(marker)) {
        throw new Error('macOS editing shortcut marker is missing: ' + marker);
    }
}
console.log('Instant Voice Translation macOS validation passed.');