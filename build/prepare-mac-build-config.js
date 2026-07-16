const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const packagePath = path.join(projectRoot, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

const asciiProductName = 'Engelsiz Video Duzenleyicisi';
const displayProductName = 'Engelsiz Video Düzenleyicisi';
const signingEnabled = process.env.EVD_MAC_SIGNING_ENABLED === '1';

pkg.build = pkg.build || {};

// macOS code signing validates exact bundle paths. Keep signed file names ASCII
// to avoid Unicode normalization mismatches such as "ü" vs "u" + combining mark.
pkg.build.productName = asciiProductName;
pkg.build.executableName = asciiProductName;
pkg.build.afterPack = 'build/afterPackFixes.js';

pkg.build.mac = {
    ...(pkg.build.mac || {}),
    target: [
        {
            target: 'dmg',
            arch: ['arm64']
        }
    ],
    artifactName: '${productName}-${version}-${arch}.${ext}',
    minimumSystemVersion: '14.2',
    binaries: ['Contents/Resources/native-audio/EvdMacAudioCapture'],
    hardenedRuntime: signingEnabled,
    gatekeeperAssess: false,
    entitlements: 'entitlements.mac.plist',
    entitlementsInherit: 'entitlements.mac.plist',
    extendInfo: {
        ...((pkg.build.mac && pkg.build.mac.extendInfo) || {}),
        CFBundleDisplayName: displayProductName,
        // Electron derives Helper.app names from CFBundleName during startup.
        // Keep it identical to the ASCII executable name; only the display name is localized.
        CFBundleName: asciiProductName,
        NSAudioCaptureUsageDescription: 'Accessible Video Editor needs system audio recording access for instant translation and broadcast room computer audio sharing.'
    }
};

if (signingEnabled) {
    delete pkg.build.mac.type;
    // electron-builder 26 selects the imported Developer ID identity itself.
    delete pkg.build.mac.identity;
} else {
    pkg.build.mac.identity = null;
    pkg.build.mac.type = 'development';
}

const extraResources = Array.isArray(pkg.build.extraResources) ? pkg.build.extraResources : [];
pkg.build.extraResources = extraResources.filter((entry) => {
    const from = String(entry && entry.from || '');
    const to = String(entry && entry.to || '');
    if (!from) {
        return false;
    }
    if (from.includes('EvdProcessLoopbackCapture') || from.includes('net8.0-windows')) {
        return false;
    }
    if (from.includes('build/native-audio/mac-arm64') || from.includes('macos-info-plist-evd')) {
        return false;
    }
    if (to === 'obs-studio' || from.includes('obs-studio')) {
        return false;
    }
    return fs.existsSync(path.join(projectRoot, from));
});
pkg.build.extraResources.push(
    { from: 'build/macos-info-plist-evd', to: '.' },
    { from: 'build/native-audio/mac-arm64', to: 'native-audio' }
);

fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

console.log('Prepared macOS build configuration:');
console.log(`- bundle/executable name: ${asciiProductName}`);
console.log(`- display name: ${displayProductName}`);
console.log('- target: dmg arm64');
console.log(`- signing: ${signingEnabled ? 'Developer ID / notarization ready' : 'disabled (unsigned test build)'}`);

