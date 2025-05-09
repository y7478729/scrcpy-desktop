import { globalState } from './state.js';
import { appendLog, updateStatus } from './loggerService.js';
import { populateDeviceSelect, requestAdbDevices as refreshAdbDevicesSidebar } from './ui/sidebarControls.js';
import { handleStreamingStarted, handleStreamingStopped, handleResolutionChange, handleDeviceName, handleAudioInfo, handleBatteryInfo, handleVolumeInfo, handleWifiStatusResponse, handleNavResponse, handleLauncherAppsList } from './messageHandlers.js';
import { BINARY_TYPES } from './constants.js';
import { handleVideoData } from './services/videoPlaybackService.js';
import { handleAudioData as processAudioData } from './services/audioPlaybackService.js';
import { elements } from './domElements.js';

export function initializeWebSocket() {
	if (globalState.ws && (globalState.ws.readyState === WebSocket.OPEN || globalState.ws.readyState === WebSocket.CONNECTING)) {
		if (globalState.ws.readyState === WebSocket.OPEN) {
            refreshAdbDevicesSidebar();
        }
		return;
	}
	globalState.ws = new WebSocket(`ws://${window.location.hostname}:8080`);
	globalState.ws.binaryType = 'arraybuffer';

	globalState.ws.onopen = () => {
		appendLog('WebSocket connection established.');
        if (elements.refreshButton) elements.refreshButton.disabled = false;
		refreshAdbDevicesSidebar();
	};

	globalState.ws.onmessage = (event) => {
		if (typeof event.data === 'string') {
			const message = JSON.parse(event.data);

            if (message.commandId && globalState.pendingAdbCommands.has(message.commandId)) {
                const cmdPromise = globalState.pendingAdbCommands.get(message.commandId);
                if (message.type === `${cmdPromise.commandType}Response`) {
                    if (message.success) {
                        cmdPromise.resolve(message);
                    } else {
                        cmdPromise.reject(new Error(message.error || `ADB command ${cmdPromise.commandType} failed.`));
                    }
                    globalState.pendingAdbCommands.delete(message.commandId);
                    return;
                }
            }

			if (message.type === 'adbDevicesList') {
                if(elements.refreshButton) elements.refreshButton.disabled = false;
				if (message.success) populateDeviceSelect(message.devices);
				else populateDeviceSelect([]);
				return;
			}

            switch (message.type) {
                case 'deviceName': handleDeviceName(message); break;
                case 'videoInfo':
                    if (typeof window.handleVideoInfo === 'function') window.handleVideoInfo(message);
                    else appendLog(`Placeholder: Received videoInfo: ${JSON.stringify(message)}`);
                    break;
                case 'audioInfo': handleAudioInfo(message); break;
                case 'status':
                    updateStatus(message.message);
                    if (message.message === 'Streaming started') handleStreamingStarted();
                    else if (message.message === 'Streaming stopped') handleStreamingStopped(false);
                    else if (message.message.startsWith('Audio disabled')) {
                        if(elements.enableAudioInput) elements.enableAudioInput.checked = false;
                        updateStatus(message.message);
                    }
                    break;
                case 'error':
                    updateStatus(`Stream Error: ${message.message}`);
                    handleStreamingStopped(false);
                    break;
                case 'resolutionChange': handleResolutionChange(message.width, message.height); break;
                case 'volumeResponse':
                    if (message.success) updateStatus(`Volume set to ${message.requestedValue}%`);
                    else updateStatus(`Volume Error: ${message.error}`);
                    break;
                case 'volumeInfo': handleVolumeInfo(message); break;
                case 'navResponse': handleNavResponse(message); break;
                case 'wifiResponse': handleWifiStatusResponse(message); break;
                case 'wifiStatus': handleWifiStatusResponse(message); break;
                case 'batteryInfo': handleBatteryInfo(message); break;
                case 'launcherAppsList': handleLauncherAppsList(message.apps); break;
                default:
                    if(globalState.isRunning) appendLog(`Unhandled message type: ${message.type}`, true);
                    else updateStatus(`Server message: ${message.message || message.type}`);
                    break;
            }
		} else if (event.data instanceof ArrayBuffer && globalState.isRunning) {
			const dataView = new DataView(event.data);
			if (dataView.byteLength < 1) return;
			const type = dataView.getUint8(0);
			const payload = event.data.slice(1);

			if (type === BINARY_TYPES.VIDEO && globalState.converter) {
                handleVideoData(payload);
			} else if (type === BINARY_TYPES.AUDIO && elements.enableAudioInput.checked) {
                processAudioData(payload);
            }
		}
	};

	globalState.ws.onclose = (event) => {
		appendLog(`WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason || 'N/A'}`);
		if (globalState.isRunning) {
            handleStreamingStopped(false);
        }
		globalState.ws = null;
        if(elements.refreshButton) elements.refreshButton.disabled = true;
        if(elements.startButton) elements.startButton.disabled = true;
		populateDeviceSelect([]);
        globalState.pendingAdbCommands.forEach(cmd => cmd.reject(new Error('WebSocket connection closed.')));
        globalState.pendingAdbCommands.clear();
	};

	globalState.ws.onerror = (error) => {
		appendLog('WebSocket error. Check console.', true);
        if (globalState.isRunning) {
            handleStreamingStopped(false);
        }
		globalState.ws = null;
        if(elements.refreshButton) elements.refreshButton.disabled = true;
        if(elements.startButton) elements.startButton.disabled = true;
		populateDeviceSelect([]);
        globalState.pendingAdbCommands.forEach(cmd => cmd.reject(new Error('WebSocket error.')));
        globalState.pendingAdbCommands.clear();
	};
}

export function sendWebSocketMessage(messageObject) {
    if (globalState.ws && globalState.ws.readyState === WebSocket.OPEN) {
        try {
            globalState.ws.send(JSON.stringify(messageObject));
            return true;
        } catch (e) {
            appendLog(`Error sending WebSocket message: ${e.message}`, true);
            return false;
        }
    } else {
        appendLog('WebSocket not open. Cannot send message.', true);
        return false;
    }
}

export function sendControlMessageToServer(buffer) {
	if (globalState.ws && globalState.ws.readyState === WebSocket.OPEN && globalState.controlEnabledAtStart) {
        try {
		    globalState.ws.send(buffer);
        } catch(e) {
            appendLog(`Error sending control buffer: ${e.message}`, true);
        }
    }
}

export function closeWebSocket() {
    if (globalState.ws) {
        globalState.ws.close();
    }
}