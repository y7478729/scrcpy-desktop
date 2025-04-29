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
const SERVER_JAR_PATH = path.resolve(__dirname, 'public/vendor/Genymobile/scrcpy-server/scrcpy-server-v3.2');
const SERVER_DEVICE_PATH = '/data/local/tmp/scrcpy-server.jar';
const SCRCPY_VERSION = '3.2';
const DEFAULT_OPTIONS = {
    log_level: 'info',
    video_codec: 'h264',
    audio_codec: 'raw',
    audio: 'false',
};

const adb = new adbkit.Client();
const execPromise = util.promisify(exec);

const DEVICE_NAME_LENGTH = 64;
const VIDEO_METADATA_LENGTH = 12;
const AUDIO_METADATA_LENGTH = 4;
const PACKET_HEADER_LENGTH = 12;

const MESSAGE_TYPES = {
    DEVICE_NAME: 'deviceName',
    VIDEO_INFO: 'videoInfo',
    AUDIO_INFO: 'audioInfo',
    STATUS: 'status',
    ERROR: 'error'
};

const BINARY_TYPES = {
    VIDEO: 0,
    AUDIO: 1
};

const CODEC_IDS = {
    H264: 0x68323634,
    RAW: 0x00726177,
};

const sessions = new Map();
const wsClients = new Map();

function createWebSocketServer() {
    const wss = new WebSocket.Server({ port: WEBSOCKET_PORT });
    wss.on('connection', (ws) => {
        const clientId = crypto.randomUUID();
        console.log(`[WebSocket] New connection, assigned clientId: ${clientId}`);
        wsClients.set(clientId, { ws, session: null });
        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data);
                console.log(`[WebSocket ${clientId}] Received message:`, message);
                if (message.action === 'start') await handleStart(clientId, ws, message);
                else if (message.action === 'disconnect') await handleDisconnect(clientId);
                else ws.send(JSON.stringify({ type: MESSAGE_TYPES.ERROR, message: `Unknown action: ${message.action}` }));
            } catch (err) {
                console.error(`[WebSocket ${clientId}] Error parsing message:`, err.message);
                ws.send(JSON.stringify({ type: MESSAGE_TYPES.ERROR, message: 'Invalid message format' }));
            }
        });
        ws.on('close', () => {
            console.log(`[WebSocket] Connection closed for clientId: ${clientId}`);
            handleDisconnect(clientId);
        });
        ws.on('error', (err) => {
            console.error(`[WebSocket] Error for clientId: ${clientId}:`, err.message);
            handleDisconnect(clientId);
        });
    });
    return wss;
}

async function handleStart(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client) {
        console.warn(`[HandleStart] No client found for clientId: ${clientId}`);
        ws.send(JSON.stringify({ type: MESSAGE_TYPES.ERROR, message: 'Client not found. Please refresh.' }));
        return;
    }
    if (client.session) {
        console.warn(`[HandleStart] Session already active for client ${clientId}`);
        ws.send(JSON.stringify({ type: MESSAGE_TYPES.STATUS, message: 'Session already active' }));
        return;
    }
    try {
        const devices = await adb.listDevices();
        if (!devices.length) throw new Error('No devices found via ADB');
        const deviceId = devices[0].id;
        const runOptions = { ...DEFAULT_OPTIONS };
        runOptions.max_size = String(message.maxSize);
        runOptions.max_fps = String(message.maxFps);
        runOptions.video_bit_rate = String((message.bitrate));
        runOptions.audio = String(message.enableAudio || false);
        runOptions.audio_codec = 'raw';
        runOptions.video = 'true';
        runOptions.video_codec = 'h264';

        const scid = (crypto.randomBytes(4).readUInt32BE(0) & 0x7FFFFFFF).toString(16).padStart(8, '0');
        const port = SERVER_PORT_BASE + (sessions.size % 1000);
        await setupScrcpySession(deviceId, scid, port, runOptions, clientId);
        wsClients.get(clientId).session = scid;
        ws.send(JSON.stringify({ type: MESSAGE_TYPES.STATUS, message: 'Streaming started' }));
    } catch (err) {
        console.error(`[HandleStart] Error starting session for client ${clientId}:`, err.message);
        ws.send(JSON.stringify({ type: MESSAGE_TYPES.ERROR, message: err.message }));
    }
}

async function handleDisconnect(clientId) {
    const client = wsClients.get(clientId);
    if (!client || !client.session) return;
    console.log(`[Disconnect] Cleaning up session for client ${clientId}, scid: ${client.session}`);
    const scidToClean = client.session;
    client.session = null;
    if (client.ws && client.ws.readyState === WebSocket.OPEN) {
         client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.STATUS, message: 'Streaming stopped' }));
    }
    wsClients.delete(clientId);
    await cleanupSession(scidToClean);
}

async function setupScrcpySession(deviceId, scid, port, runOptions, clientId) {
    const session = {
        deviceId,
        scid,
        port,
        tcpServer: null,
        processStream: null,
        tunnelActive: false,
        videoSocket: null,
        audioSocket: null,
        videoPacketBuffer: [],
        hasVideoConfig: false,
        hasKeyFrame: false,
        hasDeviceName: false
    };
    try {
        const device = adb.getDevice(deviceId);
        await device.push(SERVER_JAR_PATH, SERVER_DEVICE_PATH);
        const tunnelString = `localabstract:scrcpy_${scid}`;
        await execPromise(`adb -s ${deviceId} reverse --remove ${tunnelString}`).catch(() => {});
        await device.reverse(tunnelString, `tcp:${port}`);
        session.tunnelActive = true;

        const optionsArray = Object.entries(runOptions).map(([key, value]) => `${key}=${value}`);
        const args = [SCRCPY_VERSION, `scid=${scid}`, ...optionsArray];
        const command = `CLASSPATH=${SERVER_DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${args.join(' ')}`;

        session.processStream = await device.shell(command);
        session.processStream.on('data', (data) => console.log(`[Server ${scid}]`, data.toString().trim()));
        session.processStream.on('error', (err) => {
            console.error(`[Server ${scid}] Process error: ${err.message}`);
            cleanupSession(scid);
        });
        session.processStream.on('end', () => {
            console.log(`[Server ${scid}] Process ended.`);
            cleanupSession(scid);
        });

        session.tcpServer = createTcpServer(scid, clientId);
        session.tcpServer.listen(port, '127.0.0.1');
        sessions.set(scid, session);
    } catch (err) {
        console.error(`[Setup ${scid}] Error during setup: ${err.message}`);
        await cleanupSession(scid);
        throw err;
    }
}

async function cleanupSession(scid) {
    const session = sessions.get(scid);
    if (!session) return;

    sessions.delete(scid);
    console.log(`[Cleanup ${scid}] Starting cleanup process...`);

    if (session.videoSocket) {
        console.log(`[Cleanup ${scid}] Destroying video socket.`);
        session.videoSocket.destroy();
        session.videoSocket = null;
    }
    if (session.audioSocket) {
        console.log(`[Cleanup ${scid}] Destroying audio socket.`);
        session.audioSocket.destroy();
        session.audioSocket = null;
    }

    if (session.processStream && session.deviceId) {
        const killCmd = `ps -ef | grep scid=${scid} | grep -v grep | tr -s ' ' | cut -d ' ' -f2 | xargs -r kill -9`;
        const fullKillCmd = `adb -s ${session.deviceId} shell "${killCmd}"`;
        try {
            await execPromise(fullKillCmd);
            console.log(`[Cleanup ${scid}] Sent kill command for scrcpy process.`);
        } catch (err) {
            console.warn(`[Cleanup ${scid}] Failed to kill scrcpy process:`, err.message);
        }
        session.processStream = null;
    }

    if (session.tunnelActive && session.deviceId) {
        try {
            const tunnelString = `localabstract:scrcpy_${scid}`;
            await execPromise(`adb -s ${session.deviceId} reverse --remove ${tunnelString}`);
            console.log(`[Cleanup ${scid}] Removed reverse tunnel.`);
        } catch (err) {
            console.warn(`[Cleanup ${scid}] Failed to remove reverse tunnel:`, err.message);
        }
        session.tunnelActive = false;
    }

    if (session.tcpServer) {
        await new Promise((resolve, reject) => {
            session.tcpServer.close((err) => {
                if (err) {
                    console.warn(`[Cleanup ${scid}] Error closing TCP server:`, err.message);
                    reject(err);
                } else {
                    console.log(`[Cleanup ${scid}] Closed local TCP server.`);
                    resolve();
                }
            });
        });
        session.tcpServer = null;
    }

    console.log(`[Cleanup ${scid}] Cleanup finished.`);
}

function createTcpServer(scid, clientId) {
    const server = net.createServer((socket) => {
        const remoteId = `${socket.remoteAddress}:${socket.remotePort}`;
        socket.remoteId = remoteId;
        socket.buffer = Buffer.alloc(0);
        socket.state = 'INITIAL';
        socket.scid = scid;
        socket.type = null;

        const currentSession = sessions.get(scid);
        if (!currentSession) {
            console.warn(`[TCP Server ${scid}] Connection from ${remoteId} but session no longer exists. Closing socket.`);
            socket.destroy();
            return;
        }

        console.log(`[TCP Server ${scid}] Connection received from: ${remoteId}`);

        socket.on('data', (data) => processData(socket, data, clientId));
        socket.on('end', () => {
            console.log(`[TCP Server ${scid}] Connection ended: ${remoteId} (Type: ${socket.type || 'Unknown'})`);
            if (currentSession && socket === currentSession.videoSocket) currentSession.videoSocket = null;
            if (currentSession && socket === currentSession.audioSocket) currentSession.audioSocket = null;
        });
        socket.on('error', (err) => {
            console.error(`[TCP Server ${scid}] Socket error (${remoteId}, Type: ${socket.type || 'Unknown'}): ${err.message}`);
            socket.destroy();
            if (currentSession && socket === currentSession.videoSocket) currentSession.videoSocket = null;
            if (currentSession && socket === currentSession.audioSocket) currentSession.audioSocket = null;
        });
        socket.on('close', (hadError) => {
            console.log(`[TCP Server ${scid}] Connection closed: ${remoteId} (Type: ${socket.type || 'Unknown'}, HadError: ${hadError})`);
            if (currentSession && socket === currentSession.videoSocket) currentSession.videoSocket = null;
            if (currentSession && socket === currentSession.audioSocket) currentSession.audioSocket = null;
        });
    });
    server.on('error', (err) => {
        console.error(`[TCP Server ${scid}] Server error:`, err);
        cleanupSession(scid);
    });
    return server;
}

function processData(socket, data, clientId) {
    socket.buffer = Buffer.concat([socket.buffer, data]);
    const client = wsClients.get(clientId);
    const session = sessions.get(socket.scid);

    if (!session || !client || client.session !== socket.scid) {
        socket.buffer = Buffer.alloc(0);
        return;
    }

    while (true) {
        let processedPacket = false;

        switch (socket.state) {
            case 'INITIAL':
                if (!session.hasDeviceName && socket.buffer.length >= DEVICE_NAME_LENGTH) {
                    const deviceName = socket.buffer.subarray(0, DEVICE_NAME_LENGTH).toString('ascii').split('\0')[0];
                    console.log(`[${socket.remoteId} ${socket.scid}] Device Name: ${deviceName}`);
                    client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.DEVICE_NAME, name: deviceName }));
                    socket.buffer = socket.buffer.subarray(DEVICE_NAME_LENGTH);
                    session.hasDeviceName = true;
                    processedPacket = true;
                    socket.state = 'AWAITING_METADATA';
                } else if (session.hasDeviceName) {
                     socket.state = 'AWAITING_METADATA';
                     continue;
                } else {
                    break;
                }
                break;

            case 'AWAITING_METADATA':
                 const minMetaLength = Math.min(VIDEO_METADATA_LENGTH, AUDIO_METADATA_LENGTH);
                 if (socket.buffer.length >= minMetaLength) {
                     const codecId = socket.buffer.readUInt32BE(0);

                     if (codecId === CODEC_IDS.H264 && !session.videoSocket && socket.buffer.length >= VIDEO_METADATA_LENGTH) {
                         socket.type = 'video';
                         session.videoSocket = socket;
                         const width = socket.buffer.readUInt32BE(4);
                         const height = socket.buffer.readUInt32BE(8);
                         console.log(`[${socket.remoteId} ${socket.scid}] Video Socket - Codec: H264, Resolution: ${width}x${height}`);
                         client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.VIDEO_INFO, codecId: CODEC_IDS.H264, width, height }));
                         socket.buffer = socket.buffer.subarray(VIDEO_METADATA_LENGTH);
                         socket.state = 'STREAMING';
                         processedPacket = true;
                     } else if (codecId === CODEC_IDS.RAW && !session.audioSocket && socket.buffer.length >= AUDIO_METADATA_LENGTH) {
                         socket.type = 'audio';
                         session.audioSocket = socket;
                         console.log(`[${socket.remoteId} ${socket.scid}] Audio Socket - Codec: RAW (0x${codecId.toString(16)})`);
                         client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.AUDIO_INFO, codecId: CODEC_IDS.RAW }));
                         socket.buffer = socket.buffer.subarray(AUDIO_METADATA_LENGTH);
                         socket.state = 'STREAMING';
                         processedPacket = true;
                     } else if ((codecId === CODEC_IDS.H264 && session.videoSocket) || (codecId === CODEC_IDS.RAW && session.audioSocket)) {
                         console.warn(`[${socket.remoteId} ${socket.scid}] Duplicate metadata received for ${codecId === CODEC_IDS.H264 ? 'video' : 'audio'}. Ignoring extra metadata.`);
                         const lenToRemove = codecId === CODEC_IDS.H264 ? VIDEO_METADATA_LENGTH : AUDIO_METADATA_LENGTH;
                         if (socket.buffer.length >= lenToRemove) {
                            socket.buffer = socket.buffer.subarray(lenToRemove);
                            processedPacket = true;
                            socket.state = 'STREAMING';
                         } else {
                            break;
                         }
                     } 
						else {
							break;
                     }
                 }
                 break;

            case 'STREAMING':
                if (socket.buffer.length >= PACKET_HEADER_LENGTH) {
                    const header = socket.buffer.subarray(0, PACKET_HEADER_LENGTH);
                    const pts_flags = header.readBigUInt64BE(0);
                    const size = header.readUInt32BE(8);

                    if (size > 2 * 1024 * 1024) {
                        console.error(`[${socket.remoteId} ${socket.scid} - ${socket.type}] Unreasonable packet size: ${size}. Closing connection.`);
                        socket.destroy();
                        return;
                    }

                    if (socket.buffer.length >= PACKET_HEADER_LENGTH + size) {
                        const payload = socket.buffer.subarray(PACKET_HEADER_LENGTH, PACKET_HEADER_LENGTH + size);

                        if (payload.length > 0 && client.ws && client.ws.readyState === WebSocket.OPEN) {
                            const typeBuffer = Buffer.alloc(1);
                            if (socket.type === 'video') {
                                typeBuffer.writeUInt8(BINARY_TYPES.VIDEO, 0);
                                const isConfig = Boolean(pts_flags & (1n << 63n));
                                const isKeyFrame = isIdrFrame(payload);

                                if (!session.hasVideoConfig || !session.hasKeyFrame) {
                                    session.videoPacketBuffer.push(payload);
                                    if (isConfig) session.hasVideoConfig = true;
                                    if (isKeyFrame) session.hasKeyFrame = true;
                                    if (session.hasVideoConfig && session.hasKeyFrame) {
                                        console.log(`[${socket.remoteId} ${socket.scid}] Video ready, sending ${session.videoPacketBuffer.length} buffered packets`);
                                        for (const bufferedPayload of session.videoPacketBuffer) {
                                             //console.log(`[Server ${socket.scid}] Sending Buffered H.264 payload: ${bufferedPayload.length} bytes`);
                                             client.ws.send(Buffer.concat([typeBuffer, bufferedPayload]), { binary: true });
                                        }
                                        session.videoPacketBuffer = [];
                                    }
                                } else {
                                    //console.log(`[Server ${socket.scid}] Sending H.264 payload: ${payload.length} bytes`);
                                    client.ws.send(Buffer.concat([typeBuffer, payload]), { binary: true });
                                }
                            } else if (socket.type === 'audio') {
                                //console.log(`[Server ${socket.scid}] Sending RAW Audio payload: ${payload.length} bytes`);
                                typeBuffer.writeUInt8(BINARY_TYPES.AUDIO, 0);
                                client.ws.send(Buffer.concat([typeBuffer, payload]), { binary: true });
                            }
                        }

                        socket.buffer = socket.buffer.subarray(PACKET_HEADER_LENGTH + size);
                        processedPacket = true;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
                break;

            case 'IGNORING':
                console.log(`[${socket.remoteId} ${socket.scid} - ${socket.type}] Ignoring data chunk: ${socket.buffer.length} bytes`);
                socket.buffer = Buffer.alloc(0);
                processedPacket = true;
                break;
        }

        if (!processedPacket) break;
    }
}


function isIdrFrame(payload) {
    if (payload.length < 5) return false;
    const offset = (payload[0] === 0 && payload[1] === 0 && payload[2] === 1) ? 3 :
                   (payload[0] === 0 && payload[1] === 0 && payload[2] === 0 && payload[3] === 1) ? 4 : -1;
    return offset !== -1 && (payload[offset] & 0x1f) === 5;
}

async function gracefulShutdown(wss) {
    console.log('\nReceived signal. Shutting down gracefully...');
    const activeSessions = Array.from(sessions.keys());
    console.log(`Cleaning up ${activeSessions.length} active session(s): ${activeSessions.join(', ')}`);

    for (const [clientId, client] of wsClients) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.STATUS, message: 'Server shutting down' }));
            client.ws.close(1001, 'Server Shutting Down');
        }
    }
    wsClients.clear();

    await Promise.allSettled(activeSessions.map(scid => cleanupSession(scid)));

    wss.close(() => {
        console.log('WebSocket server closed.');
        console.log('Exiting.');
        process.exit(0);
    });

    setTimeout(() => {
        console.error("Graceful shutdown timed out. Forcing exit.");
        process.exit(1);
    }, 5000);
}

async function start() {
    const wss = createWebSocketServer();
    console.log(`WebSocket server listening on port ${WEBSOCKET_PORT}`);

    const app = express();
    app.use(express.static(path.join(__dirname, 'public')));
    app.listen(8000, () => {
        const url = 'http://localhost:8000';
		
        console.log(`HTTP server listening on port 8000`);
        console.log(`Visit http://127.0.0.1:8000 or ${url} in your browser to access the frontend.`);
    });

    process.on('SIGINT', () => gracefulShutdown(wss));
    process.on('SIGTERM', () => gracefulShutdown(wss));
}

start();