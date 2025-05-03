const VideoConverter = require('h264-converter').default;
const { setLogger } = require('h264-converter');

setLogger(() => {}, console.error);

// Constants (Video/Audio/FPS)
const CHECK_STATE_INTERVAL_MS = 250;
const MAX_SEEK_WAIT_MS = 1500;
const MAX_TIME_TO_RECOVER = 200;
const AUDIO_BYTES_PER_SAMPLE = 2;
const BINARY_TYPES = { VIDEO: 0, AUDIO: 1 };
const CODEC_IDS = { H264: 0x68323634, AAC: 0x00616163 };
const NALU_TYPE_IDR = 5;
const FPS_CHECK_INTERVAL = 10000;
const TARGET_FPS_VALUES = [30, 50, 60, 120];
const PAUSE_DETECTION_THRESHOLD = 1000;

// Constants (Control)
const CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT = 2;
const AMOTION_EVENT_ACTION_DOWN = 0;
const AMOTION_EVENT_ACTION_UP = 1;
const AMOTION_EVENT_ACTION_MOVE = 2;
const AMOTION_EVENT_BUTTON_PRIMARY = 1;
const AMOTION_EVENT_BUTTON_SECONDARY = 2;
const AMOTION_EVENT_BUTTON_TERTIARY = 4;
const POINTER_ID_MOUSE = -1n;

// Browser-specific settings
const IS_SAFARI = !!window.safari;
const IS_CHROME = navigator.userAgent.includes('Chrome');
const IS_MAC = navigator.platform.startsWith('Mac');
const MAX_BUFFER = IS_SAFARI ? 2 : IS_CHROME && IS_MAC ? 0.9 : 0.2;
const MAX_AHEAD = -0.2;

// DOM Elements
const elements = {
    startButton: document.getElementById('startBtn'),
    stopButton: document.getElementById('stopBtn'),
    bitrateSelect: document.getElementById('bitrate'),
    maxSizeSelect: document.getElementById('maxSize'),
    maxFpsSelect: document.getElementById('maxFps'),
    enableAudioInput: document.getElementById('enableAudio'),
    enableControlInput: document.getElementById('enableControl'),
    statusDiv: document.getElementById('status'),
    themeToggle: document.getElementById('themeToggle'),
    fullscreenBtn: document.getElementById('fullscreenBtn'),
    streamArea: document.getElementById('streamArea'),
    videoPlaceholder: document.getElementById('videoPlaceholder'),
    videoElement: document.getElementById('screen'),
    videoBorder: document.getElementById('videoBorder'),
    flipOrientationBtn: document.getElementById('flipOrientationBtn'),
};

// State
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
    noExceptionFramesSince: -1,
    frameTimestamps: [],
    controlEnabledAtStart: false,
    isMouseDown: false,
    currentMouseButtons: 0,
    lastMousePosition: { x: 0, y: 0 },
    nextAudioTime: 0,
    totalAudioFrames: 0,
    lastFrameReceived: -1,
};

// Utility Functions
const log = (message) => {
    console.log(message);
};

const updateStatus = (message) => {
    elements.statusDiv.textContent = `Status: ${message}`;
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

// FPS Calculation
const calculateAverageFPS = () => {
    const now = Date.now();
    state.frameTimestamps = state.frameTimestamps.filter(ts => now - ts < FPS_CHECK_INTERVAL);
    const frameCount = state.frameTimestamps.length;
    if (frameCount < 2) return null;

    const timeSpan = (state.frameTimestamps[frameCount - 1] - state.frameTimestamps[0]) / 1000;
    const fps = frameCount / timeSpan;

    return TARGET_FPS_VALUES.reduce((prev, curr) =>
        Math.abs(curr - fps) < Math.abs(prev - fps) ? curr : prev
    );
};

const checkAndUpdateFPS = () => {
    const now = Date.now();
    if (state.lastFrameReceived !== -1 && now - state.lastFrameReceived > PAUSE_DETECTION_THRESHOLD) {
        log('Stream paused, skipping FPS check');
        return;
    }

    const calculatedFPS = calculateAverageFPS();
    const currentFPS = parseInt(elements.maxFpsSelect.value);

    if (calculatedFPS && calculatedFPS !== currentFPS) {
        reinitializeConverter(calculatedFPS);
    }
};

const reinitializeConverter = (newFPS) => {
    log(`Reinitializing stream with new FPS: ${newFPS}`);
    elements.maxFpsSelect.value = newFPS.toString();

    stopStreaming(true);
    setTimeout(() => {
        if (state.isRunning || (state.ws && state.ws.readyState === WebSocket.OPEN)) {
            console.warn('Stream still active after delay, aborting restart');
            return;
        }
        log('Restarting stream with new FPS');
        startStreaming();
    }, 100);
};

// Audio Handling
const setupAudioPlayer = (codecId, metadata) => {
    if (codecId !== CODEC_IDS.AAC) {
        log(`Unsupported audio codec ID: 0x${codecId.toString(16)}`);
        return;
    }
    if (!window.AudioContext || !window.AudioDecoder) {
        updateStatus('Audio not supported in this browser');
        return;
    }

    try {
        state.audioContext = new AudioContext({
            sampleRate: metadata.sampleRate || 48000,
        });

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
                    state.nextAudioTime = Math.max(state.nextAudioTime, currentTime);
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
        log(`Failed to setup AudioDecoder: ${e}`);
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

// Video Handling
const initVideoConverter = () => {
    state.converter = new VideoConverter(elements.videoElement, parseInt(elements.maxFpsSelect.value), 1);
    state.sourceBufferInternal = state.converter?.sourceBuffer || null;

    elements.videoElement.addEventListener('loadedmetadata', () => {
        if (state.isRunning && elements.videoPlaceholder.classList.contains('hidden')) {
            elements.videoElement.play().catch(e => console.warn("Autoplay prevented:", e));
        }
    }, { once: true });

    elements.videoElement.removeEventListener('error', onVideoError);
    elements.videoElement.addEventListener('error', onVideoError);
};

const onVideoError = (e) => {
    console.error('Video Element Error:', elements.videoElement.error);
    log(`Video Error: ${elements.videoElement.error?.message} (Code: ${elements.videoElement.error?.code})`);
};

const cleanSourceBuffer = () => {
    if (!state.sourceBufferInternal || state.sourceBufferInternal.updating || state.removeStart < 0 || state.removeEnd <= state.removeStart) {
        if (state.sourceBufferInternal?.updating) {
            setTimeout(cleanSourceBuffer, 50);
        } else {
            state.sourceBufferInternal?.removeEventListener('updateend', cleanSourceBuffer);
            state.removeStart = state.removeEnd = -1;
        }
        return;
    }

    try {
        console.log(`[BufferCleaner] Removing buffer range: ${state.removeStart.toFixed(3)} - ${state.removeEnd.toFixed(3)}`);
        state.sourceBufferInternal.remove(state.removeStart, state.removeEnd);
        state.sourceBufferInternal.addEventListener('updateend', () => {
            console.log(`[BufferCleaner] Buffer range removed successfully`);
            state.sourceBufferInternal?.removeEventListener('updateend', cleanSourceBuffer);
            state.removeStart = state.removeEnd = -1;
        }, { once: true });
    } catch (e) {
        console.error(`[BufferCleaner] Failed to remove buffer: ${e}`);
        state.sourceBufferInternal?.removeEventListener('updateend', cleanSourceBuffer);
        state.removeStart = state.removeEnd = -1;
    }
};

const checkForIFrameAndCleanBuffer = (frameData) => {
    if (!state.sourceBufferInternal) {
        state.sourceBufferInternal = state.converter?.sourceBuffer || null;
        if (!state.sourceBufferInternal) return;
    }

    if (isIFrame(frameData)) {
        if (elements.videoElement.buffered && elements.videoElement.buffered.length > 0) {
            const currentBufferStart = elements.videoElement.buffered.start(0);
            const currentBufferEnd = elements.videoElement.buffered.end(elements.videoElement.buffered.length - 1);
            const keepDuration = 10.0;
            const targetRemoveEnd = Math.max(0, elements.videoElement.currentTime - keepDuration);

            if (currentBufferStart < targetRemoveEnd - 1.0) {
                const proposedStart = currentBufferStart;
                const proposedEnd = targetRemoveEnd;

                if (proposedEnd > proposedStart && !state.sourceBufferInternal.updating) {
                    if (state.removeStart === -1) {
                        console.log(`[BufferCleaner] IFrame detected. Scheduling cleanup: ${proposedStart.toFixed(3)} - ${proposedEnd.toFixed(3)}`);
                        state.removeStart = proposedStart;
                        state.removeEnd = proposedEnd;
                        setTimeout(cleanSourceBuffer, 50);
                    } else if (state.removeStart !== -1 && proposedEnd > state.removeEnd) {
                        console.log(`[BufferCleaner] Extending cleanup range to ${proposedEnd.toFixed(3)}`);
                        state.removeEnd = proposedEnd;
                    }
                }
            }
        }
    }
};

// Video Playback Quality
const getVideoPlaybackQuality = () => {
    const video = elements.videoElement;
    if (!video) return null;

    const now = Date.now();
    if (typeof video.getVideoPlaybackQuality === 'function') {
        const quality = video.getVideoPlaybackQuality();
        return { timestamp: now, decodedFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames };
    }

    if (typeof video.webkitDecodedFrameCount !== 'undefined') {
        return { timestamp: now, decodedFrames: video.webkitDecodedFrameCount, droppedFrames: video.webkitDroppedFrameCount };
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

    const currentInputBytes = state.inputBytes.reduce((sum, item) => sum + item.bytes, 0);
    const inputFrames = state.inputBytes.length;

    if (state.videoStats.length) {
        const oldest = state.videoStats[0];
        state.momentumQualityStats = {
            decodedFrames: stat.decodedFrames - oldest.decodedFrames,
            droppedFrames: stat.droppedFrames - oldest.droppedFrames,
            inputBytes: currentInputBytes,
            inputFrames,
            timestamp
        };
    } else {
        state.momentumQualityStats = { decodedFrames: 0, droppedFrames: 0, inputBytes: currentInputBytes, inputFrames, timestamp };
    }
};

const checkForBadState = () => {
    if (!state.isRunning || !state.converter || elements.videoElement.readyState < elements.videoElement.HAVE_FUTURE_DATA) return;

    const now = Date.now();
    if (state.lastFrameReceived !== -1 && now - state.lastFrameReceived > PAUSE_DETECTION_THRESHOLD) {
        log('Stream paused, skipping bad state check');
        return;
    }

    calculateMomentumStats();
    const { currentTime } = elements.videoElement;
    let hasReasonToJump = false;
    let reasonMessage = '';

    if (state.momentumQualityStats && state.momentumQualityStats.decodedFrames <= 0 && state.momentumQualityStats.inputFrames > 0) {
        state.noExceptionFramesSince = state.noExceptionFramesSince === -1 ? now : state.noExceptionFramesSince;
        if (now - state.noExceptionFramesSince > MAX_TIME_TO_RECOVER) {
            reasonMessage = `No frames decoded for ${now - state.noExceptionFramesSince} ms`;
            hasReasonToJump = true;
        }
    } else {
        state.noExceptionFramesSince = -1;
    }

    state.currentTimeNotChangedSince = Math.abs(currentTime - state.lastVideoTime) < 0.01 ?
        (state.currentTimeNotChangedSince === -1 ? now : state.currentTimeNotChangedSince) : -1;
    state.lastVideoTime = currentTime;

    if (elements.videoElement.buffered.length) {
        const bufferEnd = elements.videoElement.buffered.end(0);
        const bufferedDuration = bufferEnd - currentTime;

        if (bufferedDuration > MAX_BUFFER) {
            state.bigBufferSince = state.bigBufferSince === -1 ? now : state.bigBufferSince;
            if (now - state.bigBufferSince > MAX_TIME_TO_RECOVER) {
                reasonMessage = reasonMessage || `Buffer ahead too large (${bufferedDuration.toFixed(3)}s > ${MAX_BUFFER}s) for ${now - state.bigBufferSince} ms`;
                hasReasonToJump = true;
            }
        } else {
            state.bigBufferSince = -1;
        }

        if (bufferedDuration < MAX_AHEAD) {
            state.aheadOfBufferSince = state.aheadOfBufferSince === -1 ? now : state.aheadOfBufferSince;
            if (now - state.aheadOfBufferSince > MAX_TIME_TO_RECOVER) {
                reasonMessage = reasonMessage || `Playhead behind buffer (${bufferedDuration.toFixed(3)}s < ${MAX_AHEAD}s) for ${now - state.aheadOfBufferSince} ms`;
                hasReasonToJump = true;
            }
        } else {
            state.aheadOfBufferSince = -1;
        }

        if (state.currentTimeNotChangedSince !== -1 && now - state.currentTimeNotChangedSince > MAX_TIME_TO_RECOVER) {
            reasonMessage = reasonMessage || `Video currentTime stuck at ${currentTime.toFixed(3)} for ${now - state.currentTimeNotChangedSince} ms`;
            hasReasonToJump = true;
        }

        if (!hasReasonToJump) return;

        let waitingForSeekEnd = 0;
        if (state.seekingSince !== -1) {
            waitingForSeekEnd = now - state.seekingSince;
            if (waitingForSeekEnd < MAX_SEEK_WAIT_MS) {
                console.log(`[StallRecovery] Skipping recovery, seek already in progress for ${waitingForSeekEnd}ms`);
                return;
            } else {
                console.warn(`[StallRecovery] Previous seek seems stuck (${waitingForSeekEnd}ms). Forcing new seek`);
                elements.videoElement.removeEventListener('seeked', onSeekEnd);
            }
        }

        console.warn(`[StallRecovery] Attempting recovery: ${reasonMessage}. Jumping to buffered end: ${bufferEnd.toFixed(3)}`);
        log(`Attempting playback recovery (${reasonMessage.split('.')[0]})`);

        const onSeekEnd = () => {
            console.log('[StallRecovery] Seek completed');
            state.seekingSince = -1;
            elements.videoElement.removeEventListener('seeked', onSeekEnd);
            state.noExceptionFramesSince = state.currentTimeNotChangedSince = state.bigBufferSince = state.aheadOfBufferSince = -1;
            if (state.isRunning) {
                elements.videoElement.play().catch(e => console.warn("Autoplay prevented after seek:", e));
            }
        };

        state.seekingSince = now;
        elements.videoElement.addEventListener('seeked', onSeekEnd);
        try {
            elements.videoElement.currentTime = bufferEnd > 0.1 ? bufferEnd - 0.05 : 0;
        } catch (e) {
            console.error(`[StallRecovery] Error setting currentTime: ${e}`);
            elements.videoElement.removeEventListener('seeked', onSeekEnd);
            state.seekingSince = -1;
        }
    } else {
        state.noExceptionFramesSince = state.currentTimeNotChangedSince = state.bigBufferSince = state.aheadOfBufferSince = -1;
    }
};

// Coordinate Scaling Function
const getScaledCoordinates = (event) => {
    const video = elements.videoElement;
    const screenInfo = {
        videoSize: { width: state.deviceWidth, height: state.deviceHeight }
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

// Control Message Sending
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

// Mouse Event Handlers
const handleMouseDown = (event) => {
    if (!state.isRunning || !state.controlEnabledAtStart || !state.deviceWidth || !state.deviceHeight) return;
    event.preventDefault();

    state.isMouseDown = true;
    let buttonFlag = 0;
    switch(event.button) {
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
        console.warn(`Mouse Down - Invalid coordinates: Raw: (${event.clientX}, ${event.clientY})`);
    }
};

const handleMouseUp = (event) => {
    if (!state.isRunning || !state.controlEnabledAtStart || !state.deviceWidth || !state.deviceHeight) return;
    event.preventDefault();

    let buttonFlag = 0;
    switch(event.button) {
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
    } else {
        sendMouseEvent(AMOTION_EVENT_ACTION_MOVE, state.currentMouseButtons, finalCoords.x, finalCoords.y);
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
        console.warn(`Mouse Move - Invalid coordinates: Raw: (${event.clientX}, ${event.clientY})`);
    }
};

const handleMouseLeave = (event) => {
    if (!state.isRunning || !state.controlEnabledAtStart || !state.isMouseDown || state.currentMouseButtons === 0) return;
    event.preventDefault();

    console.log(`Mouse leave while buttons pressed: ${state.currentMouseButtons}`);
    sendMouseEvent(AMOTION_EVENT_ACTION_UP, state.currentMouseButtons, state.lastMousePosition.x, state.lastMousePosition.y);

    state.isMouseDown = false;
    state.currentMouseButtons = 0;
};

// Streaming
const startStreaming = () => {
    if (state.isRunning || (state.ws && state.ws.readyState === WebSocket.OPEN)) {
        log('Cannot start stream: Already running or WebSocket open');
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
        ws: null,
        converter: null,
        audioContext: null,
        audioDecoder: null,
        sourceBufferInternal: null,
        checkStateIntervalId: null,
        fpsCheckIntervalId: null,
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
        noExceptionFramesSince: -1,
        frameTimestamps: [],
        isMouseDown: false,
        currentMouseButtons: 0,
        lastMousePosition: { x: 0, y: 0 },
        nextAudioTime: 0,
        totalAudioFrames: 0,
        deviceWidth: 0,
        deviceHeight: 0,
        videoResolution: 'Unknown',
        isRunning: true,
        lastFrameReceived: -1,
    });

    state.ws = new WebSocket(`ws://${window.location.hostname}:8080`);
    state.ws.binaryType = 'arraybuffer';

    state.ws.onopen = () => {
        log('WebSocket connected');
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
                        log(`Device Name: ${message.name}`);
                        updateStatus(`Connected to ${message.name}`);
                        break;
                    case 'videoInfo':
                        state.deviceWidth = message.width;
                        state.deviceHeight = message.height;
                        state.videoResolution = `${message.width}x${message.height}`;
                        log(`Video Info: Codec=0x${message.codecId.toString(16)}, ${state.videoResolution}`);
                        elements.streamArea.style.aspectRatio = state.deviceWidth > 0 && state.deviceHeight > 0
                            ? `${state.deviceWidth} / ${state.deviceHeight}`
                            : '9 / 16';
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
                        log(`Audio Info: Codec=0x${message.codecId.toString(16)}${message.metadata ? `, Metadata=${JSON.stringify(message.metadata)}` : ''}`);
                        if (message.codecId === CODEC_IDS.AAC && message.metadata && elements.enableAudioInput.checked) {
                            setupAudioPlayer(message.codecId, message.metadata);
                        }
                        break;
                    case 'status':
                        log(`Status: ${message.message}`);
                        updateStatus(message.message);
                        if (message.message === 'Streaming started') {
                            elements.flipOrientationBtn.disabled = false;
                            elements.videoElement.classList.toggle('control-enabled', state.controlEnabledAtStart);
                            state.checkStateIntervalId = setInterval(checkForBadState, CHECK_STATE_INTERVAL_MS);
                            state.fpsCheckIntervalId = setInterval(checkAndUpdateFPS, FPS_CHECK_INTERVAL);
                        } else if (message.message === 'Streaming stopped') {
                            stopStreaming(false);
                        }
                        break;
                    case 'error':
                        log(`Error: ${message.message}`);
                        updateStatus(`Error: ${message.message}`);
                        stopStreaming(false);
                        break;
                    case 'deviceMessage':
                        try {
                            const deviceData = new Uint8Array(Buffer.from(message.data, 'base64'));
                            log(`Device Message: ${deviceData.length} bytes`);
                        } catch (e) {
                            console.error(`Error processing device message: ${e}`);
                        }
                        break;
                    default:
                        log(`Unknown message type: ${message.type}`);
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
                state.frameTimestamps.push(Date.now());
                state.lastFrameReceived = Date.now();
                checkForIFrameAndCleanBuffer(payloadUint8);
                try {
                    state.converter.appendRawData(payloadUint8);
                } catch (e) {
                    console.error(`Error appending video data: ${e}`);
                }
            } else if (type === BINARY_TYPES.AUDIO && elements.enableAudioInput.checked) {
                handleAudioData(payload);
            }
        }
    };

    state.ws.onclose = (event) => {
        log(`WebSocket closed (Code: ${event.code}, Reason: ${event.reason})`);
        stopStreaming(false);
    };

    state.ws.onerror = (error) => {
        console.error(`WebSocket error: ${error}`);
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
    if (state.fpsCheckIntervalId) {
        clearInterval(state.fpsCheckIntervalId);
        state.fpsCheckIntervalId = null;
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
        } catch (e) {
            console.error("Error during converter cleanup:", e);
        }
        state.converter = null;
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
        noExceptionFramesSince: -1,
        frameTimestamps: [],
        isMouseDown: false,
        currentMouseButtons: 0,
        lastMousePosition: { x: 0, y: 0 },
        deviceWidth: 0,
        deviceHeight: 0,
        videoResolution: 'Unknown',
        lastFrameReceived: -1,
    });
};

// Event Listeners
elements.startButton.addEventListener('click', startStreaming);
elements.stopButton.addEventListener('click', () => stopStreaming(true));
elements.themeToggle.addEventListener('click', () => {
    const body = document.body;
    const newTheme = body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    body.setAttribute('data-theme', newTheme);
    log(`Theme switched to ${newTheme}`);
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
            elements.videoElement.requestFullscreen().catch(e => console.error(`Fullscreen error: ${e}`));
        } else {
            log("Cannot enter fullscreen: Stream not running");
        }
    } else {
        document.exitFullscreen();
    }
});

document.addEventListener('fullscreenchange', () => {
    elements.videoElement.classList.toggle('fullscreen', document.fullscreenElement === elements.videoElement);
    log(document.fullscreenElement ? 'Entered fullscreen' : 'Exited fullscreen');
});

elements.flipOrientationBtn.addEventListener('click', () => {
    if (!state.isRunning) {
        log("Cannot flip orientation: Stream not running");
        return;
    }
    if (state.deviceWidth > 0 && state.deviceHeight > 0) {
        log(`Flipping orientation from ${state.deviceWidth}x${state.deviceHeight}`);
        const tempWidth = state.deviceWidth;
        state.deviceWidth = state.deviceHeight;
        state.deviceHeight = tempWidth;
        state.videoResolution = `${state.deviceWidth}x${state.deviceHeight}`;

        log(`New orientation: ${state.deviceWidth}x${state.deviceHeight}`);
        elements.streamArea.style.aspectRatio = state.deviceWidth > 0 && state.deviceHeight > 0
            ? `${state.deviceWidth} / ${state.deviceHeight}`
            : '9 / 16';

        requestAnimationFrame(() => {
            updateVideoBorder();
        });
    } else {
        log("Cannot flip orientation: Dimensions not set");
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

// Initialize
updateStatus('Idle');
elements.stopButton.disabled = true;
elements.flipOrientationBtn.disabled = true;
updateVideoBorder();