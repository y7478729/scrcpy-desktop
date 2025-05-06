const express = require('express');
const net = require('net');
const path = require('path');
const util = require('util');
const {
    exec
} = require('child_process');
const adbkit = require('@devicefarmer/adbkit');
const WebSocket = require('ws');
const crypto = require('crypto');
const {
    Worker
} = require('worker_threads');

const SERVER_PORT_BASE = 27183;
const WEBSOCKET_PORT = 8080;
const HTTP_PORT = 8000;
const SERVER_JAR_PATH = path.resolve(__dirname, 'public/vendor/Genymobile/scrcpy-server/scrcpy-server-v3.2');
const SERVER_DEVICE_PATH = '/data/local/tmp/scrcpy-server.jar';
const SCRCPY_VERSION = '3.2';

const LogLevel = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};
const CURRENT_LOG_LEVEL = LogLevel.INFO;

const BASE_SCRCPY_OPTIONS = {
    log_level: CURRENT_LOG_LEVEL === LogLevel.DEBUG ? 'debug' : 'info',
    video_codec: 'h264',
    audio_codec: 'aac',
};

const DEVICE_NAME_LENGTH = 64;
const VIDEO_METADATA_LENGTH = 12;
const AUDIO_METADATA_LENGTH = 4;
const PACKET_HEADER_LENGTH = 12;

const MESSAGE_TYPES = {
    DEVICE_NAME: 'deviceName',
    VIDEO_INFO: 'videoInfo',
    AUDIO_INFO: 'audioInfo',
    STATUS: 'status',
    ERROR: 'error',
    DEVICE_MESSAGE: 'deviceMessage'
};
const BINARY_TYPES = {
    VIDEO: 0,
    AUDIO: 1
};

const CODEC_IDS = {
    H264: 0x68323634,
    AAC: 0x00616163,
};

const CODEC_METADATA_LENGTHS = {
    [CODEC_IDS.H264]: VIDEO_METADATA_LENGTH,
    [CODEC_IDS.AAC]: AUDIO_METADATA_LENGTH
};

const CODEC_SOCKET_TYPES = {
    [CODEC_IDS.H264]: 'video',
    [CODEC_IDS.AAC]: 'audio'
};

const adb = new adbkit.Client();
const execPromise = util.promisify(exec);
const sessions = new Map();
const wsClients = new Map();
const workers = new Map();

const SAMPLE_RATE_MAP = {
    0: 96000,
    1: 88200,
    2: 64000,
    3: 48000,
    4: 44100,
    5: 32000,
    6: 24000,
    7: 22050,
    8: 16000,
    9: 12000,
    10: 11025,
    11: 8000,
    12: 7350,
    13: 0,
    14: 0,
    15: 0
};

const PROFILE_MAP = {
    2: 1, // AAC-LC
    5: 4, // HE-AAC (SBR)
    29: 28, // HE-AAC v2 (PS)
};

function log(level, message, ...args) {
    if (level >= CURRENT_LOG_LEVEL) {
        const levelStr = Object.keys(LogLevel).find(key => LogLevel[key] === level);
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${levelStr}]`, message, ...args);
    }
}

function parseAudioSpecificConfig(buffer) {
    let offset = 0;
    let bits = 0;
    let bitCount = 0;

    function readBits(numBits) {
        while (bitCount < numBits) {
            bits = (bits << 8) | buffer[offset++];
            bitCount += 8;
        }
        bitCount -= numBits;
        const result = (bits >> bitCount) & ((1 << numBits) - 1);
        bits &= (1 << bitCount) - 1;
        return result;
    }

    const objectType = readBits(5);
    let sampleRateIndex = readBits(4);
    let sampleRate = SAMPLE_RATE_MAP[sampleRateIndex];
    if (sampleRateIndex === 15) {
        sampleRate = readBits(24);
    }
    const channelConfig = readBits(4);

    if (!PROFILE_MAP[objectType]) {
        throw new Error(`Unsupported AAC object type: ${objectType}`);
    }
    if (!sampleRate) {
        throw new Error(`Unsupported sample rate index: ${sampleRateIndex}`);
    }
    if (channelConfig < 1 || channelConfig > 7) {
        throw new Error(`Unsupported channel configuration: ${channelConfig}`);
    }

    return {
        profile: PROFILE_MAP[objectType],
        sampleRateIndex,
        sampleRate,
        channelConfig,
    };
}

function createAdtsHeader(aacFrameLength, metadata) {
    const {
        profile,
        sampleRateIndex,
        channelConfig
    } = metadata;
    const frameLength = 7 + aacFrameLength;

    const header = Buffer.alloc(7);
    header[0] = 0xFF; // Syncword
    header[1] = 0xF9; // Syncword, ID=0 (MPEG-4), Layer=00, Protection=1
    header[2] = (profile << 6) | (sampleRateIndex << 2) | ((channelConfig >> 2) & 0x1);
    header[3] = ((channelConfig & 0x3) << 6) | ((frameLength >> 11) & 0x3);
    header[4] = (frameLength >> 3) & 0xFF;
    header[5] = ((frameLength & 0x7) << 5) | 0x1F;
    header[6] = 0xFC; // Buffer Fullness, 1 frame
    return header;
}

function createWebSocketServer() {
    const wss = new WebSocket.Server({
        port: WEBSOCKET_PORT
    });
    wss.on('connection', (ws) => {
        const clientId = crypto.randomUUID();
        wsClients.set(clientId, {
            ws,
            session: null
        });
        log(LogLevel.INFO, `[WebSocket] Client connected: ${clientId}`);

        ws.on('message', async (data, isBinary) => {
            const messageType = isBinary ? 'Binary' : 'Text';
            log(LogLevel.DEBUG, `[WebSocket] Received message from ${clientId} (Type: ${messageType}, Size: ${data.length})`);
            const client = wsClients.get(clientId);
            if (!client) return;

            if (isBinary) {
                if (client.session) {
                    const session = sessions.get(client.session);
                    if (session?.controlSocket && !session.controlSocket.destroyed) {
                        const worker = workers.get(client.session);
                        if (worker) {
                            log(LogLevel.DEBUG, `[Control Send] Forwarding ${data.length} bytes to worker for SCID ${client.session}`);
                            const bufferData = Buffer.isBuffer(data) ? data : Buffer.from(data);
                            worker.postMessage({
                                type: 'controlData',
                                data: bufferData,
                                scid: client.session,
                                clientId
                            });
                        } else {
                            log(LogLevel.WARN, `[Control Send] No worker for SCID ${client.session}`);
                        }
                    } else if (session?.options?.control === 'true') {
                        log(LogLevel.WARN, `[Control Send] Cannot forward: Control socket for SCID ${client.session} not assigned/destroyed.`);
                    }
                }
            } else {
                let message;
                try {
                    message = JSON.parse(data.toString());
                    log(LogLevel.INFO, `[WebSocket] Parsed command from ${clientId}: ${message.action}`);
                    switch (message.action) {
                        case 'start':
                            await handleStart(clientId, ws, message);
                            break;
                        case 'disconnect':
                            await handleDisconnect(clientId);
                            break;
						case 'volume':
							await handleVolumeCommand(clientId, ws, message);
							break;
						case 'getVolume':
							await handleGetVolumeCommand(clientId, ws, message);
							break;
						case 'navAction':
							await handleNavAction(clientId, ws, message);
							break;
						case 'wifiToggle':
							await handleWifiToggleCommand(clientId, ws, message);
							break;
						case 'getWifiStatus':
							await handleGetWifiStatusCommand(clientId, ws, message);
							break;							
                        default:
                            log(LogLevel.WARN, `[WebSocket] Unknown action from ${clientId}: ${message.action}`);
                            ws.send(JSON.stringify({
                                type: MESSAGE_TYPES.ERROR,
                                message: `Unknown action: ${message.action}`
                            }));
                            break;
                    }
                } catch (err) {
                    log(LogLevel.ERROR, `[WebSocket] Invalid JSON from ${clientId}: ${err.message}. Data: ${data.toString().substring(0, 100)}`);
                    ws.send(JSON.stringify({
                        type: MESSAGE_TYPES.ERROR,
                        message: 'Invalid message format'
                    }));
                }
            }
        });

        ws.on('close', (code, reason) => {
            log(LogLevel.INFO, `[WebSocket] Client disconnected: ${clientId} (Code: ${code}, Reason: ${reason?.toString()})`);
            handleDisconnect(clientId);
        });
        ws.on('error', (error) => {
            log(LogLevel.ERROR, `[WebSocket] Error for client ${clientId}: ${error.message}`);
            handleDisconnect(clientId);
        });
    });
    log(LogLevel.INFO, `[System] WebSocket server listening on port ${WEBSOCKET_PORT}`);
    return wss;
}

async function getMediaVolumeInfo(deviceId) {
    log(LogLevel.DEBUG, `[VolumeInfo] Querying media volume info for device ${deviceId}`);

    const session = Array.from(sessions.values()).find(s => s.deviceId === deviceId);
    if (!session) {
        throw new Error(`No session found for device ${deviceId}`);
    }

    let androidVersion;
    if (session.androidVersion) {
        androidVersion = session.androidVersion;
        log(LogLevel.DEBUG, `[VolumeInfo] Using cached Android version: ${androidVersion}`);
    } else {
        try {
            const device = adb.getDevice(deviceId);
            const versionStream = await device.shell('getprop ro.build.version.release');
            const versionOutput = await streamToString(versionStream);
            const versionMatch = versionOutput.trim().match(/^(\d+)/);
            androidVersion = versionMatch ? parseInt(versionMatch[1], 10) : NaN;
            if (isNaN(androidVersion)) {
                throw new Error(`Invalid Android version: ${versionOutput.trim()}`);
            }
            session.androidVersion = androidVersion;
            log(LogLevel.DEBUG, `[VolumeInfo] Cached Android version: ${androidVersion}`);
        } catch (error) {
            throw new Error(`Failed to get Android version: ${error.message}`);
        }
    }

    let maxVolume, currentVolume;
    if (session.maxVolume) {
        maxVolume = session.maxVolume;
        log(LogLevel.DEBUG, `[VolumeInfo] Using cached max volume: ${maxVolume}`);
    }

    let command;
    if (androidVersion <= 10) {
        command = 'media volume --get';
    } else {
        command = 'cmd media_session volume --get --stream 3';
    }

    try {
        const device = adb.getDevice(deviceId);
        const volumeStream = await device.shell(command);
        const volumeOutput = await streamToString(volumeStream);
        log(LogLevel.DEBUG, `[VolumeInfo] Raw volume output: ${volumeOutput}`);
        const match = volumeOutput.match(/volume is (\d+) in range \[(\d+)\.\.(\d+)\]|\[(\d+), (\d+)\]/);
        if (!match) {
            throw new Error(`Unexpected volume output format: ${volumeOutput}`);
        }
        currentVolume = parseInt(match[1] || match[4], 10);
        if (!session.maxVolume) {
            maxVolume = parseInt(match[3] || match[5], 10);
            session.maxVolume = maxVolume;
            log(LogLevel.DEBUG, `[VolumeInfo] Cached max volume: ${maxVolume}`);
        }
    } catch (error) {
        throw new Error(`Failed to get volume: ${error.message}`);
    }

    if (isNaN(maxVolume) || isNaN(currentVolume) || maxVolume < 1) {
        throw new Error(`Invalid volume info: max=${maxVolume}, current=${currentVolume}`);
    }

    log(LogLevel.DEBUG, `[VolumeInfo] Retrieved: currentVolume=${currentVolume}, maxVolume=${maxVolume}`);
    return { maxVolume, currentVolume };
}

async function setMediaVolume(deviceId, percentage) {
    log(LogLevel.DEBUG, `[SetVolume] Setting media volume to ${percentage}% for device ${deviceId}`);

    let maxVolume;
    const session = Array.from(sessions.values()).find(s => s.deviceId === deviceId);
    if (!session) {
        throw new Error(`No session found for device ${deviceId}`);
    }

    if (session.maxVolume) {
        maxVolume = session.maxVolume;
    } else {
        try {
            const volumeInfo = await getMediaVolumeInfo(deviceId);
            maxVolume = volumeInfo.maxVolume;
        } catch (error) {
            log(LogLevel.ERROR, `[SetVolume] Failed to get max volume: ${error.message}`);
            throw error;
        }
    }

    if (isNaN(maxVolume) || maxVolume < 1) {
        throw new Error(`Invalid max volume info: ${maxVolume}`);
    }

    const targetVolume = Math.round((percentage / 100) * maxVolume);
    log(LogLevel.DEBUG, `[SetVolume] Mapped ${percentage}% to volume level ${targetVolume} (max: ${maxVolume})`);

    const androidVersion = session.androidVersion;
    if (!androidVersion) {
        throw new Error(`Android version not cached for device ${deviceId}`);
    }

    try {
        const command = androidVersion <= 10
            ? `media volume --set ${targetVolume}`
            : `cmd media_session volume --set ${targetVolume} --stream 3`;
        const device = adb.getDevice(deviceId);
        await device.shell(command);
        log(LogLevel.INFO, `[SetVolume] Volume set to ${percentage}% (Target Level: ${targetVolume})`);
    } catch (error) {
        log(LogLevel.ERROR, `[SetVolume] Failed to set volume: ${error.message}`);
        throw error;
    }
}

async function handleGetVolumeCommand(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client || !client.session) {
        log(LogLevel.WARN, `[GetVolume ${clientId}] No active session for client`);
        ws.send(JSON.stringify({
            type: 'volumeInfo',
            success: false,
            error: 'No active session'
        }));
        return;
    }

    const session = sessions.get(client.session);
    if (!session || !session.deviceId) {
        log(LogLevel.WARN, `[GetVolume ${clientId}] No device associated with session ${client.session}`);
        ws.send(JSON.stringify({
            type: 'volumeInfo',
            success: false,
            error: 'No device found'
        }));
        return;
    }

    try {
        const { maxVolume, currentVolume } = await getMediaVolumeInfo(session.deviceId);
        const volumePercentage = Math.round((currentVolume / maxVolume) * 100);
        log(LogLevel.INFO, `[GetVolume ${clientId}] Current volume: ${volumePercentage}% for device ${session.deviceId}`);
        ws.send(JSON.stringify({
            type: 'volumeInfo',
            success: true,
            volume: volumePercentage
        }));
    } catch (error) {
        log(LogLevel.ERROR, `[GetVolume ${clientId}] Failed to get volume: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'volumeInfo',
            success: false,
            error: error.message
        }));
    }
}

async function handleVolumeCommand(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client || !client.session) {
        log(LogLevel.WARN, `[Volume ${clientId}] No active session for client`);
        ws.send(JSON.stringify({ type: 'volumeResponse', success: false, value: message.value, error: 'No active session' }));
        return;
    }

    const session = sessions.get(client.session);
    if (!session || !session.deviceId) {
        log(LogLevel.WARN, `[Volume ${clientId}] No device associated with session ${client.session}`);
        ws.send(JSON.stringify({ type: 'volumeResponse', success: false, value: message.value, error: 'No device found' }));
        return;
    }

    try {
        const value = parseInt(message.value, 10);
        if (isNaN(value) || value < 0 || value > 100) {
            throw new Error(`Invalid volume value: ${message.value}`);
        }

        await setMediaVolume(session.deviceId, value);
        log(LogLevel.INFO, `[Volume ${clientId}] Successfully executed volume set command for ${value}%`);
        ws.send(JSON.stringify({ type: 'volumeResponse', success: true, requestedValue: value }));

    } catch (error) {
        log(LogLevel.ERROR, `[Volume ${clientId}] Failed to set volume: ${error.message}`);
        ws.send(JSON.stringify({ type: 'volumeResponse', success: false, value: message.value, error: error.message }));
    }
}

const navKeycodes = {
    back: 4, // KEYCODE_BACK
    home: 3, // KEYCODE_HOME
    recents: 187 // KEYCODE_APP_SWITCH
};

async function handleNavAction(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client?.session) {
        ws.send(JSON.stringify({ type: 'navResponse', success: false, key: message.key, error: 'No active session' }));
        return;
    }

    const session = sessions.get(client.session);
    if (!session?.deviceId) {
        ws.send(JSON.stringify({ type: 'navResponse', success: false, key: message.key, error: 'No device found' }));
        return;
    }

    const keycode = navKeycodes[message.key];
    if (!keycode) {
        ws.send(JSON.stringify({ type: 'navResponse', success: false, key: message.key, error: 'Invalid navigation key' }));
        return;
    }

    try {
        const device = adb.getDevice(session.deviceId);
        await device.shell(`input keyevent ${keycode}`);
        ws.send(JSON.stringify({ type: 'navResponse', success: true, key: message.key }));
    } catch (error) {
        ws.send(JSON.stringify({ type: 'navResponse', success: false, key: message.key, error: error.message }));
    }
}

async function handleWifiToggleCommand(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client || !client.session) {
        log(LogLevel.WARN, `[WifiToggle ${clientId}] No active session for client`);
        ws.send(JSON.stringify({
            type: 'wifiResponse',
            success: false,
            error: 'No active session, cannot toggle Wi-Fi'
        }));
        return;
    }

    const session = sessions.get(client.session);
    if (!session || !session.deviceId) {
        log(LogLevel.WARN, `[WifiToggle ${clientId}] No device associated with session ${client.session}`);
        ws.send(JSON.stringify({
            type: 'wifiResponse',
            success: false,
            error: 'No device found, cannot toggle Wi-Fi'
        }));
        return;
    }

    const enableWifi = message.enable; // true to enable, false to disable
    if (typeof enableWifi !== 'boolean') {
        log(LogLevel.WARN, `[WifiToggle ${clientId}] Invalid enable value: ${enableWifi}`);
        ws.send(JSON.stringify({
            type: 'wifiResponse',
            success: false,
            error: 'Invalid Wi-Fi toggle value'
        }));
        return;
    }

    try {
        const device = adb.getDevice(session.deviceId);
        const command = enableWifi ? 'svc wifi enable' : 'svc wifi disable';
        log(LogLevel.INFO, `[WifiToggle ${clientId}] Executing ADB command: ${command} on device ${session.deviceId}`);
        await device.shell(command);

        // Wait 4 seconds to allow the Wi-Fi state to stabilize
        await new Promise(resolve => setTimeout(resolve, 6000));

        // Verify the Wi-Fi state
        const statusStream = await device.shell('dumpsys wifi | grep "Wi-Fi is"');
        const statusOutput = await streamToString(statusStream);
        const isWifiOn = statusOutput.includes('Wi-Fi is enabled');
        log(LogLevel.INFO, `[WifiToggle ${clientId}] Wi-Fi state after toggle: ${isWifiOn ? 'enabled' : 'disabled'}`);

        // Get the SSID
        let ssid = null;
        if (isWifiOn) {
            const ssidStream = await device.shell('dumpsys netstats | grep -E \'iface=wlan.*networkId\'');
            const ssidOutput = await streamToString(ssidStream);
            const match = ssidOutput.match(/networkId="([^"]+)"/);
            ssid = match ? match[1] : null;
            log(LogLevel.INFO, `[WifiToggle ${clientId}] SSID: ${ssid || 'Not connected'}`);
        }

        ws.send(JSON.stringify({
            type: 'wifiResponse',
            success: true,
            enable: enableWifi,
            currentState: isWifiOn,
            ssid: ssid
        }));
    } catch (error) {
        log(LogLevel.ERROR, `[WifiToggle ${clientId}] Failed to toggle Wi-Fi: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'wifiResponse',
            success: false,
            error: `Failed to toggle Wi-Fi: ${error.message}`
        }));
    }
}

async function handleGetWifiStatusCommand(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client || !client.session) {
        log(LogLevel.WARN, `[GetWifiStatus ${clientId}] No active session for client`);
        ws.send(JSON.stringify({
            type: 'wifiStatus',
            success: false,
            error: 'No active session, cannot get Wi-Fi status'
        }));
        return;
    }

    const session = sessions.get(client.session);
    if (!session || !session.deviceId) {
        log(LogLevel.WARN, `[GetWifiStatus ${clientId}] No device associated with session ${client.session}`);
        ws.send(JSON.stringify({
            type: 'wifiStatus',
            success: false,
            error: 'No device found, cannot get Wi-Fi status'
        }));
        return;
    }

    try {
        const device = adb.getDevice(session.deviceId);
        const statusStream = await device.shell('dumpsys wifi | grep "Wi-Fi is"');
        const statusOutput = await streamToString(statusStream);
        const isWifiOn = statusOutput.includes('Wi-Fi is enabled');
        log(LogLevel.INFO, `[GetWifiStatus ${clientId}] Wi-Fi state: ${isWifiOn ? 'enabled' : 'disabled'}`);

        // Get the SSID
        let ssid = null;
        if (isWifiOn) {
            const ssidStream = await device.shell('dumpsys netstats | grep -E \'iface=wlan.*networkId\'');
            const ssidOutput = await streamToString(ssidStream);
            const match = ssidOutput.match(/networkId="([^"]+)"/);
            ssid = match ? match[1] : null;
            log(LogLevel.INFO, `[GetWifiStatus ${clientId}] SSID: ${ssid || 'Not connected'}`);
        }

        ws.send(JSON.stringify({
            type: 'wifiStatus',
            success: true,
            isWifiOn,
            ssid
        }));
    } catch (error) {
        log(LogLevel.ERROR, `[GetWifiStatus ${clientId}] Failed to get Wi-Fi status: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'wifiStatus',
            success: false,
            error: `Failed to get Wi-Fi status: ${error.message}`
        }));
    }
}

function streamToString(stream) {
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', (data) => output += data.toString());
        stream.on('end', () => resolve(output));
        stream.on('error', (err) => reject(err));
    });
}

async function handleStart(clientId, ws, message) {
    log(LogLevel.INFO, `[HandleStart ${clientId}] Processing start request:`, message);
    const client = wsClients.get(clientId);
    if (!client || client.session) {
        log(client ? LogLevel.WARN : LogLevel.ERROR, `[HandleStart ${clientId}] ${client ? 'Session already active' : 'Client object not found!'}`);
        ws.send(JSON.stringify({
            type: MESSAGE_TYPES.ERROR,
            message: client ? 'Session already active' : 'Internal error: Client not found.'
        }));
        return;
    }

    let deviceId = null;
    let scid = null;
    try {
        const devices = await adb.listDevices();
        if (!devices.length) throw new Error('No devices found via ADB');
        deviceId = devices[0].id;
        log(LogLevel.INFO, `[HandleStart ${clientId}] Using device: ${deviceId}`);

        const runOptions = {
            ...BASE_SCRCPY_OPTIONS
        };
        const maxSize = parseInt(message.maxSize);
        if (!isNaN(maxSize) && maxSize > 0) runOptions.max_size = String(maxSize);
        const maxFps = parseInt(message.maxFps);
        if (!isNaN(maxFps) && maxFps > 0) runOptions.max_fps = String(maxFps);
        const bitrate = parseInt(message.bitrate);
        if (!isNaN(bitrate) && bitrate > 0) runOptions.video_bit_rate = String(bitrate);
        const audioEnabled = message.enableAudio || false;
        runOptions.audio = String(audioEnabled);
        const videoEnabled = !(message.video === false || message.video === 'false');
        runOptions.video = String(videoEnabled);
        const controlEnabled = message.enableControl || false;
        runOptions.control = String(controlEnabled);

        scid = (crypto.randomBytes(4).readUInt32BE(0) & 0x7FFFFFFF).toString(16).padStart(8, '0');
        const port = SERVER_PORT_BASE + (sessions.size % 1000);
        log(LogLevel.INFO, `[HandleStart ${clientId}] Generated SCID: ${scid}, Port: ${port}`);
        log(LogLevel.DEBUG, `[HandleStart ${clientId}] Final scrcpy options to be used:`, runOptions);

        await setupScrcpySession(deviceId, scid, port, runOptions, clientId);
        client.session = scid;
        log(LogLevel.INFO, `[HandleStart ${clientId}] Session ${scid} setup initiated. Waiting for connections...`);

    } catch (err) {
        log(LogLevel.ERROR, `[HandleStart ${clientId}] Critical error during setup: ${err.message}`);
        ws.send(JSON.stringify({
            type: MESSAGE_TYPES.ERROR,
            message: `Setup failed: ${err.message}`
        }));
        const clientData = wsClients.get(clientId);
        if (clientData?.session) {
            await cleanupSession(clientData.session);
            clientData.session = null;
        } else if (scid && sessions.has(scid)) {
            await cleanupSession(scid);
        }
    }
}

async function checkReverseTunnelExists(deviceId, tunnelString) {
    log(LogLevel.DEBUG, `[CheckTunnel] Checking reverse tunnel: ${tunnelString} for device ${deviceId}`);
    try {
        const device = adb.getDevice(deviceId);
        const reverseListStream = await device.shell('reverse --list');
        const reverseListOutput = await streamToString(reverseListStream);
        const exists = reverseListOutput.includes(tunnelString);
        log(LogLevel.DEBUG, `[CheckTunnel] Reverse tunnel ${tunnelString} ${exists ? 'exists' : 'does not exist'}`);
        return exists;
    } catch (error) {
        log(LogLevel.DEBUG, `[CheckTunnel] Error checking reverse tunnel list: ${error.message}. Assuming tunnel does not exist.`);
        return false;
    }
}

async function setupScrcpySession(deviceId, scid, port, runOptions, clientId) {
    log(LogLevel.INFO, `[Session ${scid}] Starting setup process...`);
    const session = {
        deviceId,
        scid,
        port,
        clientId,
        options: runOptions,
        tcpServer: null,
        processStream: null,
        tunnelActive: false,
        videoSocket: null,
        audioSocket: null,
        controlSocket: null,
        deviceNameReceived: false,
        expectedSockets: [],
        socketsConnected: 0,
        streamingStartedNotified: false,
        unidentifiedSockets: new Map(),
        audioMetadata: null,
        maxVolume: null,
        androidVersion: null
    };
    if (runOptions.video === 'true') session.expectedSockets.push('video');
    if (runOptions.audio === 'true') session.expectedSockets.push('audio');
    if (runOptions.control === 'true') session.expectedSockets.push('control');

    if (session.expectedSockets.length === 0) {
        throw new Error("No streams (video, audio, control) enabled.");
    }

    log(LogLevel.INFO, `[Session ${scid}] Expecting sockets: ${session.expectedSockets.join(', ')}`);
    sessions.set(scid, session);

    try {
        const device = adb.getDevice(deviceId);
        await device.push(SERVER_JAR_PATH, SERVER_DEVICE_PATH);
        log(LogLevel.INFO, `[Session ${scid}] Pushed scrcpy-server.jar to device ${deviceId}`);

        const tunnelString = `localabstract:scrcpy_${scid}`;
        const reverseListStream = await device.shell('reverse --list');
        const reverseListOutput = await streamToString(reverseListStream);
        if (reverseListOutput.includes(tunnelString)) {
            await device.shell(`reverse --remove ${tunnelString}`);
            log(LogLevel.DEBUG, `[Session ${scid}] Removed existing reverse tunnel ${tunnelString}`);
        }
        await device.shell('reverse --remove-all');
        log(LogLevel.DEBUG, `[Session ${scid}] Removed all existing reverse tunnels`);
        await device.reverse(tunnelString, `tcp:${port}`);
        session.tunnelActive = true;
        log(LogLevel.INFO, `[Session ${scid}] Reverse tunnel active for ${tunnelString} on port ${port}`);

        session.tcpServer = createTcpServer(scid);
        await new Promise((resolve, reject) => {
            session.tcpServer.listen(port, '127.0.0.1', () => {
                log(LogLevel.INFO, `[Session ${scid}] TCP server listening.`);
                resolve();
            });
            session.tcpServer.once('error', (err) => {
                log(LogLevel.ERROR, `[Session ${scid}] TCP server listen error: ${err.message}`);
                reject(err);
            });
        });

        const args = [SCRCPY_VERSION, `scid=${scid}`, `log_level=${runOptions.log_level}`];
        if (runOptions.video === 'true') args.push(`video_codec=${runOptions.video_codec}`);
        if (runOptions.audio === 'true') args.push(`audio_codec=${runOptions.audio_codec}`);
        if (runOptions.max_size) args.push(`max_size=${runOptions.max_size}`);
        if (runOptions.max_fps) args.push(`max_fps=${runOptions.max_fps}`);
        if (runOptions.video_bit_rate) args.push(`video_bit_rate=${runOptions.video_bit_rate}`);
        if (runOptions.video === 'false') args.push(`video=false`);
        if (runOptions.audio === 'false') args.push(`audio=false`);
        if (runOptions.control === 'false') args.push(`control=false`);

        const command = `CLASSPATH=${SERVER_DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${args.join(' ')}`;
        log(LogLevel.INFO, `[Session ${scid}] Executing scrcpy-server on device...`);
        log(LogLevel.DEBUG, `[Session ${scid}] Command: ${command}`);
        session.processStream = exec(`adb -s ${deviceId} shell "${command}"`);

        session.processStream.stdout.on('data', (data) => log(LogLevel.INFO, `[scrcpy-server ${scid} stdout] ${data.toString().trim()}`));
        session.processStream.stderr.on('data', (data) => log(LogLevel.WARN, `[scrcpy-server ${scid} stderr] ${data.toString().trim()}`));
        session.processStream.on('error', (err) => {
            log(LogLevel.ERROR, `[Session ${scid}] scrcpy-server process error: ${err.message}`);
            cleanupSession(scid);
        });
        session.processStream.on('exit', (code, signal) => {
            if (sessions.has(scid)) {
                log(LogLevel.WARN, `[Session ${scid}] scrcpy-server exited unexpectedly (code: ${code}, signal: ${signal}). Cleaning up.`);
                cleanupSession(scid);
            } else {
                log(LogLevel.DEBUG, `[Session ${scid}] scrcpy-server exited after cleanup (code: ${code}, signal: ${signal}).`);
            }
        });
        log(LogLevel.INFO, `[Session ${scid}] scrcpy-server process initiated.`);
    } catch (error) {
        log(LogLevel.ERROR, `[Session ${scid}] Error during ADB/TCP setup: ${error.message}`);
        await cleanupSession(scid);
        throw error;
    }
}
async function handleDisconnect(clientId) {
    const client = wsClients.get(clientId);
    if (!client) return;
    const scidToClean = client.session;
    client.session = null;
    if (client.ws?.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
            type: MESSAGE_TYPES.STATUS,
            message: 'Streaming stopped'
        }));
        client.ws.close(1000, 'User disconnected via command');
    }
    wsClients.delete(clientId);
    if (scidToClean) {
        log(LogLevel.INFO, `[Session ${scidToClean}] Initiating cleanup due to disconnect from client ${clientId}`);
        await cleanupSession(scidToClean);
    }
}

async function cleanupSession(scid) {
    const session = sessions.get(scid);
    if (!session) return;
    log(LogLevel.INFO, `[Cleanup ${scid}] Starting cleanup...`);
    sessions.delete(scid);

    const {
        deviceId,
        tcpServer,
        processStream,
        videoSocket,
        audioSocket,
        controlSocket,
        clientId,
        unidentifiedSockets
    } = session;

    unidentifiedSockets?.forEach(sock => sock.destroy());
    videoSocket?.destroy();
    audioSocket?.destroy();
    controlSocket?.destroy();

    if (processStream && !processStream.killed) {
        processStream.kill('SIGKILL');
        log(LogLevel.INFO, `[Cleanup ${scid}] Killed scrcpy-server process.`);
    }
    if (tcpServer) {
        await new Promise(resolve => tcpServer.close(resolve));
        log(LogLevel.INFO, `[Cleanup ${scid}] TCP server closed.`);
    }

    const worker = workers.get(scid);
    if (worker) {
        worker.postMessage({
            type: 'stop'
        });
        workers.delete(scid);
        log(LogLevel.INFO, `[Cleanup ${scid}] Worker terminated.`);
    }

    const client = wsClients.get(clientId);
    if (client) {
        if (client.session === scid) client.session = null;
        if (client.ws?.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({
                type: MESSAGE_TYPES.STATUS,
                message: 'Streaming stopped by server cleanup'
            }));
        }
    }
    log(LogLevel.INFO, `[Cleanup ${scid}] Cleanup finished.`);
}

function createTcpServer(scid) {
    const server = net.createServer((socket) => {
        const remoteId = `${socket.remoteAddress}:${socket.remotePort}`;
        const session = sessions.get(scid);
        if (!session) {
            log(LogLevel.WARN, `[TCP Server ${scid}] Connection from ${remoteId} but session gone.`);
            socket.destroy();
            return;
        }

        if (session.socketsConnected >= session.expectedSockets.length) {
            log(LogLevel.ERROR, `[TCP Server ${scid}] Unexpected extra connection from ${remoteId}. Max ${session.expectedSockets.length} expected. Closing.`);
            socket.destroy();
            return;
        }

        session.socketsConnected++;
        log(LogLevel.INFO, `[TCP Server ${scid}] Connection ${session.socketsConnected}/${session.expectedSockets.length} received from ${remoteId}`);

        socket.scid = scid;
        socket.remoteId = remoteId;
        socket.dynamicBuffer = {
            buffer: Buffer.alloc(1024 * 512),
            length: 0
        };
        socket.state = 'AWAITING_INITIAL_DATA';
        socket.type = 'unknown';
        socket.didHandleDeviceName = false;

        session.unidentifiedSockets.set(remoteId, socket);

        socket.on('data', (data) => {
            const currentSession = sessions.get(scid);
            if (!currentSession) {
                socket.destroy();
                return;
            }
            log(LogLevel.DEBUG, `[TCP Socket ${remoteId} (${socket.type})] Received ${data.length} bytes.`);
            processData(socket, data);
        });

        socket.on('end', () => {
            log(LogLevel.INFO, `[TCP Socket ${remoteId} (${socket.type})] Ended.`);
            clearSocketReference(scid, socket);
            sessions.get(scid)?.unidentifiedSockets?.delete(remoteId);
        });
        socket.on('close', (hadError) => {
            log(LogLevel.INFO, `[TCP Socket ${remoteId} (${socket.type})] Closed (Error: ${hadError}).`);
            clearSocketReference(scid, socket);
            sessions.get(scid)?.unidentifiedSockets?.delete(remoteId);
        });
        socket.on('error', (err) => {
            log(LogLevel.ERROR, `[TCP Socket ${remoteId} (${socket.type})] Error: ${err.message}`);
            clearSocketReference(scid, socket);
            sessions.get(scid)?.unidentifiedSockets?.delete(remoteId);
            socket.destroy();
        });

        const client = session ? wsClients.get(session.clientId) : null;
        if (client && client.ws?.readyState === WebSocket.OPEN) {
            processSingleSocket(socket, client, session);
        } else {
            log(LogLevel.WARN, `[TCP Server ${scid}] Client for new connection ${remoteId} not ready or gone. Closing socket.`);
            socket.destroy();
        }
    });
    server.on('error', (err) => {
        log(LogLevel.ERROR, `[TCP Server ${scid}] Server error: ${err.message}`);
        cleanupSession(scid);
    });
    return server;
}

function clearSocketReference(scid, socket) {
    const session = sessions.get(scid);
    if (!session) return;
    let clearedType = 'unknown';
    if (session.videoSocket === socket) {
        session.videoSocket = null;
        clearedType = 'video';
    } else if (session.audioSocket === socket) {
        session.audioSocket = null;
        clearedType = 'audio';
    } else if (session.controlSocket === socket) {
        session.controlSocket = null;
        clearedType = 'control';
    }

    log(LogLevel.DEBUG, `[Session ${scid}] Cleared reference for socket ${socket.remoteId} (${clearedType})`);
    if (!session.videoSocket && !session.audioSocket && !session.controlSocket && session.processStream) {
        log(LogLevel.INFO, `[Session ${scid}] All stream sockets closed/cleared. Triggering cleanup.`);
        cleanupSession(scid);
    }
}

function processData(socket, data) {
    const session = sessions.get(socket.scid);
    const client = session ? wsClients.get(session.clientId) : null;
    if (!session || !client || client.ws?.readyState !== WebSocket.OPEN) {
        if (!socket.destroyed) socket.destroy();
        return;
    }

    const dynBuffer = socket.dynamicBuffer;
    const requiredLength = dynBuffer.length + data.length;
    if (requiredLength > dynBuffer.buffer.length) {
        const newSize = Math.max(dynBuffer.buffer.length * 2, requiredLength + 1024);
        log(LogLevel.DEBUG, `[Buffer ${socket.remoteId}] Resizing buffer from ${dynBuffer.buffer.length} to ${newSize}`);
        try {
            const newBuffer = Buffer.allocUnsafe(newSize);
            dynBuffer.buffer.copy(newBuffer, 0, 0, dynBuffer.length);
            dynBuffer.buffer = newBuffer;
        } catch (e) {
            log(LogLevel.ERROR, `[Buffer ${socket.remoteId}] Failed to allocate ${newSize} bytes: ${e.message}. Closing.`);
            socket.destroy();
            cleanupSession(socket.scid);
            return;
        }
    }
    data.copy(dynBuffer.buffer, dynBuffer.length);
    dynBuffer.length += data.length;

    processSingleSocket(socket, client, session);

    if (dynBuffer.length === 0 && dynBuffer.buffer.length > 1024 * 512) {
        try {
            dynBuffer.buffer = Buffer.alloc(1024 * 512);
        } catch (e) {}
    }
}

async function checkAndSendStreamingStarted(session, client) {
    if (!session || !client || client.ws?.readyState !== WebSocket.OPEN || session.streamingStartedNotified) {
        return;
    }

    const videoReady = !session.expectedSockets.includes('video') || session.videoSocket;
    const audioReady = !session.expectedSockets.includes('audio') || session.audioSocket;
    const controlReady = !session.expectedSockets.includes('control') || session.controlSocket;

    if (videoReady && audioReady && controlReady) {
        log(LogLevel.INFO, `[Session ${session.scid}] All expected sockets identified. Sending 'Streaming started' status.`);
        client.ws.send(JSON.stringify({
            type: MESSAGE_TYPES.STATUS,
            message: 'Streaming started'
        }));
        session.streamingStartedNotified = true;

        if (session.tunnelActive && session.deviceId) {
            const tunnelString = `localabstract:scrcpy_${session.scid}`;
            try {
                const device = adb.getDevice(session.deviceId);
                const reverseListStream = await device.shell('reverse --list');
                const reverseListOutput = await streamToString(reverseListStream);
                if (reverseListOutput.includes(tunnelString)) {
                    await device.shell(`reverse --remove ${tunnelString}`);
                    log(LogLevel.INFO, `[Session ${session.scid}] Removed reverse tunnel ${tunnelString}`);
                } else {
                    log(LogLevel.DEBUG, `[Session ${session.scid}] Reverse tunnel ${tunnelString} already removed or not found.`);
                }
                session.tunnelActive = false;
                log(LogLevel.INFO, `[Session ${session.scid}] Reverse tunnel removed after all sockets opened.`);
            } catch (error) {
                log(LogLevel.WARN, `[Session ${session.scid}] Failed to remove reverse tunnel: ${error.message}`);
            }
        }
    } else {
        log(LogLevel.DEBUG, `[Session ${session.scid}] Waiting for all sockets. Video: ${!!session.videoSocket}, Audio: ${!!session.audioSocket}, Control: ${!!session.controlSocket}`);
    }
}

function attemptIdentifyControlByDeduction(session, client) {
    if (!session) return;
    const isControlExpected = session.options.control === 'true';
    if (session.controlSocket || !isControlExpected || session.socketsConnected < session.expectedSockets.length) {
        return;
    }

    const unidentifiedCount = session.unidentifiedSockets?.size || 0;
    const videoIdentified = !session.expectedSockets.includes('video') || session.videoSocket;
    const audioIdentified = !session.expectedSockets.includes('audio') || session.audioSocket;

    if (videoIdentified && audioIdentified && unidentifiedCount === 1) {
        const [remainingSocketId, remainingSocket] = session.unidentifiedSockets.entries().next().value;
        log(LogLevel.INFO, `[Session ${session.scid}] Identified CONTROL socket ${remainingSocket.remoteId} by deduction.`);
        session.controlSocket = remainingSocket;
        remainingSocket.type = 'control';
        remainingSocket.state = 'STREAMING';
        session.unidentifiedSockets.delete(remainingSocketId);

        const worker = new Worker(path.join(__dirname, 'serverControlWorker.js'), {
            workerData: {
                scid: session.scid,
                clientId: session.clientId,
                CURRENT_LOG_LEVEL
            }
        });
        workers.set(session.scid, worker);

        worker.on('message', (msg) => {
            if (msg.type === 'writeToSocket') {
                const session = sessions.get(msg.scid);
                const client = session ? wsClients.get(session.clientId) : null;

                if (session?.controlSocket && !session.controlSocket.destroyed && client?.ws?.readyState === WebSocket.OPEN) {
                    try {
                        session.controlSocket.write(Buffer.from(msg.data, 'base64'));
                        log(LogLevel.DEBUG, `[Worker ${msg.scid}] Wrote ${msg.data.length} base64 chars worth of data to control socket`);
                    } catch (e) {
                        log(LogLevel.ERROR, `[Worker ${msg.scid}] Control socket write error: ${e.message}`);

                        if (client?.ws?.readyState === WebSocket.OPEN) {
                            client.ws.send(JSON.stringify({
                                type: MESSAGE_TYPES.ERROR,
                                scid: msg.scid,
                                message: `Control error: ${e.message}`
                            }));
                        }
                    }
                } else {
                    log(LogLevel.WARN, `[Worker ${msg.scid}] Cannot write to control socket. Session or socket gone, or client disconnected.`);
                }
            } else if (msg.type === 'error') {
                log(LogLevel.ERROR, `[Worker ${msg.scid}] Control processing error: ${msg.error}`);
                client.ws.send(JSON.stringify({
                    type: MESSAGE_TYPES.ERROR,
                    message: `Control error: ${msg.error}`
                }));
            }
        });

        worker.on('error', (err) => {
            log(LogLevel.ERROR, `[Worker ${session.scid}] Worker error: ${err.message}`);
            workers.delete(session.scid);
        });

        worker.on('exit', (code) => {
            log(LogLevel.INFO, `[Worker ${session.scid}] Worker exited with code ${code}`);
            workers.delete(session.scid);
        });

        checkAndSendStreamingStarted(session, client);

        if (remainingSocket.dynamicBuffer.length > 0) {
            processSingleSocket(remainingSocket, client, session);
        }
    }
}

function processSingleSocket(socket, client, session) {
    const dynBuffer = socket.dynamicBuffer;
    let processedSomething = false;
    let keepProcessing = true;

    if (!socket.codecProcessed) {
        socket.codecProcessed = false;
    }

    while (keepProcessing && !socket.destroyed && socket.state !== 'UNKNOWN') {
        keepProcessing = false;
        log(LogLevel.DEBUG, `[ProcessSingleSocket ${socket.remoteId}] State: ${socket.state}, Buffer: ${dynBuffer.length} bytes, Type: ${socket.type}`);

        switch (socket.state) {
            case 'AWAITING_INITIAL_DATA':
                if (!session.deviceNameReceived) {
                    if (dynBuffer.length >= DEVICE_NAME_LENGTH) {
                        const deviceNameBuffer = dynBuffer.buffer.subarray(0, DEVICE_NAME_LENGTH);
                        const deviceName = deviceNameBuffer.toString('utf8').split('\0')[0];
                        log(LogLevel.INFO, `[Session ${session.scid}] Received Device Name: "${deviceName}" (on socket ${socket.remoteId})`);
                        client.ws.send(JSON.stringify({
                            type: MESSAGE_TYPES.DEVICE_NAME,
                            name: deviceName
                        }));
                        dynBuffer.buffer.copy(dynBuffer.buffer, 0, DEVICE_NAME_LENGTH, dynBuffer.length);
                        dynBuffer.length -= DEVICE_NAME_LENGTH;
                        session.deviceNameReceived = true;
                        socket.didHandleDeviceName = true;
                        processedSomething = true;
                        socket.state = 'AWAITING_METADATA';
                        keepProcessing = true;
                        attemptIdentifyControlByDeduction(session, client);
                    } else {
                        log(LogLevel.DEBUG, `[ProcessSingleSocket ${socket.remoteId}] Waiting for device name (need ${DEVICE_NAME_LENGTH}, have ${dynBuffer.length})`);
                    }
                } else {
                    log(LogLevel.DEBUG, `[ProcessSingleSocket ${socket.remoteId}] Device name already received by another socket, moving to AWAITING_METADATA.`);
                    socket.state = 'AWAITING_METADATA';
                    keepProcessing = true;
                }
                break;

            case 'AWAITING_METADATA':
                let identifiedThisPass = false;

                if (!session.videoSocket && session.expectedSockets.includes('video')) {
                    if (dynBuffer.length >= VIDEO_METADATA_LENGTH) {
                        const potentialCodecId = dynBuffer.buffer.readUInt32BE(0);
                        if (CODEC_SOCKET_TYPES[potentialCodecId] === 'video') {
                            const width = dynBuffer.buffer.readUInt32BE(4);
                            const height = dynBuffer.buffer.readUInt32BE(8);
                            log(LogLevel.INFO, `[Session ${session.scid}] Identified VIDEO socket ${socket.remoteId} (Codec: 0x${potentialCodecId.toString(16)}, ${width}x${height})`);
                            session.videoSocket = socket;
                            socket.type = 'video';
                            identifiedThisPass = true;
                            session.unidentifiedSockets?.delete(socket.remoteId);
                            client.ws.send(JSON.stringify({
                                type: MESSAGE_TYPES.VIDEO_INFO,
                                codecId: potentialCodecId,
                                width,
                                height
                            }));
                            dynBuffer.buffer.copy(dynBuffer.buffer, 0, VIDEO_METADATA_LENGTH, dynBuffer.length);
                            dynBuffer.length -= VIDEO_METADATA_LENGTH;
                            socket.state = 'STREAMING';
                            checkAndSendStreamingStarted(session, client);
                            processedSomething = true;
                            keepProcessing = true;
                        } else {
                            log(LogLevel.WARN, `[ProcessSingleSocket ${socket.remoteId}] Expected VIDEO socket, but received non-video metadata (0x${potentialCodecId.toString(16)}). Buffer length: ${dynBuffer.length}`);
                        }
                    }
                }

                if (!identifiedThisPass && !session.audioSocket && session.expectedSockets.includes('audio')) {
                    if (dynBuffer.length >= AUDIO_METADATA_LENGTH) {
                        const potentialCodecId = dynBuffer.buffer.readUInt32BE(0);
                        if (CODEC_SOCKET_TYPES[potentialCodecId] === 'audio') {
                            log(LogLevel.INFO, `[Session ${session.scid}] Identified AUDIO socket ${socket.remoteId} (Codec: 0x${potentialCodecId.toString(16)})`);
                            session.audioSocket = socket;
                            socket.type = 'audio';
                            socket.codecProcessed = true;
                            identifiedThisPass = true;
                            session.unidentifiedSockets?.delete(socket.remoteId);
                            client.ws.send(JSON.stringify({
                                type: MESSAGE_TYPES.AUDIO_INFO,
                                codecId: potentialCodecId
                            }));
                            dynBuffer.buffer.copy(dynBuffer.buffer, 0, AUDIO_METADATA_LENGTH, dynBuffer.length);
                            dynBuffer.length -= AUDIO_METADATA_LENGTH;
                            socket.state = 'STREAMING';
                            checkAndSendStreamingStarted(session, client);
                            processedSomething = true;
                            keepProcessing = true;
                        } else {
                            log(LogLevel.WARN, `[ProcessSingleSocket ${socket.remoteId}] Expected AUDIO socket, but received non-audio metadata (0x${potentialCodecId.toString(16)}). Buffer length: ${dynBuffer.length}`);
                        }
                    }
                }

                if (!identifiedThisPass && !session.controlSocket && session.expectedSockets.length === 1 && session.expectedSockets[0] === 'control' && socket.didHandleDeviceName) {
                    log(LogLevel.INFO, `[Session ${session.scid}] Identified CONTROL socket ${socket.remoteId} (only socket, device name received)`);
                    session.controlSocket = socket;
                    socket.type = 'control';
                    identifiedThisPass = true;
                    session.unidentifiedSockets?.delete(socket.remoteId);
                    socket.state = 'STREAMING';

                    const worker = new Worker(path.join(__dirname, 'controlWorker.js'), {
                        workerData: {
                            scid: session.scid,
                            clientId: session.clientId
                        }
                    });
                    workers.set(session.scid, worker);

                    worker.on('message', (msg) => {
                        if (msg.type === 'writeToSocket') {
                            const session = sessions.get(msg.scid);
                            if (session?.controlSocket && !session.controlSocket.destroyed) {
                                try {
                                    session.controlSocket.write(Buffer.from(msg.data, 'base64'));
                                    log(LogLevel.DEBUG, `[Worker ${msg.scid}] Wrote ${msg.data.length} bytes to control socket`);
                                } catch (e) {
                                    log(LogLevel.ERROR, `[Worker ${msg.scid}] Control socket write error: ${e.message}`);
                                    client.ws.send(JSON.stringify({
                                        type: MESSAGE_TYPES.ERROR,
                                        message: `Control error: ${e.message}`
                                    }));
                                }
                            }
                        } else if (msg.type === 'error') {
                            log(LogLevel.ERROR, `[Worker ${msg.scid}] Control processing error: ${msg.error}`);
                            client.ws.send(JSON.stringify({
                                type: MESSAGE_TYPES.ERROR,
                                message: `Control error: ${msg.error}`
                            }));
                        }
                    });

                    worker.on('error', (err) => {
                        log(LogLevel.ERROR, `[Worker ${session.scid}] Worker error: ${err.message}`);
                        workers.delete(session.scid);
                    });

                    worker.on('exit', (code) => {
                        log(LogLevel.INFO, `[Worker ${session.scid}] Worker exited with code ${code}`);
                        workers.delete(session.scid);
                    });

                    checkAndSendStreamingStarted(session, client);
                    processedSomething = true;
                    keepProcessing = true;
                }

                if (identifiedThisPass) {
                    attemptIdentifyControlByDeduction(session, client);
                } else {
                    attemptIdentifyControlByDeduction(session, client);
                    if (!session.controlSocket && session.expectedSockets.includes('control')) {
                        log(LogLevel.DEBUG, `[ProcessSingleSocket ${socket.remoteId}] Identification still pending in AWAITING_METADATA.`);
                        keepProcessing = false;
                    } else {
                        keepProcessing = dynBuffer.length > 0;
                    }
                }
                break;

            case 'STREAMING':
                if (!socket.type || socket.type === 'unknown') {
                    log(LogLevel.WARN, `[Streaming ${socket.remoteId}] Socket in STREAMING state but type unknown? Resetting.`);
                    socket.state = 'AWAITING_METADATA';
                    keepProcessing = true;
                    break;
                }

                if (socket.type === 'video') {
                    if (dynBuffer.length >= PACKET_HEADER_LENGTH) {
                        const packetSize = dynBuffer.buffer.readUInt32BE(8);
                        if (packetSize > 10 * 1024 * 1024 || packetSize < 0) {
                            log(LogLevel.ERROR, `[${socket.remoteId} ${session.scid} - ${socket.type}] Invalid packet size: ${packetSize}. Closing.`);
                            socket.state = 'UNKNOWN';
                            socket.destroy();
                            return;
                        }
                        const totalPacketLength = PACKET_HEADER_LENGTH + packetSize;
                        if (dynBuffer.length >= totalPacketLength) {
                            const payload = dynBuffer.buffer.subarray(PACKET_HEADER_LENGTH, totalPacketLength);
                            const typeBuffer = Buffer.alloc(1);
                            typeBuffer.writeUInt8(BINARY_TYPES.VIDEO, 0);
                            log(LogLevel.DEBUG, `[Streaming ${socket.remoteId}] Sending video packet (${payload.length} bytes)`);
                            client.ws.send(Buffer.concat([typeBuffer, payload]), {
                                binary: true
                            });
                            dynBuffer.buffer.copy(dynBuffer.buffer, 0, totalPacketLength, dynBuffer.length);
                            dynBuffer.length -= totalPacketLength;
                            processedSomething = true;
                            keepProcessing = true;
                        } else {
                            log(LogLevel.DEBUG, `[Streaming ${socket.remoteId}] Need ${totalPacketLength} bytes for packet, have ${dynBuffer.length}. Waiting.`);
                            keepProcessing = false;
                        }
                    } else {
                        log(LogLevel.DEBUG, `[Streaming ${socket.remoteId}] Need ${PACKET_HEADER_LENGTH} bytes for header, have ${dynBuffer.length}. Waiting.`);
                        keepProcessing = false;
                    }
                } else if (socket.type === 'audio') {
                    if (dynBuffer.length >= PACKET_HEADER_LENGTH) {
                        const configFlag = (dynBuffer.buffer.readUInt8(0) >> 7) & 0x1;
                        const pts = dynBuffer.buffer.readBigInt64BE(0) & BigInt('0x3FFFFFFFFFFFFFFF');
                        const packetSize = dynBuffer.buffer.readUInt32BE(8);
                        if (packetSize > 10 * 1024 * 1024 || packetSize < 0) {
                            log(LogLevel.ERROR, `[${socket.remoteId} ${session.scid} - ${socket.type}] Invalid packet size: ${packetSize}. Closing.`);
                            socket.state = 'UNKNOWN';
                            socket.destroy();
                            return;
                        }
                        const totalPacketLength = PACKET_HEADER_LENGTH + packetSize;
                        if (dynBuffer.length >= totalPacketLength) {
                            const payload = dynBuffer.buffer.subarray(PACKET_HEADER_LENGTH, totalPacketLength);

                            if (configFlag && !session.audioMetadata) {
                                try {
                                    session.audioMetadata = parseAudioSpecificConfig(payload);
                                    log(LogLevel.INFO, `[Session ${session.scid}] AAC Metadata: ${JSON.stringify(session.audioMetadata)}`);
                                    client.ws.send(JSON.stringify({
                                        type: MESSAGE_TYPES.AUDIO_INFO,
                                        codecId: CODEC_IDS.AAC,
                                        metadata: session.audioMetadata
                                    }));
                                } catch (e) {
                                    log(LogLevel.ERROR, `[Session ${session.scid}] Failed to parse ASC: ${e.message}`);
                                    socket.destroy();
                                    return;
                                }
                            }

                            if (!configFlag && session.audioMetadata) {
                                const adtsHeader = createAdtsHeader(payload.length, session.audioMetadata);
                                const adtsFrame = Buffer.concat([adtsHeader, payload]);
                                const typeBuffer = Buffer.alloc(1);
                                typeBuffer.writeUInt8(BINARY_TYPES.AUDIO, 0);
                                log(LogLevel.DEBUG, `[Streaming ${socket.remoteId}] Sending audio packet (${adtsFrame.length} bytes, PTS: ${pts})`);
                                client.ws.send(Buffer.concat([typeBuffer, adtsFrame]), {
                                    binary: true
                                });
                            }

                            dynBuffer.buffer.copy(dynBuffer.buffer, 0, totalPacketLength, dynBuffer.length);
                            dynBuffer.length -= totalPacketLength;
                            processedSomething = true;
                            keepProcessing = true;
                        } else {
                            log(LogLevel.DEBUG, `[Streaming ${socket.remoteId}] Need ${totalPacketLength} bytes for packet, have ${dynBuffer.length}. Waiting.`);
                            keepProcessing = false;
                        }
                    } else {
                        log(LogLevel.DEBUG, `[Streaming ${socket.remoteId}] Need ${PACKET_HEADER_LENGTH} bytes for header, have ${dynBuffer.length}. Waiting.`);
                        keepProcessing = false;
                    }
                } else if (socket.type === 'control') {
                    if (dynBuffer.length > 0) {
                        log(LogLevel.DEBUG, `[Streaming ${socket.remoteId} - Control] Forwarding ${dynBuffer.length} bytes from device to WS Client ${session.clientId}`);
                        client.ws.send(JSON.stringify({
                            type: MESSAGE_TYPES.DEVICE_MESSAGE,
                            data: dynBuffer.buffer.subarray(0, dynBuffer.length).toString('base64')
                        }));
                        dynBuffer.length = 0;
                        processedSomething = true;
                    }
                    keepProcessing = false;
                }
                break;

            default:
                log(LogLevel.ERROR, `[${socket.remoteId} ${session.scid}] Unknown socket state: ${socket.state}. Stopping processing for this socket.`);
                socket.state = 'UNKNOWN';
                keepProcessing = false;
        }
    }
}

async function gracefulShutdown(wss, httpServer) {
    log(LogLevel.INFO, '\n[Shutdown] Received signal. Shutting down gracefully...');
    const activeSessions = Array.from(sessions.keys());
    log(LogLevel.INFO, `[Shutdown] Cleaning up ${activeSessions.length} active session(s)...`);
    for (const [clientId, client] of wsClients) {
        if (client.ws?.readyState === WebSocket.OPEN || client.ws?.readyState === WebSocket.CONNECTING) {
            client.ws.close(1001, 'Server Shutting Down');
        }
    }
    wsClients.clear();
    await Promise.allSettled(activeSessions.map(scid => cleanupSession(scid)));
    const closeWss = new Promise(resolve => wss.close(resolve));
    const closeHttp = new Promise(resolve => httpServer ? httpServer.close(resolve) : resolve());
    await Promise.all([closeWss, closeHttp]);
    log(LogLevel.INFO, '[Shutdown] Servers closed. Exiting.');
    process.exit(0);
    setTimeout(() => {
        log(LogLevel.ERROR, "[Shutdown] Timeout. Forcing exit.");
        process.exit(1);
    }, 5000);
}

async function start() {
    let httpServer;
    let wss;
    try {
        log(LogLevel.INFO, '[System] Starting application...');
        wss = createWebSocketServer();
        const app = express();
        app.use(express.static(path.join(__dirname, 'public')));
        httpServer = app.listen(HTTP_PORT, () => {
            log(LogLevel.INFO, `[System] HTTP server listening on port ${HTTP_PORT}`);
            log(LogLevel.INFO, `[System] Access UI at http://localhost:${HTTP_PORT}`);
        });
        httpServer.on('error', (err) => {
            log(LogLevel.ERROR, `[System] HTTP server failed start: ${err.message}`);
            process.exit(1);
        });
        process.on('SIGINT', () => gracefulShutdown(wss, httpServer));
        process.on('SIGTERM', () => gracefulShutdown(wss, httpServer));
        process.on('uncaughtException', (err, origin) => {
            log(LogLevel.ERROR, `[FATAL] Uncaught Exception at: ${origin}`, err);
            process.exit(1);
        });
        process.on('unhandledRejection', (reason, promise) => {
            log(LogLevel.ERROR, '[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
            process.exit(1);
        });
    } catch (error) {
        log(LogLevel.ERROR, `[FATAL] Failed to start server: ${error.message}`);
        process.exit(1);
    }
}

log(LogLevel.DEBUG, 'CODEC_METADATA_LENGTHS:', CODEC_METADATA_LENGTHS);
log(LogLevel.DEBUG, 'CODEC_SOCKET_TYPES:', CODEC_SOCKET_TYPES);

start();