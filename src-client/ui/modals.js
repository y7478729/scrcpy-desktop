import { elements } from '../domElements.js';
import { globalState } from '../state.js';
import { handleConnectByIp, handlePairByQr as initiatePairByQr, cancelQrPairingSession } from '../services/adbClientService.js';
import { appendLog } from '../loggerService.js';
import { requestAdbDevices } from './sidebarControls.js';


function connectToQrWebSocket() {
	if (globalState.qrWs && globalState.qrWs.readyState === WebSocket.OPEN) return;
	globalState.qrWs = new WebSocket(`ws://${window.location.hostname}:3001`);
	globalState.qrWs.onopen = () => { appendLog('QR WebSocket connection established.'); };
	globalState.qrWs.onmessage = (event) => {
		try {
			const data = JSON.parse(event.data);
			appendLog(`QR Status: ${data.statusMessage}`);
			elements.qrPairingMessage.textContent = data.statusMessage;
			elements.qrPairingSpinner.style.display = data.isProcessing ? 'inline-block' : 'none';
			elements.qrPairingStatus.className = 'modal-status';
			if (data.status === 'success') {
				elements.qrPairingStatus.classList.add('success');
				requestAdbDevices();
				setTimeout(hideQrPairingModal, 3000);
			} else if (data.status === 'error' || data.status === 'cancelled') {
				elements.qrPairingStatus.classList.add(data.status === 'error' ? 'error' : 'info');
			}
			if (!data.isProcessing) {
				elements.qrPairingDoneBtn.style.display = 'block';
				globalState.isQrProcessActive = false;
			}
		} catch (e) {
			appendLog('Error parsing QR WebSocket message: ' + e.message, true);
			elements.qrPairingMessage.textContent = 'Error processing status update.';
			elements.qrPairingSpinner.style.display = 'none';
			elements.qrPairingStatus.className = 'modal-status error';
			elements.qrPairingDoneBtn.style.display = 'block';
			globalState.isQrProcessActive = false;
		}
	};
	globalState.qrWs.onclose = () => {
		appendLog('QR WebSocket connection closed.');
		if (globalState.isQrProcessActive) {
			elements.qrPairingSpinner.style.display = 'none';
			elements.qrPairingDoneBtn.style.display = 'block';
			if (!elements.qrPairingStatus.classList.contains('success') && !elements.qrPairingStatus.classList.contains('error')) {
                 elements.qrPairingMessage.textContent = 'QR Process ended or connection lost.';
            }
			globalState.isQrProcessActive = false;
		}
	};
	globalState.qrWs.onerror = (error) => {
		appendLog('QR WebSocket error: ' + error.message, true);
		elements.qrPairingMessage.textContent = 'QR WebSocket error. Check console.';
		elements.qrPairingSpinner.style.display = 'none';
		elements.qrPairingStatus.className = 'modal-status error';
		elements.qrPairingDoneBtn.style.display = 'block';
		globalState.isQrProcessActive = false;
	};
}


export function showAddWirelessDeviceModal() {
	elements.ipAddressInput.value = '';
	elements.ipConnectStatus.textContent = '';
	elements.ipConnectStatus.className = 'modal-status';
	elements.addWirelessDeviceModalOverlay.style.display = 'flex';
}

export function hideAddWirelessDeviceModal() {
	elements.addWirelessDeviceModalOverlay.style.display = 'none';
}

export function showQrPairingModal() {
	elements.qrCodeDisplay.innerHTML = '';
	if (globalState.qrCodeInstance) globalState.qrCodeInstance.clear();
	elements.qrPairingMessage.textContent = 'Initializing...';
	elements.qrPairingSpinner.style.display = 'inline-block';
	elements.qrPairingStatus.className = 'modal-status';
	elements.qrPairingDoneBtn.style.display = 'none';
	elements.qrPairingModalOverlay.style.display = 'flex';
}

export async function hideQrPairingModal() {
	await cancelQrPairingSession();
	elements.qrPairingModalOverlay.style.display = 'none';
}


export function initModals() {
    elements.addWirelessDeviceBtn.addEventListener('click', showAddWirelessDeviceModal);
	elements.closeAddWirelessModalBtn.addEventListener('click', hideAddWirelessDeviceModal);
	elements.connectByIpBtn.addEventListener('click', handleConnectByIp);
	elements.pairByQrBtn.addEventListener('click', () => initiatePairByQr(connectToQrWebSocket));
	elements.closeQrPairingModalBtn.addEventListener('click', hideQrPairingModal);
	elements.qrPairingDoneBtn.addEventListener('click', hideQrPairingModal);

    elements.addWirelessDeviceModalOverlay.addEventListener('click', (event) => {
		if (event.target === elements.addWirelessDeviceModalOverlay) hideAddWirelessDeviceModal();
	});
	elements.qrPairingModalOverlay.addEventListener('click', (event) => {
		if (event.target === elements.qrPairingModalOverlay) hideQrPairingModal();
	});
}