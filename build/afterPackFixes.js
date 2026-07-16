const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function findAppBundle(appOutDir, productFilename) {
    const candidates = [];
    if (productFilename) {
        candidates.push(path.join(appOutDir, `${productFilename}.app`));
    }

    try {
        for (const entry of fs.readdirSync(appOutDir)) {
            if (entry.endsWith('.app')) {
                candidates.push(path.join(appOutDir, entry));
            }
        }
    } catch (_error) {
        // The explicit candidate below will report a clearer error.
    }

    const appPath = candidates.find((candidate) => candidate && fs.existsSync(candidate));
    if (!appPath) {
        throw new Error(`macOS app bundle not found in ${appOutDir}`);
    }
    return appPath;
}

function readPlistAsJson(infoPlistPath) {
    const tempJsonPath = path.join(os.tmpdir(), `evd-info-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    try {
        execFileSync('plutil', ['-convert', 'json', '-o', tempJsonPath, infoPlistPath], { stdio: 'pipe' });
        return JSON.parse(fs.readFileSync(tempJsonPath, 'utf8'));
    } finally {
        try { fs.unlinkSync(tempJsonPath); } catch (_error) { }
    }
}

function writePlistFromJson(infoPlistPath, plistData) {
    const tempJsonPath = path.join(os.tmpdir(), `evd-info-out-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    try {
        fs.writeFileSync(tempJsonPath, JSON.stringify(plistData, null, 2), 'utf8');
        execFileSync('plutil', ['-convert', 'xml1', '-o', infoPlistPath, tempJsonPath], { stdio: 'pipe' });
    } finally {
        try { fs.unlinkSync(tempJsonPath); } catch (_error) { }
    }
}

module.exports = async function afterPackFixes(context) {
    if (process.platform !== 'darwin') {
        return;
    }

    const appInfo = context.packager && context.packager.appInfo;
    const appPath = findAppBundle(context.appOutDir, appInfo && appInfo.productFilename);
    const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
    const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');

    if (!fs.existsSync(infoPlistPath) || !fs.existsSync(asarPath)) {
        console.warn('[afterPackFixes] Info.plist or app.asar was not found; skipping asar integrity fix.');
        return;
    }

    const asarHash = crypto.createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex');
    const plistData = readPlistAsJson(infoPlistPath);

    plistData.ElectronAsarIntegrity = {
        'Resources/app.asar': {
            algorithm: 'SHA256',
            hash: asarHash
        }
    };

    writePlistFromJson(infoPlistPath, plistData);
    console.log(`[afterPackFixes] ElectronAsarIntegrity updated for ${path.basename(appPath)}: ${asarHash}`);
};
