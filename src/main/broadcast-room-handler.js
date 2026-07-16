const { BrowserWindow } = require('electron');

const prototypeRooms = new Map();
const windowBindings = new Map();

function generateRoomId() {
    return `evd-${Math.random().toString(36).slice(2, 6)}-${Date.now().toString(36).slice(-4)}`;
}

function buildInviteUrl(roomId) {
    return `https://yayinodasi.evd.local/oda/${encodeURIComponent(roomId)}`;
}

function parseRoomIdFromInvite(inviteUrl) {
    const rawValue = String(inviteUrl || '').trim();
    if (!rawValue) {
        return '';
    }

    try {
        const parsed = new URL(rawValue);
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts.length ? decodeURIComponent(parts[parts.length - 1]) : '';
    } catch (_error) {
        const parts = rawValue.split('/').filter(Boolean);
        return parts.length ? decodeURIComponent(parts[parts.length - 1]) : '';
    }
}

function getWindowById(windowId) {
    if (!windowId) {
        return null;
    }
    try {
        return BrowserWindow.fromId(windowId) || null;
    } catch (_error) {
        return null;
    }
}

function buildParticipantSnapshot(participant = {}) {
    return {
        id: String(participant.id || ''),
        name: String(participant.name || ''),
        role: String(participant.role || ''),
        cameraEnabled: participant.cameraEnabled !== false,
        microphoneEnabled: participant.microphoneEnabled !== false,
        activeShare: participant.activeShare ? {
            shareKind: String(participant.activeShare.shareKind || ''),
            label: String(participant.activeShare.label || ''),
            includeAudio: participant.activeShare.includeAudio === true,
            startedAt: Number(participant.activeShare.startedAt) || Date.now()
        } : null,
        joinedAt: Number(participant.joinedAt) || Date.now()
    };
}

function buildRoomSnapshot(room) {
    if (!room) {
        return null;
    }

    return {
        roomState: {
            roomId: room.roomId,
            inviteUrl: room.inviteUrl,
            hostConnected: true
        },
        participants: Array.from(room.participants.values())
            .map((participant) => buildParticipantSnapshot(participant))
            .sort((left, right) => Number(left.joinedAt || 0) - Number(right.joinedAt || 0)),
        participantSources: Array.from(room.participants.values())
            .flatMap((participant) => {
                const items = [];
                items.push({
                    id: `${participant.id}-camera`,
                    ownerId: participant.id,
                    ownerName: participant.name,
                    type: 'camera',
                    enabled: participant.cameraEnabled !== false
                });
                items.push({
                    id: `${participant.id}-microphone`,
                    ownerId: participant.id,
                    ownerName: participant.name,
                    type: 'microphone',
                    enabled: participant.microphoneEnabled !== false
                });
                if (participant.activeShare) {
                    items.push({
                        id: `${participant.id}-share`,
                        ownerId: participant.id,
                        ownerName: participant.name,
                        type: 'share',
                        shareKind: String(participant.activeShare.shareKind || ''),
                        label: String(participant.activeShare.label || ''),
                        includeAudio: participant.activeShare.includeAudio === true,
                        sourceGroup: participant.role === 'host' ? 'host-share' : 'guest-share',
                        isShareSource: true,
                        enabled: true
                    });
                }
                return items;
            })
    };
}

function ensureWindowCloseBinding(window) {
    if (!window || window.isDestroyed() || window.__evdBroadcastRoomCloseBound) {
        return;
    }

    window.__evdBroadcastRoomCloseBound = true;
    window.once('closed', () => {
        handleWindowClosed(window.id);
    });
}

function bindWindowToRoom(window, roomId, participantId, role) {
    if (!window || window.isDestroyed()) {
        return;
    }

    ensureWindowCloseBinding(window);
    windowBindings.set(window.id, {
        roomId,
        participantId,
        role
    });
}

function unbindWindow(windowId) {
    if (!windowId) {
        return;
    }
    windowBindings.delete(windowId);
}

function sendRoomSnapshotToWindow(window, room) {
    if (!window || window.isDestroyed() || !window.webContents || !room) {
        return;
    }

    try {
        window.webContents.send('broadcast-room-room-state', buildRoomSnapshot(room));
    } catch (error) {
        console.warn('broadcast room snapshot send failed:', error.message);
    }
}

function broadcastRoomSnapshot(roomId) {
    const room = prototypeRooms.get(roomId);
    if (!room) {
        return;
    }

    Array.from(room.participants.values()).forEach((participant) => {
        const participantWindow = getWindowById(participant.windowId);
        sendRoomSnapshotToWindow(participantWindow, room);
    });
}

function closePrototypeRoom(roomId) {
    const room = prototypeRooms.get(roomId);
    if (!room) {
        return;
    }

    Array.from(room.participants.values()).forEach((participant) => {
        const participantWindow = getWindowById(participant.windowId);
        if (participantWindow && !participantWindow.isDestroyed() && participant.role !== 'host') {
            try {
                participantWindow.webContents.send('broadcast-room-room-closed', {
                    roomId: room.roomId,
                    inviteUrl: room.inviteUrl
                });
            } catch (error) {
                console.warn('broadcast room close send failed:', error.message);
            }
        }
        if (participant.windowId) {
            unbindWindow(participant.windowId);
        }
    });

    prototypeRooms.delete(roomId);
}

function handleWindowClosed(windowId) {
    const binding = windowBindings.get(windowId);
    if (!binding) {
        return;
    }

    unbindWindow(windowId);
    const room = prototypeRooms.get(binding.roomId);
    if (!room) {
        return;
    }

    if (binding.role === 'host') {
        closePrototypeRoom(binding.roomId);
        return;
    }

    room.participants.delete(binding.participantId);
    broadcastRoomSnapshot(binding.roomId);
}

function createPrototypeRoom(hostWindow, options = {}) {
    if (!hostWindow || hostWindow.isDestroyed()) {
        throw new Error('host_window_not_found');
    }

    const existingBinding = windowBindings.get(hostWindow.id);
    if (existingBinding?.roomId) {
        closePrototypeRoom(existingBinding.roomId);
    }

    const roomId = String(options.roomId || generateRoomId());
    const inviteUrl = buildInviteUrl(roomId);
    const hostName = String(options.hostName || 'Host').trim() || 'Host';
    const hostParticipant = {
        id: `host-${hostWindow.id}`,
        name: hostName,
        role: 'host',
        cameraEnabled: options.cameraEnabled !== false,
        microphoneEnabled: options.microphoneEnabled !== false,
        activeShare: null,
        joinedAt: Date.now(),
        windowId: hostWindow.id
    };

    const room = {
        roomId,
        inviteUrl,
        participants: new Map([[hostParticipant.id, hostParticipant]])
    };

    prototypeRooms.set(roomId, room);
    bindWindowToRoom(hostWindow, roomId, hostParticipant.id, 'host');
    broadcastRoomSnapshot(roomId);
    return buildRoomSnapshot(room);
}

function joinPrototypeRoom(guestWindow, options = {}) {
    if (!guestWindow || guestWindow.isDestroyed()) {
        throw new Error('guest_window_not_found');
    }

    const displayName = String(options.displayName || '').trim();
    if (!displayName) {
        throw new Error('display_name_required');
    }

    const roomId = String(options.roomId || parseRoomIdFromInvite(options.inviteUrl)).trim();
    if (!roomId) {
        throw new Error('room_id_missing');
    }

    const room = prototypeRooms.get(roomId);
    if (!room) {
        throw new Error('room_not_found');
    }

    const guestParticipant = {
        id: `guest-${guestWindow.id}`,
        name: displayName,
        role: 'guest',
        cameraEnabled: options.cameraEnabled !== false,
        microphoneEnabled: options.microphoneEnabled !== false,
        activeShare: null,
        joinedAt: Date.now(),
        windowId: guestWindow.id
    };

    room.participants.set(guestParticipant.id, guestParticipant);
    bindWindowToRoom(guestWindow, roomId, guestParticipant.id, 'guest');
    broadcastRoomSnapshot(roomId);
    return buildRoomSnapshot(room);
}

function getPrototypeRoomSnapshot(roomId) {
    const normalizedRoomId = String(roomId || '').trim();
    if (!normalizedRoomId) {
        return null;
    }
    const room = prototypeRooms.get(normalizedRoomId);
    return buildRoomSnapshot(room);
}

function getPrototypeInviteUrl(roomId) {
    const snapshot = getPrototypeRoomSnapshot(roomId);
    return snapshot?.roomState?.inviteUrl || '';
}

function updatePrototypeParticipantMediaState(window, options = {}) {
    if (!window || window.isDestroyed()) {
        throw new Error('window_not_found');
    }

    const binding = windowBindings.get(window.id);
    if (!binding?.roomId || !binding?.participantId) {
        throw new Error('participant_binding_not_found');
    }

    const room = prototypeRooms.get(binding.roomId);
    if (!room) {
        throw new Error('room_not_found');
    }

    const participant = room.participants.get(binding.participantId);
    if (!participant) {
        throw new Error('participant_not_found');
    }

    if (typeof options.cameraEnabled === 'boolean') {
        participant.cameraEnabled = options.cameraEnabled;
    }

    if (typeof options.microphoneEnabled === 'boolean') {
        participant.microphoneEnabled = options.microphoneEnabled;
    }

    room.participants.set(binding.participantId, participant);
    broadcastRoomSnapshot(binding.roomId);
    return buildRoomSnapshot(room);
}

function updatePrototypeParticipantShareState(window, options = {}) {
    if (!window || window.isDestroyed()) {
        throw new Error('window_not_found');
    }

    const binding = windowBindings.get(window.id);
    if (!binding?.roomId || !binding?.participantId) {
        throw new Error('participant_binding_not_found');
    }

    const room = prototypeRooms.get(binding.roomId);
    if (!room) {
        throw new Error('room_not_found');
    }

    const participant = room.participants.get(binding.participantId);
    if (!participant) {
        throw new Error('participant_not_found');
    }

    if (options.clearShare) {
        participant.activeShare = null;
    } else {
        const shareKind = String(options.shareKind || '').trim();
        if (!shareKind) {
            throw new Error('share_kind_required');
        }

        participant.activeShare = {
            shareKind,
            label: String(options.label || '').trim(),
            includeAudio: options.includeAudio === true,
            startedAt: Date.now()
        };
    }

    room.participants.set(binding.participantId, participant);
    broadcastRoomSnapshot(binding.roomId);
    return buildRoomSnapshot(room);
}

module.exports = {
    buildInviteUrl,
    createPrototypeRoom,
    getPrototypeInviteUrl,
    getPrototypeRoomSnapshot,
    joinPrototypeRoom,
    parseRoomIdFromInvite,
    updatePrototypeParticipantMediaState,
    updatePrototypeParticipantShareState
};
