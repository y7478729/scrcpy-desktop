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
	control: 'false'
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
    ERROR: 'error',
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
        wsClients.set(clientId, { ws, session: null });
        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data);
                if (message.action === 'start') await handleStart(clientId, ws, message);
                else if (message.action === 'disconnect') await handleDisconnect(clientId);
                else ws.send(JSON.stringify({ type: MESSAGE_TYPES.ERROR, message: `Unknown action: ${message.action}` }));
            } catch (err) {
                ws.send(JSON.stringify({ type: MESSAGE_TYPES.ERROR, message: 'Invalid message format' }));
            }
        });
        ws.on('close', () => handleDisconnect(clientId));
        ws.on('error', () => handleDisconnect(clientId));
    });
    return wss;
}

async function handleStart(clientId, ws, message) {
    const client = wsClients.get(clientId);
    if (!client) {
        ws.send(JSON.stringify({ type: MESSAGE_TYPES.ERROR, message: 'Client not found. Please refresh.' }));
        return;
    }
    if (client.session) {
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
        runOptions.video_bit_rate = String(message.bitrate);
        runOptions.audio = String(message.enableAudio || false);
        const scid = (crypto.randomBytes(4).readUInt32BE(0) & 0x7FFFFFFF).toString(16).padStart(8, '0');
        const port = SERVER_PORT_BASE + (sessions.size % 1000);
        await setupScrcpySession(deviceId, scid, port, runOptions, clientId);
        wsClients.get(clientId).session = scid;
        ws.send(JSON.stringify({ type: MESSAGE_TYPES.STATUS, message: 'Streaming started' }));
    } catch (err) {
        ws.send(JSON.stringify({ type: MESSAGE_TYPES.ERROR, message: err.message }));
        const clientData = wsClients.get(clientId);
        if (clientData && clientData.session) {
            await cleanupSession(clientData.session);
            clientData.session = null;
        }
    }
}

async function handleDisconnect(clientId) {
    const client = wsClients.get(clientId);
    if (!client || !client.session) return;
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
        hasDeviceName: false,
        hasVideoConfig: false,
        hasKeyFrame: false
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
        session.processStream = exec(`adb -s ${deviceId} shell "${command}"`);
        session.processStream.on('error', () => cleanupSession(scid));
        session.processStream.on('exit', () => cleanupSession(scid));
        session.tcpServer = createTcpServer(scid, clientId);
        await new Promise((resolve, reject) => {
            session.tcpServer.listen(port, '127.0.0.1', () => resolve());
            session.tcpServer.once('error', reject);
        });
        sessions.set(scid, session);
    } catch (err) {
        await cleanupSession(scid);
        throw err;
    }
}

async function cleanupSession(scid) {
    const session = sessions.get(scid);
    if (!session) return;
    sessions.delete(scid);
    if (session.videoSocket) {
        session.videoSocket.destroy();
        session.videoSocket = null;
    }
    if (session.audioSocket) {
        session.audioSocket.destroy();
        session.audioSocket = null;
    }
    if (session.processStream && session.deviceId && !session.processStream.killed) {
        session.processStream.kill('SIGKILL');
        session.processStream = null;
    } else if (session.deviceId) {
        const killCmd = `ps -ef | grep scid=${scid} | grep -v grep | tr -s ' ' | cut -d ' ' -f2 | xargs -r kill -9`;
        await execPromise(`adb -s ${session.deviceId} shell "${killCmd}"`).catch(() => {});
    }
    if (session.tunnelActive && session.deviceId) {
        try {
            const tunnelString = `localabstract:scrcpy_${scid}`;
            await execPromise(`adb -s ${session.deviceId} reverse --remove ${tunnelString}`);
        } catch (err) {}
        session.tunnelActive = false;
    }
    if (session.tcpServer) {
        await new Promise((resolve) => {
            session.tcpServer.close(() => resolve());
        });
        session.tcpServer = null;
    }
    for (const [cId, clientData] of wsClients) {
        if (clientData.session === scid) {
            clientData.session = null;
            if (clientData.ws.readyState === WebSocket.OPEN) {
                clientData.ws.send(JSON.stringify({ type: MESSAGE_TYPES.STATUS, message: 'Streaming session terminated' }));
            }
        }
    }
}

function createTcpServer(scid, clientId) {
    const server = net.createServer((socket) => {
        socket.remoteId = `${socket.remoteAddress}:${socket.remotePort}`;
        socket.buffer = Buffer.alloc(0);
        socket.state = 'INITIAL';
        socket.scid = scid;
        socket.type = null;
        const currentSession = sessions.get(scid);
        if (!currentSession) {
            socket.destroy();
            return;
        }
        socket.on('data', (data) => processData(socket, data, clientId));
        socket.on('end', () => {
            if (currentSession && socket === currentSession.videoSocket) currentSession.videoSocket = null;
            if (currentSession && socket === currentSession.audioSocket) currentSession.audioSocket = null;
        });
        socket.on('close', () => {
            if (currentSession && socket === currentSession.videoSocket) currentSession.videoSocket = null;
            if (currentSession && socket === currentSession.audioSocket) currentSession.audioSocket = null;
        });
    });
    server.on('error', () => cleanupSession(scid));
    return server;
}

function processData(socket, data, clientId) {
    const client = wsClients.get(clientId);
    const session = sessions.get(socket.scid);

    if (!session || !client || client.session !== socket.scid || !client.ws || client.ws.readyState !== WebSocket.OPEN) {
        socket.buffer = Buffer.alloc(0);
        return;
    }

    // Append data to dynamic buffer with pre-allocation
    if (!socket.dynamicBuffer) {
        socket.dynamicBuffer = {
            buffer: Buffer.alloc(1024 * 1024), // Pre-allocate 1MB
            length: 0,
        };
    }

    const dynBuffer = socket.dynamicBuffer;
    const requiredLength = dynBuffer.length + data.length;

    // Resize buffer if necessary
    if (requiredLength > dynBuffer.buffer.length) {
        const newSize = Math.max(dynBuffer.buffer.length * 2, requiredLength);
        const newBuffer = Buffer.alloc(newSize);
        dynBuffer.buffer.copy(newBuffer, 0, 0, dynBuffer.length);
        dynBuffer.buffer = newBuffer;
    }

    data.copy(dynBuffer.buffer, dynBuffer.length);
    dynBuffer.length += data.length;

    // Process packets asynchronously to avoid blocking
    processPackets(socket, client, session, (done) => {
        if (done && dynBuffer.length > 0) {
            // Compact buffer after processing
            const remaining = dynBuffer.buffer.subarray(0, dynBuffer.length);
            dynBuffer.buffer = Buffer.alloc(Math.max(1024 * 1024, remaining.length));
            remaining.copy(dynBuffer.buffer);
            dynBuffer.length = remaining.length;
        }
    });
}

function processPackets(socket, client, session, callback) {
    const dynBuffer = socket.dynamicBuffer;
    let processedPacket = false;

    function processNext() {
        if (dynBuffer.length === 0) {
            callback(true);
            return;
        }

        switch (socket.state) {
            case 'INITIAL':
                if (!session.hasDeviceName && dynBuffer.length >= DEVICE_NAME_LENGTH) {
                    const deviceName = dynBuffer.buffer.subarray(0, DEVICE_NAME_LENGTH).toString('ascii').split('\0')[0];
                    console.log(`[${socket.remoteId} ${socket.scid}] Device Name: ${deviceName}`);
                    client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.DEVICE_NAME, name: deviceName }));
                    dynBuffer.buffer.copy(dynBuffer.buffer, 0, DEVICE_NAME_LENGTH, dynBuffer.length);
                    dynBuffer.length -= DEVICE_NAME_LENGTH;
                    session.hasDeviceName = true;
                    processedPacket = true;
                    socket.state = 'AWAITING_METADATA';
                } else if (session.hasDeviceName) {
                    socket.state = 'AWAITING_METADATA';
                } else {
                    callback(false);
                    return;
                }
                break;

            case 'AWAITING_METADATA':
                const minMetaLength = Math.min(VIDEO_METADATA_LENGTH, AUDIO_METADATA_LENGTH);
                if (dynBuffer.length >= minMetaLength) {
                    const codecId = dynBuffer.buffer.readUInt32BE(0);

                    if (codecId === CODEC_IDS.H264 && !session.videoSocket && dynBuffer.length >= VIDEO_METADATA_LENGTH) {
                        socket.type = 'video';
                        session.videoSocket = socket;
                        const width = dynBuffer.buffer.readUInt32BE(4);
                        const height = dynBuffer.buffer.readUInt32BE(8);
                        console.log(`[${socket.remoteId} ${socket.scid}] Video Socket - Codec: H264, Resolution: ${width}x${height}`);
                        client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.VIDEO_INFO, codecId: CODEC_IDS.H264, width, height }));
                        dynBuffer.buffer.copy(dynBuffer.buffer, 0, VIDEO_METADATA_LENGTH, dynBuffer.length);
                        dynBuffer.length -= VIDEO_METADATA_LENGTH;
                        socket.state = 'STREAMING';
                        processedPacket = true;
                    } else if (codecId === CODEC_IDS.RAW && !session.audioSocket && dynBuffer.length >= AUDIO_METADATA_LENGTH) {
                        socket.type = 'audio';
                        session.audioSocket = socket;
                        console.log(`[${socket.remoteId} ${socket.scid}] Audio Socket - Codec: RAW (0x${codecId.toString(16)})`);
                        client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.AUDIO_INFO, codecId: CODEC_IDS.RAW }));
                        dynBuffer.buffer.copy(dynBuffer.buffer, 0, AUDIO_METADATA_LENGTH, dynBuffer.length);
                        dynBuffer.length -= AUDIO_METADATA_LENGTH;
                        socket.state = 'STREAMING';
                        processedPacket = true;
                    } else if ((codecId === CODEC_IDS.H264 && session.videoSocket) || (codecId === CODEC_IDS.RAW && session.audioSocket)) {
                        console.warn(`[${socket.remoteId} ${socket.scid}] Duplicate metadata received for ${codecId === CODEC_IDS.H264 ? 'video' : 'audio'}. Ignoring extra metadata.`);
                        const lenToRemove = codecId === CODEC_IDS.H264 ? VIDEO_METADATA_LENGTH : AUDIO_METADATA_LENGTH;
                        if (dynBuffer.length >= lenToRemove) {
                            dynBuffer.buffer.copy(dynBuffer.buffer, 0, lenToRemove, dynBuffer.length);
                            dynBuffer.length -= lenToRemove;
                            processedPacket = true;
                            socket.state = 'STREAMING';
                        } else {
                            callback(false);
                            return;
                        }
                    } else {
                        callback(false);
                        return;
                    }
                } else {
                    callback(false);
                    return;
                }
                break;

            case 'STREAMING':
                if (dynBuffer.length >= PACKET_HEADER_LENGTH) {
                    const header = dynBuffer.buffer.subarray(0, PACKET_HEADER_LENGTH);
                    const pts_flags = header.readBigUInt64BE(0);
                    const size = header.readUInt32BE(8);

                    if (size > 2 * 1024 * 1024 || size === 0) {
                        console.error(`[${socket.remoteId} ${socket.scid} - ${socket.type}] Invalid packet size: ${size}. Resetting buffer.`);
                        dynBuffer.length = 0;
                        callback(true);
                        return;
                    }

                    if (dynBuffer.length >= PACKET_HEADER_LENGTH + size) {
                        const payload = dynBuffer.buffer.subarray(PACKET_HEADER_LENGTH, PACKET_HEADER_LENGTH + size);
                        const typeBuffer = Buffer.alloc(1);

                        if (socket.type === 'video') {
                            typeBuffer.writeUInt8(BINARY_TYPES.VIDEO, 0);
                            const isConfig = Boolean(pts_flags & (1n << 63n));

                            if (isConfig) {
                                console.log(`[${socket.remoteId} ${socket.scid}] Received video config packet (size: ${payload.length})`);
                                client.ws.send(Buffer.concat([typeBuffer, payload]), { binary: true });
                                session.hasVideoConfig = true;
                            } else if (session.hasVideoConfig) {
                                client.ws.send(Buffer.concat([typeBuffer, payload]), { binary: true });
                            } else {
                                console.warn(`[${socket.remoteId} ${socket.scid}] Discarding video frame received before config.`);
                            }
                        } else if (socket.type === 'audio') {
                            typeBuffer.writeUInt8(BINARY_TYPES.AUDIO, 0);
                            client.ws.send(Buffer.concat([typeBuffer, payload]), { binary: true });
                        }

                        dynBuffer.buffer.copy(dynBuffer.buffer, 0, PACKET_HEADER_LENGTH + size, dynBuffer.length);
                        dynBuffer.length -= PACKET_HEADER_LENGTH + size;
                        processedPacket = true;
                    } else {
                        callback(false);
                        return;
                    }
                } else {
                    callback(false);
                    return;
                }
                break;
        }

        if (processedPacket) {
            // Yield to event loop to prevent blocking
            setImmediate(processNext);
        } else {
            callback(false);
        }
    }

    processNext();
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