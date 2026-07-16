const baseConfig = require('./instant-voice-translation-builder.json');

const signingEnabled = process.env.EVD_MAC_SIGNING_ENABLED === '1';
const asciiProductName = 'Anlik Sesli Ceviri';
const displayProductName = 'Anlık Sesli Çeviri';

const files = baseConfig.files.filter((entry) => {
    const value = String(entry || '');
    return !value.includes('EvdProcessLoopbackCapture')
        && !value.includes('net8.0-windows')
        && !value.includes('win-x64');
});

const mac = {
    target: [{ target: 'dmg', arch: ['arm64'] }],
    icon: 'Start_icon.png',
    category: 'public.app-category.utilities',
    minimumSystemVersion: '14.2',
    binaries: ['Contents/Resources/native-audio/EvdMacAudioCapture'],
    artifactName: 'Anlik-Sesli-Ceviri-${version}-${arch}.${ext}',
    hardenedRuntime: signingEnabled,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.instant-voice-translation.mac.plist',
    entitlementsInherit: 'build/entitlements.instant-voice-translation.mac.plist',
    extendInfo: {
        CFBundleDisplayName: displayProductName,
        CFBundleName: asciiProductName,
        NSMicrophoneUsageDescription: 'Instant Voice Translation needs microphone access to translate speech in real time.',
        NSAudioCaptureUsageDescription: 'Instant Voice Translation needs system audio recording access to translate computer and application audio in real time.'
    }
};

if (signingEnabled) {
    // electron-builder selects the imported Developer ID Application identity.
    mac.type = undefined;
    mac.identity = undefined;
} else {
    mac.identity = null;
    mac.type = 'development';
}

module.exports = {
    ...baseConfig,
    productName: asciiProductName,
    executableName: asciiProductName,
    afterPack: 'build/afterPackFixes.js',
    files,
    asarUnpack: [],
    extraResources: [
        { from: 'build/macos-info-plist', to: '.' },
        { from: 'build/native-audio/mac-arm64', to: 'native-audio' }
    ],
    mac
};