import { elements } from '../domElements.js';
import { globalState } from '../state.js';
import { sendWebSocketMessage } from '../websocketService.js';
import { appendLog } from '../loggerService.js';
import { HIDE_TASKBAR_TIMEOUT_MS, DOUBLE_CLICK_THRESHOLD_MS, CONTROL_MSG_TYPE_SET_SCREEN_POWER_MODE_CLIENT, 
		 SCREEN_POWER_MODE_OFF_CLIENT, CONTROL_MSG_TYPE_EXPAND_NOTIFICATION_PANEL, 
		 CONTROL_MSG_TYPE_EXPAND_SETTINGS_PANEL } from '../constants.js';
		 
import { sendControlMessageToServer } from '../websocketService.js';
import { sendAdbCommandToServer } from '../services/adbClientService.js';


let activePanel = null;

export function updateClock() {
    if(elements.clockSpan) {
	    elements.clockSpan.textContent = new Date().toLocaleTimeString('en-GB', {
		    hour: 'numeric', minute: 'numeric', hour12: false
	    });
    }
}

export function updateWifiIndicatorUI() {
	const isWifiOn = globalState.isWifiOn;
    const wifiToggleBtn = elements.wifiToggleBtn;
    if (wifiToggleBtn) {
        const wifiToggleIcon = wifiToggleBtn.querySelector('.icon');
        const wifiToggleOn = wifiToggleIcon?.querySelector('.wifi-icon.wifion');
        const wifiToggleOff = wifiToggleIcon?.querySelector('.wifi-icon.wifioff');
        if (wifiToggleOn) wifiToggleOn.classList.toggle('hidden', !isWifiOn);
        if (wifiToggleOff) wifiToggleOff.classList.toggle('hidden', isWifiOn);
        wifiToggleBtn.classList.toggle('active', isWifiOn);
        wifiToggleBtn.setAttribute('aria-pressed', isWifiOn.toString());
        const labelSpan = wifiToggleBtn.querySelector('span:last-child');
        if(labelSpan) labelSpan.textContent = isWifiOn ? (globalState.wifiSsid || 'Wi-Fi') : 'Wi-Fi';
    }

	const wifiIndicator = elements.wifiIndicator;
    if (wifiIndicator) {
        const wifiIndicatorOn = wifiIndicator.querySelector('.wifi-icon.wifion');
        const wifiIndicatorOff = wifiIndicator.querySelector('.wifi-icon.wifioff');
        if (wifiIndicatorOn) wifiIndicatorOn.classList.toggle('hidden', !isWifiOn);
        if (wifiIndicatorOff) wifiIndicatorOff.classList.toggle('hidden', isWifiOn);
    }
}

function updatePinToggleIcon() {
    if (elements.pinToggleButton) {
	    elements.pinToggleButton.textContent = globalState.isTaskbarPinned ? '▲' : '▼';
	    elements.pinToggleButton.setAttribute('aria-label', globalState.isTaskbarPinned ? 'Unpin Taskbar' : 'Pin Taskbar');
    }
}

export function updateSpeakerIconFromVolume(volume) {
	const isMuted = volume === 0;
    if (elements.speakerButton) {
        const speakerButtonUnmuted = elements.speakerButton.querySelector('.speaker-icon.unmuted');
        const speakerButtonMuted = elements.speakerButton.querySelector('.speaker-icon.muted');
        if(speakerButtonUnmuted) speakerButtonUnmuted.classList.toggle('hidden', isMuted);
        if(speakerButtonMuted) speakerButtonMuted.classList.toggle('hidden', !isMuted);
        elements.speakerButton.setAttribute('aria-label', isMuted ? 'Audio Muted' : 'Audio Settings');
    }
    if (elements.audioPanel) {
        const audioPanelIcon = elements.audioPanel.querySelector('.slider-group .icon');
        if (audioPanelIcon) {
            const audioPanelUnmuted = audioPanelIcon.querySelector('.speaker-icon.unmuted');
            const audioPanelMuted = audioPanelIcon.querySelector('.speaker-icon.muted');
            if(audioPanelUnmuted) audioPanelUnmuted.classList.toggle('hidden', isMuted);
            if(audioPanelMuted) audioPanelMuted.classList.toggle('hidden', !isMuted);
        }
    }
}

export function updateSliderBackground(slider) {
    if (slider) {
	    const value = (slider.value - slider.min) / (slider.max - slider.min) * 100;
	    slider.style.setProperty('--value', `${value}%`);
    }
}

export function updateBatteryLevelUI(level) {
    const batteryLevel = parseInt(level, 10);
    if (elements.batteryLevelSpan) elements.batteryLevelSpan.textContent = `${batteryLevel}`;

    const batteryFill = elements.batteryFill;
    const batteryIcon = elements.batteryIcon;

	if (batteryFill) {
		const maxFillHeight = 14;
		const topY = 6.5;
		const bottomY = topY + maxFillHeight;
		const fillHeight = (batteryLevel / 100) * maxFillHeight;
		const yPosition = bottomY - fillHeight;
		batteryFill.setAttribute('height', fillHeight.toString());
		batteryFill.setAttribute('y', yPosition.toString());
	}
	if (batteryIcon) batteryIcon.classList.toggle('low-battery', batteryLevel <= 15);
}

function showTaskbar() {
	clearTimeout(globalState.taskbarHideTimeout);
	if (elements.taskbar) elements.taskbar.classList.add('taskbar-visible');
	if (!globalState.activePanel) {
        globalState.taskbarHideTimeout = setTimeout(hideTaskbar, HIDE_TASKBAR_TIMEOUT_MS);
    }
}

function hideTaskbar() {
	if (globalState.activePanel) return;
	if (elements.taskbar) elements.taskbar.classList.remove('taskbar-visible');
}

function handlePinToggle(isDoubleClick = false) {
	if (isDoubleClick) {
		if (!document.fullscreenElement && elements.streamArea) {
			if (globalState.isRunning && elements.videoElement?.classList.contains('visible')) {
                elements.streamArea.requestFullscreen().catch(e => {
                    appendLog(`Fullscreen error: ${e.message}`, true);
                });
            }
		} else if (document.fullscreenElement) {
            document.exitFullscreen();
        }
	} else {
		globalState.isTaskbarPinned = !globalState.isTaskbarPinned;
		if (elements.taskbar) elements.taskbar.classList.toggle('pinned', globalState.isTaskbarPinned);
		updatePinToggleIcon();
	}
	if (globalState.isTaskbarPinned) {
		showTaskbar();
		clearTimeout(globalState.taskbarHideTimeout);
	} else {
        showTaskbar();
    }
}

function handleWifiToggle() {
	if (globalState.ws && globalState.ws.readyState === WebSocket.OPEN) {
		const newWifiState = !globalState.isWifiOn;
		sendWebSocketMessage({ action: 'wifiToggle', enable: newWifiState });
		if (elements.wifiToggleBtn) elements.wifiToggleBtn.classList.add('pending');
	}
}

function sendVolumeUpdateInternal(volumeValue) {
	if (globalState.ws && globalState.ws.readyState === WebSocket.OPEN) {
		sendWebSocketMessage({ action: 'volume', value: volumeValue });
		globalState.lastVolumeSendTime = Date.now();
		globalState.pendingVolumeValue = null;
	}
}

async function rotateDeviceScreenViaAdb() {
	if (!globalState.selectedDeviceId) {
		appendLog("Cannot rotate: No device selected.", true);
		return;
	}
	try {
		const response = await sendAdbCommandToServer({ commandType: 'adbRotateScreen' });
		if (response.success) appendLog(response.message || "Screen rotated successfully.");
		else appendLog(`Rotation failed: ${response.error}`, true);
	} catch (error) {
		appendLog(`Error rotating screen: ${error.message}`, true);
	}
}

function turnScreenOff() {
    if (!globalState.isRunning) { appendLog("Stream not active.", true); return; }
    if (!globalState.controlEnabledAtStart) { appendLog("Control not enabled.", true); return; }
    const buffer = new ArrayBuffer(2);
    const dataView = new DataView(buffer);
    dataView.setUint8(0, CONTROL_MSG_TYPE_SET_SCREEN_POWER_MODE_CLIENT);
    dataView.setUint8(1, SCREEN_POWER_MODE_OFF_CLIENT);
    sendControlMessageToServer(buffer);
    appendLog("Sent screen off command.");
}

function expandNotificationPanel() {
    if (!globalState.isRunning) { appendLog("Stream not active.", true); return; }
    if (!globalState.controlEnabledAtStart) { appendLog("Control not enabled.", true); return; }
    const buffer = new ArrayBuffer(1);
    const dataView = new DataView(buffer);
    dataView.setUint8(0, CONTROL_MSG_TYPE_EXPAND_NOTIFICATION_PANEL);
    sendControlMessageToServer(buffer);
    appendLog("Sent expand notification panel command.");
}

function expandSettingsPanel() {
    if (!globalState.isRunning) { appendLog("Stream not active.", true); return; }
    if (!globalState.controlEnabledAtStart) { appendLog("Control not enabled.", true); return; }
    const buffer = new ArrayBuffer(1);
    const dataView = new DataView(buffer);
    dataView.setUint8(0, CONTROL_MSG_TYPE_EXPAND_SETTINGS_PANEL);
    sendControlMessageToServer(buffer);
    appendLog("Sent expand settings panel command.");
}

export function openPanel(panelId) {
	closeActivePanel();
	const panel = document.getElementById(panelId);
	if (panel) {
		panel.classList.add('active');	
		globalState.activePanel = panelId;
		showTaskbar();
        clearTimeout(globalState.taskbarHideTimeout);
	}
}

export function closeActivePanel() {
	if (globalState.activePanel) {
        const panelToCloseId = globalState.activePanel;
		const panelToClose = document.getElementById(panelToCloseId) || (elements[panelToCloseId] && elements[panelToCloseId].classList?.contains('app-drawer') ? elements[panelToCloseId] : null) ;
		if (panelToClose) panelToClose.classList.remove('active');
		globalState.activePanel = null;
        if (!globalState.isTaskbarPinned) {
            showTaskbar();
        }
	}
}

export function initTaskbarControls() {
    if (elements.streamArea) {
        elements.streamArea.addEventListener('mousemove', showTaskbar);
        elements.streamArea.addEventListener('mouseleave', () => {
	        clearTimeout(globalState.taskbarHideTimeout);
	        if (!globalState.activePanel) hideTaskbar();
        });
        elements.streamArea.addEventListener('touchstart', showTaskbar, { passive: true });
    }

    if (elements.pinToggleButton) {
        elements.pinToggleButton.addEventListener('click', (e) => {
	        e.stopPropagation();
	        const currentTime = Date.now();
	        const timeSinceLastClick = currentTime - globalState.lastPinToggleClickTime;
	        if (timeSinceLastClick < DOUBLE_CLICK_THRESHOLD_MS) handlePinToggle(true);
	        else handlePinToggle(false);
	        globalState.lastPinToggleClickTime = currentTime;
        });
    }

    if (elements.backButton) {
        elements.backButton.addEventListener('click', (e) => {
	        e.stopPropagation();
	        sendWebSocketMessage({ action: 'navAction', key: 'back' });
        });
    }
    if (elements.homeButton) {
        elements.homeButton.addEventListener('click', (e) => {
	        e.stopPropagation();
	        sendWebSocketMessage({ action: 'navAction', key: 'home' });
        });
    }
    if (elements.recentsButton) {
        elements.recentsButton.addEventListener('click', (e) => {
	        e.stopPropagation();
	        sendWebSocketMessage({ action: 'navAction', key: 'recents' });
        });
    }

    if (elements.speakerButton) {
        elements.speakerButton.addEventListener('click', (e) => {
	        e.stopPropagation();
	        if (globalState.activePanel === 'audioPanel') closeActivePanel();
	        else {
                openPanel('audioPanel');
                sendWebSocketMessage({ action: 'getVolume' });
            }
        });
    }

    if (elements.quickSettingsTrigger) {
        elements.quickSettingsTrigger.addEventListener('click', (e) => {
	        e.stopPropagation();
	        if (globalState.activePanel === 'quickSettingsPanel') closeActivePanel();
	        else openPanel('quickSettingsPanel');
        });
    }

    if (elements.mediaVolumeSlider) {
        elements.mediaVolumeSlider.addEventListener('input', () => {
	        const volumeValue = parseInt(elements.mediaVolumeSlider.value, 10);
	        updateSliderBackground(elements.mediaVolumeSlider);
	        updateSpeakerIconFromVolume(volumeValue);
	        globalState.pendingVolumeValue = volumeValue;
	        const now = Date.now();
	        if (now - globalState.lastVolumeSendTime > C.VOLUME_THROTTLE_MS) {
		        if (globalState.volumeChangeTimeout) clearTimeout(globalState.volumeChangeTimeout);
		        sendVolumeUpdateInternal(volumeValue);
	        } else if (!globalState.volumeChangeTimeout) {
                globalState.volumeChangeTimeout = setTimeout(() => {
			        if (globalState.pendingVolumeValue !== null) sendVolumeUpdateInternal(globalState.pendingVolumeValue);
			        globalState.volumeChangeTimeout = null;
		        }, C.VOLUME_THROTTLE_MS - (now - globalState.lastVolumeSendTime));
            }
        });
        const sendFinalVolume = () => {
            if (globalState.volumeChangeTimeout) { clearTimeout(globalState.volumeChangeTimeout); globalState.volumeChangeTimeout = null; }
            const finalVolumeValue = parseInt(elements.mediaVolumeSlider.value, 10);
            if (globalState.pendingVolumeValue !== null) sendVolumeUpdateInternal(finalVolumeValue);
            globalState.pendingVolumeValue = null;
        };
        elements.mediaVolumeSlider.addEventListener('mouseup', sendFinalVolume);
        elements.mediaVolumeSlider.addEventListener('touchend', sendFinalVolume);
    }

    if (elements.wifiToggleBtn) {
        elements.wifiToggleBtn.addEventListener('click', (e) => {
	        e.stopPropagation(); handleWifiToggle();
        });
    }

    if (elements.rotateAdbButton) {
        elements.rotateAdbButton.addEventListener('click', rotateDeviceScreenViaAdb);
    }
    if (elements.screenOffButton) {
        elements.screenOffButton.addEventListener('click', turnScreenOff);
    }

    if (elements.notificationPanelButton) {
        elements.notificationPanelButton.addEventListener('click', expandNotificationPanel);
    }
	
    if (elements.settingsPanelButton) {
        elements.settingsPanelButton.addEventListener('click', expandSettingsPanel);
    }

    document.addEventListener('click', (e) => {
        const target = e.target;
        if (globalState.activePanel) {
            let clickedInsidePanelOrTrigger = false;
            if (globalState.activePanel === 'appDrawer') {
                if (elements.appDrawer?.contains(target) || target === elements.appDrawerButton || elements.appDrawerButton?.contains(target)) {
                    clickedInsidePanelOrTrigger = true;
                }
            } else {
                const panelElement = document.getElementById(globalState.activePanel);
                let triggerElement = null;
                if (globalState.activePanel === 'audioPanel') triggerElement = elements.speakerButton;
                else if (globalState.activePanel === 'quickSettingsPanel') triggerElement = elements.quickSettingsTrigger;

                if (panelElement?.contains(target) || triggerElement?.contains(target) || target === triggerElement) {
                    clickedInsidePanelOrTrigger = true;
                }
            }
            if (!clickedInsidePanelOrTrigger) closeActivePanel();
        }
    });

    updateClock();
    setInterval(updateClock, 5000);
    updateWifiIndicatorUI();
    updatePinToggleIcon();
    updateSpeakerIconFromVolume(elements.mediaVolumeSlider ? parseInt(elements.mediaVolumeSlider.value, 10) : 0);
    updateSliderBackground(elements.mediaVolumeSlider);
}