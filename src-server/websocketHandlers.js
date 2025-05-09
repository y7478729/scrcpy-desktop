const WebSocket = require('ws');
const crypto = require('crypto');
const { log } = require('./logger');
const C = require('./constants');
const adbService = require('./adbService');
const sessionManager = require('./scrcpySession');

const wsClients = new Map();

async function handleStart(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client || client.session) {
        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.ERROR, message: client ? 'Session already active' : 'Internal error' }));
        return;
    }
    const deviceId = message.deviceId;
    if (!deviceId) {
        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.ERROR, message: 'No device selected.' }));
        return;
    }
    let scid = null;
    try {
        const devices = await adbService.getAdbDevices();
        const selectedDevice = devices.find(d => d.id === deviceId && d.type === 'device');
        if (!selectedDevice) {
            const allDevicesFullStatus = await adbService.adb.listDevices();
            const status = allDevicesFullStatus.find(d => d.id === deviceId)?.type || 'not found';
            ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.ERROR, message: `Device "${deviceId}" not available (status: ${status}).` }));
            return;
        }
        try {
            const launcherApps = await adbService.getLauncherApps(deviceId);
            ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.LAUNCHER_APPS_LIST, apps: launcherApps }));
        } catch (appError) {
            ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.LAUNCHER_APPS_LIST, apps: [], error: `Failed to get apps: ${appError.message}` }));
        }
        const device = adbService.adb.getDevice(deviceId);
        const versionStream = await device.shell('getprop ro.build.version.release');
        const versionOutput = await adbService.streamToString(versionStream);
        const versionMatch = versionOutput.trim().match(/^(\d+)/);
        const androidVersion = versionMatch ? parseInt(versionMatch[1], 10) : NaN;
        if (isNaN(androidVersion)) throw new Error(`Invalid Android version: ${versionOutput.trim()}`);

        const runOptions = { ...C.BASE_SCRCPY_OPTIONS };
        const maxFps = parseInt(message.maxFps); if (!isNaN(maxFps) && maxFps > 0) runOptions.max_fps = String(maxFps);
        const bitrate = parseInt(message.bitrate); if (!isNaN(bitrate) && bitrate > 0) runOptions.video_bit_rate = String(bitrate);
        const audioEnabled = message.enableAudio || false; runOptions.audio = androidVersion < 11 ? 'false' : String(audioEnabled);
        const videoEnabled = !(message.video === false || message.video === 'false'); runOptions.video = String(videoEnabled);
        const controlEnabled = message.enableControl || false; runOptions.control = String(controlEnabled);
        if (message.noPowerOn) runOptions.power_on = 'false';
        if (message.powerOffOnClose) runOptions.power_off_on_close = 'true';
        if (message.displayMode === 'overlay' && message.overlayDisplayId !== undefined) runOptions.display_id = String(message.overlayDisplayId);
        else if (message.displayMode === 'native_taskbar') runOptions.display_id = '0';
        else if (message.displayMode === 'dex') runOptions.display_id = '2';
        else if (message.displayMode === 'virtual' && message.resolution !== "reset" && message.dpi !== "reset") runOptions.new_display = `${message.resolution}/${message.dpi}`;
        if (message.displayMode !== 'native_taskbar' && message.displayMode !== 'dex' && message.rotationLock) runOptions.capture_orientation = String(message.rotationLock);

        scid = (crypto.randomBytes(4).readUInt32BE(0) & 0x7FFFFFFF).toString(16).padStart(8, '0');
        const port = C.SERVER_PORT_BASE + (sessionManager.sessions.size % 1000);
        const session = await sessionManager.setupScrcpySession(deviceId, scid, port, runOptions, clientId, message.displayMode, message.turnScreenOff || false, wsClients);
        if (session) session.androidVersion = androidVersion;
        client.session = scid;
        if (androidVersion < 11 && audioEnabled) ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.STATUS, message: 'Audio disabled (Android < 11)'}));
    } catch (err) {
        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.ERROR, message: `Setup failed: ${err.message}` }));
        const clientData = wsClients.get(clientId);
        if (clientData?.session) await sessionManager.cleanupSession(clientData.session, wsClients);
        else if (scid && sessionManager.sessions.has(scid)) await sessionManager.cleanupSession(scid, wsClients);
        if (clientData) clientData.session = null;
    }
}

async function handleClientDisconnectCommand(clientId) {
    const client = wsClients.get(clientId);
    if (!client) { log(C.LogLevel.WARN, `[ClientDisconnectCommand] Client ${clientId} not found.`); return; }
    if (client.session) {
        const scidToStop = client.session;
        log(C.LogLevel.INFO, `[ClientDisconnectCommand] Client ${clientId} stopping session ${scidToStop}.`);
        client.session = null;
        if (client.ws?.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.STATUS, message: 'Streaming stopped' }));
        await sessionManager.cleanupSession(scidToStop, wsClients);
        log(C.LogLevel.INFO, `[ClientDisconnectCommand] Session ${scidToStop} cleaned up for client ${clientId}.`);
    } else {
        log(C.LogLevel.INFO, `[ClientDisconnectCommand] Client ${clientId} sent disconnect, no active session.`);
        if (client.ws?.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.STATUS, message: 'No active stream to stop.' }));
    }
}

async function handleGetAdbDevices(clientId, ws) {
    try {
        const devices = await adbService.getAdbDevices();
        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.ADB_DEVICES_LIST, success: true, devices }));
    } catch (error) {
        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.ADB_DEVICES_LIST, success: false, error: error.message }));
    }
}

async function handleVolumeCommand(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client || !client.session) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.VOLUME_RESPONSE, success: false, value: message.value, error: 'No active session' })); return; }
    const session = sessionManager.sessions.get(client.session);
    if (!session || !session.deviceId) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.VOLUME_RESPONSE, success: false, value: message.value, error: 'No device found' })); return; }
    try {
        const value = parseInt(message.value, 10);
        if (isNaN(value) || value < 0 || value > 100) throw new Error(`Invalid volume value: ${message.value}`);
        await adbService.setMediaVolume(session.deviceId, value, sessionManager.sessions);
        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.VOLUME_RESPONSE, success: true, requestedValue: value }));
    } catch (error) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.VOLUME_RESPONSE, success: false, value: message.value, error: error.message })); }
}

async function handleGetVolumeCommand(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client || !client.session) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.VOLUME_INFO, success: false, error: 'No active session' })); return; }
    const session = sessionManager.sessions.get(client.session);
    if (!session || !session.deviceId) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.VOLUME_INFO, success: false, error: 'No device found' })); return; }
    try {
        const { maxVolume, currentVolume } = await adbService.getMediaVolumeInfo(session.deviceId, sessionManager.sessions);
        const volumePercentage = Math.round((currentVolume / maxVolume) * 100);
        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.VOLUME_INFO, success: true, volume: volumePercentage }));
    } catch (error) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.VOLUME_INFO, success: false, error: error.message })); }
}

async function handleNavAction(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client?.session) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.NAV_RESPONSE, success: false, key: message.key, error: 'No active session' })); return; }
    const session = sessionManager.sessions.get(client.session);
    if (!session?.deviceId) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.NAV_RESPONSE, success: false, key: message.key, error: 'No device found' })); return; }
    const keycode = C.NAV_KEYCODES[message.key];
    if (!keycode) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.NAV_RESPONSE, success: false, key: message.key, error: 'Invalid navigation key' })); return; }
    try {
        await adbService.adb.getDevice(session.deviceId).shell(`input keyevent ${keycode}`);
        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.NAV_RESPONSE, success: true, key: message.key }));
    } catch (error) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.NAV_RESPONSE, success: false, key: message.key, error: error.message })); }
}

async function handleWifiToggleCommand(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client || !client.session) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.WIFI_RESPONSE, success: false, error: 'No active session' })); return; }
    const session = sessionManager.sessions.get(client.session);
    if (!session || !session.deviceId) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.WIFI_RESPONSE, success: false, error: 'No device found' })); return; }
    const enableWifi = message.enable;
    if (typeof enableWifi !== 'boolean') { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.WIFI_RESPONSE, success: false, error: 'Invalid Wi-Fi toggle value' })); return; }
    try {
        const device = adbService.adb.getDevice(session.deviceId);
        const command = enableWifi ? 'svc wifi enable' : 'svc wifi disable';
        await device.shell(command);
        let isWifiOn = false, ssid = null;
        if (enableWifi) {
            const maxAttemptsWifiOn = 10, maxAttemptsSsid = 15, pollInterval = 500; let attempts = 0;
            while (attempts < maxAttemptsWifiOn) {
                const statusOutput = await adbService.streamToString(await device.shell('dumpsys wifi | grep "Wi-Fi is"'));
                isWifiOn = statusOutput.includes('Wi-Fi is enabled'); if (isWifiOn) break;
                attempts++; if (attempts < maxAttemptsWifiOn) await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
            if (!isWifiOn) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.WIFI_RESPONSE, success: false, error: 'Wi-Fi failed to enable' })); return; }
            attempts = 0;
            while (attempts < maxAttemptsSsid) {
                const ssidOutput = await adbService.streamToString(await device.shell(`dumpsys wifi | grep 'Supplicant state: COMPLETED' | tail -n 1 | grep -Eo 'SSID: [^,]+' | sed 's/SSID: //' | sed 's/"//g' | head -n 1`));
                ssid = ssidOutput.trim(); if (ssid && ssid !== '' && ssid !== '<unknown ssid>') break;
                attempts++; if (attempts < maxAttemptsSsid) await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
            if (!ssid || ssid === '' || ssid === '<unknown ssid>') { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.WIFI_RESPONSE, success: false, error: 'Failed to connect to SSID' })); return; }
        } else {
            await new Promise(resolve => setTimeout(resolve, 250));
            const statusOutput = await adbService.streamToString(await device.shell('dumpsys wifi | grep "Wi-Fi is"'));
            isWifiOn = statusOutput.includes('Wi-Fi is enabled');
        }
        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.WIFI_RESPONSE, success: true, enable: enableWifi, currentState: isWifiOn, ssid }));
    } catch (error) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.WIFI_RESPONSE, success: false, error: `Failed to toggle Wi-Fi: ${error.message}` })); }
}

async function handleGetWifiStatusCommand(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client || !client.session) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.WIFI_STATUS, success: false, error: 'No active session' })); return; }
    const session = sessionManager.sessions.get(client.session);
    if (!session || !session.deviceId) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.WIFI_STATUS, success: false, error: 'No device found' })); return; }
    try {
        const device = adbService.adb.getDevice(session.deviceId);
        const statusOutput = await adbService.streamToString(await device.shell('dumpsys wifi | grep "Wi-Fi is"'));
        const isWifiOn = statusOutput.includes('Wi-Fi is enabled'); let ssid = null;
        if (isWifiOn) {
            const ssidOutput = await adbService.streamToString(await device.shell(`dumpsys wifi | grep 'Supplicant state: COMPLETED' | tail -n 1 | grep -Eo 'SSID: [^,]+' | sed 's/SSID: //' | sed 's/"//g' | head -n 1`));
            ssid = ssidOutput.trim();
        }
        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.WIFI_STATUS, success: true, isWifiOn, ssid }));
    } catch (error) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.WIFI_STATUS, success: false, error: `Failed to get Wi-Fi status: ${error.message}` })); }
}

async function handleGetBatteryLevelCommand(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client || !client.session) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.BATTERY_INFO, success: false, error: 'No active session' })); return; }
    const session = sessionManager.sessions.get(client.session);
    if (!session || !session.deviceId) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.BATTERY_INFO, success: false, error: 'No device found' })); return; }
    try {
        const batteryLevel = await adbService.getBatteryLevel(session.deviceId);
        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.BATTERY_INFO, success: true, batteryLevel }));
    } catch (error) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.BATTERY_INFO, success: false, error: error.message })); }
}

async function handleLaunchApp(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client?.session) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.LAUNCH_APP_RESPONSE, success: false, packageName: message.packageName, error: 'No active session' })); return; }
    const session = sessionManager.sessions.get(client.session);
    if (!session?.deviceId) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.LAUNCH_APP_RESPONSE, success: false, packageName: message.packageName, error: 'No device found' })); return; }
    const packageName = message.packageName;
    if (!packageName) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.LAUNCH_APP_RESPONSE, success: false, error: 'Package name missing' })); return; }
    try {
        await adbService.adb.getDevice(session.deviceId).shell(`monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.LAUNCH_APP_RESPONSE, success: true, packageName }));
    } catch (error) { ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.LAUNCH_APP_RESPONSE, success: false, packageName, error: error.message })); }
}

async function handleAdbCommand(clientId, ws, message) {
    const { commandType, deviceId, commandId } = message;
    if (!deviceId) { ws.send(JSON.stringify({ type: `${commandType}Response`, commandId, success: false, error: 'Device ID missing' })); return; }
    let result;
    try {
        switch (commandType) {
            case 'getDisplayList': result = await adbService.adbListDisplays(deviceId); break;
            case 'setOverlay': result = await adbService.executeAdbShellCommand(deviceId, `settings put global overlay_display_devices ${message.resolution}/${message.dpi}`); break;
            case 'setWmSize': result = await adbService.executeAdbShellCommand(deviceId, `wm size ${message.resolution}`); if(result.success) log(C.LogLevel.INFO, `WM Size set to: ${message.resolution}`); break;
            case 'setWmDensity': result = await adbService.executeAdbShellCommand(deviceId, `wm density ${message.dpi}`); if(result.success) log(C.LogLevel.INFO, `WM Density set to: ${message.dpi}`); break;
            case 'adbRotateScreen': {
                if (!adbService.rotationStates) adbService.rotationStates = {};
                if (!adbService.rotationStates[deviceId]) {
                    const initialUserRot = await adbService.executeAdbShellCommand(deviceId, 'settings get system user_rotation');
                    const initialAccelRot = await adbService.executeAdbShellCommand(deviceId, 'settings get system accelerometer_rotation');
                    adbService.rotationStates[deviceId] = { user_rotation: initialUserRot.success && !isNaN(parseInt(initialUserRot.output)) ? parseInt(initialUserRot.output) : 0, accelerometer_rotation: initialAccelRot.success && !isNaN(parseInt(initialAccelRot.output)) ? parseInt(initialAccelRot.output) : 1 };
                }
                const currentRotationResult = await adbService.executeAdbShellCommand(deviceId, 'settings get system user_rotation');
                const currentRotation = currentRotationResult.success && !isNaN(parseInt(currentRotationResult.output)) ? parseInt(currentRotationResult.output) : 0;
                await adbService.executeAdbShellCommand(deviceId, 'settings put system accelerometer_rotation 0');
                const nextRotation = (currentRotation + 1) % 4;
                result = await adbService.executeAdbShellCommand(deviceId, `settings put system user_rotation ${nextRotation}`);
                if (result.success) result.message = `Screen rotated to ${nextRotation * 90} degrees.`;
                break;
            }
            case 'cleanupAdb': {
                const mode = message.mode; let cleanupMessages = [];
                if (mode === 'native_taskbar') {
                    let res = await adbService.executeAdbShellCommand(deviceId, 'wm size reset'); cleanupMessages.push(`WM Size Reset: ${res.success ? 'OK' : res.error}`);
                    res = await adbService.executeAdbShellCommand(deviceId, 'wm density reset'); cleanupMessages.push(`WM Density Reset: ${res.success ? 'OK' : res.error}`);
                }
                if (mode === 'overlay') {
                    let res = await adbService.executeAdbShellCommand(deviceId, 'settings put global overlay_display_devices none'); cleanupMessages.push(`Overlay Reset: ${res.success ? 'OK' : res.error}`);
                }
                if ((mode === 'native_taskbar') && adbService.rotationStates && adbService.rotationStates[deviceId]) {
                    const originalUser = adbService.rotationStates[deviceId].user_rotation !== undefined ? adbService.rotationStates[deviceId].user_rotation : 0;
                    const originalAccel = adbService.rotationStates[deviceId].accelerometer_rotation !== undefined ? adbService.rotationStates[deviceId].accelerometer_rotation : 1;
                    let res = await adbService.executeAdbShellCommand(deviceId, `settings put system user_rotation ${originalUser}`); cleanupMessages.push(`User Rotation Restore (${originalUser}): ${res.success ? 'OK' : res.error}`);
                    res = await adbService.executeAdbShellCommand(deviceId, `settings put system accelerometer_rotation ${originalAccel}`); cleanupMessages.push(`Accel Rotation Restore (${originalAccel}): ${res.success ? 'OK' : res.error}`);
                    delete adbService.rotationStates[deviceId];
                }
                result = { success: true, message: `Cleanup for ${mode} mode: ${cleanupMessages.join('; ')}` };
                break;
            }
            default: result = { success: false, error: `Unknown ADB commandType: ${commandType}` };
        }
    } catch (error) { result = { success: false, error: error.message }; }
    ws.send(JSON.stringify({ type: `${commandType}Response`, commandId, ...result }));
}

const actionHandlers = {
    'start': handleStart,
    'disconnect': handleClientDisconnectCommand,
    'getAdbDevices': handleGetAdbDevices,
    'volume': handleVolumeCommand,
    'getVolume': handleGetVolumeCommand,
    'navAction': handleNavAction,
    'wifiToggle': handleWifiToggleCommand,
    'getWifiStatus': handleGetWifiStatusCommand,
    'getBatteryLevel': handleGetBatteryLevelCommand,
    'launchApp': handleLaunchApp,
    'adbCommand': handleAdbCommand,
};

function createWebSocketServer() {
    const wss = new WebSocket.Server({ port: C.WEBSOCKET_PORT });
    wss.on('connection', (ws) => {
        const clientId = crypto.randomUUID();
        wsClients.set(clientId, { ws, session: null });
        log(C.LogLevel.INFO, `[WebSocket] Client connected: ${clientId}`);

        ws.on('message', async (data, isBinary) => {
            const client = wsClients.get(clientId);
            if (!client) return;

            if (isBinary) {
                if (client.session) {
                    const session = sessionManager.sessions.get(client.session);
                    if (session?.controlSocket && !session.controlSocket.destroyed) {
                        const worker = sessionManager.workers.get(client.session);
                        if (worker) {
                            const bufferData = Buffer.isBuffer(data) ? data : Buffer.from(data);
                            worker.postMessage({ type: 'controlData', data: bufferData, scid: client.session, clientId });
                        }
                    }
                }
            } else {
                let message;
                try {
                    message = JSON.parse(data.toString());
                    log(C.LogLevel.DEBUG, `[WebSocket] Parsed command from ${clientId}: ${message.action}`);
                    const handler = actionHandlers[message.action];
                    if (handler) {
                        await handler(clientId, ws, message);
                    } else {
                        log(C.LogLevel.WARN, `[WebSocket] Unknown action from ${clientId}: ${message.action}`);
                        ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.ERROR, message: `Unknown action: ${message.action}` }));
                    }
                } catch (err) {
                    log(C.LogLevel.ERROR, `[WebSocket] Invalid JSON from ${clientId}: ${err.message}.`);
                    ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.ERROR, message: 'Invalid message format' }));
                }
            }
        });

        ws.on('close', async (code, reason) => {
            log(C.LogLevel.INFO, `[WebSocket] Client WS closed: ${clientId} (Code: ${code}, Reason: ${reason?.toString()})`);
            const clientOnClose = wsClients.get(clientId);
            if (clientOnClose?.session) {
                await sessionManager.cleanupSession(clientOnClose.session, wsClients);
            }
            wsClients.delete(clientId);
        });

        ws.on('error', async (error) => {
            log(C.LogLevel.ERROR, `[WebSocket] Error for client ${clientId}: ${error.message}`);
            const clientOnError = wsClients.get(clientId);
            if (clientOnError?.session) {
                await sessionManager.cleanupSession(clientOnError.session, wsClients);
            }
            if (clientOnError?.ws && (clientOnError.ws.readyState === WebSocket.OPEN || clientOnError.ws.readyState === WebSocket.CONNECTING)) {
                clientOnError.ws.terminate();
            }
        });
    });

    log(C.LogLevel.INFO, `[System] WebSocket server listening on port ${C.WEBSOCKET_PORT}`);
    return wss;
}

module.exports = { createWebSocketServer, wsClients };