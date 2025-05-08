const VideoConverter = require('h264-converter').default;
const { setLogger } = require('h264-converter');

setLogger(() => {}, (message) => appendLog(message, true));

const CHECK_STATE_INTERVAL_MS = 500;
const MAX_SEEK_WAIT_MS = 1000;
const MAX_TIME_TO_RECOVER = 200;
const IS_SAFARI = !!window.safari;
const IS_CHROME = navigator.userAgent.includes('Chrome');
const IS_MAC = navigator.platform.startsWith('Mac');
const MAX_BUFFER = IS_SAFARI ? 2 : IS_CHROME && IS_MAC ? 0.9 : 0.2;
const MAX_AHEAD = -0.2;
const DEFAULT_FRAMES_PER_SECOND = 60;
const DEFAULT_FRAMES_PER_FRAGMENT = 1;
const NALU_TYPE_IDR = 5;

const AUDIO_BYTES_PER_SAMPLE = 2;
const BINARY_TYPES = {
	VIDEO: 0,
	AUDIO: 1
};
const CODEC_IDS = {
	H264: 0x68323634,
	AAC: 0x00616163
};
const CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT = 2;
const AMOTION_EVENT_ACTION_DOWN = 0;
const AMOTION_EVENT_ACTION_UP = 1;
const AMOTION_EVENT_ACTION_MOVE = 2;
const AMOTION_EVENT_BUTTON_PRIMARY = 1;
const AMOTION_EVENT_BUTTON_SECONDARY = 2;
const AMOTION_EVENT_BUTTON_TERTIARY = 4;
const POINTER_ID_MOUSE = -1n;

let volumeChangeTimeout = null;
const VOLUME_THROTTLE_MS = 150;
let lastVolumeSendTime = 0;
let pendingVolumeValue = null;

const APPS_PER_PAGE = 9;

const pendingAdbCommands = new Map();

const elements = {
	header: document.querySelector('header'),
	startButton: document.getElementById('startBtn'),
	stopButton: document.getElementById('stopBtn'),
	adbDevicesSelect: document.getElementById('devices'),
	refreshButton: document.getElementById('refreshButton'),
	resolutionSelect: document.getElementById('resolution'),
	customResolutionInput: document.getElementById('customResolution'),
	dpiSelect: document.getElementById('dpi'),
	customDpiInput: document.getElementById('customDpi'),
	resolutionLabel: document.getElementById('resolutionLabel'),
	dpiLabel: document.getElementById('dpiLabel'),
	rotationLockSelect: document.getElementById('rotationLock'),
	rotationLockLabel: document.getElementById('rotationLockLabel'),
	bitrateSelect: document.getElementById('bitrate'),
	customBitrateInput: document.getElementById('customBitrate'),
	maxFpsSelect: document.getElementById('maxFps'),
	noPowerOnInput: document.getElementById('noPowerOn'),
	turnScreenOffInput: document.getElementById('turnScreenOff'),
	powerOffOnCloseInput: document.getElementById('powerOffOnClose'),
	enableAudioInput: document.getElementById('enableAudio'),
	enableControlInput: document.getElementById('enableControl'),
	themeToggle: document.getElementById('themeToggle'),
	fullscreenBtn: document.getElementById('fullscreenBtn'),
	streamArea: document.getElementById('streamArea'),
	videoPlaceholder: document.getElementById('videoPlaceholder'),
	videoElement: document.getElementById('screen'),
	videoBorder: document.getElementById('videoBorder'),
	logArea: document.getElementById('logArea'),
	logContent: document.getElementById('logContent'),
	toggleLogBtn: document.getElementById('toggleLogBtn'),
	appDrawer: document.getElementById('appDrawer'),
	appDrawerContent: document.querySelector('.app-drawer-content'),
	appDrawerButton: document.querySelector('.app-drawer-button'),
	appGridContainer: document.getElementById('appGridContainer'),
	prevPageButton: document.querySelector('.drawer-nav-button.prev-page'),
	nextPageButton: document.querySelector('.drawer-nav-button.next-page'),
	paginationContainer: document.querySelector('.drawer-pagination'),
	paginationDots: [],
	addWirelessDeviceBtn: document.getElementById('addWirelessDeviceBtn'),
	addWirelessDeviceModalOverlay: document.getElementById('addWirelessDeviceModalOverlay'),
	closeAddWirelessModalBtn: document.getElementById('closeAddWirelessModalBtn'),
	ipAddressInput: document.getElementById('ipAddressInput'),
	connectByIpBtn: document.getElementById('connectByIpBtn'),
	ipConnectStatus: document.getElementById('ipConnectStatus'),
	pairByQrBtn: document.getElementById('pairByQrBtn'),
	qrPairingModalOverlay: document.getElementById('qrPairingModalOverlay'),
	closeQrPairingModalBtn: document.getElementById('closeQrPairingModalBtn'),
	qrCodeDisplay: document.getElementById('qrCodeDisplay'),
	qrPairingStatus: document.getElementById('qrPairingStatus'),
	qrPairingSpinner: document.getElementById('qrPairingSpinner'),
	qrPairingMessage: document.getElementById('qrPairingMessage'),
	qrPairingDoneBtn: document.getElementById('qrPairingDoneBtn'),
	displayModeCheckboxes: document.querySelectorAll('input[name="displayMode"]'),
	rotateAdbButton: document.getElementById('rotateButton'),
	rotateAdbButtonLabel: document.querySelector('.rotate-button-label'),
	rotateAdbSpinner: document.getElementById('rotateSpinner'),
	noPowerOnLabel: document.getElementById('noPowerOnLabel'),
	turnScreenOffLabel: document.getElementById('turnScreenOffLabel'),
	powerOffOnCloseLabel: document.getElementById('powerOffOnCloseLabel'),
};

let state = {
	ws: null,
	converter: null,
	isRunning: false,
	audioContext: null,
	audioDecoder: null,
	audioCodecId: null,
	audioMetadata: null,
	receivedFirstAudioPacket: false,
	deviceWidth: 0,
	deviceHeight: 0,
	videoResolution: 'Unknown',
	checkStateIntervalId: null,
	sourceBufferInternal: null,
	currentTimeNotChangedSince: -1,
	bigBufferSince: -1,
	aheadOfBufferSince: -1,
	lastVideoTime: -1,
	seekingSince: -1,
	removeStart: -1,
	removeEnd: -1,
	videoStats: [],
	inputBytes: [],
	momentumQualityStats: null,
	noDecodedFramesSince: -1,
	controlEnabledAtStart: false,
	isMouseDown: false,
	currentMouseButtons: 0,
	lastMousePosition: {
		x: 0,
		y: 0
	},
	nextAudioTime: 0,
	totalAudioFrames: 0,
	isWifiOn: true,
	wifiSsid: null,
	allApps: [],
	appsPerPage: APPS_PER_PAGE,
	totalPages: 0,
	currentPage: 1,
	headerScrollTimeout: null,
	isHeaderMouseOver: false,
	adbDevices: [],
	selectedDeviceId: null,
	isQrProcessActive: false,
	currentDisplayMode: 'default',
};

const MAX_LOG_LINES = 50;
const logMessages = [];
let qrWs = null;
let qrCodeInstance = null;

const appendLog = (message, isError = false) => {
	const timestamp = new Date().toLocaleTimeString('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
	logMessages.push({
		message: `[${timestamp}] ${message}`,
		isError
	});
	if (logMessages.length > MAX_LOG_LINES) logMessages.shift();
	updateLogDisplay();
};
const updateLogDisplay = () => {
	elements.logContent.innerHTML = logMessages.map(({
		message,
		isError
	}) => `<div style="${isError ? 'color: #ff4444;' : ''}">${message}</div>`).join('');
	elements.logContent.scrollTop = elements.logContent.scrollHeight;
};
const updateStatus = (message) => appendLog(message);
const originalConsoleError = console.error;
console.error = (message, ...args) => {
	const formattedMessage = [message, ...args].join(' ');
	appendLog(formattedMessage, true);
	originalConsoleError(message, ...args);
};
let frameCheckCounter = 0;
const FRAME_CHECK_INTERVAL = 2;
const isIFrame = (frameData) => {
	if (!frameData || frameData.length < 4) return false;
	let offset = 0;
	if (frameData[0] === 0 && frameData[1] === 0) {
		if (frameData[2] === 1) offset = 3;
		else if (frameData.length > 3 && frameData[2] === 0 && frameData[3] === 1) offset = 4;
	}
	return offset > 0 && frameData.length > offset && (frameData[offset] & 0x1F) === NALU_TYPE_IDR;
};
const cleanSourceBuffer = () => {
	if (!state.sourceBufferInternal || state.sourceBufferInternal.updating || state.removeStart < 0 || state.removeEnd <= state.removeStart) {
		state.sourceBufferInternal?.removeEventListener('updateend', cleanSourceBuffer);
		state.removeStart = state.removeEnd = -1;
		return;
	}
	try {
		state.sourceBufferInternal.remove(state.removeStart, state.removeEnd);
		state.sourceBufferInternal.addEventListener('updateend', cleanSourceBuffer, {
			once: true
		});
	} catch (e) {
		state.sourceBufferInternal?.removeEventListener('updateend', cleanSourceBuffer);
		state.removeStart = state.removeEnd = -1;
	}
};
const checkForIFrameAndCleanBuffer = (frameData) => {
	if (IS_SAFARI) return;
	frameCheckCounter = (frameCheckCounter + 1) % FRAME_CHECK_INTERVAL;
	if (frameCheckCounter !== 0) return;
	if (!elements.videoElement.buffered || !elements.videoElement.buffered.length) return;
	const buffered = elements.videoElement.buffered.end(0) - elements.videoElement.currentTime;
	const MAX_BUFFER_CLEAN = IS_SAFARI ? 2 : (IS_CHROME && IS_MAC ? 1.2 : 0.5);
	if (buffered < MAX_BUFFER_CLEAN * 1.5) return;
	if (!state.sourceBufferInternal) {
		state.sourceBufferInternal = state.converter?.sourceBuffer || null;
		if (!state.sourceBufferInternal) return;
	}
	if (!isIFrame(frameData)) return;
	const start = elements.videoElement.buffered.start(0);
	const end = elements.videoElement.buffered.end(0) | 0;
	if (end !== 0 && start < end) {
		if (state.removeEnd !== -1) state.removeEnd = Math.max(state.removeEnd, end);
		else {
			state.removeStart = start;
			state.removeEnd = end;
		}
		state.sourceBufferInternal.addEventListener('updateend', cleanSourceBuffer, {
			once: true
		});
	}
};
const initVideoConverter = () => {
	const fps = parseInt(elements.maxFpsSelect.value) || DEFAULT_FRAMES_PER_SECOND;
	state.converter = new VideoConverter(elements.videoElement, fps, DEFAULT_FRAMES_PER_FRAGMENT);
	state.sourceBufferInternal = state.converter?.sourceBuffer || null;
	elements.videoElement.addEventListener('canplay', onVideoCanPlay, {
		once: true
	});
	elements.videoElement.removeEventListener('error', onVideoError);
	elements.videoElement.addEventListener('error', onVideoError);
};
const onVideoCanPlay = () => {
	if (state.isRunning) elements.videoElement.play().catch(e => {});
};
const onVideoError = (e) => {};
const getVideoPlaybackQuality = () => {
	const video = elements.videoElement;
	if (!video) return null;
	const now = Date.now();
	if (typeof video.getVideoPlaybackQuality === 'function') {
		const temp = video.getVideoPlaybackQuality();
		return {
			timestamp: now,
			decodedFrames: temp.totalVideoFrames,
			droppedFrames: temp.droppedVideoFrames
		};
	}
	if (typeof video.webkitDecodedFrameCount !== 'undefined') return {
		timestamp: now,
		decodedFrames: video.webkitDecodedFrameCount,
		droppedFrames: video.webkitDroppedFrameCount
	};
	return null;
};
const calculateMomentumStats = () => {
	const stat = getVideoPlaybackQuality();
	if (!stat) return;
	const timestamp = Date.now();
	state.videoStats.push(stat);
	state.inputBytes.push({
		timestamp,
		bytes: state.inputBytes.length > 0 ? state.inputBytes[state.inputBytes.length - 1].bytes : 0
	});
	if (state.videoStats.length > 10) {
		state.videoStats.shift();
		state.inputBytes.shift();
	}
	const inputBytesSum = state.inputBytes.reduce((sum, item) => sum + item.bytes, 0);
	const inputFrames = state.inputBytes.length;
	if (state.videoStats.length > 1) {
		const oldest = state.videoStats[0];
		const decodedFrames = stat.decodedFrames - oldest.decodedFrames;
		const droppedFrames = stat.droppedFrames - oldest.droppedFrames;
		state.momentumQualityStats = {
			decodedFrames,
			droppedFrames,
			inputBytes: inputBytesSum,
			inputFrames,
			timestamp
		};
	}
};
const checkForBadState = () => {
	if (!state.isRunning || !state.converter || elements.videoElement.paused) return;
	const {
		currentTime
	} = elements.videoElement;
	const now = Date.now();
	let hasReasonToJump = false;
	if (elements.videoElement.buffered.length) {
		const end = elements.videoElement.buffered.end(0);
		const buffered = end - currentTime;
		const MAX_BUFFER_CHECK = IS_SAFARI ? 2 : (IS_CHROME && IS_MAC ? 1.2 : 0.5);
		if (buffered > MAX_BUFFER_CHECK || buffered < MAX_AHEAD) calculateMomentumStats();
	}
	if (state.momentumQualityStats && state.momentumQualityStats.decodedFrames === 0 && state.momentumQualityStats.inputFrames > 0) {
		if (state.noDecodedFramesSince === -1) state.noDecodedFramesSince = now;
		else if (now - state.noDecodedFramesSince > MAX_TIME_TO_RECOVER) hasReasonToJump = true;
	} else state.noDecodedFramesSince = -1;
	if (currentTime === state.lastVideoTime && state.currentTimeNotChangedSince === -1) state.currentTimeNotChangedSince = now;
	else if (currentTime !== state.lastVideoTime) state.currentTimeNotChangedSince = -1;
	state.lastVideoTime = currentTime;
	if (elements.videoElement.buffered.length) {
		const end = elements.videoElement.buffered.end(0);
		const buffered = end - currentTime;
		const MAX_BUFFER_JUMP = IS_SAFARI ? 2 : (IS_CHROME && IS_MAC ? 1.2 : 0.5);
		if (buffered > MAX_BUFFER_JUMP) {
			if (state.bigBufferSince === -1) state.bigBufferSince = now;
			else if (now - state.bigBufferSince > MAX_TIME_TO_RECOVER) hasReasonToJump = true;
		} else state.bigBufferSince = -1;
		if (buffered < MAX_AHEAD) {
			if (state.aheadOfBufferSince === -1) state.aheadOfBufferSince = now;
			else if (now - state.aheadOfBufferSince > MAX_TIME_TO_RECOVER) hasReasonToJump = true;
		} else state.aheadOfBufferSince = -1;
		if (state.currentTimeNotChangedSince !== -1 && now - state.currentTimeNotChangedSince > MAX_TIME_TO_RECOVER) hasReasonToJump = true;
		if (!hasReasonToJump) return;
		if (state.seekingSince !== -1 && now - state.seekingSince < MAX_SEEK_WAIT_MS) return;
		const onSeekEnd = () => {
			state.seekingSince = -1;
			elements.videoElement.removeEventListener('seeked', onSeekEnd);
			elements.videoElement.play().catch(e => {});
		};
		if (state.seekingSince !== -1) {}
		state.seekingSince = now;
		elements.videoElement.addEventListener('seeked', onSeekEnd);
		elements.videoElement.currentTime = end;
	}
};
const setupAudioPlayer = (codecId, metadata) => {
	if (codecId !== CODEC_IDS.AAC) return;
	if (!window.AudioContext || !window.AudioDecoder) return;
	try {
		if (!state.audioContext || state.audioContext.state === 'closed') state.audioContext = new AudioContext({
			sampleRate: metadata.sampleRate || 48000
		});
		state.audioDecoder = new AudioDecoder({
			output: (audioData) => {
				try {
					const numberOfChannels = audioData.numberOfChannels;
					const sampleRate = audioData.sampleRate;
					const bufferLength = audioData.numberOfFrames;
					const buffer = state.audioContext.createBuffer(numberOfChannels, bufferLength, sampleRate);
					const isInterleaved = audioData.format === 'f32' || audioData.format === 'f32-interleaved';
					if (isInterleaved) {
						const interleavedData = new Float32Array(audioData.numberOfFrames * numberOfChannels);
						audioData.copyTo(interleavedData, {
							planeIndex: 0
						});
						for (let channel = 0; channel < numberOfChannels; channel++) {
							const channelData = buffer.getChannelData(channel);
							for (let i = 0; i < audioData.numberOfFrames; i++) channelData[i] = interleavedData[i * numberOfChannels + channel];
						}
					} else
						for (let channel = 0; channel < numberOfChannels; channel++) audioData.copyTo(buffer.getChannelData(channel), {
							planeIndex: channel
						});
					const source = state.audioContext.createBufferSource();
					source.buffer = buffer;
					source.connect(state.audioContext.destination);
					const currentTime = state.audioContext.currentTime;
					const bufferDuration = audioData.numberOfFrames / sampleRate;
					const videoTime = elements.videoElement.currentTime;
					if (!state.receivedFirstAudioPacket) {
						state.nextAudioTime = Math.max(currentTime, videoTime);
						state.receivedFirstAudioPacket = true;
					}
					if (state.nextAudioTime < currentTime) state.nextAudioTime = currentTime;
					source.start(state.nextAudioTime);
					state.nextAudioTime += bufferDuration;
				} catch (e) {}
			},
			error: (error) => {},
		});
		state.audioDecoder.configure({
			codec: 'mp4a.40.2',
			sampleRate: metadata.sampleRate || 48000,
			numberOfChannels: metadata.channelConfig || 2
		});
		state.audioCodecId = codecId;
		state.audioMetadata = metadata;
		state.receivedFirstAudioPacket = false;
		state.nextAudioTime = 0;
		state.totalAudioFrames = 0;
	} catch (e) {
		state.audioDecoder = null;
		state.audioContext = null;
	}
};
const handleAudioData = (arrayBuffer) => {
	if (!state.audioDecoder || !state.isRunning || state.audioCodecId !== CODEC_IDS.AAC || arrayBuffer.byteLength === 0) return;
	try {
		const uint8Array = new Uint8Array(arrayBuffer);
		const sampleRate = state.audioMetadata?.sampleRate || 48000;
		const frameDuration = 1024 / sampleRate * 1000000;
		state.audioDecoder.decode(new EncodedAudioChunk({
			type: 'key',
			timestamp: state.totalAudioFrames * frameDuration,
			data: uint8Array
		}));
		state.totalAudioFrames += 1024;
		state.receivedFirstAudioPacket = true;
	} catch (e) {}
};
const getScaledCoordinates = (event) => {
	const video = elements.videoElement;
	const screenInfo = {
		videoSize: {
			width: state.deviceWidth,
			height: state.deviceHeight
		}
	};
	if (!screenInfo || !screenInfo.videoSize || !screenInfo.videoSize.width || !screenInfo.videoSize.height) return null;
	const {
		width,
		height
	} = screenInfo.videoSize;
	const target = video;
	const rect = target.getBoundingClientRect();
	let {
		clientWidth,
		clientHeight
	} = target;
	let touchX = event.clientX - rect.left;
	let touchY = event.clientY - rect.top;
	const videoRatio = width / height;
	const elementRatio = clientWidth / clientHeight;
	if (elementRatio > videoRatio) {
		const realWidth = clientHeight * videoRatio;
		const barsWidth = (clientWidth - realWidth) / 2;
		if (touchX < barsWidth || touchX > barsWidth + realWidth) return null;
		touchX -= barsWidth;
		clientWidth = realWidth;
	} else if (elementRatio < videoRatio) {
		const realHeight = clientWidth / videoRatio;
		const barsHeight = (clientHeight - realHeight) / 2;
		if (touchY < barsHeight || touchY > barsHeight + realHeight) return null;
		touchY -= barsHeight;
		clientHeight = realHeight;
	}
	let deviceX = Math.round((touchX * width) / clientWidth);
	let deviceY = Math.round((touchY * height) / clientHeight);
	deviceX = Math.max(0, Math.min(width, deviceX));
	deviceY = Math.max(0, Math.min(height, deviceY));
	return {
		x: deviceX,
		y: deviceY
	};
};
const sendControlMessage = (buffer) => {
	if (state.ws && state.ws.readyState === WebSocket.OPEN && state.controlEnabledAtStart) try {
		state.ws.send(buffer);
	} catch (e) {}
};
const sendMouseEvent = (action, buttons, x, y) => {
	if (!state.deviceWidth || !state.deviceHeight || !state.controlEnabledAtStart) return;
	const buffer = new ArrayBuffer(32);
	const dataView = new DataView(buffer);
	dataView.setUint8(0, CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT);
	dataView.setUint8(1, action);
	dataView.setBigInt64(2, POINTER_ID_MOUSE, false);
	dataView.setInt32(10, x, false);
	dataView.setInt32(14, y, false);
	dataView.setUint16(18, state.deviceWidth, false);
	dataView.setUint16(20, state.deviceHeight, false);
	dataView.setUint16(22, 0xFFFF, false);
	dataView.setUint32(24, 0, false);
	dataView.setUint32(28, buttons, false);
	sendControlMessage(buffer);
};
const handleMouseDown = (event) => {
	if (!state.isRunning || !state.controlEnabledAtStart || !state.deviceWidth || !state.deviceHeight) return;
	event.preventDefault();
	state.isMouseDown = true;
	let buttonFlag = 0;
	switch (event.button) {
		case 0:
			buttonFlag = AMOTION_EVENT_BUTTON_PRIMARY;
			break;
		case 1:
			buttonFlag = AMOTION_EVENT_BUTTON_TERTIARY;
			break;
		case 2:
			buttonFlag = AMOTION_EVENT_BUTTON_SECONDARY;
			break;
		default:
			return;
	}
	state.currentMouseButtons |= buttonFlag;
	const coords = getScaledCoordinates(event);
	if (coords) {
		state.lastMousePosition = coords;
		sendMouseEvent(AMOTION_EVENT_ACTION_DOWN, state.currentMouseButtons, coords.x, coords.y);
	}
};
const handleMouseUp = (event) => {
	if (!state.isMouseDown) return;
	if (!state.isRunning || !state.controlEnabledAtStart || !state.deviceWidth || !state.deviceHeight) return;
	event.preventDefault();
	let buttonFlag = 0;
	switch (event.button) {
		case 0:
			buttonFlag = AMOTION_EVENT_BUTTON_PRIMARY;
			break;
		case 1:
			buttonFlag = AMOTION_EVENT_BUTTON_TERTIARY;
			break;
		case 2:
			buttonFlag = AMOTION_EVENT_BUTTON_SECONDARY;
			break;
		default:
			return;
	}
	if (!(state.currentMouseButtons & buttonFlag)) return;
	const coords = getScaledCoordinates(event);
	const finalCoords = coords || state.lastMousePosition;
	sendMouseEvent(AMOTION_EVENT_ACTION_UP, state.currentMouseButtons, finalCoords.x, finalCoords.y);
	state.currentMouseButtons &= ~buttonFlag;
	if (state.currentMouseButtons === 0) state.isMouseDown = false;
};
const handleMouseMove = (event) => {
	if (!state.isRunning || !state.controlEnabledAtStart || !state.deviceWidth || !state.deviceHeight || !state.isMouseDown) return;
	event.preventDefault();
	const coords = getScaledCoordinates(event);
	if (coords) {
		state.lastMousePosition = coords;
		sendMouseEvent(AMOTION_EVENT_ACTION_MOVE, state.currentMouseButtons, coords.x, coords.y);
	}
};
const handleMouseLeave = (event) => {
	if (!state.isRunning || !state.controlEnabledAtStart || !state.isMouseDown || state.currentMouseButtons === 0) return;
	event.preventDefault();
	sendMouseEvent(AMOTION_EVENT_ACTION_UP, state.currentMouseButtons, state.lastMousePosition.x, state.lastMousePosition.y);
	state.isMouseDown = false;
	state.currentMouseButtons = 0;
};

function populateDeviceSelect(devices) {
	elements.adbDevicesSelect.innerHTML = '';
	state.adbDevices = devices || [];
	if (state.adbDevices.length === 0) {
		const option = document.createElement('option');
		option.value = '';
		option.textContent = 'No ADB devices found';
		elements.adbDevicesSelect.appendChild(option);
		elements.adbDevicesSelect.disabled = true;
		state.selectedDeviceId = null;
	} else {
		const defaultOption = document.createElement('option');
		defaultOption.value = '';
		defaultOption.textContent = '-- Select a device --';
		elements.adbDevicesSelect.appendChild(defaultOption);
		state.adbDevices.forEach(device => {
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
		const previouslySelected = state.selectedDeviceId;
		const isValidPreviousSelection = previouslySelected && state.adbDevices.some(d => d.id === previouslySelected && d.type === 'device');
		if (isValidPreviousSelection) {
			elements.adbDevicesSelect.value = previouslySelected;
		} else {
			const firstAvailableDevice = state.adbDevices.find(d => d.type === 'device');
			if (firstAvailableDevice) {
				elements.adbDevicesSelect.value = firstAvailableDevice.id;
				state.selectedDeviceId = firstAvailableDevice.id;
			} else {
				elements.adbDevicesSelect.value = '';
				state.selectedDeviceId = null;
			}
		}
	}
	elements.startButton.disabled = !state.selectedDeviceId || state.isRunning;
	elements.adbDevicesSelect.onchange = () => {
		const selectedId = elements.adbDevicesSelect.value;
		const selectedDevice = state.adbDevices.find(d => d.id === selectedId);
		if (selectedDevice && selectedDevice.type === 'device') {
			state.selectedDeviceId = selectedId;
		} else {
			state.selectedDeviceId = null;
		}
		elements.startButton.disabled = !state.selectedDeviceId || state.isRunning;
		updateDisplayOptionsState();
	};
	if (typeof elements.adbDevicesSelect.onchange === 'function') {
		elements.adbDevicesSelect.onchange();
	}
}

function requestAdbDevices() {
	if (state.ws && state.ws.readyState === WebSocket.OPEN) {
		state.ws.send(JSON.stringify({
			action: 'getAdbDevices'
		}));
		elements.refreshButton.disabled = true;
	} else {
		populateDeviceSelect([]);
		elements.refreshButton.disabled = false;
	}
}

async function sendAdbCommand(commandData) {
	return new Promise((resolve, reject) => {
		if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.selectedDeviceId) {
			reject(new Error('WebSocket not connected or no device selected for ADB command.'));
			return;
		}

		const commandId = Date.now() + Math.random().toString(36).substring(2, 7);

		pendingAdbCommands.set(commandId, {
			resolve,
			reject,
			commandType: commandData.commandType
		});

		const messageToSend = {
			action: 'adbCommand',
			commandId: commandId,
			deviceId: state.selectedDeviceId,
			...commandData
		};

		try {
			state.ws.send(JSON.stringify(messageToSend));
		} catch (e) {
			pendingAdbCommands.delete(commandId);
			reject(new Error(`WebSocket send error for ADB command: ${e.message}`));
			return;
		}


		setTimeout(() => {
			if (pendingAdbCommands.has(commandId)) {
				const cmd = pendingAdbCommands.get(commandId);
				cmd.reject(new Error(`ADB command ${cmd.commandType} (ID: ${commandId}) timed out.`));
				pendingAdbCommands.delete(commandId);
			}
		}, 15000);
	});
}

const startStreaming = async () => {
	if (!state.selectedDeviceId) {
		alert('Please select an ADB device.');
		return;
	}
	if (state.isRunning) return;
	if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
		appendLog("WebSocket not connected. Cannot start.", true);
		return;
	}

	elements.startButton.disabled = true;
	elements.stopButton.disabled = false;
	elements.adbDevicesSelect.disabled = true;

	state.isRunning = true;
	state.controlEnabledAtStart = elements.enableControlInput.checked;
	updateDisplayOptionsState();

	Object.assign(state, {
		converter: null,
		audioContext: null,
		audioDecoder: null,
		sourceBufferInternal: null,
		checkStateIntervalId: null,
		currentTimeNotChangedSince: -1,
		bigBufferSince: -1,
		aheadOfBufferSince: -1,
		lastVideoTime: -1,
		seekingSince: -1,
		removeStart: -1,
		removeEnd: -1,
		receivedFirstAudioPacket: false,
		audioMetadata: null,
		videoStats: [],
		inputBytes: [],
		momentumQualityStats: null,
		noDecodedFramesSince: -1,
		isMouseDown: false,
		currentMouseButtons: 0,
		lastMousePosition: {
			x: 0,
			y: 0
		},
		nextAudioTime: 0,
		totalAudioFrames: 0,
		deviceWidth: 0,
		deviceHeight: 0,
		videoResolution: 'Unknown',
	});

	const startMessage = {
		action: 'start',
		deviceId: state.selectedDeviceId,
		maxFps: parseInt(elements.maxFpsSelect.value) || 0,
		bitrate: ((!isNaN(parseInt(elements.customBitrateInput.value.trim())) && parseInt(elements.customBitrateInput.value.trim()) > 0) ?
			parseInt(elements.customBitrateInput.value.trim()) : parseInt(elements.bitrateSelect.value)) * 1000000,
		enableAudio: elements.enableAudioInput.checked,
		enableControl: state.controlEnabledAtStart,
		video: true,
		noPowerOn: elements.noPowerOnInput.checked,
		turnScreenOff: elements.turnScreenOffInput.checked,
		powerOffOnClose: elements.powerOffOnCloseInput.checked,
		displayMode: state.currentDisplayMode,
		rotationLock: elements.rotationLockSelect.value,
	};

	const selectedResolution = elements.customResolutionInput.value.trim() || elements.resolutionSelect.value;
	let selectedDpi = elements.customDpiInput.value.trim() || elements.dpiSelect.value;

	startMessage.resolution = selectedResolution;
	startMessage.dpi = selectedDpi;

	try {
		if (state.currentDisplayMode === 'overlay') {
			if (selectedResolution === "reset" || selectedDpi === "reset") {
				throw new Error("Resolution and DPI must be set for Overlay mode.");
			}
			updateStatus("Overlay Mode: Fetching initial displays...");
			const initialDisplaysResponse = await sendAdbCommand({
				commandType: 'getDisplayList',
					deviceId: state.selectedDeviceId
			});
			const initialDisplayIds = initialDisplaysResponse.data.map(d => d.id);

			updateStatus(`Overlay Mode: Setting overlay display to ${selectedResolution}/${selectedDpi}...`);
			await sendAdbCommand({
				commandType: 'setOverlay',
				deviceId: state.selectedDeviceId,
				resolution: selectedResolution,
				dpi: selectedDpi
			});

			updateStatus("Overlay Mode: Fetching updated displays...");
			await new Promise(resolve => setTimeout(resolve, 2000));
			const updatedDisplaysResponse = await sendAdbCommand({
				commandType: 'getDisplayList',
					deviceId: state.selectedDeviceId
			});
			const updatedDisplayIds = updatedDisplaysResponse.data.map(d => d.id);

			const newDisplayIds = updatedDisplayIds.filter(id => !initialDisplayIds.includes(id));
			if (newDisplayIds.length === 0) {
				throw new Error("Overlay Mode: Could not find new display ID after setting overlay.");
			}
			startMessage.overlayDisplayId = newDisplayIds[0];
			updateStatus(`Overlay Mode: Using new display ID ${startMessage.overlayDisplayId}`);

		} else if (state.currentDisplayMode === 'native_taskbar') {
			updateStatus("Native Taskbar Mode: Setting WM properties...");

			let finalResolution = selectedResolution;
			let finalDpi = selectedDpi;
			let originalWidth = null;
			let originalHeight = null;
			
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
						appendLog(`Original DPI ${currentDpiValue} was higher than calculated magic DPI ${calculatedMagicDpi} for original height ${originalHeight}. Using ${finalDpi}.`);
					} else {
						appendLog(`Original DPI ${currentDpiValue} is not higher than calculated magic DPI ${calculatedMagicDpi} for original height ${originalHeight}. Keeping original DPI.`);
					}
				}
			}
			if (finalResolution !== "reset") {
				appendLog(`Attempting to set WM size to ${finalResolution}...`);
				await sendAdbCommand({
					commandType: 'setWmSize',
					deviceId: state.selectedDeviceId,
					resolution: finalResolution
				});
				appendLog('WM size command sent/responded.');
			}

			if (finalDpi !== "reset") {
				appendLog(`Attempting to set WM density to ${finalDpi}...`);
				await sendAdbCommand({
					commandType: 'setWmDensity',
					deviceId: state.selectedDeviceId,
					dpi: finalDpi
				});
				appendLog('WM density command sent/responded.');
			}
			updateStatus("Native Taskbar Mode: WM properties set.");

			startMessage.resolution = finalResolution;
			startMessage.dpi = finalDpi;
		}
		state.ws.send(JSON.stringify(startMessage));
		initVideoConverter();
	} catch (error) {
		appendLog(`Error during pre-start ADB commands: ${error.message}`, true);
		stopStreaming(false);
	}
};

const stopStreaming = async (sendDisconnect = true) => {
	const wasRunning = state.isRunning;
	const previousDisplayMode = state.currentDisplayMode;
	const deviceToClean = state.selectedDeviceId;

	if (!state.isRunning && !sendDisconnect && !(state.ws && state.ws.readyState < WebSocket.CLOSING)) return;

	if (state.ws && state.ws.readyState === WebSocket.OPEN && sendDisconnect) {
		try {
			state.ws.send(JSON.stringify({
				action: 'disconnect'
			}));
		} catch (e) {}
	}

	if (state.checkStateIntervalId) {
		clearInterval(state.checkStateIntervalId);
		state.checkStateIntervalId = null;
	}
	if (state.audioDecoder) {
		if (state.audioDecoder.state !== 'closed') state.audioDecoder.close();
		state.audioDecoder = null;
	}
	if (state.audioContext) {
		if (state.audioContext.state !== 'closed') state.audioContext.close();
		state.audioContext = null;
	}
	state.audioMetadata = null;
	state.receivedFirstAudioPacket = false;
	state.nextAudioTime = 0;
	state.totalAudioFrames = 0;

	if (state.converter) {
		try {
			state.converter.appendRawData(new Uint8Array([]));
			state.converter.pause();
			state.converter = null;
		} catch (e) {}
	}
	state.sourceBufferInternal = null;
	elements.videoElement.pause();
	try {
		elements.videoElement.src = "";
		elements.videoElement.removeAttribute('src');
		elements.videoElement.load();
	} catch (e) {}
	elements.videoElement.classList.remove('visible');
	elements.videoElement.classList.remove('control-enabled');
	elements.videoPlaceholder.classList.remove('hidden');
	elements.videoBorder.style.display = 'none';
	elements.streamArea.style.aspectRatio = '9 / 16';

	if (wasRunning && deviceToClean && (previousDisplayMode === 'overlay' || previousDisplayMode === 'native_taskbar')) {
		updateStatus(`Cleaning up ADB settings for ${previousDisplayMode} mode on ${deviceToClean}...`);
		try {
			await sendAdbCommand({
				commandType: 'cleanupAdb',
				deviceId: deviceToClean,
				mode: previousDisplayMode
			});
			updateStatus("ADB cleanup complete.");
		} catch (error) {
			appendLog(`Error during ADB cleanup: ${error.message}`, true);
		}
	}

	if (wasRunning || sendDisconnect) {
		state.isRunning = false;
		updateStatus('Disconnected');
		elements.stopButton.disabled = true;
		elements.adbDevicesSelect.disabled = false;
		elements.refreshButton.disabled = !(state.ws && state.ws.readyState === WebSocket.OPEN);
		elements.startButton.disabled = !state.selectedDeviceId;
		updateDisplayOptionsState();
	}

	Object.assign(state, {
		currentTimeNotChangedSince: -1,
		bigBufferSince: -1,
		aheadOfBufferSince: -1,
		lastVideoTime: -1,
		seekingSince: -1,
		removeStart: -1,
		removeEnd: -1,
		videoStats: [],
		inputBytes: [],
		momentumQualityStats: null,
		noDecodedFramesSince: -1,
		isMouseDown: false,
		currentMouseButtons: 0,
		deviceWidth: 0,
		deviceHeight: 0,
		videoResolution: 'Unknown',
	});
};

function initializeWebSocket() {
	if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
		if (state.ws.readyState === WebSocket.OPEN) requestAdbDevices();
		return;
	}
	state.ws = new WebSocket(`ws://${window.location.hostname}:8080`);
	state.ws.binaryType = 'arraybuffer';
	state.ws.onopen = () => {
		elements.refreshButton.disabled = false;
		requestAdbDevices();
	};
	state.ws.onmessage = (event) => {
		if (typeof event.data === 'string') {
			const message = JSON.parse(event.data);

			if (message.commandId && pendingAdbCommands.has(message.commandId)) {
				const cmdPromise = pendingAdbCommands.get(message.commandId);
				if (message.type === `${cmdPromise.commandType}Response`) {
					if (message.success) {
						cmdPromise.resolve(message);
					} else {
						cmdPromise.reject(new Error(message.error || `ADB command ${cmdPromise.commandType} failed.`));
					}
					pendingAdbCommands.delete(message.commandId);
					return;
				}
			}

			if (message.type === 'adbDevicesList') {
				elements.refreshButton.disabled = false;
				if (message.success) populateDeviceSelect(message.devices);
				else populateDeviceSelect([]);
				return;
			}
			if (state.isRunning) {
				switch (message.type) {
					case 'deviceName':
						updateStatus(`Streaming from ${message.name}`);
						break;
					case 'videoInfo':
						state.deviceWidth = message.width;
						state.deviceHeight = message.height;
						state.videoResolution = `${message.width}x${message.height}`;
						elements.streamArea.style.aspectRatio = state.deviceWidth > 0 && state.deviceHeight > 0 ? `${state.deviceWidth} / ${state.deviceHeight}` : '9 / 16';
						elements.videoPlaceholder.classList.add('hidden');
						elements.videoElement.classList.add('visible');
						break;
					case 'audioInfo':
						if (message.codecId === CODEC_IDS.AAC && message.metadata && elements.enableAudioInput.checked) setupAudioPlayer(message.codecId, message.metadata);
						break;
					case 'status':
						updateStatus(message.message);
						if (message.message === 'Streaming started') {
							elements.videoElement.classList.toggle('control-enabled', state.controlEnabledAtStart);
							if (state.checkStateIntervalId) clearInterval(state.checkStateIntervalId);
							state.checkStateIntervalId = setInterval(checkForBadState, CHECK_STATE_INTERVAL_MS);
							if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({
								action: 'getBatteryLevel'
							}));
							requestWifiStatus();
						} else if (message.message === 'Streaming stopped') stopStreaming(false);
						else if (message.message.startsWith('Audio disabled')) {
							elements.enableAudioInput.checked = false;
							updateStatus(message.message);
						}
						break;
					case 'error':
						updateStatus(`Stream Error: ${message.message}`);
						stopStreaming(false);
						break;
					case 'deviceMessage':
						try {
							new Uint8Array(Buffer.from(message.data, 'base64'));
						} catch (e) {}
						break;
					case 'resolutionChange':
						handleResolutionChange(message.width, message.height);
						break;
					case 'volumeResponse':
						if (message.success) updateStatus(`Volume set to ${message.requestedValue}%`);
						else updateStatus(`Volume Error: ${message.error}`);
						break;
					case 'volumeInfo':
						if (message.success) {
							mediaVolumeSlider.value = message.volume;
							updateSliderBackground(mediaVolumeSlider);
							updateSpeakerIcon();
							updateStatus(`Volume: ${message.volume}%`);
						} else updateStatus(`Get Volume Error: ${message.error}`);
						break;
					case 'navResponse':
						if (message.success) updateStatus(`Nav ${message.key} OK`);
						else updateStatus(`Nav ${message.key} Error: ${message.error}`);
						break;
					case 'wifiResponse':
						const wifiToggleBtn = document.getElementById('wifiToggleBtn');
						if (wifiToggleBtn) wifiToggleBtn.classList.remove('pending');
						if (message.success) {
							state.isWifiOn = message.currentState;
							state.wifiSsid = message.ssid;
							updateWifiIndicator();
							updateStatus(`Wi-Fi ${state.isWifiOn ? 'On' : 'Off'}${state.wifiSsid ? ` (${state.wifiSsid})` : ''}`);
						} else updateStatus(`Wi-Fi Error: ${message.error}`);
						break;
					case 'wifiStatus':
						if (message.success) {
							state.isWifiOn = message.isWifiOn;
							state.wifiSsid = message.ssid;
							updateWifiIndicator();
							updateStatus(`Wi-Fi: ${state.isWifiOn ? 'On' : 'Off'}${state.wifiSsid ? ` (${state.wifiSsid})` : ''}`);
						} else updateStatus(`Get Wi-Fi Error: ${message.error}`);
						break;
					case 'batteryInfo':
						if (message.success) updateBatteryLevel(message.batteryLevel);
						else updateStatus(`Battery Error: ${message.error}`);
						break;
					case 'launcherAppsList':
						const apps = message.apps;
						if (Array.isArray(apps)) renderAppDrawer(apps);
						break;
				}
			} else {
				switch (message.type) {
					case 'status':
						updateStatus(message.message);
						break;
					case 'error':
						updateStatus(`Server Error: ${message.message}`);
						break;
				}
			}
		} else if (event.data instanceof ArrayBuffer && state.isRunning) {
			const dataView = new DataView(event.data);
			if (dataView.byteLength < 1) return;
			const type = dataView.getUint8(0);
			const payload = event.data.slice(1);
			const payloadUint8 = new Uint8Array(payload);
			if (type === BINARY_TYPES.VIDEO && state.converter) {
				if (state.inputBytes.length > 200) state.inputBytes.shift();
				state.inputBytes.push({
					timestamp: Date.now(),
					bytes: payload.byteLength
				});
				state.converter.appendRawData(payloadUint8);
				checkForIFrameAndCleanBuffer(payloadUint8);
			} else if (type === BINARY_TYPES.AUDIO && elements.enableAudioInput.checked) handleAudioData(payload);
		}
	};
	state.ws.onclose = (event) => {
		if (state.isRunning) stopStreaming(false);
		state.ws = null;
		elements.refreshButton.disabled = true;
		elements.startButton.disabled = true;
		populateDeviceSelect([]);
		pendingAdbCommands.forEach(cmd => cmd.reject(new Error('WebSocket connection closed.')));
		pendingAdbCommands.clear();
	};
	state.ws.onerror = (error) => {
		if (state.isRunning) stopStreaming(false);
		state.ws = null;
		elements.refreshButton.disabled = true;
		elements.startButton.disabled = true;
		populateDeviceSelect([]);
		pendingAdbCommands.forEach(cmd => cmd.reject(new Error('WebSocket error.')));
		pendingAdbCommands.clear();
	};
}

function showAddWirelessDeviceModal() {
	elements.ipAddressInput.value = '';
	elements.ipConnectStatus.textContent = '';
	elements.ipConnectStatus.className = 'modal-status';
	elements.addWirelessDeviceModalOverlay.style.display = 'flex';
}

function hideAddWirelessDeviceModal() {
	elements.addWirelessDeviceModalOverlay.style.display = 'none';
}
async function hideQrPairingModal() {
	if (state.isQrProcessActive) {
		try {
			await fetch('/cancel-qr-session', {
				method: 'POST'
			});
			appendLog('QR session cancellation requested.');
		} catch (error) {
			appendLog('Error sending QR session cancellation: ' + error.message, true);
		}
	}
	elements.qrPairingModalOverlay.style.display = 'none';
	if (qrWs && qrWs.readyState === WebSocket.OPEN) {
		qrWs.close();
	}
	qrWs = null;
	state.isQrProcessActive = false;
	elements.qrPairingSpinner.style.display = 'none';
	elements.qrPairingDoneBtn.style.display = 'block';
}

function showQrPairingModal() {
	elements.qrCodeDisplay.innerHTML = '';
	if (qrCodeInstance) qrCodeInstance.clear();
	elements.qrPairingMessage.textContent = 'Initializing...';
	elements.qrPairingSpinner.style.display = 'inline-block';
	elements.qrPairingStatus.className = 'modal-status';
	elements.qrPairingDoneBtn.style.display = 'none';
	elements.qrPairingModalOverlay.style.display = 'flex';
	state.isQrProcessActive = true;
}
async function handleConnectByIp() {
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
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				ipAddress
			})
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
async function handlePairByQr() {
	hideAddWirelessDeviceModal();
	showQrPairingModal();
	try {
		const response = await fetch('/initiate-qr-session');
		const data = await response.json();
		if (response.ok && data.success && data.qrString) {
			elements.qrPairingMessage.textContent = 'Scan QR with your device...';
			elements.qrPairingSpinner.style.display = 'inline-block';
			if (qrCodeInstance) qrCodeInstance.clear();
			elements.qrCodeDisplay.innerHTML = '';
			qrCodeInstance = new QRCode(elements.qrCodeDisplay, {
				text: data.qrString,
				width: 256,
				height: 256,
				colorDark: "#000000",
				colorLight: "#ffffff",
				correctLevel: QRCode.CorrectLevel.H
			});
			connectToQrWebSocket();
		} else {
			elements.qrPairingMessage.textContent = data.message || 'Failed to generate QR code.';
			elements.qrPairingSpinner.style.display = 'none';
			elements.qrPairingStatus.className = 'modal-status error';
			elements.qrPairingDoneBtn.style.display = 'block';
			state.isQrProcessActive = false;
		}
	} catch (error) {
		elements.qrPairingMessage.textContent = 'Error initiating QR session: ' + error.message;
		elements.qrPairingSpinner.style.display = 'none';
		elements.qrPairingStatus.className = 'modal-status error';
		elements.qrPairingDoneBtn.style.display = 'block';
		state.isQrProcessActive = false;
	}
}

function connectToQrWebSocket() {
	if (qrWs && qrWs.readyState === WebSocket.OPEN) {
		return;
	}
	qrWs = new WebSocket(`ws://${window.location.hostname}:3001`);
	qrWs.onopen = () => {
		appendLog('QR WebSocket connection established.');
	};
	qrWs.onmessage = (event) => {
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
				state.isQrProcessActive = false;
			}
		} catch (e) {
			appendLog('Error parsing QR WebSocket message: ' + e.message, true);
			elements.qrPairingMessage.textContent = 'Error processing status update.';
			elements.qrPairingSpinner.style.display = 'none';
			elements.qrPairingStatus.className = 'modal-status error';
			elements.qrPairingDoneBtn.style.display = 'block';
			state.isQrProcessActive = false;
		}
	};
	qrWs.onclose = () => {
		appendLog('QR WebSocket connection closed.');
		if (state.isQrProcessActive) {
			elements.qrPairingSpinner.style.display = 'none';
			elements.qrPairingDoneBtn.style.display = 'block';
			state.isQrProcessActive = false;
		}
	};
	qrWs.onerror = (error) => {
		appendLog('QR WebSocket error: ' + error.message, true);
		elements.qrPairingMessage.textContent = 'QR WebSocket error. Check console.';
		elements.qrPairingSpinner.style.display = 'none';
		elements.qrPairingStatus.className = 'modal-status error';
		elements.qrPairingDoneBtn.style.display = 'block';
		state.isQrProcessActive = false;
	};
}

elements.startButton.addEventListener('click', startStreaming);
elements.stopButton.addEventListener('click', () => stopStreaming(true));
elements.refreshButton.addEventListener('click', () => {
	if (state.ws && state.ws.readyState === WebSocket.OPEN) requestAdbDevices();
	else initializeWebSocket();
});
elements.themeToggle.addEventListener('click', () => {
	const body = document.body;
	const currentTheme = body.getAttribute('data-theme');
	const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
	body.setAttribute('data-theme', newTheme);
	elements.themeToggle.setAttribute('aria-checked', newTheme === 'dark' ? 'true' : 'false');
});
elements.fullscreenBtn.addEventListener('click', () => {
	if (!document.fullscreenElement) {
		if (state.isRunning && elements.videoElement.classList.contains('visible')) elements.streamArea.requestFullscreen().catch(e => {});
	} else document.exitFullscreen();
});
document.addEventListener('fullscreenchange', () => {
	elements.streamArea.classList.toggle('in-fullscreen-mode', document.fullscreenElement === elements.streamArea);
});
window.addEventListener('beforeunload', () => {
	if (state.isRunning || (state.ws && state.ws.readyState === WebSocket.OPEN)) stopStreaming(true);
});
elements.videoElement.addEventListener('mousedown', handleMouseDown);
document.addEventListener('mouseup', handleMouseUp);
elements.videoElement.addEventListener('mousemove', handleMouseMove);
elements.videoElement.addEventListener('mouseleave', handleMouseLeave);
elements.videoElement.addEventListener('contextmenu', (e) => {
	if (state.controlEnabledAtStart && state.isRunning) e.preventDefault();
});

const taskbar = document.querySelector('.custom-taskbar');
const backButton = taskbar.querySelector('.back-button');
const homeButton = taskbar.querySelector('.home-button');
const recentsButton = taskbar.querySelector('.recents-button');
const speakerButton = document.getElementById('speakerButton');
const quickSettingsTrigger = document.getElementById('quickSettingsTrigger');
const batteryLevelSpan = document.getElementById('batteryLevel');
const clockSpan = quickSettingsTrigger.querySelector('.clock');
const pinToggleButton = document.getElementById('pinToggleButton');
const audioPanel = document.getElementById('audioPanel');
const quickSettingsPanel = document.getElementById('quickSettingsPanel');
const mediaVolumeSlider = document.getElementById('mediaVolume');
let isTaskbarPinned = false;
let taskbarHideTimeout = null;
const HIDE_TASKBAR_TIMEOUT_MS = 2000;
let activePanel = null;

function updateClock() {
	clockSpan.textContent = new Date().toLocaleTimeString('en-GB', {
		hour: 'numeric',
		minute: 'numeric',
		hour12: false
	});
}

function updateWifiIndicator() {
	const isWifiOn = state.isWifiOn;
	const wifiToggleBtn = document.getElementById('wifiToggleBtn');
	const wifiToggleIcon = wifiToggleBtn.querySelector('.icon');
	const wifiToggleOn = wifiToggleIcon.querySelector('.wifi-icon.wifion');
	const wifiToggleOff = wifiToggleIcon.querySelector('.wifi-icon.wifioff');
	wifiToggleOn.classList.toggle('hidden', !isWifiOn);
	wifiToggleOff.classList.toggle('hidden', isWifiOn);
	wifiToggleBtn.classList.toggle('active', isWifiOn);
	wifiToggleBtn.setAttribute('aria-pressed', isWifiOn.toString());
	wifiToggleBtn.querySelector('span:last-child').textContent = isWifiOn ? (state.wifiSsid || 'Wi-Fi') : 'Wi-Fi';
	const wifiIndicator = quickSettingsTrigger.querySelector('.wifi-indicator');
	const wifiIndicatorOn = wifiIndicator.querySelector('.wifi-icon.wifion');
	const wifiIndicatorOff = wifiIndicator.querySelector('.wifi-icon.wifioff');
	wifiIndicatorOn.classList.toggle('hidden', !isWifiOn);
	wifiIndicatorOff.classList.toggle('hidden', isWifiOn);
}

function requestWifiStatus() {
	if (state.ws && state.ws.readyState === WebSocket.OPEN) try {
		state.ws.send(JSON.stringify({
			action: 'getWifiStatus'
		}));
	} catch (error) {}
}

function updatePinToggleIcon() {
	pinToggleButton.textContent = isTaskbarPinned ? '▲' : '▼';
	pinToggleButton.setAttribute('aria-label', isTaskbarPinned ? 'Unpin Taskbar' : 'Pin Taskbar');
}

function updateSpeakerIcon() {
	const volume = parseInt(mediaVolumeSlider.value, 10);
	const isMuted = volume === 0;
	const speakerButtonUnmuted = speakerButton.querySelector('.speaker-icon.unmuted');
	const speakerButtonMuted = speakerButton.querySelector('.speaker-icon.muted');
	speakerButtonUnmuted.classList.toggle('hidden', isMuted);
	speakerButtonMuted.classList.toggle('hidden', !isMuted);
	speakerButton.setAttribute('aria-label', isMuted ? 'Audio Muted' : 'Audio Settings');
	const audioPanelIcon = audioPanel.querySelector('.slider-group .icon');
	const audioPanelUnmuted = audioPanelIcon.querySelector('.speaker-icon.unmuted');
	const audioPanelMuted = audioPanelIcon.querySelector('.speaker-icon.muted');
	audioPanelUnmuted.classList.toggle('hidden', isMuted);
	audioPanelMuted.classList.toggle('hidden', !isMuted);
}

function updateSliderBackground(slider) {
	const value = (slider.value - slider.min) / (slider.max - slider.min) * 100;
	slider.style.setProperty('--value', `${value}%`);
}

function showTaskbar() {
	clearTimeout(taskbarHideTimeout);
	taskbar.classList.add('taskbar-visible');
	if (!activePanel) taskbarHideTimeout = setTimeout(hideTaskbar, HIDE_TASKBAR_TIMEOUT_MS);
}

function hideTaskbar() {
	if (activePanel) return;
	taskbar.classList.remove('taskbar-visible');
}
let lastPinToggleClickTime = 0;
const DOUBLE_CLICK_THRESHOLD_MS = 200;

function handlePinToggle(isDoubleClick = false) {
	if (isDoubleClick) {
		if (!document.fullscreenElement) {
			if (state.isRunning && elements.videoElement.classList.contains('visible')) elements.streamArea.requestFullscreen().catch(e => {});
		} else document.exitFullscreen();
	} else {
		isTaskbarPinned = !isTaskbarPinned;
		taskbar.classList.toggle('pinned', isTaskbarPinned);
		updatePinToggleIcon();
	}
	if (isTaskbarPinned) {
		showTaskbar();
		clearTimeout(taskbarHideTimeout);
	} else showTaskbar();
}

function handleWifiToggle() {
	if (state.ws && state.ws.readyState === WebSocket.OPEN) {
		const newWifiState = !state.isWifiOn;
		const message = {
			action: 'wifiToggle',
			enable: newWifiState
		};
		try {
			state.ws.send(JSON.stringify(message));
			const wifiToggleBtn = document.getElementById('wifiToggleBtn');
			wifiToggleBtn.classList.add('pending');
		} catch (error) {}
	}
}

function renderAppDrawer(apps) {
	elements.appGridContainer.innerHTML = '';
	elements.paginationContainer.innerHTML = '';
	elements.paginationDots = [];
	state.allApps = apps || [];
	state.totalPages = Math.ceil(state.allApps.length / state.appsPerPage);
	if (state.allApps.length === 0) {
		const noAppsMessage = document.createElement('div');
		noAppsMessage.textContent = 'No applications found.';
		noAppsMessage.style.textAlign = 'center';
		noAppsMessage.style.width = '100%';
		noAppsMessage.style.padding = '20px';
		elements.appGridContainer.appendChild(noAppsMessage);
	} else {
		elements.appGridContainer.style.width = `${state.totalPages * 100}%`;
		for (let i = 0; i < state.totalPages; i++) {
			const pageDiv = document.createElement('div');
			pageDiv.classList.add('app-grid');
			pageDiv.id = `appGridPage${i + 1}`;
			pageDiv.style.width = `${100 / state.totalPages}%`;
			const pageApps = state.allApps.slice(i * state.appsPerPage, (i + 1) * state.appsPerPage);
			pageApps.forEach(app => {
				const button = document.createElement('button');
				button.classList.add('app-button');
				button.setAttribute('data-package-name', app.packageName);
				button.setAttribute('title', `${app.label} (${app.packageName})`);
				const iconDiv = document.createElement('div');
				iconDiv.classList.add('app-icon');
				iconDiv.textContent = app.letter || '?';
				const labelSpan = document.createElement('span');
				labelSpan.textContent = app.label;
				button.appendChild(iconDiv);
				button.appendChild(labelSpan);
				button.addEventListener('click', (e) => {
					e.stopPropagation();
					if (state.ws && state.ws.readyState === WebSocket.OPEN) {
						const packageName = button.getAttribute('data-package-name');
						state.ws.send(JSON.stringify({
							action: 'launchApp',
							packageName
						}));
						closeAppDrawer();
					}
				});
				pageDiv.appendChild(button);
			});
			elements.appGridContainer.appendChild(pageDiv);
		}
	}
	if (state.totalPages > 1) {
		for (let i = 0; i < state.totalPages; i++) {
			const dot = document.createElement('span');
			dot.classList.add('dot');
			dot.setAttribute('data-page', i + 1);
			dot.addEventListener('click', (e) => {
				e.stopPropagation();
				showPage(i + 1);
			});
			elements.paginationContainer.appendChild(dot);
			elements.paginationDots.push(dot);
		}
	}
	if (state.currentPage > state.totalPages && state.totalPages > 0) state.currentPage = state.totalPages;
	else if (state.currentPage <= 0 && state.totalPages > 0) state.currentPage = 1;
	else if (state.totalPages === 0) state.currentPage = 1;
	showPage(state.currentPage);
}

function showPage(pageNumber) {
	let targetPage = parseInt(pageNumber, 10);
	if (isNaN(targetPage) || targetPage <= 0) targetPage = 1;
	if (targetPage > state.totalPages && state.totalPages > 0) targetPage = state.totalPages;
	if (state.totalPages === 0) targetPage = 1;
	if (state.totalPages > 0) elements.appGridContainer.style.transform = `translateX(-${(targetPage - 1) * (100 / state.totalPages)}%)`;
	elements.paginationDots.forEach((dot, index) => dot.classList.toggle('active', index === targetPage - 1));
	elements.prevPageButton.disabled = targetPage === 1 || state.totalPages === 0;
	elements.nextPageButton.disabled = targetPage === state.totalPages || state.totalPages <= 1;
	state.currentPage = targetPage;
}

function openAppDrawer() {
	closeActivePanel();
	elements.appDrawer.classList.add('active');
	activePanel = 'appDrawer';
	showPage(state.currentPage || 1);
	showTaskbar();
}

function closeAppDrawer() {
	elements.appDrawer.classList.remove('active');
	if (activePanel === 'appDrawer') activePanel = null;
	showTaskbar();
}
elements.prevPageButton.addEventListener('click', (e) => {
	e.stopPropagation();
	if (state.currentPage > 1) showPage(state.currentPage - 1);
});
elements.nextPageButton.addEventListener('click', (e) => {
	e.stopPropagation();
	if (state.currentPage < state.totalPages) showPage(state.currentPage + 1);
});
elements.appDrawerButton.addEventListener('click', (e) => {
	e.stopPropagation();
	if (activePanel === 'appDrawer') closeAppDrawer();
	else openAppDrawer();
});

function openPanel(panelId) {
	closeActivePanel();
	const panel = document.getElementById(panelId);
	if (panel) {
		panel.classList.add('active');
		activePanel = panelId;
		showTaskbar();
	}
}

function closeActivePanel() {
	if (activePanel) {
		const panelToClose = document.getElementById(activePanel) || elements[activePanel];
		if (panelToClose) panelToClose.classList.remove('active');
		const previouslyActivePanel = activePanel;
		activePanel = null;
		if (previouslyActivePanel !== 'appDrawer') showTaskbar();
	}
}
document.addEventListener('click', (e) => {
	const target = e.target;
	if (activePanel === 'appDrawer') {
		if (elements.appDrawer.classList.contains('active') && !elements.appDrawerContent.contains(target) && target !== elements.appDrawerButton && !elements.appDrawerButton.contains(target)) closeAppDrawer();
		return;
	}
	if (activePanel) {
		let clickedOnCurrentPanelOrTrigger = false;
		if (activePanel === 'audioPanel') {
			if (audioPanel.contains(target) || target === speakerButton || speakerButton.contains(target)) clickedOnCurrentPanelOrTrigger = true;
		} else if (activePanel === 'quickSettingsPanel') {
			if (quickSettingsPanel.contains(target) || target === quickSettingsTrigger || quickSettingsTrigger.contains(target)) clickedOnCurrentPanelOrTrigger = true;
		}
		if (!clickedOnCurrentPanelOrTrigger) closeActivePanel();
	}
});
elements.streamArea.addEventListener('mousemove', showTaskbar);
elements.streamArea.addEventListener('mouseleave', () => {
	clearTimeout(taskbarHideTimeout);
	if (!activePanel) hideTaskbar();
});
elements.streamArea.addEventListener('touchstart', showTaskbar, {
	passive: true
});
pinToggleButton.addEventListener('click', (e) => {
	e.stopPropagation();
	const currentTime = Date.now();
	const timeSinceLastClick = currentTime - lastPinToggleClickTime;
	if (timeSinceLastClick < DOUBLE_CLICK_THRESHOLD_MS) handlePinToggle(true);
	else handlePinToggle(false);
	lastPinToggleClickTime = currentTime;
	if (isTaskbarPinned) {
		showTaskbar();
		clearTimeout(taskbarHideTimeout);
	} else showTaskbar();
});
backButton.addEventListener('click', (e) => {
	e.stopPropagation();
	if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({
		action: 'navAction',
		key: 'back'
	}));
});
homeButton.addEventListener('click', (e) => {
	e.stopPropagation();
	if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({
		action: 'navAction',
		key: 'home'
	}));
});
recentsButton.addEventListener('click', (e) => {
	e.stopPropagation();
	if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({
		action: 'navAction',
		key: 'recents'
	}));
});
speakerButton.addEventListener('click', (e) => {
	e.stopPropagation();
	if (activePanel === 'audioPanel') closeActivePanel();
	else {
		openPanel('audioPanel');
		if (state.ws && state.ws.readyState === WebSocket.OPEN) try {
			state.ws.send(JSON.stringify({
				action: 'getVolume'
			}));
		} catch (error) {}
	}
});
quickSettingsTrigger.addEventListener('click', (e) => {
	e.stopPropagation();
	if (activePanel === 'quickSettingsPanel') closeActivePanel();
	else openPanel('quickSettingsPanel');
});

function sendVolumeUpdate(volumeValue) {
	if (state.ws && state.ws.readyState === WebSocket.OPEN) {
		const message = {
			action: 'volume',
			value: volumeValue
		};
		try {
			state.ws.send(JSON.stringify(message));
			lastVolumeSendTime = Date.now();
			pendingVolumeValue = null;
		} catch (e) {}
	}
}
mediaVolumeSlider.addEventListener('input', () => {
	const volumeValue = parseInt(mediaVolumeSlider.value, 10);
	updateSliderBackground(mediaVolumeSlider);
	updateSpeakerIcon();
	pendingVolumeValue = volumeValue;
	const now = Date.now();
	if (now - lastVolumeSendTime > VOLUME_THROTTLE_MS) {
		if (volumeChangeTimeout) clearTimeout(volumeChangeTimeout);
		sendVolumeUpdate(volumeValue);
	} else if (!volumeChangeTimeout) volumeChangeTimeout = setTimeout(() => {
		if (pendingVolumeValue !== null) sendVolumeUpdate(pendingVolumeValue);
		volumeChangeTimeout = null;
	}, VOLUME_THROTTLE_MS - (now - lastVolumeSendTime));
});
const sendFinalVolume = () => {
	if (volumeChangeTimeout) {
		clearTimeout(volumeChangeTimeout);
		volumeChangeTimeout = null;
	}
	const finalVolumeValue = parseInt(mediaVolumeSlider.value, 10);
	if (pendingVolumeValue !== null && pendingVolumeValue !== finalVolumeValue) sendVolumeUpdate(finalVolumeValue);
	else if (pendingVolumeValue !== null) sendVolumeUpdate(finalVolumeValue);
	pendingVolumeValue = null;
};
mediaVolumeSlider.addEventListener('mouseup', sendFinalVolume);
mediaVolumeSlider.addEventListener('touchend', sendFinalVolume);
document.getElementById('wifiToggleBtn').addEventListener('click', (e) => {
	e.stopPropagation();
	handleWifiToggle();
});

function handleResolutionChange(width, height) {
	if (!state.isRunning) return;
	if (width !== state.deviceWidth || height !== state.deviceHeight) {
		state.deviceWidth = width;
		state.deviceHeight = height;
		state.videoResolution = `${width}x${height}`;
		elements.streamArea.style.aspectRatio = state.deviceWidth > 0 && state.deviceHeight > 0 ? `${state.deviceWidth} / ${state.deviceHeight}` : '9 / 16';
	}
}

function updateBatteryLevel(level) {
	const batteryLevel = parseInt(level, 10);
	batteryLevelSpan.textContent = `${batteryLevel}`;
	const batteryFill = document.querySelector('.battery-fill');
	const batteryIcon = document.querySelector('.battery-icon');
	if (batteryFill) {
		const maxFillHeight = 14;
		const topY = 6.5;
		const bottomY = topY + maxFillHeight;
		const fillHeight = (batteryLevel / 100) * maxFillHeight;
		const yPosition = bottomY - fillHeight;
		batteryFill.setAttribute('height', fillHeight);
		batteryFill.setAttribute('y', yPosition);
	}
	if (batteryIcon) batteryIcon.classList.toggle('low-battery', batteryLevel <= 15);
}
elements.toggleLogBtn.addEventListener('click', () => {
	const isExpanded = elements.toggleLogBtn.getAttribute('aria-expanded') === 'true';
	elements.toggleLogBtn.setAttribute('aria-expanded', (!isExpanded).toString());
	elements.toggleLogBtn.textContent = isExpanded ? 'Show Logs' : 'Hide Logs';
	elements.logContent.classList.toggle('hidden', isExpanded);
});
const HIDE_HEADER_TIMEOUT_MS = 2500;

function showPageHeader() {
	if (elements.header.classList.contains('hidden')) elements.header.classList.remove('hidden');
}

function hidePageHeader() {
	if (!state.isHeaderMouseOver && elements.header && !elements.header.classList.contains('hidden')) elements.header.classList.add('hidden');
}

function resetHeaderTimeout() {
	clearTimeout(state.headerScrollTimeout);
	state.headerScrollTimeout = setTimeout(hidePageHeader, HIDE_HEADER_TIMEOUT_MS);
}
window.addEventListener('scroll', () => {
	showPageHeader();
	resetHeaderTimeout();
});
elements.header.addEventListener('mouseenter', () => {
	state.isHeaderMouseOver = true;
	clearTimeout(state.headerScrollTimeout);
	showPageHeader();
});
elements.header.addEventListener('mouseleave', () => {
	state.isHeaderMouseOver = false;
	resetHeaderTimeout();
});

function updateDisplayOptionsState() {
    const isStreaming = state.isRunning;
    const deviceSelected = !!state.selectedDeviceId;
    const canInteractWithOptions = !isStreaming && deviceSelected;

    elements.bitrateSelect.disabled = !canInteractWithOptions;
    elements.customBitrateInput.disabled = !canInteractWithOptions;
    elements.maxFpsSelect.disabled = !canInteractWithOptions;
    elements.noPowerOnInput.disabled = !canInteractWithOptions;
    elements.enableAudioInput.disabled = !canInteractWithOptions;
    elements.enableControlInput.disabled = !canInteractWithOptions;

    const enableControlChecked = elements.enableControlInput.checked;
    elements.turnScreenOffInput.disabled = !canInteractWithOptions || !enableControlChecked;
    elements.powerOffOnCloseInput.disabled = !canInteractWithOptions || !enableControlChecked;

    elements.displayModeCheckboxes.forEach(cb => cb.disabled = !canInteractWithOptions);

    const mode = state.currentDisplayMode;
    const isDex = mode === 'dex';
    const isNative = mode === 'native_taskbar';
    const isOverlay = mode === 'overlay';
    const isDefault = mode === 'default';

    elements.resolutionSelect.disabled = !canInteractWithOptions || isDex || isDefault;
    elements.customResolutionInput.disabled = !canInteractWithOptions || isDex || isDefault;
    elements.dpiSelect.disabled = !canInteractWithOptions || isDex || isDefault;
    elements.customDpiInput.disabled = !canInteractWithOptions || isDex || isDefault;
    elements.rotationLockSelect.disabled = !canInteractWithOptions || isDex || isNative;

    const rotateButtonShouldBeDisabled = !deviceSelected || !(isNative || isOverlay);
    elements.rotateAdbButton.disabled = rotateButtonShouldBeDisabled;
    elements.rotateAdbButton.classList.toggle('button-disabled', elements.rotateAdbButton.disabled);

    const updateLabelVisualState = (label, inputElement, isSpecialClass = false) => {
        if (label && inputElement) {
            const isDisabled = inputElement.disabled;
            const activeClass = isSpecialClass ? 'disabled-label' : 'disabled';
            const inactiveClass = isSpecialClass ? 'disabled' : 'disabled-label';

            label.classList.toggle(activeClass, isDisabled);
            if (isDisabled) {
                label.classList.remove(inactiveClass);
            }
        }
    };

    updateLabelVisualState(elements.resolutionLabel, elements.resolutionSelect);
    updateLabelVisualState(elements.dpiLabel, elements.dpiSelect);
    updateLabelVisualState(elements.rotationLockLabel, elements.rotationLockSelect);
    updateLabelVisualState(elements.rotateAdbButtonLabel, elements.rotateAdbButton);
    updateLabelVisualState(elements.noPowerOnLabel, elements.noPowerOnInput);
    updateLabelVisualState(elements.turnScreenOffLabel, elements.turnScreenOffInput, true);
    updateLabelVisualState(elements.powerOffOnCloseLabel, elements.powerOffOnCloseInput, true);
    updateLabelVisualState(document.querySelector('label[for=enableAudio]'), elements.enableAudioInput);
    updateLabelVisualState(document.querySelector('label[for=enableControl]'), elements.enableControlInput);

    if (isStreaming) {
        const controlsToDisableDuringStream = [
            elements.resolutionSelect, elements.customResolutionInput, elements.dpiSelect, elements.customDpiInput,
            elements.bitrateSelect, elements.customBitrateInput, elements.maxFpsSelect, elements.rotationLockSelect,
            elements.noPowerOnInput, elements.turnScreenOffInput, elements.powerOffOnCloseInput,
            elements.enableAudioInput, elements.enableControlInput, ...elements.displayModeCheckboxes
        ];
        controlsToDisableDuringStream.forEach(el => el.disabled = true);

        updateLabelVisualState(elements.resolutionLabel, elements.resolutionSelect);
        updateLabelVisualState(elements.dpiLabel, elements.dpiSelect);
        updateLabelVisualState(elements.rotationLockLabel, elements.rotationLockSelect);
        updateLabelVisualState(elements.noPowerOnLabel, elements.noPowerOnInput);
        updateLabelVisualState(elements.turnScreenOffLabel, elements.turnScreenOffInput, true);
        updateLabelVisualState(elements.powerOffOnCloseLabel, elements.powerOffOnCloseInput, true);
        updateLabelVisualState(document.querySelector('label[for=enableAudio]'), elements.enableAudioInput);
        updateLabelVisualState(document.querySelector('label[for=enableControl]'), elements.enableControlInput);
    }
}

elements.displayModeCheckboxes.forEach(checkbox => {
	checkbox.addEventListener('change', () => {
		if (checkbox.checked) {
			state.currentDisplayMode = checkbox.value;
			elements.displayModeCheckboxes.forEach(cb => {
				if (cb !== checkbox) cb.checked = false;
			});
		}
		updateDisplayOptionsState();
	});
});

elements.enableControlInput.addEventListener('change', function() {
	const noControl = !this.checked;

	if (noControl) {
		elements.turnScreenOffInput.checked = false;
		elements.powerOffOnCloseInput.checked = false;
	}
	updateDisplayOptionsState();
});

async function rotateDeviceScreen() {
	if (!state.selectedDeviceId || elements.rotateAdbButton.disabled) {
		appendLog("Cannot rotate: No device selected or button disabled.", true);
		return;
	}
	elements.rotateAdbButton.disabled = true;
	elements.rotateAdbSpinner.style.display = 'inline-block';
	try {
		const response = await sendAdbCommand({
			commandType: 'adbRotateScreen',
			deviceId: state.selectedDeviceId
		});
		if (response.success) {
			appendLog(response.message || "Screen rotated successfully.");
		} else {
			appendLog(`Rotation failed: ${response.error}`, true);
		}
	} catch (error) {
		appendLog(`Error rotating screen: ${error.message}`, true);
	} finally {
		elements.rotateAdbButton.disabled = false;
		elements.rotateAdbSpinner.style.display = 'none';
		updateDisplayOptionsState();
	}
}
elements.rotateAdbButton.addEventListener('click', rotateDeviceScreen);


document.addEventListener('DOMContentLoaded', () => {
	elements.themeToggle.setAttribute('aria-checked', document.body.getAttribute('data-theme') === 'dark' ? 'true' : 'false');
	setInterval(updateClock, 5000);
	updateClock();
	updateWifiIndicator();
	updatePinToggleIcon();
	updateSpeakerIcon();
	updateSliderBackground(mediaVolumeSlider);

	elements.displayModeCheckboxes.forEach(cb => cb.checked = false);
	const defaultDisplayModeCheckbox = document.getElementById('displayModeDefault');
	if (defaultDisplayModeCheckbox) {
		defaultDisplayModeCheckbox.checked = true;
	}
	state.currentDisplayMode = 'default';


	elements.noPowerOnInput.checked = false;
	elements.turnScreenOffInput.checked = false;
	elements.powerOffOnCloseInput.checked = false;
	elements.enableAudioInput.checked = false;
	elements.enableControlInput.checked = true;

	elements.refreshButton.disabled = true;
	elements.startButton.disabled = true;
	elements.stopButton.disabled = true;
	populateDeviceSelect([]);

	updateDisplayOptionsState();

	initializeWebSocket();
	showPageHeader();
	resetHeaderTimeout();

	elements.addWirelessDeviceBtn.addEventListener('click', showAddWirelessDeviceModal);
	elements.closeAddWirelessModalBtn.addEventListener('click', hideAddWirelessDeviceModal);
	elements.connectByIpBtn.addEventListener('click', handleConnectByIp);
	elements.pairByQrBtn.addEventListener('click', handlePairByQr);
	elements.closeQrPairingModalBtn.addEventListener('click', hideQrPairingModal);
	elements.qrPairingDoneBtn.addEventListener('click', hideQrPairingModal);
	elements.addWirelessDeviceModalOverlay.addEventListener('click', (event) => {
		if (event.target === elements.addWirelessDeviceModalOverlay) {
			hideAddWirelessDeviceModal();
		}
	});
	elements.qrPairingModalOverlay.addEventListener('click', (event) => {
		if (event.target === elements.qrPairingModalOverlay) {
			hideQrPairingModal();
		}
	});
});