const fs = require('fs');
const path = require('path');
const os = require('os');

const EFFECTS_DIR = path.join(os.homedir(), '.korcul-video-editor', 'live-effects');
const PROFILES_FILE = path.join(EFFECTS_DIR, 'profiles.json');
const SHORTCUT_ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function getMediaTypeFromPath(sourcePath = '') {
    const ext = path.extname(String(sourcePath || '')).toLowerCase();
    const videoExts = ['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.mpg', '.mpeg', '.ts', '.mts', '.m2ts', '.vob', '.3gp', '.flv', '.wmv'];
    return videoExts.includes(ext) ? 'video' : 'audio';
}

function ensureEffectsDir() {
    if (!fs.existsSync(EFFECTS_DIR)) {
        fs.mkdirSync(EFFECTS_DIR, { recursive: true });
    }
}

function createEmptySlot(index) {
    return {
        id: `slot-${index + 1}`,
        name: '',
        type: 'audio',
        sourcePath: '',
        imagePath: '',
        shortcutKey: SHORTCUT_ORDER[index] || '',
        volumePercent: 100,
        playMode: 'once',
        duckMic: false,
        duckSystem: false,
        stopOthers: false,
        enabled: true
    };
}

function createDefaultProfile() {
    return {
        id: 'default-live-effects',
        name: 'Varsayilan Profil',
        description: '',
        introSlotId: '',
        outroSlotId: '',
        slots: Array.from({ length: 10 }, (_, index) => createEmptySlot(index))
    };
}

function createDefaultState() {
    const defaultProfile = createDefaultProfile();
    return {
        activeProfileId: defaultProfile.id,
        profiles: [defaultProfile]
    };
}

function normalizeState(rawState) {
    const baseState = rawState && typeof rawState === 'object' ? rawState : {};
    const profiles = Array.isArray(baseState.profiles) && baseState.profiles.length > 0
        ? baseState.profiles.map((profile, profileIndex) => ({
            id: profile.id || `profile-${profileIndex + 1}`,
            name: profile.name || `Profil ${profileIndex + 1}`,
            description: profile.description || '',
            introSlotId: profile.introSlotId || '',
            outroSlotId: profile.outroSlotId || '',
            slots: Array.from({ length: 10 }, (_, slotIndex) => {
                const source = Array.isArray(profile.slots) ? profile.slots[slotIndex] : null;
                const normalizedSlot = {
                    ...createEmptySlot(slotIndex),
                    ...(source && typeof source === 'object' ? source : {})
                };
                normalizedSlot.type = normalizedSlot.type === 'video'
                    ? 'video'
                    : getMediaTypeFromPath(normalizedSlot.sourcePath);
                normalizedSlot.shortcutKey = normalizedSlot.shortcutKey || SHORTCUT_ORDER[slotIndex] || '';
                return normalizedSlot;
            })
        }))
        : [createDefaultProfile()];

    profiles.forEach((profile) => {
        const slotIds = new Set(profile.slots.map((slot) => slot.id));
        if (!slotIds.has(profile.introSlotId)) {
            profile.introSlotId = '';
        }
        if (!slotIds.has(profile.outroSlotId)) {
            profile.outroSlotId = '';
        }
    });

    const activeProfileId = profiles.some((profile) => profile.id === baseState.activeProfileId)
        ? baseState.activeProfileId
        : profiles[0].id;

    return {
        activeProfileId,
        profiles
    };
}

function loadState() {
    ensureEffectsDir();
    if (!fs.existsSync(PROFILES_FILE)) {
        const defaultState = createDefaultState();
        fs.writeFileSync(PROFILES_FILE, JSON.stringify(defaultState, null, 2), 'utf8');
        return defaultState;
    }

    try {
        const raw = fs.readFileSync(PROFILES_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        const normalized = normalizeState(parsed);
        fs.writeFileSync(PROFILES_FILE, JSON.stringify(normalized, null, 2), 'utf8');
        return normalized;
    } catch (error) {
        console.error('[LiveEffects] Profil dosyasi okunamadi, varsayilan durum olusturuluyor:', error.message);
        const defaultState = createDefaultState();
        fs.writeFileSync(PROFILES_FILE, JSON.stringify(defaultState, null, 2), 'utf8');
        return defaultState;
    }
}

function saveState(state) {
    ensureEffectsDir();
    const normalized = normalizeState(state);
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
}

function getState() {
    return loadState();
}

function saveProfile(profile) {
    const state = loadState();
    const normalizedProfile = normalizeState({
        profiles: [profile],
        activeProfileId: profile && profile.id
    }).profiles[0];

    const existingIndex = state.profiles.findIndex((item) => item.id === normalizedProfile.id);
    if (existingIndex >= 0) {
        state.profiles[existingIndex] = normalizedProfile;
    } else {
        state.profiles.push(normalizedProfile);
    }

    state.activeProfileId = normalizedProfile.id;
    return saveState(state);
}

function createProfile(name) {
    const state = loadState();
    const profileId = `profile-${Date.now()}`;
    const profile = {
        ...createDefaultProfile(),
        id: profileId,
        name: name || 'Yeni Profil'
    };
    state.profiles.push(profile);
    state.activeProfileId = profile.id;
    return saveState(state);
}

function deleteProfile(profileId) {
    const state = loadState();
    if (state.profiles.length <= 1) {
        return state;
    }

    state.profiles = state.profiles.filter((profile) => profile.id !== profileId);
    if (!state.profiles.some((profile) => profile.id === state.activeProfileId)) {
        state.activeProfileId = state.profiles[0].id;
    }
    return saveState(state);
}

function setActiveProfile(profileId) {
    const state = loadState();
    if (state.profiles.some((profile) => profile.id === profileId)) {
        state.activeProfileId = profileId;
    }
    return saveState(state);
}

module.exports = {
    getState,
    saveProfile,
    createProfile,
    deleteProfile,
    setActiveProfile
};
