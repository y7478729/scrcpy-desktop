const express = require('express');
const net = require('net');
const path = require('path');
const util = require('util');
const { exec, spawn } = require('child_process');
const adbkit = require('@devicefarmer/adbkit');
const WebSocket = require('ws');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { nanoid } = require('nanoid');
const mDnsSd = require('node-dns-sd');

const SERVER_PORT_BASE = 27183;
const WEBSOCKET_PORT = 8080;
const HTTP_PORT = 8000;
const SERVER_JAR_PATH = path.resolve(__dirname, 'public/vendor/Genymobile/scrcpy-server/scrcpy-server-v3.2');
const SERVER_DEVICE_PATH = '/data/local/tmp/scrcpy-server.jar';
const SCRCPY_VERSION = '3.2';
const WSS_QR_PORT = 3001;

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
	audio_codec: 'aac'
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
	DEVICE_MESSAGE: 'deviceMessage',
};
const BINARY_TYPES = {
	VIDEO: 0,
	AUDIO: 1
};
const CODEC_IDS = {
	H264: 0x68323634,
	AAC: 0x00616163
};

const adb = new adbkit.Client();
const execPromise = util.promisify(exec);
const sessions = new Map();
const wsClients = new Map();
const workers = new Map();
const rotationStates = {};

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
	2: 1,
	5: 4,
	29: 28
};



const CONTROL_MSG_TYPE_SET_SCREEN_POWER_MODE = 10;


let currentQrSession = {
	serviceName: null,
	password: null,
	qrString: null,
	status: 'idle',
	statusMessage: 'System Idle.',
	isProcessing: false,
	connectedDeviceIp: null,
	isCancelled: false
};
let wssQr;

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
	if (!PROFILE_MAP[objectType]) throw new Error(`Unsupported AAC object type: ${objectType}`);
	if (!sampleRate) throw new Error(`Unsupported sample rate index: ${sampleRateIndex}`);
	if (channelConfig < 1 || channelConfig > 7) throw new Error(`Unsupported channel configuration: ${channelConfig}`);
	return {
		profile: PROFILE_MAP[objectType],
		sampleRateIndex,
		sampleRate,
		channelConfig
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
	header[0] = 0xFF;
	header[1] = 0xF9;
	header[2] = (profile << 6) | (sampleRateIndex << 2) | ((channelConfig >> 2) & 0x1);
	header[3] = ((channelConfig & 0x3) << 6) | ((frameLength >> 11) & 0x3);
	header[4] = (frameLength >> 3) & 0xFF;
	header[5] = ((frameLength & 0x7) << 5) | 0x1F;
	header[6] = 0xFC;
	return header;
}

function resetQrSession(initialMessage = 'System Idle.') {
	currentQrSession = {
		serviceName: null,
		password: null,
		qrString: null,
		status: 'idle',
		statusMessage: initialMessage,
		isProcessing: false,
		connectedDeviceIp: null,
		isCancelled: false
	};
	broadcastQrStatus();
}

function broadcastQrStatus() {
	if (wssQr) {
		wssQr.clients.forEach(client => {
			if (client.readyState === WebSocket.OPEN) {
				client.send(JSON.stringify({
					status: currentQrSession.status,
					statusMessage: currentQrSession.statusMessage,
					isProcessing: currentQrSession.isProcessing,
					connectedDeviceIp: currentQrSession.connectedDeviceIp
				}));
			}
		});
	}
}

function checkAdbAvailability() {
	return new Promise((resolve, reject) => {
		exec('adb version', (error) => {
			if (error) {
				log(LogLevel.ERROR, 'ADB not found. Please ensure ADB is installed and in your PATH.');
				return reject(new Error('ADB not found.'));
			}
			resolve();
		});
	});
}

function findTargetPairingService(discoveredServices, targetInstanceName) {
	for (const service of discoveredServices) {
		if (!service.packet || !service.packet.answers) continue;
		let serviceIpAddress = service.packet.additionals?.find(ans => ans.type === 'A' && ans.rdata)?.rdata || service.packet?.address;
		if (!serviceIpAddress) continue;
		const ptrAnswer = service.packet.answers.find(answer => answer.type === 'PTR' && answer.name.includes('_adb-tls-pairing._tcp.local') && answer.rdata.includes(targetInstanceName));
		if (ptrAnswer) {
			const srvAnswer = (service.packet.answers.find(ans => ans.type === 'SRV' && ans.name === ptrAnswer.rdata) || service.packet.additionals?.find(ans => ans.type === 'SRV' && ans.name === ptrAnswer.rdata));
			const servicePort = srvAnswer?.rdata?.port || 0;
			if (servicePort) {
				return {
					address: serviceIpAddress,
					port: servicePort
				};
			}
		}
	}
	return null;
}

function findTargetConnectService(discoveredServices, targetIp) {
	for (const service of discoveredServices) {
		if (!service.packet || !service.packet.answers) continue;
		let serviceIpAddress = service.packet.additionals?.find(ans => ans.type === 'A' && ans.rdata)?.rdata || service.packet?.address;
		if (!serviceIpAddress || serviceIpAddress !== targetIp) continue;
		const ptrAnswer = service.packet.answers.find(answer => answer.type === 'PTR' && answer.name.includes('_adb-tls-connect._tcp.local'));
		if (ptrAnswer) {
			const srvAnswer = (service.packet.answers.find(ans => ans.type === 'SRV' && ans.name === ptrAnswer.rdata) || service.packet.additionals?.find(ans => ans.type === 'SRV' && ans.name === ptrAnswer.rdata));
			const servicePort = srvAnswer?.rdata?.port || 0;
			if (servicePort) {
				return {
					address: serviceIpAddress,
					port: servicePort
				};
			}
		}
	}
	return null;
}

async function executeQrWorkflow() {
	try {
		if (currentQrSession.isCancelled) {
			log(LogLevel.INFO, '[QR] Workflow cancelled at start.');
			currentQrSession.status = 'cancelled';
			currentQrSession.statusMessage = 'QR pairing cancelled.';
			currentQrSession.isProcessing = false;
			broadcastQrStatus();
			return;
		}
		currentQrSession.statusMessage = 'Discovering device for pairing...';
		broadcastQrStatus();
		let phonePairingService = null;
		const discoveryPairingTimeout = 90000;
		const discoveryRetryDelay = 1500;
		let discoveryStartTime = Date.now();
		log(LogLevel.INFO, `[QR] Starting mDNS discovery for pairing service: _adb-tls-pairing._tcp.local, target: ${currentQrSession.serviceName}`);
		while (Date.now() - discoveryStartTime < discoveryPairingTimeout && !phonePairingService) {
			if (currentQrSession.isCancelled) {
				log(LogLevel.INFO, '[QR] Workflow cancelled during pairing discovery.');
				currentQrSession.status = 'cancelled';
				currentQrSession.statusMessage = 'QR pairing cancelled.';
				currentQrSession.isProcessing = false;
				broadcastQrStatus();
				return;
			}
			const allPairingServices = await mDnsSd.discover({
				name: '_adb-tls-pairing._tcp.local',
				timeout: discoveryRetryDelay
			});
			phonePairingService = findTargetPairingService(allPairingServices, currentQrSession.serviceName);
			if (phonePairingService) {
				log(LogLevel.INFO, `[QR] Found pairing service: ${phonePairingService.address}:${phonePairingService.port}`);
				break;
			}
			log(LogLevel.DEBUG, '[QR] Pairing service not found yet, retrying discovery...');
			await new Promise(resolve => setTimeout(resolve, discoveryRetryDelay));
		}
		if (!phonePairingService) {
			if (currentQrSession.isCancelled) return;
			log(LogLevel.ERROR, '[QR] Failed to discover phone pairing service within timeout.');
			currentQrSession.status = 'error';
			currentQrSession.statusMessage = 'Device discovery for pairing timed out.';
			broadcastQrStatus();
			currentQrSession.isProcessing = false;
			return;
		}
		if (currentQrSession.isCancelled) {
			log(LogLevel.INFO, '[QR] Workflow cancelled before pairing command.');
			currentQrSession.status = 'cancelled';
			currentQrSession.statusMessage = 'QR pairing cancelled.';
			currentQrSession.isProcessing = false;
			broadcastQrStatus();
			return;
		}
		currentQrSession.statusMessage = `Pairing with ${phonePairingService.address}:${phonePairingService.port}...`;
		broadcastQrStatus();
		log(LogLevel.INFO, `[QR] Attempting to pair with ${phonePairingService.address}:${phonePairingService.port} using password ${currentQrSession.password}`);
		const pairCommand = `adb pair ${phonePairingService.address}:${phonePairingService.port} ${currentQrSession.password}`;
		let pairStdout;
		try {
			const {
				stdout
			} = await execPromise(pairCommand, {
				timeout: 30000
			});
			pairStdout = stdout;
			log(LogLevel.INFO, `[QR] Pair command stdout: ${pairStdout}`);
		} catch (pairError) {
			if (currentQrSession.isCancelled) return;
			log(LogLevel.ERROR, `[QR] ADB pair command failed: ${pairError.message}. Stderr: ${pairError.stderr}`);
			currentQrSession.status = 'error';
			currentQrSession.statusMessage = `Pairing failed. ${pairError.message.includes('timeout') ? 'Timeout.' : 'Error.'}`;
			broadcastQrStatus();
			currentQrSession.isProcessing = false;
			return;
		}
		if (!pairStdout || !pairStdout.toLowerCase().includes('successfully paired')) {
			if (currentQrSession.isCancelled) return;
			log(LogLevel.ERROR, `[QR] Pairing was not successful. Output: ${pairStdout}`);
			currentQrSession.status = 'error';
			currentQrSession.statusMessage = 'Pairing failed. Device did not confirm success.';
			broadcastQrStatus();
			currentQrSession.isProcessing = false;
			return;
		}
		log(LogLevel.INFO, '[QR] Successfully paired.');
		if (currentQrSession.isCancelled) {
			log(LogLevel.INFO, '[QR] Workflow cancelled after pairing, before connect discovery.');
			currentQrSession.status = 'cancelled';
			currentQrSession.statusMessage = 'QR pairing cancelled.';
			currentQrSession.isProcessing = false;
			broadcastQrStatus();
			return;
		}
		currentQrSession.statusMessage = 'Discovering device for connection...';
		broadcastQrStatus();
		let phoneConnectService = null;
		const discoveryConnectTimeout = 60000;
		discoveryStartTime = Date.now();
		log(LogLevel.INFO, `[QR] Starting mDNS discovery for connect service: _adb-tls-connect._tcp.local, target IP: ${phonePairingService.address}`);
		while (Date.now() - discoveryStartTime < discoveryConnectTimeout && !phoneConnectService) {
			if (currentQrSession.isCancelled) {
				log(LogLevel.INFO, '[QR] Workflow cancelled during connect discovery.');
				currentQrSession.status = 'cancelled';
				currentQrSession.statusMessage = 'QR pairing cancelled.';
				currentQrSession.isProcessing = false;
				broadcastQrStatus();
				return;
			}
			const allConnectServices = await mDnsSd.discover({
				name: '_adb-tls-connect._tcp.local',
				timeout: discoveryRetryDelay
			});
			phoneConnectService = findTargetConnectService(allConnectServices, phonePairingService.address);
			if (phoneConnectService) {
				log(LogLevel.INFO, `[QR] Found connect service: ${phoneConnectService.address}:${phoneConnectService.port}`);
				break;
			}
			log(LogLevel.DEBUG, '[QR] Connect service not found yet, retrying discovery...');
			await new Promise(resolve => setTimeout(resolve, discoveryRetryDelay));
		}
		if (!phoneConnectService) {
			if (currentQrSession.isCancelled) return;
			log(LogLevel.ERROR, '[QR] Failed to discover phone connect service within timeout.');
			currentQrSession.status = 'error';
			currentQrSession.statusMessage = 'Device discovery for connection timed out.';
			broadcastQrStatus();
			currentQrSession.isProcessing = false;
			return;
		}
		if (currentQrSession.isCancelled) {
			log(LogLevel.INFO, '[QR] Workflow cancelled before connect command.');
			currentQrSession.status = 'cancelled';
			currentQrSession.statusMessage = 'QR pairing cancelled.';
			currentQrSession.isProcessing = false;
			broadcastQrStatus();
			return;
		}
		currentQrSession.statusMessage = `Connecting to ${phoneConnectService.address}:${phoneConnectService.port}...`;
		broadcastQrStatus();
		log(LogLevel.INFO, `[QR] Attempting to connect to ${phoneConnectService.address}:${phoneConnectService.port}`);
		const connectCommand = `adb connect ${phoneConnectService.address}:${phoneConnectService.port}`;
		let connectStdout;
		try {
			const {
				stdout
			} = await execPromise(connectCommand, {
				timeout: 15000
			});
			connectStdout = stdout;
			log(LogLevel.INFO, `[QR] Connect command stdout: ${connectStdout}`);
		} catch (connectError) {
			if (currentQrSession.isCancelled) return;
			log(LogLevel.ERROR, `[QR] ADB connect command failed: ${connectError.message}. Stderr: ${connectError.stderr}`);
			currentQrSession.status = 'error';
			currentQrSession.statusMessage = `Connection failed. ${connectError.message.includes('timeout') ? 'Timeout.' : 'Error.'}`;
			broadcastQrStatus();
			currentQrSession.isProcessing = false;
			return;
		}
		if (currentQrSession.isCancelled) {
			log(LogLevel.INFO, '[QR] Workflow cancelled after connect attempt.');
			currentQrSession.status = 'cancelled';
			currentQrSession.statusMessage = 'QR pairing cancelled.';
			currentQrSession.isProcessing = false;
			broadcastQrStatus();
			return;
		}
		if (connectStdout && (connectStdout.toLowerCase().includes('connected to') || connectStdout.toLowerCase().includes('already connected'))) {
			currentQrSession.status = 'success';
			currentQrSession.statusMessage = `Successfully connected to ${phoneConnectService.address}:${phoneConnectService.port}!`;
			currentQrSession.connectedDeviceIp = `${phoneConnectService.address}:${phoneConnectService.port}`;
			log(LogLevel.INFO, `[QR] ${currentQrSession.statusMessage}`);
		} else {
			log(LogLevel.ERROR, `[QR] Connection was not successful. Output: ${connectStdout}`);
			currentQrSession.status = 'error';
			currentQrSession.statusMessage = 'Connection failed. Device did not confirm success.';
		}
		broadcastQrStatus();
		currentQrSession.isProcessing = false;
	} catch (err) {
		if (currentQrSession.isCancelled) return;
		log(LogLevel.ERROR, `[QR] Unhandled error in QR workflow: ${err.stack || err.message || err}`);
		currentQrSession.status = 'error';
		currentQrSession.statusMessage = 'An unexpected error occurred during the QR process.';
		broadcastQrStatus();
		currentQrSession.isProcessing = false;
	}
}

function setupQrPairingRoutes(app) {
	app.post('/connect-ip', async (req, res) => {
		const {
			ipAddress
		} = req.body;
		if (!ipAddress || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}$/.test(ipAddress)) {
			return res.status(400).json({
				success: false,
				message: 'Invalid IP address format (e.g., 192.168.1.10:5555)'
			});
		}
		log(LogLevel.INFO, `[ConnectIP] Attempting to connect to ${ipAddress}`);
		try {
			const {
				stdout,
				stderr
			} = await execPromise(`adb connect ${ipAddress}`);
			if (stderr && !stderr.toLowerCase().includes('already connected') && !stderr.toLowerCase().includes('connected to')) {
				log(LogLevel.WARN, `[ConnectIP] ADB connect stderr for ${ipAddress}: ${stderr}`);
			}
			if (stdout.toLowerCase().includes('connected to') || stdout.toLowerCase().includes('already connected') || (stderr && (stderr.toLowerCase().includes('already connected to') || stderr.toLowerCase().includes('connected to')))) {
				log(LogLevel.INFO, `[ConnectIP] Successfully connected or already connected to ${ipAddress}. Output: ${stdout}`);
				res.json({
					success: true,
					message: `Successfully connected to ${ipAddress}`
				});
			} else {
				log(LogLevel.ERROR, `[ConnectIP] Failed to connect to ${ipAddress}. ADB output: ${stdout} \nStderr: ${stderr}`);
				res.status(500).json({
					success: false,
					message: `Failed to connect. ADB output: ${stdout || stderr || 'No output'}`
				});
			}
		} catch (error) {
			log(LogLevel.ERROR, `[ConnectIP] Error connecting to ${ipAddress}: ${error.message}`);
			res.status(500).json({
				success: false,
				message: `Error connecting: ${error.message}`
			});
		}
	});
	app.get('/initiate-qr-session', async (req, res) => {
		if (currentQrSession.isProcessing) {
			log(LogLevel.WARN, '[QR] Initiate QR session requested while already processing.');
			return res.status(400).json({
				success: false,
				message: 'A QR session is already in progress.'
			});
		}
		try {
			await checkAdbAvailability();
		} catch (adbError) {
			log(LogLevel.ERROR, `[QR] ADB check failed: ${adbError.message}`);
			return res.status(500).json({
				success: false,
				message: adbError.message
			});
		}
		resetQrSession('Generating QR Code...');
		currentQrSession.isProcessing = true;
		currentQrSession.status = 'generating';
		broadcastQrStatus();
		currentQrSession.serviceName = `WebAppQR-${nanoid(8)}`;
		currentQrSession.password = nanoid(10);
		currentQrSession.qrString = `WIFI:T:ADB;S:${currentQrSession.serviceName};P:${currentQrSession.password};;`;
		log(LogLevel.INFO, `[QR] Generated QR string for service: ${currentQrSession.serviceName}`);
		currentQrSession.statusMessage = 'Scan QR with your device...';
		broadcastQrStatus();
		executeQrWorkflow().catch((err) => {
			if (!currentQrSession.isCancelled) {
				log(LogLevel.ERROR, `[QR] executeQrWorkflow failed: ${err.message || err}`);
				currentQrSession.status = 'error';
				currentQrSession.statusMessage = 'Pairing/Connection process failed.';
				currentQrSession.isProcessing = false;
				broadcastQrStatus();
			}
		});
		res.json({
			success: true,
			qrString: currentQrSession.qrString
		});
	});
	app.post('/cancel-qr-session', (req, res) => {
		log(LogLevel.INFO, '[QR] Received request to cancel QR session.');
		if (currentQrSession.isProcessing) {
			currentQrSession.isCancelled = true;
			currentQrSession.status = 'cancelled';
			currentQrSession.statusMessage = 'QR pairing cancelled by user.';
			currentQrSession.isProcessing = false;
			broadcastQrStatus();
			log(LogLevel.INFO, '[QR] QR session marked as cancelled and processing stopped.');
		} else {
			resetQrSession('System Idle. QR session was not active or already cancelled.');
			log(LogLevel.INFO, '[QR] QR session was not active or already cancelled, reset to idle.');
		}
		res.json({
			success: true,
			message: 'QR session cancellation initiated.'
		});
	});
}

async function handleAdbCommand(clientId, ws, message) {
	const {
		commandType,
		deviceId,
		commandId
	} = message;
	if (!deviceId) {
		ws.send(JSON.stringify({
			type: `${commandType}Response`,
			commandId: commandId,
			success: false,
			error: 'Device ID missing'
		}));
		return;
	}

	let result;
	try {
		switch (commandType) {
			case 'getDisplayList': {
				const scidForList = (crypto.randomBytes(4).readUInt32BE(0) & 0x7FFFFFFF).toString(16).padStart(8, '0');
				const listCmd = `CLASSPATH=${SERVER_DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} list_displays=true scid=${scidForList} log_level=info`;
				const device = adb.getDevice(deviceId);
				const transfer = await device.push(SERVER_JAR_PATH, SERVER_DEVICE_PATH);
				await new Promise((resolve, reject) => {
					transfer.on('end', resolve);
					transfer.on('error', reject);
				});
				const shellResult = await executeAdbShellCommand(deviceId, listCmd);
				if (shellResult.success) {
					const displays = [];
					const lines = shellResult.output.split('\n');
					lines.forEach(line => {
						const match = line.match(/--display-id=(\d+)\s*\(([^)]+)\)/);
						if (match) {
							displays.push({
								id: parseInt(match[1], 10),
								resolution: match[2]
							});
						}
					});
					result = {
						success: true,
						data: displays
					};
				} else {
					result = shellResult;
				}
				break;
			}
			case 'setOverlay':
				result = await executeAdbShellCommand(deviceId, `settings put global overlay_display_devices ${message.resolution}/${message.dpi}`);
				break;
			case 'setWmSize':
				result = await executeAdbShellCommand(deviceId, `wm size ${message.resolution}`);
				if (result.success) log(LogLevel.INFO, `WM Size set to: ${message.resolution}`);
				break;
			case 'setWmDensity':
				result = await executeAdbShellCommand(deviceId, `wm density ${message.dpi}`);
				if (result.success) log(LogLevel.INFO, `WM Density set to: ${message.dpi}`);
				break;
			case 'adbRotateScreen': {
				if (!rotationStates[deviceId]) {
					const initialUserRot = await executeAdbShellCommand(deviceId, 'settings get system user_rotation');
					const initialAccelRot = await executeAdbShellCommand(deviceId, 'settings get system accelerometer_rotation');
					rotationStates[deviceId] = {
						user_rotation: initialUserRot.success && !isNaN(parseInt(initialUserRot.output)) ? parseInt(initialUserRot.output) : 0,
						accelerometer_rotation: initialAccelRot.success && !isNaN(parseInt(initialAccelRot.output)) ? parseInt(initialAccelRot.output) : 1
					};
				}
				const currentRotationResult = await executeAdbShellCommand(deviceId, 'settings get system user_rotation');
				const currentRotation = currentRotationResult.success && !isNaN(parseInt(currentRotationResult.output)) ? parseInt(currentRotationResult.output) : 0;
				await executeAdbShellCommand(deviceId, 'settings put system accelerometer_rotation 0');
				const nextRotation = (currentRotation + 1) % 4;
				result = await executeAdbShellCommand(deviceId, `settings put system user_rotation ${nextRotation}`);
				if (result.success) result.message = `Screen rotated to ${nextRotation * 90} degrees.`;
				break;
			}
			case 'cleanupAdb': {
				const mode = message.mode;
				let cleanupMessages = [];
				if (mode === 'native_taskbar') {
					let res = await executeAdbShellCommand(deviceId, 'wm size reset');
					cleanupMessages.push(`WM Size Reset: ${res.success ? 'OK' : res.error}`);
					res = await executeAdbShellCommand(deviceId, 'wm density reset');
					cleanupMessages.push(`WM Density Reset: ${res.success ? 'OK' : res.error}`);
				}
				if (mode === 'overlay') {
					let res = await executeAdbShellCommand(deviceId, 'settings put global overlay_display_devices none');
					cleanupMessages.push(`Overlay Reset: ${res.success ? 'OK' : res.error}`);
				}
				if ((mode === 'native_taskbar') && rotationStates[deviceId]) {
					const originalUser = rotationStates[deviceId].user_rotation !== undefined ? rotationStates[deviceId].user_rotation : 0;
					const originalAccel = rotationStates[deviceId].accelerometer_rotation !== undefined ? rotationStates[deviceId].accelerometer_rotation : 1;
					let res = await executeAdbShellCommand(deviceId, `settings put system user_rotation ${originalUser}`);
					cleanupMessages.push(`User Rotation Restore (${originalUser}): ${res.success ? 'OK' : res.error}`);
					res = await executeAdbShellCommand(deviceId, `settings put system accelerometer_rotation ${originalAccel}`);
					cleanupMessages.push(`Accel Rotation Restore (${originalAccel}): ${res.success ? 'OK' : res.error}`);
					delete rotationStates[deviceId];
				}
				result = {
					success: true,
					message: `Cleanup for ${mode} mode: ${cleanupMessages.join('; ')}`
				};
				break;
			}
			default:
				result = {
					success: false,
					error: `Unknown ADB commandType: ${commandType}`
				};
		}
	} catch (error) {
		result = {
			success: false,
			error: error.message
		};
	}

	ws.send(JSON.stringify({
		type: `${commandType}Response`,
		commandId: commandId,
		...result
	}));
}

async function executeAdbShellCommand(deviceId, command) {
	log(LogLevel.DEBUG, `[ADB Execute] Called for device: ${deviceId}, command: '${command}'`);
	try {
		const device = adb.getDevice(deviceId);
		log(LogLevel.DEBUG, `[ADB Execute] Got device object for ${deviceId}. Attempting to execute: adb shell "${command}"`);
		const stream = await device.shell(command);
		log(LogLevel.DEBUG, `[ADB Execute] Shell command '${command}' initiated for ${deviceId}. Stream object obtained. Waiting for output...`);
		stream.on('data', (dataChunk) => {
			log(LogLevel.DEBUG, `[ADB Execute Stream - ${deviceId} - '${command}'] Data chunk received (length: ${dataChunk.length})`);
		});
		stream.on('end', () => {
			log(LogLevel.DEBUG, `[ADB Execute Stream - ${deviceId} - '${command}'] Stream ended.`);
		});
		stream.on('error', (err) => {
			log(LogLevel.ERROR, `[ADB Execute Stream - ${deviceId} - '${command}'] Stream error: ${err.message}`);
		});
		const output = await streamToString(stream);
		log(LogLevel.INFO, `[ADB Execute] Command '${command}' for ${deviceId} completed. Output length: ${output.length}. Output (first 200 chars): "${output.substring(0,200)}"`);
		return {
			success: true,
			output
		};
	} catch (error) {
		log(LogLevel.ERROR, `[ADB Execute] Error executing command '${command}' for ${deviceId}: ${error.message}`);
		if (error.stack) {
			log(LogLevel.ERROR, `[ADB Execute] Stacktrace: ${error.stack}`);
		}
		return {
			success: false,
			error: error.message
		};
	}
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
							const bufferData = Buffer.isBuffer(data) ? data : Buffer.from(data);
							worker.postMessage({
								type: 'controlData',
								data: bufferData,
								scid: client.session,
								clientId
							});
						}
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
							await handleClientDisconnectCommand(clientId);
							break;
						case 'getAdbDevices':
							await handleGetAdbDevices(clientId, ws);
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
						case 'getBatteryLevel':
							await handleGetBatteryLevelCommand(clientId, ws, message);
							break;
						case 'launchApp':
							await handleLaunchApp(clientId, ws, message);
							break;
						case 'adbCommand':
							await handleAdbCommand(clientId, ws, message);
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
		ws.on('close', async (code, reason) => {
			log(LogLevel.INFO, `[WebSocket] Client WS connection closed: ${clientId} (Code: ${code}, Reason: ${reason?.toString()})`);
			const clientOnClose = wsClients.get(clientId);
			if (clientOnClose) {
				if (clientOnClose.session) {
					const scidToCleanOnClose = clientOnClose.session;
					log(LogLevel.INFO, `[WebSocket] WS closed for ${clientId} which had active session ${scidToCleanOnClose}. Initiating cleanup.`);
					await cleanupSession(scidToCleanOnClose);
				}
				wsClients.delete(clientId);
				log(LogLevel.INFO, `[WebSocket] Client ${clientId} removed from wsClients map due to WS close.`);
			} else {
				log(LogLevel.WARN, `[WebSocket] ws.on('close') for ${clientId}, but client not found in wsClients map (might have been already removed).`);
			}
		});
		ws.on('error', async (error) => {
			log(LogLevel.ERROR, `[WebSocket] Error for client ${clientId}: ${error.message}`);
			const clientOnError = wsClients.get(clientId);
			if (clientOnError) {
				if (clientOnError.session) {
					const scidToCleanOnError = clientOnError.session;
					log(LogLevel.INFO, `[WebSocket] WS error for ${clientId} with active session ${scidToCleanOnError}. Initiating cleanup.`);
					await cleanupSession(scidToCleanOnError);
				}
				if (clientOnError.ws && (clientOnError.ws.readyState === WebSocket.OPEN || clientOnError.ws.readyState === WebSocket.CONNECTING)) {
					log(LogLevel.DEBUG, `[WebSocket] Terminating WS for client ${clientId} due to error.`);
					clientOnError.ws.terminate();
				}
			} else {
				log(LogLevel.WARN, `[WebSocket] ws.on('error') for ${clientId}, but client not found in wsClients map.`);
			}
		});
	});
	log(LogLevel.INFO, `[System] WebSocket server listening on port ${WEBSOCKET_PORT}`);
	return wss;
}

function createQrWebSocketServer() {
	wssQr = new WebSocket.Server({
		port: WSS_QR_PORT
	});
	wssQr.on('connection', ws => {
		log(LogLevel.INFO, '[QR WebSocket] Client connected to QR status stream.');
		ws.send(JSON.stringify({
			status: currentQrSession.status,
			statusMessage: currentQrSession.statusMessage,
			isProcessing: currentQrSession.isProcessing,
			connectedDeviceIp: currentQrSession.connectedDeviceIp,
		}));
	});
	log(LogLevel.INFO, `[System] QR WebSocket server listening on port ${WSS_QR_PORT}`);
}

async function getMediaVolumeInfo(deviceId) {
	const session = Array.from(sessions.values()).find(s => s.deviceId === deviceId);
	if (!session) throw new Error(`No session found for device ${deviceId}`);
	let androidVersion = session.androidVersion;
	if (!androidVersion) {
		try {
			const device = adb.getDevice(deviceId);
			const versionStream = await device.shell('getprop ro.build.version.release');
			const versionOutput = await streamToString(versionStream);
			const versionMatch = versionOutput.trim().match(/^(\d+)/);
			androidVersion = versionMatch ? parseInt(versionMatch[1], 10) : NaN;
			if (isNaN(androidVersion)) throw new Error(`Invalid Android version: ${versionOutput.trim()}`);
			session.androidVersion = androidVersion;
		} catch (error) {
			throw new Error(`Failed to get Android version: ${error.message}`);
		}
	}
	let maxVolume = session.maxVolume,
		currentVolume;
	let command = androidVersion <= 10 ? 'media volume --get' : 'cmd media_session volume --get --stream 3';
	try {
		const device = adb.getDevice(deviceId);
		const volumeStream = await device.shell(command);
		const volumeOutput = await streamToString(volumeStream);
		const match = volumeOutput.match(/volume is (\d+) in range \[(\d+)\.\.(\d+)\]|\[(\d+), (\d+)\]/);
		if (!match) throw new Error(`Unexpected volume output format: ${volumeOutput}`);
		currentVolume = parseInt(match[1] || match[4], 10);
		if (!session.maxVolume) {
			maxVolume = parseInt(match[3] || match[5], 10);
			session.maxVolume = maxVolume;
		}
	} catch (error) {
		throw new Error(`Failed to get volume: ${error.message}`);
	}
	if (isNaN(maxVolume) || isNaN(currentVolume) || maxVolume < 1) throw new Error(`Invalid volume info: max=${maxVolume}, current=${currentVolume}`);
	return {
		maxVolume,
		currentVolume
	};
}
async function setMediaVolume(deviceId, percentage) {
	let maxVolume;
	const session = Array.from(sessions.values()).find(s => s.deviceId === deviceId);
	if (!session) throw new Error(`No session found for device ${deviceId}`);
	if (session.maxVolume) maxVolume = session.maxVolume;
	else try {
		maxVolume = (await getMediaVolumeInfo(deviceId)).maxVolume;
	} catch (error) {
		throw error;
	}
	if (isNaN(maxVolume) || maxVolume < 1) throw new Error(`Invalid max volume info: ${maxVolume}`);
	const targetVolume = Math.round((percentage / 100) * maxVolume);
	const androidVersion = session.androidVersion;
	if (!androidVersion) throw new Error(`Android version not cached for device ${deviceId}`);
	try {
		const command = androidVersion <= 10 ? `media volume --set ${targetVolume}` : `cmd media_session volume --set ${targetVolume} --stream 3`;
		await adb.getDevice(deviceId).shell(command);
	} catch (error) {
		throw error;
	}
}
async function handleGetVolumeCommand(clientId, ws, message) {
	const client = wsClients.get(clientId);
	if (!client || !client.session) {
		ws.send(JSON.stringify({
			type: 'volumeInfo',
			success: false,
			error: 'No active session'
		}));
		return;
	}
	const session = sessions.get(client.session);
	if (!session || !session.deviceId) {
		ws.send(JSON.stringify({
			type: 'volumeInfo',
			success: false,
			error: 'No device found'
		}));
		return;
	}
	try {
		const {
			maxVolume,
			currentVolume
		} = await getMediaVolumeInfo(session.deviceId);
		const volumePercentage = Math.round((currentVolume / maxVolume) * 100);
		ws.send(JSON.stringify({
			type: 'volumeInfo',
			success: true,
			volume: volumePercentage
		}));
	} catch (error) {
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
		ws.send(JSON.stringify({
			type: 'volumeResponse',
			success: false,
			value: message.value,
			error: 'No active session'
		}));
		return;
	}
	const session = sessions.get(client.session);
	if (!session || !session.deviceId) {
		ws.send(JSON.stringify({
			type: 'volumeResponse',
			success: false,
			value: message.value,
			error: 'No device found'
		}));
		return;
	}
	try {
		const value = parseInt(message.value, 10);
		if (isNaN(value) || value < 0 || value > 100) throw new Error(`Invalid volume value: ${message.value}`);
		await setMediaVolume(session.deviceId, value);
		ws.send(JSON.stringify({
			type: 'volumeResponse',
			success: true,
			requestedValue: value
		}));
	} catch (error) {
		ws.send(JSON.stringify({
			type: 'volumeResponse',
			success: false,
			value: message.value,
			error: error.message
		}));
	}
}
const navKeycodes = {
	back: 4,
	home: 3,
	recents: 187
};
async function handleNavAction(clientId, ws, message) {
	const client = wsClients.get(clientId);
	if (!client?.session) {
		ws.send(JSON.stringify({
			type: 'navResponse',
			success: false,
			key: message.key,
			error: 'No active session'
		}));
		return;
	}
	const session = sessions.get(client.session);
	if (!session?.deviceId) {
		ws.send(JSON.stringify({
			type: 'navResponse',
			success: false,
			key: message.key,
			error: 'No device found'
		}));
		return;
	}
	const keycode = navKeycodes[message.key];
	if (!keycode) {
		ws.send(JSON.stringify({
			type: 'navResponse',
			success: false,
			key: message.key,
			error: 'Invalid navigation key'
		}));
		return;
	}
	try {
		await adb.getDevice(session.deviceId).shell(`input keyevent ${keycode}`);
		ws.send(JSON.stringify({
			type: 'navResponse',
			success: true,
			key: message.key
		}));
	} catch (error) {
		ws.send(JSON.stringify({
			type: 'navResponse',
			success: false,
			key: message.key,
			error: error.message
		}));
	}
}
async function handleWifiToggleCommand(clientId, ws, message) {
	const client = wsClients.get(clientId);
	if (!client || !client.session) {
		ws.send(JSON.stringify({
			type: 'wifiResponse',
			success: false,
			error: 'No active session, cannot toggle Wi-Fi'
		}));
		return;
	}
	const session = sessions.get(client.session);
	if (!session || !session.deviceId) {
		ws.send(JSON.stringify({
			type: 'wifiResponse',
			success: false,
			error: 'No device found, cannot toggle Wi-Fi'
		}));
		return;
	}
	const enableWifi = message.enable;
	if (typeof enableWifi !== 'boolean') {
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
		await device.shell(command);
		let isWifiOn = false,
			ssid = null;
		if (enableWifi) {
			const maxAttemptsWifiOn = 10,
				maxAttemptsSsid = 15,
				pollInterval = 500;
			let attempts = 0;
			while (attempts < maxAttemptsWifiOn) {
				const statusOutput = await streamToString(await device.shell('dumpsys wifi | grep "Wi-Fi is"'));
				isWifiOn = statusOutput.includes('Wi-Fi is enabled');
				if (isWifiOn) break;
				attempts++;
				if (attempts < maxAttemptsWifiOn) await new Promise(resolve => setTimeout(resolve, pollInterval));
			}
			if (!isWifiOn) {
				ws.send(JSON.stringify({
					type: 'wifiResponse',
					success: false,
					error: 'Wi-Fi failed to enable within timeout'
				}));
				return;
			}
			attempts = 0;
			while (attempts < maxAttemptsSsid) {
				const ssidOutput = await streamToString(await device.shell(`dumpsys wifi | grep 'Supplicant state: COMPLETED' | tail -n 1 | grep -Eo 'SSID: [^,]+' | sed 's/SSID: //' | sed 's/"//g' | head -n 1`));
				ssid = ssidOutput.trim();
				if (ssid && ssid !== '' && ssid !== '<unknown ssid>') break;
				attempts++;
				if (attempts < maxAttemptsSsid) await new Promise(resolve => setTimeout(resolve, pollInterval));
			}
			if (!ssid || ssid === '' || ssid === '<unknown ssid>') {
				ws.send(JSON.stringify({
					type: 'wifiResponse',
					success: false,
					error: 'Failed to connect to a valid SSID within timeout'
				}));
				return;
			}
		} else {
			await new Promise(resolve => setTimeout(resolve, 250));
			const statusOutput = await streamToString(await device.shell('dumpsys wifi | grep "Wi-Fi is"'));
			isWifiOn = statusOutput.includes('Wi-Fi is enabled');
		}
		ws.send(JSON.stringify({
			type: 'wifiResponse',
			success: true,
			enable: enableWifi,
			currentState: isWifiOn,
			ssid: ssid
		}));
	} catch (error) {
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
		ws.send(JSON.stringify({
			type: 'wifiStatus',
			success: false,
			error: 'No active session, cannot get Wi-Fi status'
		}));
		return;
	}
	const session = sessions.get(client.session);
	if (!session || !session.deviceId) {
		ws.send(JSON.stringify({
			type: 'wifiStatus',
			success: false,
			error: 'No device found, cannot get Wi-Fi status'
		}));
		return;
	}
	try {
		const device = adb.getDevice(session.deviceId);
		const statusOutput = await streamToString(await device.shell('dumpsys wifi | grep "Wi-Fi is"'));
		const isWifiOn = statusOutput.includes('Wi-Fi is enabled');
		let ssid = null;
		if (isWifiOn) {
			const ssidOutput = await streamToString(await device.shell(`dumpsys wifi | grep 'Supplicant state: COMPLETED' | tail -n 1 | grep -Eo 'SSID: [^,]+' | sed 's/SSID: //' | sed 's/"//g' | head -n 1`));
			ssid = ssidOutput.trim();
		}
		ws.send(JSON.stringify({
			type: 'wifiStatus',
			success: true,
			isWifiOn,
			ssid
		}));
	} catch (error) {
		ws.send(JSON.stringify({
			type: 'wifiStatus',
			success: false,
			error: `Failed to get Wi-Fi status: ${error.message}`
		}));
	}
}
async function getBatteryLevel(deviceId) {
	const session = Array.from(sessions.values()).find(s => s.deviceId === deviceId);
	if (!session) throw new Error(`No session found for device ${deviceId}`);
	try {
		const device = adb.getDevice(deviceId);
		const batteryOutput = await streamToString(await device.shell("dumpsys battery | grep 'level:' | cut -d':' -f2 | tr -d ' '"));
		const batteryLevel = parseInt(batteryOutput.trim(), 10);
		if (isNaN(batteryLevel) || batteryLevel < 0 || batteryLevel > 100) throw new Error(`Invalid battery level: ${batteryOutput.trim()}`);
		return batteryLevel;
	} catch (error) {
		throw error;
	}
}
async function handleGetBatteryLevelCommand(clientId, ws, message) {
	const client = wsClients.get(clientId);
	if (!client || !client.session) {
		ws.send(JSON.stringify({
			type: 'batteryInfo',
			success: false,
			error: 'No active session'
		}));
		return;
	}
	const session = sessions.get(client.session);
	if (!session || !session.deviceId) {
		ws.send(JSON.stringify({
			type: 'batteryInfo',
			success: false,
			error: 'No device found'
		}));
		return;
	}
	try {
		const batteryLevel = await getBatteryLevel(session.deviceId);
		ws.send(JSON.stringify({
			type: 'batteryInfo',
			success: true,
			batteryLevel: batteryLevel
		}));
	} catch (error) {
		ws.send(JSON.stringify({
			type: 'batteryInfo',
			success: false,
			error: error.message
		}));
	}
}

function streamToString(stream) {
	return new Promise((resolve, reject) => {
		let output = '';
		stream.on('data', (data) => output += data.toString());
		stream.on('end', () => resolve(output.trim()));
		stream.on('error', (err) => reject(err));
	});
}
async function getLauncherApps(deviceId) {
	try {
		const device = adb.getDevice(deviceId);
		const command = 'cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER';
		const rawOutput = await streamToString(await device.shell(command));
		const apps = [];
		const activityBlocks = rawOutput.split('Activity #').slice(1);
		const genericSuffixes = ['android', 'app', 'mobile', 'client', 'lite', 'pro', 'free', 'plus', 'core', 'base', 'main', 'ui', 'launcher', 'system', 'service'];
		for (const block of activityBlocks) {
			let packageName = 'N/A',
				label = 'Unknown App';
			const packageNameMatch = block.match(/packageName=([^\s]+)/);
			if (packageNameMatch) packageName = packageNameMatch[1];
			const appNonLocalizedLabelMatch = block.match(/ApplicationInfo:\s*[^]*?nonLocalizedLabel=([^\s]+)/is);
			if (appNonLocalizedLabelMatch && appNonLocalizedLabelMatch[1] !== 'null') label = appNonLocalizedLabelMatch[1];
			else {
				const activityNonLocalizedLabelMatch = block.match(/ActivityInfo:\s*[^]*?nonLocalizedLabel=([^\s]+)/is);
				if (activityNonLocalizedLabelMatch && activityNonLocalizedLabelMatch[1] !== 'null') label = activityNonLocalizedLabelMatch[1];
				else if (label === 'Unknown App' && packageName !== 'N/A') {
					let parts = packageName.split('.');
					let derivedLabel = parts[parts.length - 1];
					if (genericSuffixes.includes(derivedLabel.toLowerCase()) && parts.length > 1) derivedLabel = parts[parts.length - 2];
					derivedLabel = derivedLabel.replace(/([A-Z])/g, ' $1').replace(/[-_.]/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
					label = derivedLabel;
				}
			}
			if (packageName !== 'N/A' && label !== 'Unknown App') {
				apps.push({
					packageName,
					label,
					letter: label.charAt(0).toUpperCase()
				});
			}
		}
		apps.sort((a, b) => a.label.localeCompare(b.label));
		return apps;
	} catch (error) {
		throw new Error(`Failed to get launcher apps: ${error.message}`);
	}
}
async function handleLaunchApp(clientId, ws, message) {
	const client = wsClients.get(clientId);
	if (!client?.session) {
		ws.send(JSON.stringify({
			type: 'launchAppResponse',
			success: false,
			packageName: message.packageName,
			error: 'No active session'
		}));
		return;
	}
	const session = sessions.get(client.session);
	if (!session?.deviceId) {
		ws.send(JSON.stringify({
			type: 'launchAppResponse',
			success: false,
			packageName: message.packageName,
			error: 'No device found'
		}));
		return;
	}
	const packageName = message.packageName;
	if (!packageName) {
		ws.send(JSON.stringify({
			type: 'launchAppResponse',
			success: false,
			error: 'Package name missing'
		}));
		return;
	}
	try {
		await adb.getDevice(session.deviceId).shell(`monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
		ws.send(JSON.stringify({
			type: 'launchAppResponse',
			success: true,
			packageName: packageName
		}));
	} catch (error) {
		ws.send(JSON.stringify({
			type: 'launchAppResponse',
			success: false,
			packageName: packageName,
			error: error.message
		}));
	}
}

async function executeCommand(command, description) {
	try {
		const {
			stdout,
			stderr
		} = await execPromise(command);
		if (stderr && !(description.includes('Remove') && stderr.includes('not found'))) log(LogLevel.WARN, `[Exec] Stderr (${description}): ${stderr.trim()}`);
		else if (stderr) log(LogLevel.DEBUG, `[Exec] Stderr (${description}): ${stderr.trim()} (Ignored)`);
		if (stdout) log(LogLevel.DEBUG, `[Exec] Stdout (${description}): ${stdout.trim()}`);
		return {
			success: true,
			stdout,
			stderr
		};
	} catch (error) {
		if (error.stderr) log(LogLevel.ERROR, `[Exec] Stderr: ${error.stderr.trim()}`);
		if (error.stdout) log(LogLevel.ERROR, `[Exec] Stdout: ${error.stdout.trim()}`);
		throw new Error(`Failed to execute: ${description} - ${error.message}`);
	}
}

async function getAdbDevices() {
	try {
		const devices = await adb.listDevices();
		const activeDevices = devices.filter(d => d.type === 'device' || d.type === 'unauthorized' || d.type === 'offline');
		return activeDevices.map(d => ({
			id: d.id,
			type: d.type
		}));
	} catch (error) {
		throw new Error(`Failed to list ADB devices: ${error.message}`);
	}
}
async function handleGetAdbDevices(clientId, ws) {
	try {
		const devices = await getAdbDevices();
		ws.send(JSON.stringify({
			type: 'adbDevicesList',
			success: true,
			devices: devices
		}));
	} catch (error) {
		ws.send(JSON.stringify({
			type: 'adbDevicesList',
			success: false,
			error: error.message
		}));
	}
}
async function handleStart(clientId, ws, message) {
	const client = wsClients.get(clientId);
	if (!client || client.session) {
		ws.send(JSON.stringify({
			type: MESSAGE_TYPES.ERROR,
			message: client ? 'Session already active' : 'Internal error: Client not found.'
		}));
		return;
	}
	const deviceId = message.deviceId;
	if (!deviceId) {
		ws.send(JSON.stringify({
			type: MESSAGE_TYPES.ERROR,
			message: 'No device selected.'
		}));
		return;
	}

	let scid = null;
	try {
		const devices = await getAdbDevices();
		const selectedDevice = devices.find(d => d.id === deviceId && d.type === 'device');
		if (!selectedDevice) {
			const allDevicesFullStatus = await adb.listDevices();
			const status = allDevicesFullStatus.find(d => d.id === deviceId)?.type || 'not found';
			ws.send(JSON.stringify({
				type: MESSAGE_TYPES.ERROR,
				message: `Device "${deviceId}" not found or not ready (status: ${status}). Please refresh and select an active device.`
			}));
			return;
		}

		try {
			const launcherApps = await getLauncherApps(deviceId);
			ws.send(JSON.stringify({
				type: 'launcherAppsList',
				apps: launcherApps
			}));
		} catch (appError) {
			ws.send(JSON.stringify({
				type: 'launcherAppsList',
				apps: [],
				error: `Failed to get apps: ${appError.message}`
			}));
		}

		let androidVersion;
		const device = adb.getDevice(deviceId);
		const versionStream = await device.shell('getprop ro.build.version.release');
		const versionOutput = await streamToString(versionStream);
		const versionMatch = versionOutput.trim().match(/^(\d+)/);
		androidVersion = versionMatch ? parseInt(versionMatch[1], 10) : NaN;
		if (isNaN(androidVersion)) throw new Error(`Invalid Android version: ${versionOutput.trim()}`);

		const runOptions = {
			...BASE_SCRCPY_OPTIONS
		};

		const maxFps = parseInt(message.maxFps);
		if (!isNaN(maxFps) && maxFps > 0) runOptions.max_fps = String(maxFps);

		const bitrate = parseInt(message.bitrate);
		if (!isNaN(bitrate) && bitrate > 0) runOptions.video_bit_rate = String(bitrate);

		const audioEnabled = message.enableAudio || false;
		runOptions.audio = androidVersion < 11 ? 'false' : String(audioEnabled);

		const videoEnabled = !(message.video === false || message.video === 'false');
		runOptions.video = String(videoEnabled);

		const controlEnabled = message.enableControl || false;
		runOptions.control = String(controlEnabled);

		if (message.noPowerOn) runOptions.power_on = 'false';
		if (message.powerOffOnClose) runOptions.power_off_on_close = 'true';

		if (message.displayMode === 'overlay' && message.overlayDisplayId !== undefined) {
			runOptions.display_id = String(message.overlayDisplayId);
		} else if (message.displayMode === 'native_taskbar') {
			runOptions.display_id = '0';
		} else if (message.displayMode === 'dex') {
			runOptions.display_id = '2';
		} else if (message.displayMode === 'virtual' && message.resolution !== "reset" && message.dpi !== "reset") {
			runOptions.new_display = `${message.resolution}/${message.dpi}`;
		}

		if (message.displayMode !== 'native_taskbar' && message.displayMode !== 'dex' && message.rotationLock) {
			runOptions.capture_orientation = String(message.rotationLock);
		}


		scid = (crypto.randomBytes(4).readUInt32BE(0) & 0x7FFFFFFF).toString(16).padStart(8, '0');
		const port = SERVER_PORT_BASE + (sessions.size % 1000);

		await setupScrcpySession(deviceId, scid, port, runOptions, clientId, message.displayMode, message.turnScreenOff || false);
		const session = sessions.get(scid);
		if (session) {
			session.androidVersion = androidVersion;
		}
		client.session = scid;

		if (androidVersion < 11 && audioEnabled) {
			ws.send(JSON.stringify({
				type: MESSAGE_TYPES.STATUS,
				message: 'Audio disabled (Android < 11)'
			}));
		}
	} catch (err) {
		ws.send(JSON.stringify({
			type: MESSAGE_TYPES.ERROR,
			message: `Setup failed: ${err.message}`
		}));
		const clientData = wsClients.get(clientId);
		if (clientData?.session) await cleanupSession(clientData.session);
		else if (scid && sessions.has(scid)) await cleanupSession(scid);
		if (clientData) clientData.session = null;
	}
}

async function checkReverseTunnelExists(deviceId, tunnelString) {
	try {
		const {
			stdout
		} = await executeCommand(`adb -s ${deviceId} reverse --list`, `List reverse tunnels (Device: ${deviceId})`);
		return stdout.includes(tunnelString);
	} catch (error) {
		return false;
	}
}

async function setupScrcpySession(deviceId, scid, port, runOptions, clientId, displayMode, shouldTurnScreenOffOnStartPref) {
	const session = {
		deviceId,
		scid,
		port,
		clientId,
		options: runOptions,
		displayMode,
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
		androidVersion: null,
		currentWidth: 0,
		currentHeight: 0,
		batteryInterval: null,
		shouldTurnScreenOffOnStart: shouldTurnScreenOffOnStartPref,
	};

	if (runOptions.video === 'true') session.expectedSockets.push('video');
	if (runOptions.audio === 'true') session.expectedSockets.push('audio');
	if (runOptions.control === 'true') session.expectedSockets.push('control');

	if (session.expectedSockets.length === 0) throw new Error("No streams (video, audio, control) enabled.");

	sessions.set(scid, session);

	try {
		const device = adb.getDevice(deviceId);

		const transfer = await device.push(SERVER_JAR_PATH, SERVER_DEVICE_PATH);
		await new Promise((resolve, reject) => {
			transfer.on('end', resolve);
			transfer.on('error', reject);
		});
		log(LogLevel.INFO, `[ADB] Pushed server JAR to ${deviceId}`);

		const tunnelString = `localabstract:scrcpy_${scid}`;
		if (await checkReverseTunnelExists(deviceId, tunnelString)) {
			await executeCommand(`adb -s ${deviceId} reverse --remove ${tunnelString}`, `Remove specific tunnel (SCID: ${scid})`);
		}
		await executeCommand(`adb -s ${deviceId} reverse --remove-all`, `Remove all tunnels (SCID: ${scid})`).catch(() => {});
		await executeCommand(`adb -s ${deviceId} reverse ${tunnelString} tcp:${port}`, `Setup reverse tunnel (SCID: ${scid})`);
		session.tunnelActive = true;

		session.tcpServer = createTcpServer(scid);
		await new Promise((resolve, reject) => {
			session.tcpServer.listen(port, '127.0.0.1', resolve);
			session.tcpServer.once('error', reject);
		});
		log(LogLevel.INFO, `[TCP] Server listening on 127.0.0.1:${port} for SCID ${scid}`);

		const args = [SCRCPY_VERSION, `scid=${scid}`];
		for (const [key, value] of Object.entries(runOptions)) {
			if (value !== undefined && value !== null) {
				args.push(`${key}=${value}`);
			}
		}

		const command = `CLASSPATH=${SERVER_DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${args.join(' ')}`;
		log(LogLevel.INFO, `[ADB] Executing server on ${deviceId}: adb shell "${command}"`);

		session.processStream = await device.shell(command);

		session.processStream.on('data', (data) => log(LogLevel.INFO, `[scrcpy-server ${scid} std] ${data.toString().trim()}`));
		session.processStream.on('error', (err) => {
			log(LogLevel.ERROR, `[scrcpy-server ${scid}] Stream error: ${err.message}`);
			cleanupSession(scid);
		});
		session.processStream.on('end', () => {
			log(LogLevel.INFO, `[scrcpy-server ${scid}] Stream ended.`);
		});

	} catch (error) {
		log(LogLevel.ERROR, `[Setup] Error in setupScrcpySession for ${scid}: ${error.message}`);
		await cleanupSession(scid);
		throw error;
	}
}

async function handleClientDisconnectCommand(clientId) {
	const client = wsClients.get(clientId);
	if (!client) {
		log(LogLevel.WARN, `[ClientDisconnectCommand] Client ${clientId} not found.`);
		return;
	}
	if (client.session) {
		const scidToStop = client.session;
		log(LogLevel.INFO, `[ClientDisconnectCommand] Client ${clientId} stopping session ${scidToStop}.`);
		client.session = null;
		if (client.ws?.readyState === WebSocket.OPEN) {
			client.ws.send(JSON.stringify({
				type: MESSAGE_TYPES.STATUS,
				message: 'Streaming stopped'
			}));
		}
		await cleanupSession(scidToStop);
		log(LogLevel.INFO, `[ClientDisconnectCommand] Session ${scidToStop} cleaned up for client ${clientId}. WebSocket remains open.`);
	} else {
		log(LogLevel.INFO, `[ClientDisconnectCommand] Client ${clientId} sent disconnect, but no active session.`);
		if (client.ws?.readyState === WebSocket.OPEN) {
			client.ws.send(JSON.stringify({
				type: MESSAGE_TYPES.STATUS,
				message: 'No active stream to stop.'
			}));
		}
	}
}

async function cleanupSession(scid) {
	const session = sessions.get(scid);
	if (!session) return;
	log(LogLevel.INFO, `[Cleanup] Starting cleanup for session ${scid}`);
	sessions.delete(scid);

	const {
		deviceId,
		tcpServer,
		processStream,
		videoSocket,
		audioSocket,
		controlSocket,
		clientId,
		unidentifiedSockets,
		batteryInterval,
		displayMode
	} = session;

	if (batteryInterval) clearInterval(batteryInterval);
	unidentifiedSockets?.forEach(sock => sock.destroy());
	videoSocket?.destroy();
	audioSocket?.destroy();
	controlSocket?.destroy();

	if (processStream && typeof processStream.end === 'function') {
		try {
			processStream.end();
			log(LogLevel.DEBUG, `[Cleanup] Ended process stream for ${scid}`);
		} catch (e) {
			log(LogLevel.WARN, `[Cleanup] Error ending process stream for ${scid}: ${e.message}`);
		}
	}

	if (tcpServer) {
		await new Promise(resolve => tcpServer.close(resolve));
		log(LogLevel.DEBUG, `[Cleanup] Closed TCP server for ${scid}`);
	}

	const worker = workers.get(scid);
	if (worker) {
		worker.postMessage({
			type: 'stop'
		});
		workers.delete(scid);
		log(LogLevel.DEBUG, `[Cleanup] Stopped and deleted worker for ${scid}`);
	}

	if (session.tunnelActive && deviceId) {
		const tunnelString = `localabstract:scrcpy_${scid}`;
		try {
			const device = adb.getDevice(deviceId);
			if (await checkReverseTunnelExists(deviceId, tunnelString)) {
				await device.reverse.remove(tunnelString);
				log(LogLevel.INFO, `[ADB] Removed reverse tunnel during cleanup: ${tunnelString}`);
			}
		} catch (error) {
			log(LogLevel.WARN, `[ADB] Error removing reverse tunnel during cleanup for ${scid}: ${error.message}`);
		}
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
	log(LogLevel.INFO, `[Cleanup] Completed cleanup for session ${scid}`);
}

function createTcpServer(scid) {
	const server = net.createServer((socket) => {
		const remoteId = `${socket.remoteAddress}:${socket.remotePort}`;
		const session = sessions.get(scid);
		if (!session) {
			log(LogLevel.WARN, `[TCP] Connection for unknown/cleaned session ${scid}, destroying socket.`);
			socket.destroy();
			return;
		}
		if (session.socketsConnected >= session.expectedSockets.length) {
			log(LogLevel.WARN, `[TCP] Extra socket connection for session ${scid}, destroying.`);
			socket.destroy();
			return;
		}
		session.socketsConnected++;
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
		log(LogLevel.DEBUG, `[TCP] Socket connected for ${scid} from ${remoteId}. Total connected: ${session.socketsConnected}/${session.expectedSockets.length}`);
		socket.on('data', (data) => {
			const currentSession = sessions.get(scid);
			if (!currentSession) {
				log(LogLevel.WARN, `[TCP] Data received for missing session ${scid}, destroying socket.`);
				socket.destroy();
				return;
			}
			processData(socket, data);
		});
		socket.on('end', () => {
			log(LogLevel.DEBUG, `[TCP] Socket ended for ${scid} from ${remoteId}`);
			clearSocketReference(scid, socket);
			sessions.get(scid)?.unidentifiedSockets?.delete(remoteId);
		});
		socket.on('close', (hadError) => {
			log(LogLevel.DEBUG, `[TCP] Socket closed for ${scid} from ${remoteId}. Had error: ${hadError}`);
			clearSocketReference(scid, socket);
			sessions.get(scid)?.unidentifiedSockets?.delete(remoteId);
		});
		socket.on('error', (err) => {
			log(LogLevel.ERROR, `[TCP] Socket error for ${scid} from ${remoteId}: ${err.message}`);
			clearSocketReference(scid, socket);
			sessions.get(scid)?.unidentifiedSockets?.delete(remoteId);
			socket.destroy();
		});
		const client = session ? wsClients.get(session.clientId) : null;
		if (client && client.ws?.readyState === WebSocket.OPEN) processSingleSocket(socket, client, session);
		else {
			log(LogLevel.WARN, `[TCP] WebSocket client not ready for session ${scid}, destroying new socket.`);
			socket.destroy();
		}
	});
	server.on('error', (err) => {
		log(LogLevel.ERROR, `[TCP] Server error for ${scid}: ${err.message}`);
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
		log(LogLevel.DEBUG, `[Session ${scid}] Video socket cleared.`);
	} else if (session.audioSocket === socket) {
		session.audioSocket = null;
		clearedType = 'audio';
		log(LogLevel.DEBUG, `[Session ${scid}] Audio socket cleared.`);
	} else if (session.controlSocket === socket) {
		session.controlSocket = null;
		clearedType = 'control';
		log(LogLevel.DEBUG, `[Session ${scid}] Control socket cleared.`);
	}
	const allSocketsClosed = !session.videoSocket && !session.audioSocket && !session.controlSocket;
	const expectedSocketsMet = session.socketsConnected >= session.expectedSockets.length;
	if (expectedSocketsMet && allSocketsClosed) {
		log(LogLevel.INFO, `[Session ${scid}] All expected sockets have closed. Triggering cleanup.`);
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
		try {
			const newBuffer = Buffer.allocUnsafe(newSize);
			dynBuffer.buffer.copy(newBuffer, 0, 0, dynBuffer.length);
			dynBuffer.buffer = newBuffer;
		} catch (e) {
			log(LogLevel.ERROR, `[TCP] Failed to allocate buffer for ${socket.scid}: ${e.message}`);
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
	if (!session || !client || client.ws?.readyState !== WebSocket.OPEN || session.streamingStartedNotified) return;
	const videoReady = !session.expectedSockets.includes('video') || session.videoSocket;
	const audioReady = !session.expectedSockets.includes('audio') || session.audioSocket;
	const controlReady = !session.expectedSockets.includes('control') || session.controlSocket;
	if (videoReady && audioReady && controlReady) {
		client.ws.send(JSON.stringify({
			type: MESSAGE_TYPES.STATUS,
			message: 'Streaming started'
		}));
		session.streamingStartedNotified = true;


		if (session.shouldTurnScreenOffOnStart && session.controlSocket && session.options.control === 'true') {
			log(LogLevel.INFO, `[Session ${session.scid}] Sending initial screen off command as requested.`);
			const powerMode = 0;
			const buffer = Buffer.alloc(2);
			buffer.writeUInt8(CONTROL_MSG_TYPE_SET_SCREEN_POWER_MODE, 0);
			buffer.writeUInt8(powerMode, 1);

			try {
				session.controlSocket.write(buffer);
				log(LogLevel.INFO, `[Session ${session.scid}] Successfully sent initial screen off control message.`);
			} catch (e) {
				log(LogLevel.ERROR, `[Session ${session.scid}] Failed to send initial screen off control message: ${e.message}`);
				if (client.ws?.readyState === WebSocket.OPEN) {
					client.ws.send(JSON.stringify({
						type: MESSAGE_TYPES.ERROR,
						message: `Failed to send initial screen off command: ${e.message}`
					}));
				}
			}
			session.shouldTurnScreenOffOnStart = false;
		}

		session.batteryInterval = setInterval(async () => {
			try {
				const batteryLevel = await getBatteryLevel(session.deviceId);
				client.ws.send(JSON.stringify({
					type: 'batteryInfo',
					success: true,
					batteryLevel: batteryLevel
				}));
			} catch (error) {}
		}, 60000);
		if (session.tunnelActive && session.deviceId) {
			const tunnelString = `localabstract:scrcpy_${session.scid}`;
			try {
				if (await checkReverseTunnelExists(session.deviceId, tunnelString)) {
					await executeCommand(`adb -s ${session.deviceId} reverse --remove ${tunnelString}`, `Remove reverse tunnel after sockets opened (SCID: ${session.scid})`);
				}
				session.tunnelActive = false;
			} catch (error) {}
		}
	}
}

function attemptIdentifyControlByDeduction(session, client) {
	if (!session) return;
	const isControlExpected = session.options.control === 'true';
	if (session.controlSocket || !isControlExpected || session.socketsConnected < session.expectedSockets.length) return;
	const unidentifiedCount = session.unidentifiedSockets?.size || 0;
	const videoIdentified = !session.expectedSockets.includes('video') || session.videoSocket;
	const audioIdentified = !session.expectedSockets.includes('audio') || session.audioSocket;
	if (videoIdentified && audioIdentified && unidentifiedCount === 1) {
		const [remainingSocketId, remainingSocket] = session.unidentifiedSockets.entries().next().value;
		log(LogLevel.INFO, `[Session ${session.scid}] Identifying remaining socket ${remainingSocketId} as control.`);
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
				const currentSession = sessions.get(msg.scid);
				if (currentSession?.controlSocket && !currentSession.controlSocket.destroyed) {
					try {
						currentSession.controlSocket.write(Buffer.from(msg.data, 'base64'));
					} catch (e) {
						const currentClient = wsClients.get(currentSession.clientId);
						if (currentClient?.ws?.readyState === WebSocket.OPEN) currentClient.ws.send(JSON.stringify({
							type: MESSAGE_TYPES.ERROR,
							scid: msg.scid,
							message: `Control error: ${e.message}`
						}));
					}
				}
			} else if (msg.type === 'error') {
				const currentClient = wsClients.get(session.clientId);
				if (currentClient?.ws?.readyState === WebSocket.OPEN) currentClient.ws.send(JSON.stringify({
					type: MESSAGE_TYPES.ERROR,
					message: `Control error: ${msg.error}`
				}));
			}
		});
		worker.on('error', (err) => {
			log(LogLevel.ERROR, `[Worker ${session.scid}] Error: ${err.message}`);
			workers.delete(session.scid);
		});
		worker.on('exit', (code) => {
			log(LogLevel.INFO, `[Worker ${session.scid}] Exited with code ${code}`);
			workers.delete(session.scid);
		});
		checkAndSendStreamingStarted(session, client);
		if (remainingSocket.dynamicBuffer.length > 0) processSingleSocket(remainingSocket, client, session);
	}
}
class BitReader {
	constructor(buffer) {
		this.buffer = buffer;
		this.bytePosition = 0;
		this.bitPosition = 0;
	}
	readBits(n) {
		if (n === 0) return 0;
		if (n > 32) return null;
		let result = 0;
		for (let i = 0; i < n; i++) {
			if (this.bytePosition >= this.buffer.length) return null;
			result <<= 1;
			result |= (this.buffer[this.bytePosition] >> (7 - this.bitPosition)) & 1;
			this.bitPosition++;
			if (this.bitPosition === 8) {
				this.bitPosition = 0;
				this.bytePosition++;
			}
		}
		return result;
	}
	readUE() {
		let leadingZeroBits = 0;
		while (this.readBits(1) === 0) {
			leadingZeroBits++;
			if (leadingZeroBits > 31) return null;
		}
		if (leadingZeroBits === 0) return 0;
		const valueSuffix = this.readBits(leadingZeroBits);
		if (valueSuffix === null) return null;
		return (1 << leadingZeroBits) - 1 + valueSuffix;
	}
	readSE() {
		const codeNum = this.readUE();
		if (codeNum === null) return null;
		return (codeNum % 2 === 0) ? -(codeNum / 2) : (codeNum + 1) / 2;
	}
	readBool() {
		const bit = this.readBits(1);
		if (bit === null) return null;
		return bit === 1;
	}
}

function parseSPS(naluBuffer) {
	if (!naluBuffer || naluBuffer.length < 1) return null;
	let offset = 0;
	if (naluBuffer.length >= 3 && naluBuffer[0] === 0 && naluBuffer[1] === 0) {
		if (naluBuffer[2] === 1) offset = 3;
		else if (naluBuffer.length >= 4 && naluBuffer[2] === 0 && naluBuffer[3] === 1) offset = 4;
	}
	const rbspBuffer = naluBuffer.subarray(offset);
	if (rbspBuffer.length < 1) return null;
	const nal_unit_type = rbspBuffer[0] & 0x1F;
	if (nal_unit_type !== 7) return null;
	const reader = new BitReader(rbspBuffer.subarray(1));
	try {
		const profile_idc = reader.readBits(8);
		reader.readBits(8);
		reader.readBits(8);
		reader.readUE();
		if (profile_idc === null) return null;
		let chroma_format_idc = 1,
			separate_colour_plane_flag = 0;
		if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile_idc)) {
			chroma_format_idc = reader.readUE();
			if (chroma_format_idc === null || chroma_format_idc > 3) return null;
			if (chroma_format_idc === 3) {
				separate_colour_plane_flag = reader.readBool();
				if (separate_colour_plane_flag === null) return null;
			}
			reader.readUE();
			reader.readUE();
			reader.readBool();
			const seq_scaling_matrix_present_flag = reader.readBool();
			if (seq_scaling_matrix_present_flag === null) return null;
			if (seq_scaling_matrix_present_flag) {
				const limit = (chroma_format_idc !== 3) ? 8 : 12;
				for (let i = 0; i < limit; i++) {
					if (reader.readBool()) {
						const sizeOfScalingList = (i < 6) ? 16 : 64;
						let lastScale = 8,
							nextScale = 8;
						for (let j = 0; j < sizeOfScalingList; j++) {
							if (nextScale !== 0) {
								const delta_scale = reader.readSE();
								if (delta_scale === null) return null;
								nextScale = (lastScale + delta_scale + 256) % 256;
							}
							lastScale = (nextScale === 0) ? lastScale : nextScale;
						}
					}
				}
			}
		}
		reader.readUE();
		const pic_order_cnt_type = reader.readUE();
		if (pic_order_cnt_type === null) return null;
		if (pic_order_cnt_type === 0) reader.readUE();
		else if (pic_order_cnt_type === 1) {
			reader.readBool();
			reader.readSE();
			reader.readSE();
			const num_ref_frames_in_pic_order_cnt_cycle = reader.readUE();
			if (num_ref_frames_in_pic_order_cnt_cycle === null) return null;
			for (let i = 0; i < num_ref_frames_in_pic_order_cnt_cycle; i++) reader.readSE();
		}
		reader.readUE();
		reader.readBool();
		const pic_width_in_mbs_minus1 = reader.readUE();
		const pic_height_in_map_units_minus1 = reader.readUE();
		const frame_mbs_only_flag = reader.readBool();
		if (pic_width_in_mbs_minus1 === null || pic_height_in_map_units_minus1 === null || frame_mbs_only_flag === null) return null;
		if (!frame_mbs_only_flag) reader.readBool();
		reader.readBool();
		const frame_cropping_flag = reader.readBool();
		if (frame_cropping_flag === null) return null;
		let frame_crop_left_offset = 0,
			frame_crop_right_offset = 0,
			frame_crop_top_offset = 0,
			frame_crop_bottom_offset = 0;
		if (frame_cropping_flag) {
			frame_crop_left_offset = reader.readUE();
			frame_crop_right_offset = reader.readUE();
			frame_crop_top_offset = reader.readUE();
			frame_crop_bottom_offset = reader.readUE();
			if (frame_crop_left_offset === null || frame_crop_right_offset === null || frame_crop_top_offset === null || frame_crop_bottom_offset === null) return null;
		}
		const pic_width_in_mbs = pic_width_in_mbs_minus1 + 1;
		const pic_height_in_map_units = pic_height_in_map_units_minus1 + 1;
		const frame_height_in_mbs = (2 - (frame_mbs_only_flag ? 1 : 0)) * pic_height_in_map_units;
		let width = pic_width_in_mbs * 16,
			height = frame_height_in_mbs * 16;
		if (frame_cropping_flag) {
			let subWidthC = 1,
				subHeightC = 1;
			if (separate_colour_plane_flag) {} else if (chroma_format_idc === 1) {
				subWidthC = 2;
				subHeightC = 2;
			} else if (chroma_format_idc === 2) {
				subWidthC = 2;
				subHeightC = 1;
			} else if (chroma_format_idc === 3) {}
			const cropUnitX = subWidthC;
			const cropUnitY = subHeightC * (2 - (frame_mbs_only_flag ? 1 : 0));
			width -= (frame_crop_left_offset + frame_crop_right_offset) * cropUnitX;
			height -= (frame_crop_top_offset + frame_crop_bottom_offset) * cropUnitY;
		}
		return {
			width,
			height
		};
	} catch (e) {
		return null;
	}
}

function _handleAwaitingInitialData(socket, dynBuffer, session, client) {
    if (!session.deviceNameReceived) {
        if (dynBuffer.length >= DEVICE_NAME_LENGTH) {
            const deviceName = dynBuffer.buffer.subarray(0, DEVICE_NAME_LENGTH).toString('utf8').split('\0')[0];
            client.ws.send(JSON.stringify({
                type: MESSAGE_TYPES.DEVICE_NAME,
                name: deviceName
            }));
            dynBuffer.buffer.copy(dynBuffer.buffer, 0, DEVICE_NAME_LENGTH, dynBuffer.length);
            dynBuffer.length -= DEVICE_NAME_LENGTH;
            session.deviceNameReceived = true;
            socket.didHandleDeviceName = true;
            socket.state = 'AWAITING_METADATA';
            attemptIdentifyControlByDeduction(session, client);
            return true;
        }
    } else {
        socket.state = 'AWAITING_METADATA';
        return true;
    }
    return false;
}

function _handleAwaitingMetadata(socket, dynBuffer, session, client) {
    let identifiedThisPass = false;

    if (!session.videoSocket && session.expectedSockets.includes('video')) {
        if (dynBuffer.length >= VIDEO_METADATA_LENGTH) {
            const potentialCodecId = dynBuffer.buffer.readUInt32BE(0);
            if (potentialCodecId === CODEC_IDS.H264) {
                const width = dynBuffer.buffer.readUInt32BE(4);
                const height = dynBuffer.buffer.readUInt32BE(8);
                log(LogLevel.INFO, `[Session ${session.scid}] Identified Video socket (${width}x${height})`);
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
            }
        }
    }

    if (!identifiedThisPass && !session.audioSocket && session.expectedSockets.includes('audio')) {
        if (dynBuffer.length >= AUDIO_METADATA_LENGTH) {
            const potentialCodecId = dynBuffer.buffer.readUInt32BE(0);
            if (potentialCodecId === CODEC_IDS.AAC) {
                log(LogLevel.INFO, `[Session ${session.scid}] Identified Audio socket`);
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
            }
        }
    }

    if (!identifiedThisPass && !session.controlSocket && session.expectedSockets.length === 1 && session.expectedSockets[0] === 'control' && socket.didHandleDeviceName) {
        log(LogLevel.INFO, `[Session ${session.scid}] Identified Control socket (only expected stream)`);
        session.controlSocket = socket;
        socket.type = 'control';
        identifiedThisPass = true;
        session.unidentifiedSockets?.delete(socket.remoteId);
        socket.state = 'STREAMING';
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
                const currentSession = sessions.get(msg.scid);
                if (currentSession?.controlSocket && !currentSession.controlSocket.destroyed) {
                    try {
                        currentSession.controlSocket.write(Buffer.from(msg.data.data ? msg.data.data : msg.data)); // Handle potential {type: 'Buffer', data: [...]}
                    } catch (e) {
                        const currentClient = wsClients.get(currentSession.clientId);
                        if (currentClient?.ws?.readyState === WebSocket.OPEN) currentClient.ws.send(JSON.stringify({
                            type: MESSAGE_TYPES.ERROR,
                            scid: msg.scid,
                            message: `Control error: ${e.message}`
                        }));
                    }
                }
            } else if (msg.type === 'error') {
                const currentClient = wsClients.get(session.clientId);
                if (currentClient?.ws?.readyState === WebSocket.OPEN) currentClient.ws.send(JSON.stringify({
                    type: MESSAGE_TYPES.ERROR,
                    message: `Control error: ${msg.error}`
                }));
            }
        });
        worker.on('error', (err) => {
            log(LogLevel.ERROR, `[Worker ${session.scid}] Error: ${err.message}`);
            workers.delete(session.scid);
        });
        worker.on('exit', (code) => {
            log(LogLevel.INFO, `[Worker ${session.scid}] Exited with code ${code}`);
            workers.delete(session.scid);
        });
        checkAndSendStreamingStarted(session, client);
    }

    if (identifiedThisPass) {
        attemptIdentifyControlByDeduction(session, client);
        return true; 
    } else {
        attemptIdentifyControlByDeduction(session, client);
        if (!session.controlSocket && session.expectedSockets.includes('control') && session.unidentifiedSockets?.has(socket.remoteId)) {
             return false;
        }
        return dynBuffer.length > 0;
    }
}

function _processVideoStreamPacket(socket, dynBuffer, session, client) {
    if (dynBuffer.length >= PACKET_HEADER_LENGTH) {
        const configFlag = (dynBuffer.buffer.readUInt8(0) >> 7) & 0x1;
        const keyFrameFlag = (dynBuffer.buffer.readUInt8(0) >> 6) & 0x1;
        const pts = dynBuffer.buffer.readBigInt64BE(0) & BigInt('0x3FFFFFFFFFFFFFFF');
        const packetSize = dynBuffer.buffer.readUInt32BE(8);

        if (packetSize > 10 * 1024 * 1024 || packetSize < 0) {
            log(LogLevel.ERROR, `[TCP Video ${socket.scid}] Invalid packet size: ${packetSize}`);
            socket.state = 'UNKNOWN';
            socket.destroy();
            return false;
        }

        const totalPacketLength = PACKET_HEADER_LENGTH + packetSize;
        if (dynBuffer.length >= totalPacketLength) {
            const payload = dynBuffer.buffer.subarray(PACKET_HEADER_LENGTH, totalPacketLength);
            if (configFlag) {
                const resolutionInfo = parseSPS(payload);
                if (resolutionInfo) {
                    const newWidth = resolutionInfo.width,
                        newHeight = resolutionInfo.height;
                    if (session.currentWidth !== newWidth || session.currentHeight !== newHeight) {
                        session.currentWidth = newWidth;
                        session.currentHeight = newHeight;
                        if (client && client.ws?.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({
                            type: 'resolutionChange',
                            width: newWidth,
                            height: newHeight
                        }));
                    }
                }
            }
            const typeBuffer = Buffer.alloc(1);
            typeBuffer.writeUInt8(BINARY_TYPES.VIDEO, 0);
            client.ws.send(Buffer.concat([typeBuffer, payload]), {
                binary: true
            });
            dynBuffer.buffer.copy(dynBuffer.buffer, 0, totalPacketLength, dynBuffer.length);
            dynBuffer.length -= totalPacketLength;
            return true;
        }
    }
    return false;
}

function _processAudioStreamPacket(socket, dynBuffer, session, client) {
    if (dynBuffer.length >= PACKET_HEADER_LENGTH) {
        const configFlag = (dynBuffer.buffer.readUInt8(0) >> 7) & 0x1;
        const pts = dynBuffer.buffer.readBigInt64BE(0) & BigInt('0x3FFFFFFFFFFFFFFF');
        const packetSize = dynBuffer.buffer.readUInt32BE(8);

        if (packetSize > 10 * 1024 * 1024 || packetSize < 0) {
            log(LogLevel.ERROR, `[TCP Audio ${socket.scid}] Invalid packet size: ${packetSize}`);
            socket.state = 'UNKNOWN';
            socket.destroy();
            return false;
        }
        const totalPacketLength = PACKET_HEADER_LENGTH + packetSize;
        if (dynBuffer.length >= totalPacketLength) {
            const payload = dynBuffer.buffer.subarray(PACKET_HEADER_LENGTH, totalPacketLength);
            if (configFlag && !session.audioMetadata) {
                try {
                    session.audioMetadata = parseAudioSpecificConfig(payload);
                    client.ws.send(JSON.stringify({
                        type: MESSAGE_TYPES.AUDIO_INFO,
                        codecId: CODEC_IDS.AAC,
                        metadata: session.audioMetadata
                    }));
                } catch (e) {
                    log(LogLevel.ERROR, `[TCP Audio ${socket.scid}] Failed to parse audio config: ${e.message}`);
                    socket.destroy();
                    return false;
                }
            }
            if (!configFlag && session.audioMetadata) {
                const adtsHeader = createAdtsHeader(payload.length, session.audioMetadata);
                const adtsFrame = Buffer.concat([adtsHeader, payload]);
                const typeBuffer = Buffer.alloc(1);
                typeBuffer.writeUInt8(BINARY_TYPES.AUDIO, 0);
                client.ws.send(Buffer.concat([typeBuffer, adtsFrame]), {
                    binary: true
                });
            }
            dynBuffer.buffer.copy(dynBuffer.buffer, 0, totalPacketLength, dynBuffer.length);
            dynBuffer.length -= totalPacketLength;
            return true;
        }
    }
    return false;
}

function _processControlStreamMessage(socket, dynBuffer, session, client) {
    if (dynBuffer.length > 0) {
        client.ws.send(JSON.stringify({
            type: MESSAGE_TYPES.DEVICE_MESSAGE,
            data: dynBuffer.buffer.subarray(0, dynBuffer.length).toString('base64')
        }));
        dynBuffer.length = 0;
    }
    return false;
}

function _handleStreamingData(socket, dynBuffer, session, client) {
    if (!socket.type || socket.type === 'unknown') {
        socket.state = 'AWAITING_METADATA';
        return true;
    }

    let processedPacket = false;
    if (socket.type === 'video') {
        processedPacket = _processVideoStreamPacket(socket, dynBuffer, session, client);
    } else if (socket.type === 'audio') {
        processedPacket = _processAudioStreamPacket(socket, dynBuffer, session, client);
    } else if (socket.type === 'control') {
        processedPacket = _processControlStreamMessage(socket, dynBuffer, session, client);
    }
    return processedPacket;
}

function processSingleSocket(socket, client, session) {
    const dynBuffer = socket.dynamicBuffer;
    if (!socket.codecProcessed) socket.codecProcessed = false;

    let keepProcessing = true;
    while (keepProcessing && !socket.destroyed && socket.state !== 'UNKNOWN') {
        keepProcessing = false;

        switch (socket.state) {
            case 'AWAITING_INITIAL_DATA':
                if (_handleAwaitingInitialData(socket, dynBuffer, session, client)) {
                    keepProcessing = true;
                }
                break;
            case 'AWAITING_METADATA':
                if (_handleAwaitingMetadata(socket, dynBuffer, session, client)) {
                    keepProcessing = true;
                }
                break;
            case 'STREAMING':
                if (_handleStreamingData(socket, dynBuffer, session, client)) {
                    keepProcessing = true;
                }
                break;
            default:
                socket.state = 'UNKNOWN';
                log(LogLevel.ERROR, `[TCP] Socket ${socket.scid} from ${socket.remoteId} entered invalid state: ${socket.state}. Original was: ${socket.state}`);
                break;
        }
    }
}

async function gracefulShutdown(mainWss, httpServer, qrWssInstance) {
	log(LogLevel.INFO, '[System] Initiating graceful shutdown...');
	if (qrWssInstance) {
		log(LogLevel.INFO, '[System] Closing QR WebSocket server...');
		const closeQrWss = new Promise(resolve => qrWssInstance.close(resolve));
		await closeQrWss;
		log(LogLevel.INFO, '[System] QR WebSocket server closed.');
	}
	const activeSessions = Array.from(sessions.keys());
	for (const [clientId, client] of wsClients) {
		if (client.ws?.readyState === WebSocket.OPEN || client.ws?.readyState === WebSocket.CONNECTING) {
			client.ws.close(1001, 'Server Shutting Down');
		}
	}
	wsClients.clear();
	await Promise.allSettled(activeSessions.map(scid => cleanupSession(scid)));
	const closeMainWss = new Promise(resolve => mainWss.close(resolve));
	const closeHttp = new Promise(resolve => httpServer ? httpServer.close(resolve) : resolve());
	await Promise.all([closeMainWss, closeHttp]);
	log(LogLevel.INFO, '[System] All services closed. Exiting.');
	process.exit(0);
	setTimeout(() => {
		log(LogLevel.WARN, '[System] Force exiting after timeout.');
		process.exit(1);
	}, 5000);
}
async function start() {
	let httpServer, mainWss;
	try {
		await checkAdbAvailability();
		resetQrSession();
		mainWss = createWebSocketServer();
		createQrWebSocketServer();
		const app = express();
		app.use(express.json());
		app.use(express.static(path.join(__dirname, 'public')));
		setupQrPairingRoutes(app);
		httpServer = app.listen(HTTP_PORT, () => {
			log(LogLevel.INFO, `[System] HTTP server listening on port ${HTTP_PORT}`);
			log(LogLevel.INFO, `[System] Access UI at http://localhost:${HTTP_PORT}`);
		});
		httpServer.on('error', (err) => {
			log(LogLevel.ERROR, `[System] HTTP server error: ${err.message}`);
			process.exit(1);
		});
		process.on('SIGINT', () => gracefulShutdown(mainWss, httpServer, wssQr));
		process.on('SIGTERM', () => gracefulShutdown(mainWss, httpServer, wssQr));
		process.on('uncaughtException', (err, origin) => {
			log(LogLevel.ERROR, `[System] Uncaught Exception: ${err.message} at ${origin}. Stack: ${err.stack}`);
			process.exit(1);
		});
		process.on('unhandledRejection', (reason, promise) => {
			log(LogLevel.ERROR, `[System] Unhandled Rejection at: ${promise}, reason: ${reason instanceof Error ? reason.stack : reason}`);
			process.exit(1);
		});
	} catch (error) {
		log(LogLevel.ERROR, `[System] Startup error: ${error.message}`);
		process.exit(1);
	}
}
start();