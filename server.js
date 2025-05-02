const express = require('express');
const net = require('net');
const path = require('path');
const util = require('util');
const { exec } = require('child_process');
const adbkit = require('@devicefarmer/adbkit');
const WebSocket = require('ws');
const crypto = require('crypto');

const SERVER_PORT_BASE = 27183;
const WEBSOCKET_PORT = 8080;
const HTTP_PORT = 8000;
const SERVER_JAR_PATH = path.resolve(__dirname, 'public/vendor/Genymobile/scrcpy-server/scrcpy-server-v3.2');
const SERVER_DEVICE_PATH = '/data/local/tmp/scrcpy-server.jar';
const SCRCPY_VERSION = '3.2';

const LogLevel = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LOG_LEVEL = LogLevel.INFO;

const BASE_SCRCPY_OPTIONS = {
    log_level: CURRENT_LOG_LEVEL === LogLevel.DEBUG ? 'debug' : 'info',
    video_codec: 'h264',
    audio_codec: 'raw',
};

const DEVICE_NAME_LENGTH = 64;
const VIDEO_METADATA_LENGTH = 12;
const AUDIO_METADATA_LENGTH = 4;
const PACKET_HEADER_LENGTH = 12;

const MESSAGE_TYPES = {
    DEVICE_NAME: 'deviceName', VIDEO_INFO: 'videoInfo', AUDIO_INFO: 'audioInfo',
    STATUS: 'status', ERROR: 'error', DEVICE_MESSAGE: 'deviceMessage'
};
const BINARY_TYPES = { VIDEO: 0, AUDIO: 1 };

const CODEC_IDS = {
    H264: 0x68323634, H265: 0x68323635, AV1: 0x00617631,
    OPUS: 0x6f707573, AAC: 0x00616163, RAW: 0x00726177,
};

const CODEC_METADATA_LENGTHS = {
    [CODEC_IDS.H264]: VIDEO_METADATA_LENGTH, [CODEC_IDS.H265]: VIDEO_METADATA_LENGTH,
    [CODEC_IDS.AV1]: VIDEO_METADATA_LENGTH, [CODEC_IDS.OPUS]: AUDIO_METADATA_LENGTH,
    [CODEC_IDS.AAC]: AUDIO_METADATA_LENGTH, [CODEC_IDS.RAW]: AUDIO_METADATA_LENGTH,
};

const CODEC_SOCKET_TYPES = {
    [CODEC_IDS.H264]: 'video', [CODEC_IDS.H265]: 'video', [CODEC_IDS.AV1]: 'video',
    [CODEC_IDS.OPUS]: 'audio', [CODEC_IDS.AAC]: 'audio', [CODEC_IDS.RAW]: 'audio',
};

const adb = new adbkit.Client();
const execPromise = util.promisify(exec);
const sessions = new Map();
const wsClients = new Map();

function log(level, message, ...args) {
    if (level >= CURRENT_LOG_LEVEL) {
        const levelStr = Object.keys(LogLevel).find(key => LogLevel[key] === level);
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${levelStr}]`, message, ...args);
    }
}

function createWebSocketServer() {
    const wss = new WebSocket.Server({ port: WEBSOCKET_PORT });
    wss.on('connection', (ws) => {
        const clientId = crypto.randomUUID();
        wsClients.set(clientId, { ws, session: null });
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
                        log(LogLevel.DEBUG, `[Control Send] Forwarding ${data.length} bytes to CONTROL socket ${session.controlSocket.remoteId}`);
                        try { session.controlSocket.write(data); }
                        catch (e) { log(LogLevel.ERROR, `[Control Send Error] SCID ${client.session}: ${e.message}`); }
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
                        case 'start': await handleStart(clientId, ws, message); break;
                        case 'disconnect': await handleDisconnect(clientId); break;
                        default:
                            log(LogLevel.WARN, `[WebSocket] Unknown action from ${clientId}: ${message.action}`);
                            ws.send(JSON.stringify({ type: MESSAGE_TYPES.ERROR, message: `Unknown action: ${message.action}` }));
                            break;
                    }
                } catch (err) {
                    log(LogLevel.ERROR, `[WebSocket] Invalid JSON from ${clientId}: ${err.message}. Data: ${data.toString().substring(0, 100)}`);
                    ws.send(JSON.stringify({ type: MESSAGE_TYPES.ERROR, message: 'Invalid message format' }));
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

async function executeCommand(command, description) {
    log(LogLevel.DEBUG, `[Exec] Running: ${description} (${command})`);
    try {
        const { stdout, stderr } = await execPromise(command);
        if (stderr && !(description.includes('Remove') && stderr.includes('not found'))) { log(LogLevel.WARN, `[Exec] Stderr (${description}): ${stderr.trim()}`); }
        else if (stderr) { log(LogLevel.DEBUG, `[Exec] Stderr (${description}): ${stderr.trim()} (Ignored)`); }
        if (stdout) { log(LogLevel.DEBUG, `[Exec] Stdout (${description}): ${stdout.trim()}`); }
        log(LogLevel.DEBUG, `[Exec] Success: ${description}`);
        return { success: true, stdout, stderr };
    } catch (error) {
        log(LogLevel.ERROR, `[Exec] Error (${description}): ${error.message}`);
        if (error.stderr) log(LogLevel.ERROR, `[Exec] Stderr: ${error.stderr.trim()}`);
        if (error.stdout) log(LogLevel.ERROR, `[Exec] Stdout: ${error.stdout.trim()}`);
        throw new Error(`Failed to execute: ${description} - ${error.message}`);
    }
}

async function handleStart(clientId, ws, message) {
    log(LogLevel.INFO, `[HandleStart ${clientId}] Processing start request:`, message);
    const client = wsClients.get(clientId);
    if (!client || client.session) {
        log(client ? LogLevel.WARN : LogLevel.ERROR, `[HandleStart ${clientId}] ${client ? 'Session already active' : 'Client object not found!'}`);
        ws.send(JSON.stringify({ type: MESSAGE_TYPES.ERROR, message: client ? 'Session already active' : 'Internal error: Client not found.' }));
        return;
    }

    let deviceId = null;
    let scid = null;
    try {
        const devices = await adb.listDevices();
        if (!devices.length) throw new Error('No devices found via ADB');
        deviceId = devices[0].id;
        log(LogLevel.INFO, `[HandleStart ${clientId}] Using device: ${deviceId}`);

        const runOptions = { ...BASE_SCRCPY_OPTIONS };
        const maxSize = parseInt(message.maxSize); if (!isNaN(maxSize) && maxSize > 0) runOptions.max_size = String(maxSize);
        const maxFps = parseInt(message.maxFps); if (!isNaN(maxFps) && maxFps > 0) runOptions.max_fps = String(maxFps);
        const bitrate = parseInt(message.bitrate); if (!isNaN(bitrate) && bitrate > 0) runOptions.video_bit_rate = String(bitrate);
        const audioEnabled = message.enableAudio || false; runOptions.audio = String(audioEnabled);
        const videoEnabled = !(message.video === false || message.video === 'false'); runOptions.video = String(videoEnabled);
        const controlEnabled = message.enableControl || false; runOptions.control = String(controlEnabled);

        scid = (crypto.randomBytes(4).readUInt32BE(0) & 0x7FFFFFFF).toString(16).padStart(8, '0');
        const port = SERVER_PORT_BASE + (sessions.size % 1000);
        log(LogLevel.INFO, `[HandleStart ${clientId}] Generated SCID: ${scid}, Port: ${port}`);
        log(LogLevel.DEBUG, `[HandleStart ${clientId}] Final scrcpy options to be used:`, runOptions);

        await setupScrcpySession(deviceId, scid, port, runOptions, clientId);
        client.session = scid;
        log(LogLevel.INFO, `[HandleStart ${clientId}] Session ${scid} setup initiated. Waiting for connections...`);

    } catch (err) {
        log(LogLevel.ERROR, `[HandleStart ${clientId}] Critical error during setup: ${err.message}`);
        ws.send(JSON.stringify({ type: MESSAGE_TYPES.ERROR, message: `Setup failed: ${err.message}` }));
        const clientData = wsClients.get(clientId);
        if (clientData?.session) { await cleanupSession(clientData.session); clientData.session = null; }
        else if (scid && sessions.has(scid)) { await cleanupSession(scid); }
    }
}

async function setupScrcpySession(deviceId, scid, port, runOptions, clientId) {
    log(LogLevel.INFO, `[Session ${scid}] Starting setup process...`);
    const session = {
        deviceId, scid, port, clientId, options: runOptions,
        tcpServer: null, processStream: null, tunnelActive: false,
        videoSocket: null, audioSocket: null, controlSocket: null,
        deviceNameReceived: false, expectedSockets: [], socketsConnected: 0,
        streamingStartedNotified: false,
        unidentifiedSockets: new Map(),
    };
    if (runOptions.video === 'true') session.expectedSockets.push('video');
    if (runOptions.audio === 'true') session.expectedSockets.push('audio');
    if (runOptions.control === 'true') session.expectedSockets.push('control');

    if(session.expectedSockets.length === 0) {
        throw new Error("No streams (video, audio, control) enabled.");
    }

    log(LogLevel.INFO, `[Session ${scid}] Expecting sockets: ${session.expectedSockets.join(', ')}`);
    sessions.set(scid, session);

    try {
        await executeCommand(`adb -s ${deviceId} push "${SERVER_JAR_PATH}" "${SERVER_DEVICE_PATH}"`, `Push server JAR (SCID: ${scid})`);
        const tunnelString = `localabstract:scrcpy_${scid}`;
        await executeCommand(`adb -s ${deviceId} reverse --remove ${tunnelString}`, `Remove specific tunnel (SCID: ${scid})`).catch(() => {});
        await executeCommand(`adb -s ${deviceId} reverse --remove-all`, `Remove all tunnels (SCID: ${scid})`).catch(() => {});
        await executeCommand(`adb -s ${deviceId} reverse ${tunnelString} tcp:${port}`, `Setup reverse tunnel (SCID: ${scid})`);
        session.tunnelActive = true;
        log(LogLevel.INFO, `[Session ${scid}] Reverse tunnel active.`);

        session.tcpServer = createTcpServer(scid);
        await new Promise((resolve, reject) => {
            session.tcpServer.listen(port, '127.0.0.1', () => { log(LogLevel.INFO, `[Session ${scid}] TCP server listening.`); resolve(); });
            session.tcpServer.once('error', (err) => { log(LogLevel.ERROR, `[Session ${scid}] TCP server listen error: ${err.message}`); reject(err); });
        });

        const args = [SCRCPY_VERSION, `scid=${scid}`, `log_level=${runOptions.log_level}`];
        if (runOptions.video === 'true') args.push(`video_codec=${runOptions.video_codec}`);
        if (runOptions.audio === 'true') args.push(`audio_codec=${runOptions.audio_codec}`);
        if (runOptions.max_size) args.push(`max_size=${runOptions.max_size}`);
        if (runOptions.max_fps) args.push(`max_fps=${runOptions.max_fps}`);
        if (runOptions.video_bit_rate) args.push(`video_bit_rate=${runOptions.video_bit_rate}`);
        args.push(`video=${runOptions.video}`);
        args.push(`audio=${runOptions.audio}`);
        args.push(`control=${runOptions.control}`);

        const command = `CLASSPATH=${SERVER_DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${args.join(' ')}`;
        const fullAdbCommand = `adb -s ${deviceId} shell "${command}"`;
        log(LogLevel.INFO, `[Session ${scid}] Executing scrcpy-server on device...`);
        log(LogLevel.DEBUG, `[Session ${scid}] Full command: ${fullAdbCommand}`);
        session.processStream = exec(fullAdbCommand);

        session.processStream.stdout.on('data', (data) => log(LogLevel.INFO, `[scrcpy-server ${scid} stdout] ${data.toString().trim()}`));
        session.processStream.stderr.on('data', (data) => log(LogLevel.WARN, `[scrcpy-server ${scid} stderr] ${data.toString().trim()}`));
        session.processStream.on('error', (err) => { log(LogLevel.ERROR, `[Session ${scid}] scrcpy-server process error: ${err.message}`); cleanupSession(scid); });
        session.processStream.on('exit', (code, signal) => {
            if (sessions.has(scid)) { log(LogLevel.WARN, `[Session ${scid}] scrcpy-server exited unexpectedly (code: ${code}, signal: ${signal}). Cleaning up.`); cleanupSession(scid); }
            else { log(LogLevel.DEBUG, `[Session ${scid}] scrcpy-server exited after cleanup (code: ${code}, signal: ${signal}).`); }
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
        client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.STATUS, message: 'Streaming stopped' }));
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

    const { deviceId, tcpServer, processStream, tunnelActive, videoSocket, audioSocket, controlSocket, clientId, unidentifiedSockets } = session;

    unidentifiedSockets?.forEach(sock => sock.destroy());
    videoSocket?.destroy(); audioSocket?.destroy(); controlSocket?.destroy();

    if (processStream && !processStream.killed) { processStream.kill('SIGKILL'); log(LogLevel.INFO, `[Cleanup ${scid}] Killed scrcpy-server process.`); }
    if (tunnelActive && deviceId) { await executeCommand(`adb -s ${deviceId} reverse --remove localabstract:scrcpy_${scid}`, `Remove reverse tunnel (SCID: ${scid})`).catch(() => {}); }
    if (tcpServer) { await new Promise(resolve => tcpServer.close(resolve)); log(LogLevel.INFO, `[Cleanup ${scid}] TCP server closed.`); }

    const client = wsClients.get(clientId);
    if (client) {
         if(client.session === scid) client.session = null;
         if(client.ws?.readyState === WebSocket.OPEN) {
             client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.STATUS, message: 'Streaming stopped by server cleanup' }));
         }
    }
    log(LogLevel.INFO, `[Cleanup ${scid}] Cleanup finished.`);
}

function createTcpServer(scid) {
    const server = net.createServer((socket) => {
        const remoteId = `${socket.remoteAddress}:${socket.remotePort}`;
        const session = sessions.get(scid);
        if (!session) { log(LogLevel.WARN, `[TCP Server ${scid}] Connection from ${remoteId} but session gone.`); socket.destroy(); return; }

        if (session.socketsConnected >= session.expectedSockets.length) {
            log(LogLevel.ERROR, `[TCP Server ${scid}] Unexpected extra connection from ${remoteId}. Max ${session.expectedSockets.length} expected. Closing.`);
            socket.destroy();
            return;
        }

        session.socketsConnected++;
        log(LogLevel.INFO, `[TCP Server ${scid}] Connection ${session.socketsConnected}/${session.expectedSockets.length} received from ${remoteId}`);

        socket.scid = scid;
        socket.remoteId = remoteId;
        socket.dynamicBuffer = { buffer: Buffer.alloc(1024 * 512), length: 0 };
        socket.state = 'AWAITING_INITIAL_DATA';
        socket.type = 'unknown';
        socket.didHandleDeviceName = false;

        session.unidentifiedSockets.set(remoteId, socket);

        socket.on('data', (data) => {
            const currentSession = sessions.get(scid);
            if (!currentSession) { socket.destroy(); return; }
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
    if (session.videoSocket === socket) { session.videoSocket = null; clearedType = 'video';}
    else if (session.audioSocket === socket) { session.audioSocket = null; clearedType = 'audio'; }
    else if (session.controlSocket === socket) { session.controlSocket = null; clearedType = 'control';}

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
        if (!socket.destroyed) socket.destroy(); return;
    }

    const dynBuffer = socket.dynamicBuffer;
    const requiredLength = dynBuffer.length + data.length;
    if (requiredLength > dynBuffer.buffer.length) {
        const newSize = Math.max(dynBuffer.buffer.length * 2, requiredLength + 1024);
        log(LogLevel.DEBUG, `[Buffer ${socket.remoteId}] Resizing buffer from ${dynBuffer.buffer.length} to ${newSize}`);
        try {
            const newBuffer = Buffer.alloc(newSize);
            dynBuffer.buffer.copy(newBuffer, 0, 0, dynBuffer.length);
            dynBuffer.buffer = newBuffer;
        } catch (e) {
            log(LogLevel.ERROR, `[Buffer ${socket.remoteId}] Failed to allocate ${newSize} bytes: ${e.message}. Closing.`);
            socket.destroy(); cleanupSession(socket.scid); return;
        }
    }
    data.copy(dynBuffer.buffer, dynBuffer.length);
    dynBuffer.length += data.length;

    processSingleSocket(socket, client, session);

    if (dynBuffer.length === 0 && dynBuffer.buffer.length > 1024 * 512) {
        try { dynBuffer.buffer = Buffer.alloc(1024 * 512); } catch (e) {}
    }
}

function checkAndSendStreamingStarted(session, client) {
    if (!session || !client || client.ws?.readyState !== WebSocket.OPEN || session.streamingStartedNotified) {
        return;
    }

    const videoReady = !session.expectedSockets.includes('video') || session.videoSocket;
    const audioReady = !session.expectedSockets.includes('audio') || session.audioSocket;
    const controlReady = !session.expectedSockets.includes('control') || session.controlSocket;

    if (videoReady && audioReady && controlReady) {
        log(LogLevel.INFO, `[Session ${session.scid}] All expected sockets identified. Sending 'Streaming started' status.`);
        client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.STATUS, message: 'Streaming started' }));
        session.streamingStartedNotified = true;
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
        checkAndSendStreamingStarted(session, client);

        if (remainingSocket.dynamicBuffer.length > 0) {
             const controlClient = session ? wsClients.get(session.clientId) : null;
             if (controlClient) {
                processSingleSocket(remainingSocket, controlClient, session);
             }
        }
    }
}

function processSingleSocket(socket, client, session) {
    const dynBuffer = socket.dynamicBuffer;
    let processedSomething = false;
    let keepProcessing = true;

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
                        client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.DEVICE_NAME, name: deviceName }));
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
                            client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.VIDEO_INFO, codecId: potentialCodecId, width, height }));
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
                            identifiedThisPass = true;
                            session.unidentifiedSockets?.delete(socket.remoteId);
                            client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.AUDIO_INFO, codecId: potentialCodecId }));
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
                    checkAndSendStreamingStarted(session, client);
                    processedSomething = true;
                    keepProcessing = true;
                }

                if (identifiedThisPass) {
                    attemptIdentifyControlByDeduction(session, client);
                } else {
                     attemptIdentifyControlByDeduction(session, client);
                     if(!session.controlSocket && session.expectedSockets.includes('control')) {
                       log(LogLevel.DEBUG, `[ProcessSingleSocket ${socket.remoteId}] Identification still pending in AWAITING_METADATA.`);
                       keepProcessing = false;
                     } else {
                        keepProcessing = dynBuffer.length > 0;
                     }
                }
                break;

            case 'STREAMING':
                if (!socket.type || socket.type === 'unknown') { log(LogLevel.WARN, `[Streaming ${socket.remoteId}] Socket in STREAMING state but type unknown? Resetting.`); socket.state = 'AWAITING_METADATA'; keepProcessing = true; break; }

                if (socket.type === 'video' || socket.type === 'audio') {
                    if (dynBuffer.length >= PACKET_HEADER_LENGTH) {
                        const packetSize = dynBuffer.buffer.readUInt32BE(8);
                        if (packetSize > 10 * 1024 * 1024 || packetSize < 0) { log(LogLevel.ERROR, `[${socket.remoteId} ${session.scid} - ${socket.type}] Invalid packet size: ${packetSize}. Closing.`); socket.state = 'UNKNOWN'; socket.destroy(); return; }
                        const totalPacketLength = PACKET_HEADER_LENGTH + packetSize;
                        if (dynBuffer.length >= totalPacketLength) {
                            const payload = dynBuffer.buffer.subarray(PACKET_HEADER_LENGTH, totalPacketLength);
                            const typeBuffer = Buffer.alloc(1);
                            typeBuffer.writeUInt8(socket.type === 'video' ? BINARY_TYPES.VIDEO : BINARY_TYPES.AUDIO, 0);
                            log(LogLevel.DEBUG, `[Streaming ${socket.remoteId}] Sending ${socket.type} packet (${payload.length} bytes)`);
                            client.ws.send(Buffer.concat([typeBuffer, payload]), { binary: true });
                            dynBuffer.buffer.copy(dynBuffer.buffer, 0, totalPacketLength, dynBuffer.length);
                            dynBuffer.length -= totalPacketLength;
                            processedSomething = true;
                            keepProcessing = true;
                        } else { log(LogLevel.DEBUG, `[Streaming ${socket.remoteId}] Need ${totalPacketLength} bytes for packet, have ${dynBuffer.length}. Waiting.`); keepProcessing = false; }
                    } else { log(LogLevel.DEBUG, `[Streaming ${socket.remoteId}] Need ${PACKET_HEADER_LENGTH} bytes for header, have ${dynBuffer.length}. Waiting.`); keepProcessing = false; }
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
    setTimeout(() => { log(LogLevel.ERROR, "[Shutdown] Timeout. Forcing exit."); process.exit(1); }, 5000);
}

async function start() {
    let httpServer;
    let wss;
    try {
        log(LogLevel.INFO, '[System] Starting application...');
        wss = createWebSocketServer();
        const app = express();
        app.use(express.static(path.join(__dirname, 'public')));
        httpServer = app.listen(HTTP_PORT, () => { log(LogLevel.INFO, `[System] HTTP server listening on port ${HTTP_PORT}`); log(LogLevel.INFO, `[System] Access UI at http://localhost:${HTTP_PORT}`); });
        httpServer.on('error', (err) => { log(LogLevel.ERROR, `[System] HTTP server failed start: ${err.message}`); process.exit(1); });
        process.on('SIGINT', () => gracefulShutdown(wss, httpServer));
        process.on('SIGTERM', () => gracefulShutdown(wss, httpServer));
        process.on('uncaughtException', (err, origin) => { log(LogLevel.ERROR, `[FATAL] Uncaught Exception at: ${origin}`, err); process.exit(1); });
        process.on('unhandledRejection', (reason, promise) => { log(LogLevel.ERROR, '[FATAL] Unhandled Rejection at:', promise, 'reason:', reason); process.exit(1); });
    } catch (error) {
        log(LogLevel.ERROR, `[FATAL] Failed to start server: ${error.message}`);
        process.exit(1);
    }
}

log(LogLevel.DEBUG, 'CODEC_METADATA_LENGTHS:', CODEC_METADATA_LENGTHS);
log(LogLevel.DEBUG, 'CODEC_SOCKET_TYPES:', CODEC_SOCKET_TYPES);

start();