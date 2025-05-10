import { elements } from '../domElements.js';
import { globalState } from '../state.js';
import { appendLog } from '../loggerService.js';
import { requestAdbDevices } from '../ui/sidebarControls.js';
import { hideAddWirelessDeviceModal, hideQrPairingModal } from '../ui/modals.js';
import QRCode from 'qrcode';

export async function handleConnectByIp() {
	const ipAddress = elements.ipAddressInput.value.trim();
	if (!ipAddress) {
		elements.ipConnectStatus.textContent = 'Please enter an IP address and port.';
		elements.ipConnectStatus.className = 'modal-status error';
		return;
	}
	if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}$/.test(ipAddress)) {
		elements.ipConnectStatus.textContent = 'Invalid format. Use IP:PORT (e.g., 192.168.1.8:5555).';
		elements.ipConnectStatus.className = 'modal-status error';
		return;
	}
	elements.ipConnectStatus.textContent = 'Connecting...';
	elements.ipConnectStatus.className = 'modal-status';
	elements.connectByIpBtn.disabled = true;
	try {
		const response = await fetch('/connect-ip', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ipAddress })
		});
		const data = await response.json();
		if (response.ok && data.success) {
			elements.ipConnectStatus.textContent = data.message || 'Successfully connected!';
			elements.ipConnectStatus.className = 'modal-status success';
			requestAdbDevices();
			setTimeout(hideAddWirelessDeviceModal, 1500);
		} else {
			elements.ipConnectStatus.textContent = data.message || 'Failed to connect.';
			elements.ipConnectStatus.className = 'modal-status error';
		}
	} catch (error) {
		elements.ipConnectStatus.textContent = 'Connection error: ' + error.message;
		elements.ipConnectStatus.className = 'modal-status error';
	} finally {
		elements.connectByIpBtn.disabled = false;
	}
}

export async function handlePairByQr(connectToQrWebSocket) {
	hideAddWirelessDeviceModal();
    elements.qrCodeDisplay.innerHTML = '';

	globalState.qrCodeInstance = null; 

	elements.qrPairingMessage.textContent = 'Initializing...';
	elements.qrPairingSpinner.style.display = 'inline-block';
	elements.qrPairingStatus.className = 'modal-status';
	elements.qrPairingDoneBtn.style.display = 'none';
	elements.qrPairingModalOverlay.style.display = 'flex';
	globalState.isQrProcessActive = true;

	try {
		const response = await fetch('/initiate-qr-session');
		if (!response.ok) {
			const errorData = await response.json().catch(() => ({ message: `HTTP error ${response.status}` }));
			throw new Error(errorData.message || `Failed to initiate QR session: ${response.statusText}`);
		}
		const data = await response.json();

		if (data.success && data.qrString) {
			elements.qrPairingMessage.textContent = 'Scan QR with your device...';
			elements.qrPairingSpinner.style.display = 'inline-block';
			
			const canvasElement = document.createElement('canvas');
			elements.qrCodeDisplay.appendChild(canvasElement);

			await QRCode.toCanvas(canvasElement, data.qrString, {
				width: 256,
				margin: 1,
				color: {
					dark: '#000000',
					light: '#ffffff'
				},
				errorCorrectionLevel: 'H'
			});
			
			connectToQrWebSocket();
		} else {
			elements.qrPairingMessage.textContent = data.message || 'Failed to generate QR code.';
			elements.qrPairingSpinner.style.display = 'none';
			elements.qrPairingStatus.className = 'modal-status error';
			elements.qrPairingDoneBtn.style.display = 'block';
			globalState.isQrProcessActive = false;
		}
	} catch (error) {
        appendLog(`Error in handlePairByQr: ${error.message}`, true);
		elements.qrPairingMessage.textContent = 'Error initiating QR session: ' + error.message;
		elements.qrPairingSpinner.style.display = 'none';
		elements.qrPairingStatus.className = 'modal-status error';
		elements.qrPairingDoneBtn.style.display = 'block';
		globalState.isQrProcessActive = false;
	}
}

export async function cancelQrPairingSession() {
    if (globalState.isQrProcessActive) {
		try {
			await fetch('/cancel-qr-session', { method: 'POST' });
			appendLog('QR session cancellation requested.');
		} catch (error) {
			appendLog('Error sending QR session cancellation: ' + error.message, true);
		}
	}
    if (globalState.qrWs && globalState.qrWs.readyState === WebSocket.OPEN) {
		globalState.qrWs.close();
	}
	globalState.qrWs = null;
	globalState.isQrProcessActive = false;
	elements.qrPairingSpinner.style.display = 'none';
	elements.qrPairingDoneBtn.style.display = 'block';
}

export async function sendAdbCommandToServer(commandData) {
    return new Promise((resolve, reject) => {
        if (!globalState.ws || globalState.ws.readyState !== WebSocket.OPEN || !globalState.selectedDeviceId) {
            reject(new Error('WebSocket not connected or no device selected for ADB command.'));
            return;
        }
        const commandId = Date.now() + Math.random().toString(36).substring(2, 7);
        globalState.pendingAdbCommands.set(commandId, { resolve, reject, commandType: commandData.commandType });
        const messageToSend = {
            action: 'adbCommand', commandId: commandId,
            deviceId: globalState.selectedDeviceId, ...commandData
        };
        try {
            globalState.ws.send(JSON.stringify(messageToSend));
        } catch (e) {
            globalState.pendingAdbCommands.delete(commandId);
            reject(new Error(`WebSocket send error for ADB command: ${e.message}`));
            return;
        }
        setTimeout(() => {
            if (globalState.pendingAdbCommands.has(commandId)) {
                const cmd = globalState.pendingAdbCommands.get(commandId);
                cmd.reject(new Error(`ADB command ${cmd.commandType} (ID: ${commandId}) timed out.`));
                globalState.pendingAdbCommands.delete(commandId);
            }
        }, 15000);
    });
}