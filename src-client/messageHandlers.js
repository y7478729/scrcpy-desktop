import { globalState, resetStreamRelatedState } from './state.js';
import { elements } from './domElements.js';
import { appendLog, updateStatus } from './loggerService.js';
import { sendWebSocketMessage } from './websocketService.js';
import { setupAudioPlayer as setupAudioDecoder, closeAudio } from './services/audioPlaybackService.js';
import { initializeVideoConverter, stopVideoConverter, updateVideoResolutionInStream, checkForBadState, handleVideoInfo as processVideoInfoInternal } from './services/videoPlaybackService.js';
import { updateDisplayOptionsOnStreamStop, updateDisplayOptionsOnStreamStart } from './ui/sidebarControls.js';
import { renderAppDrawer } from './ui/appDrawer.js';
import { updateSpeakerIconFromVolume, updateSliderBackground, updateWifiIndicatorUI, updateBatteryLevelUI } from './ui/taskbarControls.js';
import { CHECK_STATE_INTERVAL_MS, CODEC_IDS } from './constants.js';


export function handleDeviceName(message) {
    updateStatus(`Streaming from ${message.name}`);
}

export function handleVideoInfo(message) {
    processVideoInfoInternal(message.width, message.height);
}

export function handleAudioInfo(message) {
    if (message.codecId === CODEC_IDS.AAC && message.metadata && elements.enableAudioInput.checked) {
        setupAudioDecoder(message.codecId, message.metadata);
    }
}

export function handleStreamingStarted() {
    if(elements.videoElement) elements.videoElement.classList.toggle('control-enabled', globalState.controlEnabledAtStart);
    if (globalState.checkStateIntervalId) clearInterval(globalState.checkStateIntervalId);
    globalState.checkStateIntervalId = setInterval(checkForBadState, CHECK_STATE_INTERVAL_MS);

    sendWebSocketMessage({ action: 'getBatteryLevel' });
    sendWebSocketMessage({ action: 'getWifiStatus' });
    sendWebSocketMessage({ action: 'getVolume' });
    updateDisplayOptionsOnStreamStart();
}

export function handleStreamingStopped(sendDisconnect = true) {
    const wasRunning = globalState.isRunning;

    if (globalState.checkStateIntervalId) {
		clearInterval(globalState.checkStateIntervalId);
		globalState.checkStateIntervalId = null;
	}
    closeAudio();
    stopVideoConverter();

    if (elements.videoElement) {
        elements.videoElement.classList.remove('visible');
        elements.videoElement.classList.remove('control-enabled');
    }
    if (elements.videoPlaceholder) elements.videoPlaceholder.classList.remove('hidden');
    if (elements.videoBorder) elements.videoBorder.style.display = 'none';
    if (elements.streamArea) elements.streamArea.style.aspectRatio = '9 / 16';

	if (wasRunning || sendDisconnect === false) {
        globalState.isRunning = false;
        updateStatus('Disconnected');
        updateDisplayOptionsOnStreamStop();
    }
    resetStreamRelatedState();
}


export function handleResolutionChange(width, height) {
	if (!globalState.isRunning) return;
    updateVideoResolutionInStream(width, height);
}

export function handleVolumeInfo(message) {
    if (message.success) {
        if (elements.mediaVolumeSlider) {
            elements.mediaVolumeSlider.value = message.volume;
            updateSliderBackground(elements.mediaVolumeSlider);
        }
        updateSpeakerIconFromVolume(message.volume);
        updateStatus(`Volume: ${message.volume}%`);
    } else updateStatus(`Get Volume Error: ${message.error}`);
}

export function handleNavResponse(message) {
    if (message.success) updateStatus(`Nav ${message.key} OK`);
    else updateStatus(`Nav ${message.key} Error: ${message.error}`);
}

export function handleWifiStatusResponse(message) {
    const wifiToggleBtn = elements.wifiToggleBtn;
    if (wifiToggleBtn) wifiToggleBtn.classList.remove('pending');
    if (message.success) {
        globalState.isWifiOn = message.isWifiOn !== undefined ? message.isWifiOn : message.currentState;
        globalState.wifiSsid = message.ssid;
        updateWifiIndicatorUI();
        updateStatus(`Wi-Fi ${globalState.isWifiOn ? 'On' : 'Off'}${globalState.wifiSsid ? ` (${globalState.wifiSsid})` : ''}`);
    } else updateStatus(`Wi-Fi Error: ${message.error}`);
}

export function handleBatteryInfo(message) {
    if (message.success) updateBatteryLevelUI(message.batteryLevel);
    else updateStatus(`Battery Error: ${message.error}`);
}

export function handleLauncherAppsList(apps) {
    if (Array.isArray(apps)) {
        renderAppDrawer(apps);
    }
}

export function handleLaunchAppResponse(message) {
    if (message.success) updateStatus(`App ${message.packageName} launched successfully.`);
    else updateStatus(`App Launch Error: ${message.error}`);
}
