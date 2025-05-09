const { nanoid } = require('nanoid');
const mDnsSd = require('node-dns-sd');
const WebSocket = require('ws');
const { log } = require('./logger');
const { LogLevel, WSS_QR_PORT } = require('./constants');
const { checkAdbAvailability, executeCommand } = require('./adbService');

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
let wssQrInstance;

function resetQrSession(initialMessage = 'System Idle.') {
	currentQrSession = {
		serviceName: null, password: null, qrString: null, status: 'idle',
		statusMessage: initialMessage, isProcessing: false, connectedDeviceIp: null, isCancelled: false
	};
	broadcastQrStatus();
}

function broadcastQrStatus() {
	if (wssQrInstance) {
		wssQrInstance.clients.forEach(client => {
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

function findTargetPairingService(discoveredServices, targetInstanceName) {
	for (const service of discoveredServices) {
		if (!service.packet || !service.packet.answers) continue;
		let serviceIpAddress = service.packet.additionals?.find(ans => ans.type === 'A' && ans.rdata)?.rdata || service.packet?.address;
		if (!serviceIpAddress) continue;
		const ptrAnswer = service.packet.answers.find(answer => answer.type === 'PTR' && answer.name.includes('_adb-tls-pairing._tcp.local') && answer.rdata.includes(targetInstanceName));
		if (ptrAnswer) {
			const srvAnswer = (service.packet.answers.find(ans => ans.type === 'SRV' && ans.name === ptrAnswer.rdata) || service.packet.additionals?.find(ans => ans.type === 'SRV' && ans.name === ptrAnswer.rdata));
			const servicePort = srvAnswer?.rdata?.port || 0;
			if (servicePort) return { address: serviceIpAddress, port: servicePort };
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
			if (servicePort) return { address: serviceIpAddress, port: servicePort };
		}
	}
	return null;
}

async function executeQrWorkflow() {
	try {
		if (currentQrSession.isCancelled) {
			log(LogLevel.INFO, '[QR] Workflow cancelled at start.');
			currentQrSession.status = 'cancelled'; currentQrSession.statusMessage = 'QR pairing cancelled.';
			currentQrSession.isProcessing = false; broadcastQrStatus(); return;
		}
		currentQrSession.statusMessage = 'Discovering device for pairing...'; broadcastQrStatus();
		let phonePairingService = null; const discoveryPairingTimeout = 90000; const discoveryRetryDelay = 1500;
		let discoveryStartTime = Date.now();
		log(LogLevel.INFO, `[QR] Starting mDNS discovery for pairing service: _adb-tls-pairing._tcp.local, target: ${currentQrSession.serviceName}`);
		while (Date.now() - discoveryStartTime < discoveryPairingTimeout && !phonePairingService) {
			if (currentQrSession.isCancelled) {
				log(LogLevel.INFO, '[QR] Workflow cancelled during pairing discovery.');
				currentQrSession.status = 'cancelled'; currentQrSession.statusMessage = 'QR pairing cancelled.';
				currentQrSession.isProcessing = false; broadcastQrStatus(); return;
			}
			const allPairingServices = await mDnsSd.discover({ name: '_adb-tls-pairing._tcp.local', timeout: discoveryRetryDelay });
			phonePairingService = findTargetPairingService(allPairingServices, currentQrSession.serviceName);
			if (phonePairingService) { log(LogLevel.INFO, `[QR] Found pairing service: ${phonePairingService.address}:${phonePairingService.port}`); break; }
			log(LogLevel.DEBUG, '[QR] Pairing service not found yet, retrying discovery...');
			await new Promise(resolve => setTimeout(resolve, discoveryRetryDelay));
		}
		if (!phonePairingService) {
			if (currentQrSession.isCancelled) return;
			log(LogLevel.ERROR, '[QR] Failed to discover phone pairing service within timeout.');
			currentQrSession.status = 'error'; currentQrSession.statusMessage = 'Device discovery for pairing timed out.';
			broadcastQrStatus(); currentQrSession.isProcessing = false; return;
		}
		if (currentQrSession.isCancelled) {
			log(LogLevel.INFO, '[QR] Workflow cancelled before pairing command.');
			currentQrSession.status = 'cancelled'; currentQrSession.statusMessage = 'QR pairing cancelled.';
			currentQrSession.isProcessing = false; broadcastQrStatus(); return;
		}
		currentQrSession.statusMessage = `Pairing with ${phonePairingService.address}:${phonePairingService.port}...`; broadcastQrStatus();
		log(LogLevel.INFO, `[QR] Attempting to pair with ${phonePairingService.address}:${phonePairingService.port} using password ${currentQrSession.password}`);
		const pairCommand = `adb pair ${phonePairingService.address}:${phonePairingService.port} ${currentQrSession.password}`;
		let pairStdout;
		try {
			const { stdout } = await executeCommand(pairCommand, 'ADB Pair');
			pairStdout = stdout; log(LogLevel.INFO, `[QR] Pair command stdout: ${pairStdout}`);
		} catch (pairError) {
			if (currentQrSession.isCancelled) return;
			log(LogLevel.ERROR, `[QR] ADB pair command failed: ${pairError.message}. Stderr: ${pairError.stderr}`);
			currentQrSession.status = 'error'; currentQrSession.statusMessage = `Pairing failed. ${pairError.message.includes('timeout') ? 'Timeout.' : 'Error.'}`;
			broadcastQrStatus(); currentQrSession.isProcessing = false; return;
		}
		if (!pairStdout || !pairStdout.toLowerCase().includes('successfully paired')) {
			if (currentQrSession.isCancelled) return;
			log(LogLevel.ERROR, `[QR] Pairing was not successful. Output: ${pairStdout}`);
			currentQrSession.status = 'error'; currentQrSession.statusMessage = 'Pairing failed. Device did not confirm success.';
			broadcastQrStatus(); currentQrSession.isProcessing = false; return;
		}
		log(LogLevel.INFO, '[QR] Successfully paired.');
		if (currentQrSession.isCancelled) {
			log(LogLevel.INFO, '[QR] Workflow cancelled after pairing, before connect discovery.');
			currentQrSession.status = 'cancelled'; currentQrSession.statusMessage = 'QR pairing cancelled.';
			currentQrSession.isProcessing = false; broadcastQrStatus(); return;
		}
		currentQrSession.statusMessage = 'Discovering device for connection...'; broadcastQrStatus();
		let phoneConnectService = null; const discoveryConnectTimeout = 60000; discoveryStartTime = Date.now();
		log(LogLevel.INFO, `[QR] Starting mDNS discovery for connect service: _adb-tls-connect._tcp.local, target IP: ${phonePairingService.address}`);
		while (Date.now() - discoveryStartTime < discoveryConnectTimeout && !phoneConnectService) {
			if (currentQrSession.isCancelled) {
				log(LogLevel.INFO, '[QR] Workflow cancelled during connect discovery.');
				currentQrSession.status = 'cancelled'; currentQrSession.statusMessage = 'QR pairing cancelled.';
				currentQrSession.isProcessing = false; broadcastQrStatus(); return;
			}
			const allConnectServices = await mDnsSd.discover({ name: '_adb-tls-connect._tcp.local', timeout: discoveryRetryDelay });
			phoneConnectService = findTargetConnectService(allConnectServices, phonePairingService.address);
			if (phoneConnectService) { log(LogLevel.INFO, `[QR] Found connect service: ${phoneConnectService.address}:${phoneConnectService.port}`); break; }
			log(LogLevel.DEBUG, '[QR] Connect service not found yet, retrying discovery...');
			await new Promise(resolve => setTimeout(resolve, discoveryRetryDelay));
		}
		if (!phoneConnectService) {
			if (currentQrSession.isCancelled) return;
			log(LogLevel.ERROR, '[QR] Failed to discover phone connect service within timeout.');
			currentQrSession.status = 'error'; currentQrSession.statusMessage = 'Device discovery for connection timed out.';
			broadcastQrStatus(); currentQrSession.isProcessing = false; return;
		}
		if (currentQrSession.isCancelled) {
			log(LogLevel.INFO, '[QR] Workflow cancelled before connect command.');
			currentQrSession.status = 'cancelled'; currentQrSession.statusMessage = 'QR pairing cancelled.';
			currentQrSession.isProcessing = false; broadcastQrStatus(); return;
		}
		currentQrSession.statusMessage = `Connecting to ${phoneConnectService.address}:${phoneConnectService.port}...`; broadcastQrStatus();
		log(LogLevel.INFO, `[QR] Attempting to connect to ${phoneConnectService.address}:${phoneConnectService.port}`);
		const connectCommand = `adb connect ${phoneConnectService.address}:${phoneConnectService.port}`;
		let connectStdout;
		try {
			const { stdout } = await executeCommand(connectCommand, 'ADB Connect');
			connectStdout = stdout; log(LogLevel.INFO, `[QR] Connect command stdout: ${connectStdout}`);
		} catch (connectError) {
			if (currentQrSession.isCancelled) return;
			log(LogLevel.ERROR, `[QR] ADB connect command failed: ${connectError.message}. Stderr: ${connectError.stderr}`);
			currentQrSession.status = 'error'; currentQrSession.statusMessage = `Connection failed. ${connectError.message.includes('timeout') ? 'Timeout.' : 'Error.'}`;
			broadcastQrStatus(); currentQrSession.isProcessing = false; return;
		}
		if (currentQrSession.isCancelled) {
			log(LogLevel.INFO, '[QR] Workflow cancelled after connect attempt.');
			currentQrSession.status = 'cancelled'; currentQrSession.statusMessage = 'QR pairing cancelled.';
			currentQrSession.isProcessing = false; broadcastQrStatus(); return;
		}
		if (connectStdout && (connectStdout.toLowerCase().includes('connected to') || connectStdout.toLowerCase().includes('already connected'))) {
			currentQrSession.status = 'success'; currentQrSession.statusMessage = `Successfully connected to ${phoneConnectService.address}:${phoneConnectService.port}!`;
			currentQrSession.connectedDeviceIp = `${phoneConnectService.address}:${phoneConnectService.port}`;
			log(LogLevel.INFO, `[QR] ${currentQrSession.statusMessage}`);
		} else {
			log(LogLevel.ERROR, `[QR] Connection was not successful. Output: ${connectStdout}`);
			currentQrSession.status = 'error'; currentQrSession.statusMessage = 'Connection failed. Device did not confirm success.';
		}
		broadcastQrStatus(); currentQrSession.isProcessing = false;
	} catch (err) {
		if (currentQrSession.isCancelled) return;
		log(LogLevel.ERROR, `[QR] Unhandled error in QR workflow: ${err.stack || err.message || err}`);
		currentQrSession.status = 'error'; currentQrSession.statusMessage = 'An unexpected error occurred during the QR process.';
		broadcastQrStatus(); currentQrSession.isProcessing = false;
	}
}

function setupQrPairingRoutes(app) {
	app.post('/connect-ip', async (req, res) => {
		const { ipAddress } = req.body;
		if (!ipAddress || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}$/.test(ipAddress)) {
			return res.status(400).json({ success: false, message: 'Invalid IP address format (e.g., 192.168.1.10:5555)' });
		}
		log(LogLevel.INFO, `[ConnectIP] Attempting to connect to ${ipAddress}`);
		try {
			const { stdout, stderr } = await executeCommand(`adb connect ${ipAddress}`, 'ADB Connect IP');
			if (stderr && !stderr.toLowerCase().includes('already connected') && !stderr.toLowerCase().includes('connected to')) {
				log(LogLevel.WARN, `[ConnectIP] ADB connect stderr for ${ipAddress}: ${stderr}`);
			}
			if (stdout.toLowerCase().includes('connected to') || stdout.toLowerCase().includes('already connected') || (stderr && (stderr.toLowerCase().includes('already connected to') || stderr.toLowerCase().includes('connected to')))) {
				log(LogLevel.INFO, `[ConnectIP] Successfully connected or already connected to ${ipAddress}. Output: ${stdout}`);
				res.json({ success: true, message: `Successfully connected to ${ipAddress}` });
			} else {
				log(LogLevel.ERROR, `[ConnectIP] Failed to connect to ${ipAddress}. ADB output: ${stdout} \nStderr: ${stderr}`);
				res.status(500).json({ success: false, message: `Failed to connect. ADB output: ${stdout || stderr || 'No output'}` });
			}
		} catch (error) {
			log(LogLevel.ERROR, `[ConnectIP] Error connecting to ${ipAddress}: ${error.message}`);
			res.status(500).json({ success: false, message: `Error connecting: ${error.message}` });
		}
	});
	app.get('/initiate-qr-session', async (req, res) => {
		if (currentQrSession.isProcessing) {
			log(LogLevel.WARN, '[QR] Initiate QR session requested while already processing.');
			return res.status(400).json({ success: false, message: 'A QR session is already in progress.' });
		}
		try { await checkAdbAvailability(); } catch (adbError) {
			log(LogLevel.ERROR, `[QR] ADB check failed: ${adbError.message}`);
			return res.status(500).json({ success: false, message: adbError.message });
		}
		resetQrSession('Generating QR Code...');
		currentQrSession.isProcessing = true; currentQrSession.status = 'generating'; broadcastQrStatus();
		currentQrSession.serviceName = `WebAppQR-${nanoid(8)}`; currentQrSession.password = nanoid(10);
		currentQrSession.qrString = `WIFI:T:ADB;S:${currentQrSession.serviceName};P:${currentQrSession.password};;`;
		log(LogLevel.INFO, `[QR] Generated QR string for service: ${currentQrSession.serviceName}`);
		currentQrSession.statusMessage = 'Scan QR with your device...'; broadcastQrStatus();
		executeQrWorkflow().catch((err) => {
			if (!currentQrSession.isCancelled) {
				log(LogLevel.ERROR, `[QR] executeQrWorkflow failed: ${err.message || err}`);
				currentQrSession.status = 'error'; currentQrSession.statusMessage = 'Pairing/Connection process failed.';
				currentQrSession.isProcessing = false; broadcastQrStatus();
			}
		});
		res.json({ success: true, qrString: currentQrSession.qrString });
	});
	app.post('/cancel-qr-session', (req, res) => {
		log(LogLevel.INFO, '[QR] Received request to cancel QR session.');
		if (currentQrSession.isProcessing) {
			currentQrSession.isCancelled = true; currentQrSession.status = 'cancelled';
			currentQrSession.statusMessage = 'QR pairing cancelled by user.'; currentQrSession.isProcessing = false;
			broadcastQrStatus(); log(LogLevel.INFO, '[QR] QR session marked as cancelled and processing stopped.');
		} else {
			resetQrSession('System Idle. QR session was not active or already cancelled.');
			log(LogLevel.INFO, '[QR] QR session was not active or already cancelled, reset to idle.');
		}
		res.json({ success: true, message: 'QR session cancellation initiated.' });
	});
}

function createQrWebSocketServer() {
    wssQrInstance = new WebSocket.Server({ port: WSS_QR_PORT });
    wssQrInstance.on('connection', ws => {
        log(LogLevel.INFO, '[QR WebSocket] Client connected to QR status stream.');
        ws.send(JSON.stringify({
            status: currentQrSession.status,
            statusMessage: currentQrSession.statusMessage,
            isProcessing: currentQrSession.isProcessing,
            connectedDeviceIp: currentQrSession.connectedDeviceIp,
        }));
    });
    log(LogLevel.INFO, `[System] QR WebSocket server listening on port ${WSS_QR_PORT}`);
    return wssQrInstance;
}

module.exports = {
    setupQrPairingRoutes,
    createQrWebSocketServer,
    resetQrSession,
};