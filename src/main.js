const VideoConverter = require('h264-converter').default;
const { setLogger } = require('h264-converter');

setLogger(() => {}, (message) => appendLog(message, true));

const CHECK_STATE_INTERVAL_MS = 250;
const MAX_SEEK_WAIT_MS = 1500;
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
const BINARY_TYPES = { VIDEO: 0, AUDIO: 1 };
const CODEC_IDS = { H264: 0x68323634, AAC: 0x00616163 };
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

const elements = {
    startButton: document.getElementById('startBtn'),
    stopButton: document.getElementById('stopBtn'),
    bitrateSelect: document.getElementById('bitrate'),
    maxSizeSelect: document.getElementById('maxSize'),
    maxFpsSelect: document.getElementById('maxFps'),
    enableAudioInput: document.getElementById('enableAudio'),
    enableControlInput: document.getElementById('enableControl'),
    themeToggle: document.getElementById('themeToggle'),
    fullscreenBtn: document.getElementById('fullscreenBtn'),
    streamArea: document.getElementById('streamArea'),
    videoPlaceholder: document.getElementById('videoPlaceholder'),
    videoElement: document.getElementById('screen'),
    videoBorder: document.getElementById('videoBorder'),
    flipOrientationBtn: document.getElementById('flipOrientationBtn'),
	logArea: document.getElementById('logArea'),
    logContent: document.getElementById('logContent'),
    toggleLogBtn: document.getElementById('toggleLogBtn'),
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
    lastMousePosition: { x: 0, y: 0 },
    nextAudioTime: 0,
    totalAudioFrames: 0,
	isWifiOn: true,
	wifiSsid: null,
};


const MAX_LOG_LINES = 50;
const logMessages = [];

const appendLog = (message, isError = false) => {
    const timestamp = new Date().toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    logMessages.push({ message: `[${timestamp}] ${message}`, isError });
    if (logMessages.length > MAX_LOG_LINES) {
        logMessages.shift();
    }
    updateLogDisplay();
};

const updateLogDisplay = () => {
    elements.logContent.innerHTML = logMessages
        .map(({ message, isError }) => `<div style="${isError ? 'color: #ff4444;' : ''}">${message}</div>`)
        .join('');
    elements.logContent.scrollTop = elements.logContent.scrollHeight;
};

const updateStatus = (message) => appendLog(message);

const originalConsoleError = console.error;
console.error = (message, ...args) => {
    const formattedMessage = [message, ...args].join(' ');
    appendLog(formattedMessage, true);
    originalConsoleError(message, ...args);
};

const updateVideoBorder = () => {
    const video = elements.videoElement;
    const border = elements.videoBorder;
    const container = elements.streamArea;

    if (!state.isRunning || state.deviceWidth === 0 || state.deviceHeight === 0 || !video.classList.contains('visible')) {
        border.style.display = 'none';
        return;
    }

    const videoWidth = state.deviceWidth;
    const videoHeight = state.deviceHeight;
    const elementWidth = video.clientWidth;
    const elementHeight = video.clientHeight;

    if (elementWidth === 0 || elementHeight === 0) {
        border.style.display = 'none';
        return;
    }

    const videoAspectRatio = videoWidth / videoHeight;
    const elementAspectRatio = elementWidth / elementHeight;

    let renderedVideoWidth, renderedVideoHeight;
    let offsetX = 0, offsetY = 0;

    if (elementAspectRatio > videoAspectRatio) {
        renderedVideoHeight = elementHeight;
        renderedVideoWidth = elementHeight * videoAspectRatio;
        offsetX = (elementWidth - renderedVideoWidth) / 2;
    } else {
        renderedVideoWidth = elementWidth;
        renderedVideoHeight = elementWidth / videoAspectRatio;
        offsetY = (elementHeight - renderedVideoHeight) / 2;
    }

    const borderLeft = video.offsetLeft + offsetX;
    const borderTop = video.offsetTop + offsetY;

    border.style.left = `${borderLeft}px`;
    border.style.top = `${borderTop}px`;
    const borderWidth = 3;
    border.style.width = `${renderedVideoWidth}px`;
    border.style.height = `${renderedVideoHeight}px`;
    border.style.display = 'block';
};

const isIFrame = (frameData) => {
    if (!frameData || frameData.length < 1) return false;
    let offset = frameData.length > 4 && frameData[0] === 0 && frameData[1] === 0 && frameData[2] === 0 && frameData[3] === 1 ? 4 :
        frameData.length > 3 && frameData[0] === 0 && frameData[1] === 0 && frameData[2] === 1 ? 3 : 0;
    return frameData.length > offset && (frameData[offset] & 0x1F) === NALU_TYPE_IDR;
};

const initVideoConverter = () => {
    const fps = parseInt(elements.maxFpsSelect.value) || DEFAULT_FRAMES_PER_SECOND;
    state.converter = new VideoConverter(elements.videoElement, fps, DEFAULT_FRAMES_PER_FRAGMENT);
    state.sourceBufferInternal = state.converter?.sourceBuffer || null;

    elements.videoElement.addEventListener('canplay', onVideoCanPlay, { once: true });
    elements.videoElement.removeEventListener('error', onVideoError);
    elements.videoElement.addEventListener('error', onVideoError);
};

const onVideoCanPlay = () => {
    if (state.isRunning) {
        elements.videoElement.play().catch(e => console.warn("Autoplay prevented:", e));
    }
};

const onVideoError = (e) => {
    appendLog(`Video Element Error: ${e.message}`, true);
    appendLog(`Video Error: ${elements.videoElement.error?.message} (Code: ${elements.videoElement.error?.code})`, true);
};

const cleanSourceBuffer = () => {
    if (!state.sourceBufferInternal || state.sourceBufferInternal.updating || state.removeStart < 0 || state.removeEnd <= state.removeStart) {
        state.sourceBufferInternal?.removeEventListener('updateend', cleanSourceBuffer);
        state.removeStart = state.removeEnd = -1;
        return;
    }

	try {
		appendLog(`Removing source buffer range: ${state.removeStart.toFixed(3)} - ${state.removeEnd.toFixed(3)}`);
		state.sourceBufferInternal.remove(state.removeStart, state.removeEnd);
		state.sourceBufferInternal.addEventListener('updateend', cleanSourceBuffer, { once: true });
	} catch (e) {
		appendLog(`Failed to clean source buffer: ${e.message}`, true);
		state.sourceBufferInternal?.removeEventListener('updateend', cleanSourceBuffer);
		state.removeStart = state.removeEnd = -1;
	}
};

const checkForIFrameAndCleanBuffer = (frameData) => {
    if (IS_SAFARI || !isIFrame(frameData)) {
        return;
    }

    if (!state.sourceBufferInternal) {
        state.sourceBufferInternal = state.converter?.sourceBuffer || null;
        if (!state.sourceBufferInternal) return;
    }

    if (elements.videoElement.buffered && elements.videoElement.buffered.length) {
        const start = elements.videoElement.buffered.start(0);
        const end = elements.videoElement.buffered.end(0) | 0;

        if (end !== 0 && start < end) {
            if (state.removeEnd !== -1) {
                state.removeEnd = end;
            } else {
                state.removeStart = start;
                state.removeEnd = end;
            }
            state.sourceBufferInternal.addEventListener('updateend', cleanSourceBuffer, { once: true });
        }
    }
};

const getVideoPlaybackQuality = () => {
    const video = elements.videoElement;
    if (!video) return null;

    const now = Date.now();
    if (typeof video.getVideoPlaybackQuality === 'function') {
        const temp = video.getVideoPlaybackQuality();
        return {
            timestamp: now,
            decodedFrames: temp.totalVideoFrames,
            droppedFrames: temp.droppedVideoFrames,
        };
    }

    if (typeof video.webkitDecodedFrameCount !== 'undefined') {
        return {
            timestamp: now,
            decodedFrames: video.webkitDecodedFrameCount,
            droppedFrames: video.webkitDroppedFrameCount,
        };
    }
    return null;
};

const calculateMomentumStats = () => {
    const stat = getVideoPlaybackQuality();
    if (!stat) return;

    const timestamp = Date.now();
    const oneSecondBefore = timestamp - 1000;
    state.videoStats.push(stat);
    state.videoStats = state.videoStats.filter(s => s.timestamp >= oneSecondBefore);
    state.inputBytes = state.inputBytes.filter(b => b.timestamp >= oneSecondBefore);

    const inputBytes = state.inputBytes.reduce((sum, item) => sum + item.bytes, 0);
    const inputFrames = state.inputBytes.length;

    if (state.videoStats.length) {
        const oldest = state.videoStats[0];
        const decodedFrames = stat.decodedFrames - oldest.decodedFrames;
        const droppedFrames = stat.droppedFrames - oldest.droppedFrames;
        state.momentumQualityStats = {
            decodedFrames,
            droppedFrames,
            inputBytes,
            inputFrames,
            timestamp,
        };
    }
};

const checkForBadState = () => {
    if (!state.isRunning || !state.converter) return;

    const { currentTime } = elements.videoElement;
    const now = Date.now();
    let hasReasonToJump = false;

    calculateMomentumStats();

    if (state.momentumQualityStats) {
        if (state.momentumQualityStats.decodedFrames === 0 && state.momentumQualityStats.inputFrames > 0) {
            if (state.noDecodedFramesSince === -1) {
                state.noDecodedFramesSince = now;
            } else {
                const time = now - state.noDecodedFramesSince;
                if (time > MAX_TIME_TO_RECOVER) {
                    hasReasonToJump = true;
                }
            }
        } else {
            state.noDecodedFramesSince = -1;
        }
    }

    if (currentTime === state.lastVideoTime && state.currentTimeNotChangedSince === -1) {
        state.currentTimeNotChangedSince = now;
    } else {
        state.currentTimeNotChangedSince = -1;
    }
    state.lastVideoTime = currentTime;

    if (elements.videoElement.buffered.length) {
        const end = elements.videoElement.buffered.end(0);
        const buffered = end - currentTime;

        if ((end | 0) - currentTime > MAX_BUFFER) {
            if (state.bigBufferSince === -1) {
                state.bigBufferSince = now;
            } else {
                const time = now - state.bigBufferSince;
                if (time > MAX_TIME_TO_RECOVER) {
                    hasReasonToJump = true;
                }
            }
        } else {
            state.bigBufferSince = -1;
        }

        if (buffered < MAX_AHEAD) {
            if (state.aheadOfBufferSince === -1) {
                state.aheadOfBufferSince = now;
            } else {
                const time = now - state.aheadOfBufferSince;
                if (time > MAX_TIME_TO_RECOVER) {
                    hasReasonToJump = true;
                }
            }
        } else {
            state.aheadOfBufferSince = -1;
        }

        if (state.currentTimeNotChangedSince !== -1) {
            const time = now - state.currentTimeNotChangedSince;
            if (time > MAX_TIME_TO_RECOVER) {
                hasReasonToJump = true;
            }
        }

        if (!hasReasonToJump) return;

        let waitingForSeekEnd = 0;
        if (state.seekingSince !== -1) {
            waitingForSeekEnd = now - state.seekingSince;
            if (waitingForSeekEnd < MAX_SEEK_WAIT_MS) {
                return;
            }
        }

        const onSeekEnd = () => {
            state.seekingSince = -1;
            elements.videoElement.removeEventListener('seeked', onSeekEnd);
            elements.videoElement.play().catch(e => console.warn("Autoplay prevented after seek:", e));
        };

		if (state.seekingSince !== -1) {
			appendLog(`Attempt to seek while already seeking! ${waitingForSeekEnd}`, true);
		}
        state.seekingSince = now;
        elements.videoElement.addEventListener('seeked', onSeekEnd);
        elements.videoElement.currentTime = end;
    }
};

const setupAudioPlayer = (codecId, metadata) => {
    if (codecId !== CODEC_IDS.AAC) {
        appendLog(`Unsupported audio codec ID: 0x${codecId.toString(16)}`);
        return;
    }
    if (!window.AudioContext || !window.AudioDecoder) {
        updateStatus('Audio not supported in this browser');
        return;
    }

    try {
		if (!state.audioContext || state.audioContext.state === 'closed') {
			state.audioContext = new AudioContext({
				sampleRate: metadata.sampleRate || 48000,
			});
		}

        state.audioDecoder = new AudioDecoder({
            output: (audioData) => {
                try {
                    const numberOfChannels = audioData.numberOfChannels;
                    const sampleRate = audioData.sampleRate;
                    const bufferLength = Math.max(audioData.numberOfFrames, 8192);
                    const buffer = state.audioContext.createBuffer(
                        numberOfChannels,
                        bufferLength,
                        sampleRate
                    );

                    const isInterleaved = audioData.format === 'f32' || audioData.format === 'f32-interleaved';
                    if (isInterleaved) {
                        const interleavedData = new Float32Array(audioData.numberOfFrames * numberOfChannels);
                        audioData.copyTo(interleavedData, { planeIndex: 0 });

                        for (let channel = 0; channel < numberOfChannels; channel++) {
                            const channelData = buffer.getChannelData(channel);
                            for (let i = 0; i < audioData.numberOfFrames; i++) {
                                channelData[i] = interleavedData[i * numberOfChannels + channel];
                            }
                        }
                    } else {
                        for (let channel = 0; channel < numberOfChannels; channel++) {
                            audioData.copyTo(buffer.getChannelData(channel), { planeIndex: channel });
                        }
                    }

                    const source = state.audioContext.createBufferSource();
                    source.buffer = buffer;
                    source.connect(state.audioContext.destination);
                    const currentTime = state.audioContext.currentTime;
                    const bufferDuration = audioData.numberOfFrames / sampleRate;
					if (state.nextAudioTime < currentTime) {
						console.warn(`Audio scheduling behind by ${currentTime - state.nextAudioTime}s`);
						state.nextAudioTime = currentTime;
					}
                    source.start(state.nextAudioTime);
                    state.nextAudioTime += bufferDuration;
                } catch (e) {
                    console.error(`Error processing decoded audio: ${e}`);
                }
            },
            error: (error) => {
                console.error(`AudioDecoder error: ${error}`);
            },
        });

        state.audioDecoder.configure({
            codec: 'mp4a.40.2',
            sampleRate: metadata.sampleRate || 48000,
            numberOfChannels: metadata.channelConfig || 2,
        });

        state.audioCodecId = codecId;
        state.audioMetadata = metadata;
        state.receivedFirstAudioPacket = false;
        state.nextAudioTime = 0;
        state.totalAudioFrames = 0;
    } catch (e) {
        appendLog(`Failed to setup AudioDecoder: ${e}`);
        state.audioDecoder = null;
        state.audioContext = null;
        updateStatus('Failed to initialize audio');
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
            data: uint8Array,
        }));
        state.totalAudioFrames += 1024;
        state.receivedFirstAudioPacket = true;
    } catch (e) {
        console.error(`Error decoding audio data: ${e}`);
    }
};

const getScaledCoordinates = (event) => {
    const video = elements.videoElement;
    const screenInfo = {
        videoSize: {
            width: state.deviceWidth,
            height: state.deviceHeight
        }
    };

    if (!screenInfo || !screenInfo.videoSize || !screenInfo.videoSize.width || !screenInfo.videoSize.height) {
        return null;
    }
    const { width, height } = screenInfo.videoSize;
    const target = video;
    const rect = target.getBoundingClientRect();
    let { clientWidth, clientHeight } = target;

    let touchX = event.clientX - rect.left;
    let touchY = event.clientY - rect.top;

    const videoRatio = width / height;
    const elementRatio = clientWidth / clientHeight;

    if (elementRatio > videoRatio) {
        const realWidth = clientHeight * videoRatio;
        const barsWidth = (clientWidth - realWidth) / 2;
        if (touchX < barsWidth || touchX > barsWidth + realWidth) {
            return null;
        }
        touchX -= barsWidth;
        clientWidth = realWidth;
    } else if (elementRatio < videoRatio) {
        const realHeight = clientWidth / videoRatio;
        const barsHeight = (clientHeight - realHeight) / 2;
        if (touchY < barsHeight || touchY > barsHeight + realHeight) {
            return null;
        }
        touchY -= barsHeight;
        clientHeight = realHeight;
    }

    let deviceX = Math.round((touchX * width) / clientWidth);
    let deviceY = Math.round((touchY * height) / clientHeight);

    deviceX = Math.max(0, Math.min(width, deviceX));
    deviceY = Math.max(0, Math.min(height, deviceY));

    return { x: deviceX, y: deviceY };
};

const sendControlMessage = (buffer) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN && state.controlEnabledAtStart) {
        try {
            state.ws.send(buffer);
        } catch (e) {
            console.error("Failed to send control message:", e);
        }
    }
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
        case 0: buttonFlag = AMOTION_EVENT_BUTTON_PRIMARY; break;
        case 1: buttonFlag = AMOTION_EVENT_BUTTON_TERTIARY; break;
        case 2: buttonFlag = AMOTION_EVENT_BUTTON_SECONDARY; break;
        default: return;
    }
    state.currentMouseButtons |= buttonFlag;

    const coords = getScaledCoordinates(event);
    if (coords) {
        state.lastMousePosition = coords;
        sendMouseEvent(AMOTION_EVENT_ACTION_DOWN, state.currentMouseButtons, coords.x, coords.y);
    } else {
        appendLog(`Mouse Down - Invalid coordinates: Raw: (${event.clientX}, ${event.clientY})`);
    }
};

const handleMouseUp = (event) => {
    if (!state.isMouseDown) return;

    if (!state.isRunning || !state.controlEnabledAtStart || !state.deviceWidth || !state.deviceHeight) return;
    event.preventDefault();

    let buttonFlag = 0;
    switch (event.button) {
        case 0: buttonFlag = AMOTION_EVENT_BUTTON_PRIMARY; break;
        case 1: buttonFlag = AMOTION_EVENT_BUTTON_TERTIARY; break;
        case 2: buttonFlag = AMOTION_EVENT_BUTTON_SECONDARY; break;
        default: return;
    }

    if (!(state.currentMouseButtons & buttonFlag)) {
        return;
    }

    const coords = getScaledCoordinates(event);
    const finalCoords = coords || state.lastMousePosition;

    sendMouseEvent(AMOTION_EVENT_ACTION_UP, state.currentMouseButtons, finalCoords.x, finalCoords.y);

    state.currentMouseButtons &= ~buttonFlag;

    if (state.currentMouseButtons === 0) {
        state.isMouseDown = false;
    }
};

const handleMouseMove = (event) => {
    if (!state.isRunning || !state.controlEnabledAtStart || !state.deviceWidth || !state.deviceHeight || !state.isMouseDown) return;
    event.preventDefault();

    const coords = getScaledCoordinates(event);
    if (coords) {
        state.lastMousePosition = coords;
        sendMouseEvent(AMOTION_EVENT_ACTION_MOVE, state.currentMouseButtons, coords.x, coords.y);
    } else {
        appendLog(`Mouse Move - Invalid coordinates: Raw: (${event.clientX}, ${event.clientY})`);
    }
};

const handleMouseLeave = (event) => {
    if (!state.isRunning || !state.controlEnabledAtStart || !state.isMouseDown || state.currentMouseButtons === 0) return;
    event.preventDefault();

    appendLog(`Mouse leave while buttons pressed: ${state.currentMouseButtons}`);
    sendMouseEvent(AMOTION_EVENT_ACTION_UP, state.currentMouseButtons, state.lastMousePosition.x, state.lastMousePosition.y);

    state.isMouseDown = false;
    state.currentMouseButtons = 0;
};

const startStreaming = () => {
    if (state.isRunning || (state.ws && state.ws.readyState === WebSocket.OPEN)) {
        appendLog('Cannot start stream: Already running or WebSocket open');
        return;
    }

    updateStatus('Connecting...');
    elements.startButton.disabled = true;
    elements.stopButton.disabled = false;
    elements.maxSizeSelect.disabled = true;
    elements.maxFpsSelect.disabled = true;
    elements.bitrateSelect.disabled = true;
    elements.enableAudioInput.disabled = true;
    elements.enableControlInput.disabled = true;
    elements.flipOrientationBtn.disabled = true;

    state.controlEnabledAtStart = elements.enableControlInput.checked;

    Object.assign(state, {
        ws: null, converter: null, audioContext: null, audioDecoder: null,
        sourceBufferInternal: null, checkStateIntervalId: null, currentTimeNotChangedSince: -1,
        bigBufferSince: -1, aheadOfBufferSince: -1, lastVideoTime: -1, seekingSince: -1,
        removeStart: -1, removeEnd: -1, receivedFirstAudioPacket: false, audioMetadata: null,
        videoStats: [], inputBytes: [], momentumQualityStats: null, noDecodedFramesSince: -1,
        isMouseDown: false, currentMouseButtons: 0, lastMousePosition: { x: 0, y: 0 },
        nextAudioTime: 0, totalAudioFrames: 0, deviceWidth: 0, deviceHeight: 0,
        videoResolution: 'Unknown', isRunning: true,
    });

    state.ws = new WebSocket(`ws://${window.location.hostname}:8080`);
    state.ws.binaryType = 'arraybuffer';

    state.ws.onopen = () => {
        appendLog('WebSocket connected');
        updateStatus('Connected, initializing stream...');
        const message = {
            action: 'start',
            maxSize: parseInt(elements.maxSizeSelect.value) || 0,
            maxFps: parseInt(elements.maxFpsSelect.value) || 0,
            bitrate: (parseInt(elements.bitrateSelect.value) || 8) * 1000000,
            enableAudio: elements.enableAudioInput.checked,
            enableControl: state.controlEnabledAtStart,
            video: true,
        };
        state.ws.send(JSON.stringify(message));
        initVideoConverter();
    };

    state.ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
            try {
                const message = JSON.parse(event.data);
                switch (message.type) {
                    case 'deviceName':
                        appendLog(`Device Name: ${message.name}`);
                        updateStatus(`Connected to ${message.name}`);
                        break;
                    case 'videoInfo':
                        state.deviceWidth = message.width;
                        state.deviceHeight = message.height;
                        state.videoResolution = `${message.width}x${message.height}`;
                        appendLog(`Video Info: Codec=0x${message.codecId.toString(16)}, ${state.videoResolution}`);
                        elements.streamArea.style.aspectRatio = state.deviceWidth > 0 && state.deviceHeight > 0 ?
                            `${state.deviceWidth} / ${state.deviceHeight}` : '9 / 16';
                        elements.videoPlaceholder.classList.add('hidden');
                        elements.videoElement.classList.add('visible');
                        if (state.converter) {
                            requestAnimationFrame(() => {
                                elements.videoElement.play().catch(e => console.warn("Autoplay prevented:", e));
                                setTimeout(updateVideoBorder, 50);
                            });
                        } else {
                            setTimeout(updateVideoBorder, 50);
                        }
                        break;
                    case 'audioInfo':
                        appendLog(`Audio Info: Codec=0x${message.codecId.toString(16)}${message.metadata ? `, Metadata=${JSON.stringify(message.metadata)}` : ''}`);
                        if (message.codecId === CODEC_IDS.AAC && message.metadata && elements.enableAudioInput.checked) {
                            setupAudioPlayer(message.codecId, message.metadata);
                        }
                        break;
                    case 'status':
                        appendLog(`Status: ${message.message}`);
                        updateStatus(message.message);
                        if (message.message === 'Streaming started') {
                            elements.flipOrientationBtn.disabled = false;
                            elements.videoElement.classList.toggle('control-enabled', state.controlEnabledAtStart);
                            state.checkStateIntervalId = setInterval(checkForBadState, CHECK_STATE_INTERVAL_MS);
							state.ws.send(JSON.stringify({ action: 'getBatteryLevel' }));
							requestWifiStatus();
                        } else if (message.message === 'Streaming stopped') {
                            stopStreaming(false);
                        }
						  else if (message.message === 'Audio disabled') {
							elements.enableAudioInput.checked = false;
							appendLog('Audio disabled due to Android version < 11');
							updateStatus('Audio disabled: Android version < 11 not supported.');
						}
                        break;
                    case 'error':
                        appendLog(`Error: ${message.message}`);
                        updateStatus(`Error: ${message.message}`);
                        stopStreaming(false);
                        break;
                    case 'deviceMessage':
                        try {
                            const deviceData = new Uint8Array(Buffer.from(message.data, 'base64'));
                            appendLog(`Device Message: ${deviceData.length} bytes`);
                        } catch (e) {
                            console.error(`Error processing device message: ${e}`);
                        }
                        break;
                    case 'volumeResponse':
                        if (message.success) {
                            updateStatus(`Volume command acknowledged for ${message.requestedValue}%`);
                        } else {
                            updateStatus(`Failed to set volume: ${message.error}`);                        }
                        break;

					case 'volumeInfo':
						if (message.success) {
							mediaVolumeSlider.value = message.volume;
							updateSliderBackground(mediaVolumeSlider);
							updateSpeakerIcon();
							updateStatus(`Current volume: ${message.volume}%`);
							appendLog(`Received volume info: ${message.volume}%`);
						} else {
							updateStatus(`Failed to get volume: ${message.error}`);
							appendLog(`Failed to get volume: ${message.error}`);
						}
						break;
					case 'navResponse':
						if (message.success) {
							updateStatus(`Navigation ${message.key} command executed`);
							appendLog(`Navigation ${message.key} command succeeded`);
						} else {
							updateStatus(`Failed to execute ${message.key} command: ${message.error}`);
							appendLog(`Navigation ${message.key} command failed: ${message.error}`);
						}
						break;
					case 'wifiResponse':
						const wifiToggleBtn = document.getElementById('wifiToggleBtn');
						wifiToggleBtn.classList.remove('pending');
						if (message.success) {
							state.isWifiOn = message.currentState;
							state.wifiSsid = message.ssid;
							updateWifiIndicator();
							updateStatus(`Wi-Fi ${state.isWifiOn ? 'enabled' : 'disabled'}${state.isWifiOn && state.wifiSsid ? ` (Connected to ${state.wifiSsid})` : ''}`);
							appendLog(`Wi-Fi toggled successfully: ${state.isWifiOn ? 'Enabled' : 'Disabled'}${state.isWifiOn && state.wifiSsid ? ` (SSID: ${state.wifiSsid})` : ''}`);
						} else {
							updateStatus(`Failed to toggle Wi-Fi: ${message.error}`);
							appendLog(`Failed to toggle Wi-Fi: ${message.error}`);
						}
						break;
					case 'wifiStatus':
						if (message.success) {
							state.isWifiOn = message.isWifiOn;
							state.wifiSsid = message.ssid;
							updateWifiIndicator();
							updateStatus(`Wi-Fi is ${state.isWifiOn ? 'enabled' : 'disabled'}${state.isWifiOn && state.wifiSsid ? ` (Connected to ${state.wifiSsid})` : ''}`);
							appendLog(`Wi-Fi status: ${state.isWifiOn ? 'Enabled' : 'Disabled'}${state.isWifiOn && state.wifiSsid ? ` (SSID: ${state.wifiSsid})` : ''}`);
						} else {
							updateStatus(`Failed to get Wi-Fi status: ${message.error}`);
							appendLog(`Failed to get Wi-Fi status: ${message.error}`);
						}
						break;
					case 'batteryInfo':
						if (message.success) {
							updateBatteryLevel(message.batteryLevel);
							updateStatus(`Battery level: ${message.batteryLevel}%`);
							appendLog(`Received battery level: ${message.batteryLevel}%`);
						} else {
							updateStatus(`Failed to get battery level: ${message.error}`);
							appendLog(`Failed to get battery level: ${message.error}`);
						}
						break;						
                    default:
                        appendLog(`Unknown message type: ${message.type}`);
                }
            } catch (e) {
                console.error(`Error parsing JSON message: ${e}`);
            }
        } else if (event.data instanceof ArrayBuffer) {
            const dataView = new DataView(event.data);
            if (dataView.byteLength < 1) return;

            const type = dataView.getUint8(0);
            const payload = event.data.slice(1);
            const payloadUint8 = new Uint8Array(payload);

            if (type === BINARY_TYPES.VIDEO && state.converter) {
                state.inputBytes.push({ timestamp: Date.now(), bytes: payload.byteLength });
                state.converter.appendRawData(payloadUint8);
                checkForIFrameAndCleanBuffer(payloadUint8);
            } else if (type === BINARY_TYPES.AUDIO && elements.enableAudioInput.checked) {
                handleAudioData(payload);
            }
        }
    };

    state.ws.onclose = (event) => {
        appendLog(`WebSocket closed (Code: ${event.code}, Reason: ${event.reason})`);
        stopStreaming(false);
    };

    state.ws.onerror = (error) => {
        appendLog(`WebSocket error: ${error}`);
        updateStatus('WebSocket error');
        stopStreaming(false);
    };
};

const stopStreaming = (sendDisconnect = true) => {
    if (!state.isRunning && !sendDisconnect && !(state.ws && state.ws.readyState < WebSocket.CLOSING)) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.close(1000, 'Cleanup closure');
        }
        return;
    }

    if (state.ws && state.ws.readyState === WebSocket.OPEN && sendDisconnect) {
        try {
            state.ws.send(JSON.stringify({ action: 'disconnect' }));
        } catch (e) {
            console.error("Error sending disconnect message:", e);
        }
        state.ws.close(1000, 'User stopped streaming');
    }
    state.ws = null;

    if (state.checkStateIntervalId) {
        clearInterval(state.checkStateIntervalId);
        state.checkStateIntervalId = null;
    }

    if (state.audioDecoder) {
        state.audioDecoder.close();
        state.audioDecoder = null;
    }
    if (state.audioContext) {
        state.audioContext.close();
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
        } catch (e) {
            console.error("Error during converter cleanup:", e);
        }
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

    if (!sendDisconnect) {
        state.isRunning = false;
        updateStatus('Disconnected');
        elements.startButton.disabled = false;
        elements.stopButton.disabled = true;
        elements.maxSizeSelect.disabled = false;
        elements.maxFpsSelect.disabled = false;
        elements.bitrateSelect.disabled = false;
        elements.enableAudioInput.disabled = false;
        elements.enableControlInput.disabled = false;
        elements.flipOrientationBtn.disabled = true;
    }

    Object.assign(state, {
        currentTimeNotChangedSince: -1, bigBufferSince: -1, aheadOfBufferSince: -1,
        lastVideoTime: -1, seekingSince: -1, removeStart: -1, removeEnd: -1,
        videoStats: [], inputBytes: [], momentumQualityStats: null, noDecodedFramesSince: -1,
        isMouseDown: false, currentMouseButtons: 0, lastMousePosition: { x: 0, y: 0 },
        deviceWidth: 0, deviceHeight: 0, videoResolution: 'Unknown',
    });
};

elements.startButton.addEventListener('click', startStreaming);
elements.stopButton.addEventListener('click', () => stopStreaming(true));
elements.themeToggle.addEventListener('click', () => {
    const body = document.body;
    const newTheme = body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    body.setAttribute('data-theme', newTheme);
    appendLog(`Theme switched to ${newTheme}`);
});

let themeToggleTimeout;
const showThemeToggle = () => {
    elements.themeToggle.classList.remove('hidden');
    clearTimeout(themeToggleTimeout);
    themeToggleTimeout = setTimeout(() => elements.themeToggle.classList.add('hidden'), 3000);
};

['mousemove', 'scroll', 'touchstart'].forEach(event =>
    document.addEventListener(event, showThemeToggle)
);
showThemeToggle();

elements.fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        if (state.isRunning && elements.videoElement.classList.contains('visible')) {
             elements.streamArea.requestFullscreen().catch(e => console.error(`Fullscreen error: ${e}`));
        } else {
            appendLog("Cannot enter fullscreen: Stream not running or video not visible");
        }
    } else {
        document.exitFullscreen();
    }
});

document.addEventListener('fullscreenchange', () => {
    const isFullscreen = document.fullscreenElement === elements.streamArea;
    elements.streamArea.classList.toggle('in-fullscreen-mode', isFullscreen);
    appendLog(isFullscreen ? 'Entered fullscreen' : 'Exited fullscreen');
    requestAnimationFrame(updateVideoBorder);
});

elements.flipOrientationBtn.addEventListener('click', () => {
    if (!state.isRunning) {
        appendLog("Cannot flip orientation: Stream not running");
        return;
    }
    if (state.deviceWidth > 0 && state.deviceHeight > 0) {
        appendLog(`Flipping orientation from ${state.deviceWidth}x${state.deviceHeight}`);
        const tempWidth = state.deviceWidth;
        state.deviceWidth = state.deviceHeight;
        state.deviceHeight = tempWidth;
        state.videoResolution = `${state.deviceWidth}x${state.deviceHeight}`;

        appendLog(`New orientation: ${state.deviceWidth}x${state.deviceHeight}`);
        elements.streamArea.style.aspectRatio = state.deviceWidth > 0 && state.deviceHeight > 0 ?
            `${state.deviceWidth} / ${state.deviceHeight}` : '9 / 16';

        requestAnimationFrame(() => {
            updateVideoBorder();
        });
    } else {
        appendLog("Cannot flip orientation: Dimensions not set");
    }
});

window.addEventListener('beforeunload', () => {
    if (state.isRunning || (state.ws && state.ws.readyState === WebSocket.OPEN)) {
        stopStreaming(true);
    }
});

elements.videoElement.addEventListener('mousedown', handleMouseDown);
document.addEventListener('mouseup', handleMouseUp);
elements.videoElement.addEventListener('mousemove', handleMouseMove);
elements.videoElement.addEventListener('mouseleave', handleMouseLeave);
elements.videoElement.addEventListener('contextmenu', (e) => {
    if (state.controlEnabledAtStart && state.isRunning) {
        e.preventDefault();
    }
});

const resizeObserver = new ResizeObserver(() => {
    updateVideoBorder();
});
resizeObserver.observe(elements.videoElement);


const taskbar = document.querySelector('.custom-taskbar');
const taskbarMainContent = taskbar.querySelector('.taskbar-main-content');
const taskbarPinArea = taskbar.querySelector('.taskbar-pin-area');
const backButton = taskbar.querySelector('.back-button');
const homeButton = taskbar.querySelector('.home-button');
const recentsButton = taskbar.querySelector('.recents-button');
const speakerButton = document.getElementById('speakerButton');
const quickSettingsTrigger = document.getElementById('quickSettingsTrigger');
const wifiIndicator = quickSettingsTrigger.querySelector('.wifi-indicator');
const batteryLevelSpan = document.getElementById('batteryLevel');
const clockSpan = quickSettingsTrigger.querySelector('.clock');
const pinToggleButton = document.getElementById('pinToggleButton');

const audioPanel = document.getElementById('audioPanel');
const quickSettingsPanel = document.getElementById('quickSettingsPanel');
const mediaVolumeSlider = document.getElementById('mediaVolume');
const wifiToggleBtn = document.getElementById('wifiToggleBtn');


let isTaskbarPinned = false;
let taskbarHideTimeout = null;
const HIDE_TIMEOUT_MS = 2000;
let activePanel = null;


function updateClock() {
    const now = new Date();
    const options = { hour: 'numeric', minute: 'numeric', hour12: false };
    clockSpan.textContent = now.toLocaleTimeString('en-GB', options);
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
    wifiToggleBtn.querySelector('span:last-child').textContent = isWifiOn ? (state.wifiSsid || 'Wi-Fi') : 'Flight Mode';

    const wifiIndicator = quickSettingsTrigger.querySelector('.wifi-indicator');
    const wifiIndicatorOn = wifiIndicator.querySelector('.wifi-icon.wifion');
    const wifiIndicatorOff = wifiIndicator.querySelector('.wifi-icon.wifioff');
    wifiIndicatorOn.classList.toggle('hidden', !isWifiOn);
    wifiIndicatorOff.classList.toggle('hidden', isWifiOn);
}

function requestWifiStatus() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        const message = {
            action: 'getWifiStatus'
        };
        try {
            state.ws.send(JSON.stringify(message));
            appendLog('Requested Wi-Fi status');
        } catch (error) {
            console.error(`Failed to request Wi-Fi status: ${error}`);
            updateStatus(`Failed to get Wi-Fi status: ${error.message}`);
        }
    } else {
        appendLog('WebSocket not connected, cannot get Wi-Fi status');
        updateStatus('Cannot get Wi-Fi status: Not connected');
    }
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
    taskbarHideTimeout = setTimeout(hideTaskbar, HIDE_TIMEOUT_MS);
}

function hideTaskbar() {
    taskbar.classList.remove('taskbar-visible');
    closeActivePanel();
}

function handlePinToggle() {
    isTaskbarPinned = !isTaskbarPinned;
    taskbar.classList.toggle('pinned', isTaskbarPinned);
    updatePinToggleIcon();
    appendLog(`Taskbar ${isTaskbarPinned ? 'pinned' : 'unpinned'}`);
    if (isTaskbarPinned) {
         showTaskbar();
    }
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
            appendLog(`Sent Wi-Fi toggle command: ${newWifiState ? 'Enable' : 'Disable'}`);
            updateStatus(`Wi-Fi ${newWifiState ? 'enabling' : 'disabling'}...`);

            const wifiToggleBtn = document.getElementById('wifiToggleBtn');
            wifiToggleBtn.classList.add('pending');
        } catch (error) {
            console.error(`Failed to send Wi-Fi toggle command: ${error}`);
            updateStatus(`Failed to toggle Wi-Fi: ${error.message}`);
        }
    } else {
        appendLog('WebSocket not connected, cannot toggle Wi-Fi');
        updateStatus('Cannot toggle Wi-Fi: Not connected');
    }
}

function openPanel(panelId) {
    closeActivePanel();
    const panel = document.getElementById(panelId);
    if (panel) {
        panel.classList.add('active');
        activePanel = panelId;
    }
}

function closeActivePanel() {
    if (activePanel) {
        const panel = document.getElementById(activePanel);
        if (panel) {
            panel.classList.remove('active');
        }
        activePanel = null;
    }
}


elements.streamArea.addEventListener('mousemove', showTaskbar);
elements.streamArea.addEventListener('mouseleave', () => {
     clearTimeout(taskbarHideTimeout);
     hideTaskbar();
});
elements.streamArea.addEventListener('touchstart', showTaskbar, { passive: true });


pinToggleButton.addEventListener('click', handlePinToggle);

backButton.addEventListener('click', () => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ action: 'navAction', key: 'back' }));
        appendLog('Sent Back navigation command');
    } else {
        appendLog('Cannot send Back command: WebSocket not connected');
        updateStatus('Cannot send navigation command: Not connected');
    }
});

homeButton.addEventListener('click', () => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ action: 'navAction', key: 'home' }));
        appendLog('Sent Home navigation command');
    } else {
        appendLog('Cannot send Home command: WebSocket not connected');
        updateStatus('Cannot send navigation command: Not connected');
    }
});

recentsButton.addEventListener('click', () => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ action: 'navAction', key: 'recents' }));
        appendLog('Sent Recents navigation command');
    } else {
        appendLog('Cannot send Recents command: WebSocket not connected');
        updateStatus('Cannot send navigation command: Not connected');
    }
});

speakerButton.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activePanel === 'audioPanel') {
        closeActivePanel();
    } else {
        openPanel('audioPanel');
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            const message = {
                action: 'getVolume'
            };
            try {
                state.ws.send(JSON.stringify(message));
                appendLog('Requested current volume');
            } catch (error) {
                console.error(`Failed to request volume: ${error}`);
                updateStatus(`Failed to get volume: ${error.message}`);
            }
        } else {
            appendLog('WebSocket not connected, cannot get volume');
            updateStatus('Cannot get volume: Not connected');
        }
    }
});

quickSettingsTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activePanel === 'quickSettingsPanel') {
        closeActivePanel();
    } else {
        openPanel('quickSettingsPanel');
    }
});


function sendVolumeUpdate(volumeValue) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        const message = { action: 'volume', value: volumeValue };
        try {
            state.ws.send(JSON.stringify(message));
            lastVolumeSendTime = Date.now();
            pendingVolumeValue = null;
        } catch (e) {
            console.error(`Failed to send volume command: ${e}`);
            updateStatus(`Failed to set volume: ${e.message}`);
        }
    } else {
        appendLog('WebSocket not connected, cannot set volume');
        updateStatus('Cannot set volume: Not connected');
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
    } else if (!volumeChangeTimeout) {
        volumeChangeTimeout = setTimeout(() => {
            if (pendingVolumeValue !== null) {
                sendVolumeUpdate(pendingVolumeValue);
            }
            volumeChangeTimeout = null;
        }, VOLUME_THROTTLE_MS - (now - lastVolumeSendTime));
    }
});

const sendFinalVolume = () => {
    if (volumeChangeTimeout) {
        clearTimeout(volumeChangeTimeout);
        volumeChangeTimeout = null;
    }
    const finalVolumeValue = parseInt(mediaVolumeSlider.value, 10);
     if (pendingVolumeValue !== null && pendingVolumeValue !== finalVolumeValue) {
         sendVolumeUpdate(finalVolumeValue);
     } else if (pendingVolumeValue !== null) {
         sendVolumeUpdate(finalVolumeValue);
     }
     pendingVolumeValue = null;
};

mediaVolumeSlider.addEventListener('mouseup', sendFinalVolume);
mediaVolumeSlider.addEventListener('touchend', sendFinalVolume);

wifiToggleBtn.addEventListener('click', handleWifiToggle);



document.addEventListener('click', (e) => {
    if (!audioPanel.contains(e.target) && e.target !== speakerButton &&
        !quickSettingsPanel.contains(e.target) && e.target !== quickSettingsTrigger && !quickSettingsTrigger.contains(e.target))
    {
        closeActivePanel();
    }
});


function updateBatteryLevel(level) {
    const batteryLevel = parseInt(level, 10);

    batteryLevelSpan.textContent = `${batteryLevel}`;
    updateStatus(`Battery level: ${batteryLevel}%`);
    appendLog(`Updated battery level: ${batteryLevel}%`);

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

    if (batteryIcon) {
        batteryIcon.classList.toggle('low-battery', batteryLevel <= 15);
    }
}


elements.toggleLogBtn.addEventListener('click', () => {
    const isExpanded = elements.toggleLogBtn.getAttribute('aria-expanded') === 'true';
    elements.toggleLogBtn.setAttribute('aria-expanded', (!isExpanded).toString());
    elements.toggleLogBtn.textContent = isExpanded ? 'Show Logs' : 'Hide Logs';
    elements.logContent.classList.toggle('hidden', isExpanded);
});

setInterval(updateClock, 5000);
updateClock();
updateWifiIndicator();
updatePinToggleIcon();
updateSpeakerIcon();
updateSliderBackground(mediaVolumeSlider);


appendLog('Idle');
elements.stopButton.disabled = true;
elements.flipOrientationBtn.disabled = true;
updateVideoBorder();