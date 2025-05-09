import { elements } from '../domElements.js';
import { globalState } from '../state.js';
import { sendWebSocketMessage, initializeWebSocket as initMainWebSocket } from '../websocketService.js';
import { initializeVideoConverter as initVideo, stopVideoConverter as stopVideo } from '../services/videoPlaybackService.js';
import { appendLog, updateStatus } from '../loggerService.js';
import { sendAdbCommandToServer } from '../services/adbClientService.js';
import { handleStreamingStopped } from '../messageHandlers.js';


function getStreamSettings() {
    return {
        maxFps: parseInt(elements.maxFpsSelect.value) || 0,
        bitrate: ((!isNaN(parseInt(elements.customBitrateInput.value.trim())) && parseInt(elements.customBitrateInput.value.trim()) > 0) ?
            parseInt(elements.customBitrateInput.value.trim()) : parseInt(elements.bitrateSelect.value)) * 1000000,
        enableAudio: elements.enableAudioInput.checked,
        enableControl: elements.enableControlInput.checked,
        video: true,
        noPowerOn: elements.noPowerOnInput.checked,
        turnScreenOff: elements.turnScreenOffInput.checked,
        powerOffOnClose: elements.powerOffOnCloseInput.checked,
        displayMode: globalState.currentDisplayMode,
        rotationLock: elements.rotationLockSelect.value,
        resolution: elements.customResolutionInput.value.trim() || elements.resolutionSelect.value,
        dpi: elements.customDpiInput.value.trim() || elements.dpiSelect.value,
    };
}

async function startStreaming() {
	if (!globalState.selectedDeviceId) {
		alert('Please select an ADB device.');
		return;
	}
	if (globalState.isRunning) return;
	if (!globalState.ws || globalState.ws.readyState !== WebSocket.OPEN) {
		appendLog("WebSocket not connected. Cannot start.", true);
		return;
	}

	globalState.isRunning = true;
    globalState.controlEnabledAtStart = elements.enableControlInput.checked;
	updateDisplayOptionsOnStreamStart();

	const streamSettings = getStreamSettings();
    const startMessage = {
        action: 'start',
        deviceId: globalState.selectedDeviceId,
        ...streamSettings
    };

    try {
		if (globalState.currentDisplayMode === 'overlay') {
			if (streamSettings.resolution === "reset" || streamSettings.dpi === "reset") {
				throw new Error("Resolution and DPI must be set for Overlay mode.");
			}
			updateStatus("Overlay Mode: Fetching initial displays...");
			const initialDisplaysResponse = await sendAdbCommandToServer({ commandType: 'getDisplayList' });
			const initialDisplayIds = initialDisplaysResponse.data.map(d => d.id);

			updateStatus(`Overlay Mode: Setting overlay display to ${streamSettings.resolution}/${streamSettings.dpi}...`);
			await sendAdbCommandToServer({ commandType: 'setOverlay', resolution: streamSettings.resolution, dpi: streamSettings.dpi });

			updateStatus("Overlay Mode: Fetching updated displays...");
			await new Promise(resolve => setTimeout(resolve, 2000));
			const updatedDisplaysResponse = await sendAdbCommandToServer({ commandType: 'getDisplayList' });
			const updatedDisplayIds = updatedDisplaysResponse.data.map(d => d.id);

			const newDisplayIds = updatedDisplayIds.filter(id => !initialDisplayIds.includes(id));
			if (newDisplayIds.length === 0) throw new Error("Overlay Mode: Could not find new display ID.");
			startMessage.overlayDisplayId = newDisplayIds[0];
			updateStatus(`Overlay Mode: Using new display ID ${startMessage.overlayDisplayId}`);

		} else if (globalState.currentDisplayMode === 'native_taskbar') {
			updateStatus("Native Taskbar Mode: Setting WM properties...");
            let finalResolution = streamSettings.resolution;
            let finalDpi = streamSettings.dpi;
            let originalWidth = null, originalHeight = null;

            if (finalResolution !== "reset" && finalResolution.includes('x')) {
                [originalWidth, originalHeight] = finalResolution.split('x').map(Number);
                finalResolution = `${originalHeight}x${originalWidth}`;
                appendLog(`Flipped resolution to ${finalResolution} for native_taskbar.`);
            }
             if (originalHeight !== null && finalDpi !== "reset") {
                const currentDpiValue = parseInt(finalDpi, 10);
                if (!isNaN(currentDpiValue)) {
                    const targetSmallestWidth = 600;
                    const calculatedMagicDpi = Math.round((originalHeight / targetSmallestWidth) * 160);
                    if (currentDpiValue > calculatedMagicDpi) {
                        finalDpi = calculatedMagicDpi.toString();
                        appendLog(`Original DPI ${currentDpiValue} adjusted to magic DPI ${finalDpi} for height ${originalHeight}.`);
                    }
                }
            }
            if (finalResolution !== "reset") {
                appendLog(`Attempting WM size ${finalResolution}...`);
                await sendAdbCommandToServer({ commandType: 'setWmSize', resolution: finalResolution });
            }
            if (finalDpi !== "reset") {
                appendLog(`Attempting WM density ${finalDpi}...`);
                await sendAdbCommandToServer({ commandType: 'setWmDensity', dpi: finalDpi });
            }
			updateStatus("Native Taskbar Mode: WM properties set.");
            startMessage.resolution = finalResolution;
            startMessage.dpi = finalDpi;
		}
        initVideo();
		sendWebSocketMessage(startMessage);
	} catch (error) {
		appendLog(`Error during pre-start ADB commands: ${error.message}`, true);
		stopStreamingAndCleanup(false);
	}
}

export async function stopStreamingAndCleanup(sendDisconnect = true) {
    const wasRunning = globalState.isRunning;
    const previousDisplayMode = globalState.currentDisplayMode;
    const deviceToClean = globalState.selectedDeviceId;

    if (!globalState.isRunning && !sendDisconnect && !(globalState.ws && globalState.ws.readyState < WebSocket.CLOSING)) return;

    if (globalState.ws && globalState.ws.readyState === WebSocket.OPEN && sendDisconnect) {
        sendWebSocketMessage({ action: 'disconnect' });
    }

    handleStreamingStopped(sendDisconnect);

    if (wasRunning && deviceToClean && (previousDisplayMode === 'overlay' || previousDisplayMode === 'native_taskbar')) {
        updateStatus(`Cleaning up ADB settings for ${previousDisplayMode} mode on ${deviceToClean}...`);
        try {
            await sendAdbCommandToServer({ commandType: 'cleanupAdb', mode: previousDisplayMode });
            updateStatus("ADB cleanup complete.");
        } catch (error) {
            appendLog(`Error during ADB cleanup: ${error.message}`, true);
        }
    }
}

export function requestAdbDevices() {
	if (globalState.ws && globalState.ws.readyState === WebSocket.OPEN) {
		sendWebSocketMessage({ action: 'getAdbDevices' });
		if (elements.refreshButton) elements.refreshButton.disabled = true;
	} else {
		populateDeviceSelect([]);
        if (elements.refreshButton) elements.refreshButton.disabled = false;
	}
}

export function populateDeviceSelect(devices) {
	elements.adbDevicesSelect.innerHTML = '';
	globalState.adbDevices = devices || [];
	if (globalState.adbDevices.length === 0) {
		const option = document.createElement('option');
		option.value = ''; option.textContent = 'No ADB devices found';
		elements.adbDevicesSelect.appendChild(option);
		elements.adbDevicesSelect.disabled = true;
		globalState.selectedDeviceId = null;
	} else {
		const defaultOption = document.createElement('option');
		defaultOption.value = ''; defaultOption.textContent = '-- Select a device --';
		elements.adbDevicesSelect.appendChild(defaultOption);
		globalState.adbDevices.forEach(device => {
			const option = document.createElement('option');
			option.value = device.id;
			option.textContent = device.model ? `${device.model} (${device.id})` : device.id;
			if (device.type !== 'device') {
				option.textContent += ` (${device.type})`;
				option.disabled = true;
			}
			elements.adbDevicesSelect.appendChild(option);
		});
		elements.adbDevicesSelect.disabled = false;
		const previouslySelected = globalState.selectedDeviceId;
        const isValidPrevious = previouslySelected && globalState.adbDevices.some(d => d.id === previouslySelected && d.type === 'device');
		if (isValidPrevious) {
            elements.adbDevicesSelect.value = previouslySelected;
        } else {
            const firstAvailable = globalState.adbDevices.find(d => d.type === 'device');
            if (firstAvailable) {
                elements.adbDevicesSelect.value = firstAvailable.id;
                globalState.selectedDeviceId = firstAvailable.id;
            } else {
                elements.adbDevicesSelect.value = '';
                globalState.selectedDeviceId = null;
            }
        }
	}
    updateDisplayOptionsState();
}


function updateLabelVisualState(label, inputElement, isSpecialClass = false) {
    if (label && inputElement) {
        const isDisabled = inputElement.disabled;
        const activeClass = isSpecialClass ? 'disabled-label' : 'disabled';
        const inactiveClass = isSpecialClass ? 'disabled' : 'disabled-label';

        label.classList.toggle(activeClass, isDisabled);
        if (isDisabled) label.classList.remove(inactiveClass);
        else label.classList.remove(activeClass);
    }
}


export function updateDisplayOptionsState() {
    const isStreaming = globalState.isRunning;
    const deviceSelected = !!globalState.selectedDeviceId;
    const canInteractWithOptions = !isStreaming && deviceSelected;
    const enableControlChecked = elements.enableControlInput.checked;
    const mode = globalState.currentDisplayMode;
    const isDex = mode === 'dex';
    const isNative = mode === 'native_taskbar';
    const isDefault = mode === 'default';

    const controlsToUpdate = [
        { els: [elements.bitrateSelect, elements.customBitrateInput], enable: canInteractWithOptions },
        { els: [elements.maxFpsSelect], enable: canInteractWithOptions },
        { els: [elements.noPowerOnInput], enable: canInteractWithOptions, label: elements.noPowerOnLabel },
        { els: [elements.enableAudioInput], enable: canInteractWithOptions, label: elements.enableAudioLabel},
        { els: [elements.enableControlInput], enable: canInteractWithOptions, label: elements.enableControlLabel},
        { els: [elements.turnScreenOffInput], enable: canInteractWithOptions && enableControlChecked, label: elements.turnScreenOffLabel, isSpecialClass: true },
        { els: [elements.powerOffOnCloseInput], enable: canInteractWithOptions && enableControlChecked, label: elements.powerOffOnCloseLabel, isSpecialClass: true },
        { els: Array.from(elements.displayModeCheckboxes), enable: canInteractWithOptions },
        { els: [elements.resolutionSelect, elements.customResolutionInput], enable: canInteractWithOptions && !isDex && !isDefault, label: elements.resolutionLabel },
        { els: [elements.dpiSelect, elements.customDpiInput], enable: canInteractWithOptions && !isDex && !isDefault, label: elements.dpiLabel },
        { els: [elements.rotationLockSelect], enable: canInteractWithOptions && !isDex && !isNative, label: elements.rotationLockLabel },
    ];

    controlsToUpdate.forEach(config => {
        const elementsToProcess = Array.isArray(config.els) ? config.els : [config.els];
        elementsToProcess.forEach(el => { if (el) el.disabled = !config.enable; });
        if (config.label && elementsToProcess[0]) {
            updateLabelVisualState(config.label, elementsToProcess[0], config.isSpecialClass);
        }
    });

    if (elements.startButton) elements.startButton.disabled = isStreaming || !deviceSelected;
    if (elements.stopButton) elements.stopButton.disabled = !isStreaming;
    if (elements.adbDevicesSelect) elements.adbDevicesSelect.disabled = isStreaming;
    if (elements.refreshButton) elements.refreshButton.disabled = isStreaming || !(globalState.ws && globalState.ws.readyState === WebSocket.OPEN);


    if (isStreaming) {
        const streamDisableConfig = [
            elements.resolutionSelect, elements.customResolutionInput, elements.dpiSelect, elements.customDpiInput,
            elements.bitrateSelect, elements.customBitrateInput, elements.maxFpsSelect, elements.rotationLockSelect,
            elements.noPowerOnInput, elements.turnScreenOffInput, elements.powerOffOnCloseInput,
            elements.enableAudioInput, elements.enableControlInput, ...Array.from(elements.displayModeCheckboxes)
        ];
        streamDisableConfig.forEach(el => { if(el) el.disabled = true; });

        updateLabelVisualState(elements.resolutionLabel, elements.resolutionSelect);
        updateLabelVisualState(elements.dpiLabel, elements.dpiSelect);
        updateLabelVisualState(elements.rotationLockLabel, elements.rotationLockSelect);
        updateLabelVisualState(elements.noPowerOnLabel, elements.noPowerOnInput);
        updateLabelVisualState(elements.turnScreenOffLabel, elements.turnScreenOffInput, true);
        updateLabelVisualState(elements.powerOffOnCloseLabel, elements.powerOffOnCloseInput, true);
        updateLabelVisualState(elements.enableAudioLabel, elements.enableAudioInput);
        updateLabelVisualState(elements.enableControlLabel, elements.enableControlInput);
    }
}


export function updateDisplayOptionsOnStreamStart() {
    if(elements.startButton) elements.startButton.disabled = true;
    if(elements.stopButton) elements.stopButton.disabled = false;
    if(elements.adbDevicesSelect) elements.adbDevicesSelect.disabled = true;
    if(elements.refreshButton) elements.refreshButton.disabled = true;
    updateDisplayOptionsState();
}

export function updateDisplayOptionsOnStreamStop() {
    if(elements.stopButton) elements.stopButton.disabled = true;
    if(elements.adbDevicesSelect) elements.adbDevicesSelect.disabled = false;
    if(elements.refreshButton && globalState.ws && globalState.ws.readyState === WebSocket.OPEN) {
        elements.refreshButton.disabled = false;
    } else if (elements.refreshButton) {
        elements.refreshButton.disabled = true;
    }
    if(elements.startButton) elements.startButton.disabled = !globalState.selectedDeviceId;
    updateDisplayOptionsState();
}


export function initSidebarControls() {
    elements.startButton.addEventListener('click', startStreaming);
    elements.stopButton.addEventListener('click', () => stopStreamingAndCleanup(true));
    elements.refreshButton.addEventListener('click', () => {
        if (globalState.ws && globalState.ws.readyState === WebSocket.OPEN) requestAdbDevices();
	    else initMainWebSocket();
    });

    elements.adbDevicesSelect.onchange = () => {
		const selectedId = elements.adbDevicesSelect.value;
		const selectedDevice = globalState.adbDevices.find(d => d.id === selectedId);
		globalState.selectedDeviceId = (selectedDevice && selectedDevice.type === 'device') ? selectedId : null;
		updateDisplayOptionsState();
	};

    elements.displayModeCheckboxes.forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                globalState.currentDisplayMode = checkbox.value;
                elements.displayModeCheckboxes.forEach(cb => { if (cb !== checkbox) cb.checked = false; });
            }
            updateDisplayOptionsState();
        });
    });

    elements.enableControlInput.addEventListener('change', function() {
        if (!this.checked) {
            elements.turnScreenOffInput.checked = false;
            elements.powerOffOnCloseInput.checked = false;
        }
        updateDisplayOptionsState();
    });

    populateDeviceSelect([]);
    updateDisplayOptionsState();
}