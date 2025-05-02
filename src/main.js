import VideoConverter from 'h264-converter';
import { setLogger } from 'h264-converter';

setLogger(() => {}, console.error);

// Constants
const CHECK_STATE_INTERVAL_MS = 250;
const MAX_SEEK_WAIT_MS = 1500;
const MAX_TIME_TO_RECOVER = 200;
const MAX_AUDIO_QUEUE_SIZE = 10;
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_BYTES_PER_SAMPLE = 2;
const AUDIO_SAMPLE_SIZE = AUDIO_CHANNELS * AUDIO_BYTES_PER_SAMPLE;
const BINARY_TYPES = { VIDEO: 0, AUDIO: 1 };
const CODEC_IDS = { H264: 0x68323634, RAW: 0x00726177 };
const NALU_TYPE_IDR = 5;
const FPS_CHECK_INTERVAL = 10000; // Check FPS every 10 seconds
const TARGET_FPS_VALUES = [30, 60, 120];

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
    statusDiv: document.getElementById('status'),
    themeToggle: document.getElementById('themeToggle'),
    fullscreenBtn: document.getElementById('fullscreenBtn'),
    streamArea: document.getElementById('streamArea'),
    videoPlaceholder: document.getElementById('videoPlaceholder'),
    videoElement: document.getElementById('screen'),
    infoDiv: document.getElementById('info')
};

// State
let state = {
    ws: null,
    converter: null,
    isRunning: false,
    audioContext: null,
    audioBufferQueue: [],
    nextAudioTime: 0,
    audioCodecId: null,
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
    frameTimestamps: [], // For FPS calculation
    fpsCheckIntervalId: null
};

// Utility Functions
const log = (message) => {
    console.log(message);
    elements.infoDiv.textContent = message;
};

const updateStatus = (message) => {
    elements.statusDiv.textContent = `Status: ${message}`;
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
    
    // Find closest target FPS
    return TARGET_FPS_VALUES.reduce((prev, curr) => 
        Math.abs(curr - fps) < Math.abs(prev - fps) ? curr : prev
    );
};

const checkAndUpdateFPS = () => {
    const calculatedFPS = calculateAverageFPS();
    const currentFPS = parseInt(elements.maxFpsSelect.value);
    
    if (calculatedFPS && calculatedFPS !== currentFPS) {
        log(`FPS mismatch detected. Current: ${currentFPS}, Calculated: ${calculatedFPS}. Reinitializing converter.`);
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
const setupAudioPlayer = (codecId) => {
    if (codecId !== CODEC_IDS.RAW) {
        log(`Unsupported audio codec ID: 0x${codecId.toString(16)}`);
        return;
    }
    if (!window.AudioContext && !window.webkitAudioContext) {
        log('Web Audio API not supported');
        return;
    }
    
    if (state.audioContext && state.audioContext.state !== 'closed') {
        state.audioContext.close().catch(e => console.error(`Error closing previous AudioContext: ${e}`));
    }
    
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        state.audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: AUDIO_SAMPLE_RATE });
        state.audioBufferQueue = [];
        state.nextAudioTime = 0;
        state.receivedFirstAudioPacket = false;
        state.audioCodecId = codecId;
        log('Audio player setup for RAW audio');
    } catch (e) {
        log(`Failed to create AudioContext: ${e}`);
        state.audioContext = null;
    }
};

const handleAudioData = (arrayBuffer) => {
    if (!state.audioContext || !state.isRunning || state.audioCodecId !== CODEC_IDS.RAW || arrayBuffer.byteLength === 0) return;
    if (arrayBuffer.byteLength % AUDIO_SAMPLE_SIZE !== 0) {
        console.warn(`Invalid audio data length: ${arrayBuffer.byteLength} bytes`);
        return;
    }

    const frameCount = arrayBuffer.byteLength / AUDIO_SAMPLE_SIZE;
    try {
        const audioBuffer = state.audioContext.createBuffer(AUDIO_CHANNELS, frameCount, AUDIO_SAMPLE_RATE);
        const float32Data = new Float32Array(frameCount);
        const int16Data = new Int16Array(arrayBuffer);
        for (let channel = 0; channel < AUDIO_CHANNELS; channel++) {
            for (let i = 0; i < frameCount; i++) {
                float32Data[i] = int16Data[i * AUDIO_CHANNELS + channel] / 32768.0;
            }
            audioBuffer.copyToChannel(float32Data, channel);
        }
        playAudioBuffer(audioBuffer);
    } catch (e) {
        console.error(`Error processing audio: ${e}`);
    }
};

const playAudioBuffer = (buffer) => {
    if (!state.audioContext || state.audioContext.state === 'closed') return;
    if (state.audioContext.state === 'suspended') {
        state.audioContext.resume().catch(e => console.error(`Audio context resume error: ${e}`));
    }
    
    if (state.audioBufferQueue.length >= MAX_AUDIO_QUEUE_SIZE) {
        const oldSource = state.audioBufferQueue.shift();
        try { oldSource.stop(0); oldSource.disconnect(); } catch (e) {}
    }
    
    if (!state.receivedFirstAudioPacket) {
        state.nextAudioTime = state.audioContext.currentTime + 0.05;
        state.receivedFirstAudioPacket = true;
    }

    try {
        const source = state.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(state.audioContext.destination);
        const startTime = Math.max(state.audioContext.currentTime, state.nextAudioTime);
        source.start(startTime);
        state.nextAudioTime = startTime + buffer.duration;
        state.audioBufferQueue.push(source);
        
        source.onended = () => {
            const index = state.audioBufferQueue.indexOf(source);
            if (index > -1) state.audioBufferQueue.splice(index, 1);
            try { source.disconnect(); } catch (e) {}
        };
    } catch (e) {
        console.error(`Error playing audio buffer: ${e}`);
        if (e.name === 'InvalidStateError' && state.audioContext.state === 'closed') {
            state.audioContext = null;
        }
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
            console.log(`[BufferCleaner] Buffer range removed successfully.`);
            state.sourceBufferInternal?.removeEventListener('updateend', cleanSourceBuffer);
            state.removeStart = state.removeEnd = -1;
        }, { once: true });
    } catch (e) {
        console.error(`[BufferCleaner] Failed to remove buffer: ${e}`, `Range: ${state.removeStart}-${state.removeEnd}`);
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
            const keepDuration = 5.0;
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

    calculateMomentumStats();
    const { currentTime } = elements.videoElement;
    const now = Date.now();
    let hasReasonToJump = false;
    let reasonMessage = '';

    if (state.momentumQualityStats && state.momentumQualityStats.decodedFrames <= 0 && state.momentumQualityStats.inputFrames > 0) {
        state.noDecodedFramesSince = state.noDecodedFramesSince === -1 ? now : state.noDecodedFramesSince;
        if (now - state.noDecodedFramesSince > MAX_TIME_TO_RECOVER) {
            reasonMessage = `No frames decoded for ${now - state.noDecodedFramesSince} ms.`;
            hasReasonToJump = true;
        }
    } else {
        state.noDecodedFramesSince = -1;
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
                reasonMessage = reasonMessage || `Buffer ahead too large (${bufferedDuration.toFixed(3)}s > ${MAX_BUFFER}s) for ${now - state.bigBufferSince} ms.`;
                hasReasonToJump = true;
            }
        } else {
            state.bigBufferSince = -1;
        }

        if (bufferedDuration < MAX_AHEAD) {
            state.aheadOfBufferSince = state.aheadOfBufferSince === -1 ? now : state.aheadOfBufferSince;
            if (now - state.aheadOfBufferSince > MAX_TIME_TO_RECOVER) {
                reasonMessage = reasonMessage || `Playhead behind buffer (${bufferedDuration.toFixed(3)}s < ${MAX_AHEAD}s) for ${now - state.aheadOfBufferSince} ms.`;
                hasReasonToJump = true;
            }
        } else {
            state.aheadOfBufferSince = -1;
        }

        if (state.currentTimeNotChangedSince !== -1 && now - state.currentTimeNotChangedSince > MAX_TIME_TO_RECOVER) {
            reasonMessage = reasonMessage || `Video currentTime stuck at ${currentTime.toFixed(3)} for ${now - state.currentTimeNotChangedSince} ms.`;
            hasReasonToJump = true;
        }

        if (!hasReasonToJump) return;

        let waitingForSeekEnd = 0;
        if (state.seekingSince !== -1) {
            waitingForSeekEnd = now - state.seekingSince;
            if (waitingForSeekEnd < MAX_SEEK_WAIT_MS) {
                console.log(`[StallRecovery] Skipping recovery, seek already in progress for ${waitingForSeekEnd}ms.`);
                return;
            } else {
                console.warn(`[StallRecovery] Previous seek seems stuck (${waitingForSeekEnd}ms). Forcing new seek.`);
                elements.videoElement.removeEventListener('seeked', onSeekEnd);
            }
        }

        console.warn(`[StallRecovery] Attempting recovery: ${reasonMessage}. Jumping to buffered end: ${bufferEnd.toFixed(3)}`);
        log(`Attempting playback recovery (${reasonMessage.split('.')[0]})`);

        const onSeekEnd = () => {
            console.log('[StallRecovery] Seek completed.');
            state.seekingSince = -1;
            elements.videoElement.removeEventListener('seeked', onSeekEnd);
            state.noDecodedFramesSince = state.currentTimeNotChangedSince = state.bigBufferSince = state.aheadOfBufferSince = -1;
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
        state.noDecodedFramesSince = state.currentTimeNotChangedSince = state.bigBufferSince = state.aheadOfBufferSince = -1;
    }
};

// Streaming
const startStreaming = () => {
    if (state.isRunning || (state.ws && state.ws.readyState === WebSocket.OPEN)) {
        log('Cannot start stream: Already running or WebSocket open.');
        return;
    }

    updateStatus('Connecting...');
    elements.startButton.disabled = true;
    elements.maxSizeSelect.disabled = true;
    elements.maxFpsSelect.disabled = true;
    elements.bitrateSelect.disabled = true;
    elements.enableAudioInput.disabled = true;

    // Reset state
    Object.assign(state, {
        currentTimeNotChangedSince: -1,
        bigBufferSince: -1,
        aheadOfBufferSince: -1,
        lastVideoTime: -1,
        seekingSince: -1,
        removeStart: -1,
        removeEnd: -1,
        sourceBufferInternal: null,
        receivedFirstAudioPacket: false,
        nextAudioTime: 0,
        audioBufferQueue: [],
        videoStats: [],
        inputBytes: [],
        momentumQualityStats: null,
        noDecodedFramesSince: -1,
        frameTimestamps: []
    });

    if (state.checkStateIntervalId) clearInterval(state.checkStateIntervalId);
    if (state.fpsCheckIntervalId) clearInterval(state.fpsCheckIntervalId);

    const wsUrl = `ws://${window.location.hostname}:8080`;
    state.ws = new WebSocket(wsUrl);
    state.ws.binaryType = 'arraybuffer';

    initVideoConverter();

    state.ws.onopen = () => {
        updateStatus('Connected. Requesting stream...');
        log('WebSocket opened. Sending start options.');
        state.ws.send(JSON.stringify({
            action: 'start',
            maxSize: parseInt(elements.maxSizeSelect.value) || 0,
            maxFps: parseInt(elements.maxFpsSelect.value) || 0,
            bitrate: (parseInt(elements.bitrateSelect.value) || 8) * 1000000,
            enableAudio: elements.enableAudioInput.checked
        }));
        
        // Start FPS checking
        state.fpsCheckIntervalId = setInterval(checkAndUpdateFPS, FPS_CHECK_INTERVAL);
    };

    state.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            if (!state.isRunning) return;

            const dataView = new DataView(event.data);
            if (dataView.byteLength < 1) return;

            const type = dataView.getUint8(0);
            const payload = event.data.slice(1);
            const payloadUint8 = new Uint8Array(payload);

            if (type === BINARY_TYPES.VIDEO && state.converter) {
                state.inputBytes.push({ timestamp: Date.now(), bytes: payload.byteLength });
                state.frameTimestamps.push(Date.now()); // Track frame for FPS
                state.converter.appendRawData(payloadUint8);
                checkForIFrameAndCleanBuffer(payloadUint8);
            } else if (type === BINARY_TYPES.AUDIO && elements.enableAudioInput.checked && state.audioContext) {
                handleAudioData(payload);
            }
        } else if (typeof event.data === 'string') {
            try {
                const message = JSON.parse(event.data);
                switch (message.type) {
                    case 'status':
                        updateStatus(message.message);
                        log(`Status: ${message.message}`);
                        if (message.message === 'Streaming started') {
                            state.isRunning = true;
                            elements.startButton.disabled = true;
                            elements.stopButton.disabled = false;
                            elements.maxSizeSelect.disabled = true;
                            elements.maxFpsSelect.disabled = true;
                            elements.bitrateSelect.disabled = true;
                            elements.enableAudioInput.disabled = true;
                            if (!state.checkStateIntervalId) {
                                state.checkStateIntervalId = setInterval(checkForBadState, CHECK_STATE_INTERVAL_MS);
                            }
                        } else if (message.message === 'Streaming stopped') {
                            stopStreaming(false);
                        }
                        break;
                    case 'videoInfo':
                        state.videoResolution = `${message.width}x${message.height}`;
                        state.deviceWidth = message.width;
                        state.deviceHeight = message.height;
                        log(`Video dimensions: ${state.videoResolution}`);
                        elements.streamArea.style.aspectRatio = state.deviceWidth > 0 && state.deviceHeight > 0 ? 
                            `${state.deviceWidth} / ${state.deviceHeight}` : '';
                        elements.videoPlaceholder.classList.add('hidden');
                        elements.videoElement.classList.add('visible');
                        if (state.converter) {
                            requestAnimationFrame(() => {
                                elements.videoElement.play().catch(e => console.warn("Autoplay prevented:", e));
                            });
                        }
                        break;
                    case 'audioInfo':
                        log(`Audio info: Codec ID 0x${message.codecId?.toString(16)}`);
                        if (elements.enableAudioInput.checked) {
                            setupAudioPlayer(message.codecId);
                        }
                        break;
                }
            } catch (e) {
                console.error('Error parsing JSON message:', e, 'Raw data:', event.data);
                updateStatus('Error processing server message');
            }
        }
    };

    state.ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        updateStatus('WebSocket error');
        log('WebSocket error occurred.');
        stopStreaming(false);
    };

    state.ws.onclose = (event) => {
        const reason = event.reason || `code ${event.code}`;
        updateStatus(event.wasClean ? `Disconnected (${reason})` : `Connection Lost (${reason})`);
        log(`WebSocket closed: ${reason}`);
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

    if (state.checkStateIntervalId) clearInterval(state.checkStateIntervalId);
    if (state.fpsCheckIntervalId) clearInterval(state.fpsCheckIntervalId);

    state.isRunning = false;
    elements.startButton.disabled = false;
    elements.stopButton.disabled = true;
    elements.maxSizeSelect.disabled = false;
    elements.maxFpsSelect.disabled = false;
    elements.bitrateSelect.disabled = false;
    elements.enableAudioInput.disabled = false;

    if (state.ws) {
        if (sendDisconnect && state.ws.readyState === WebSocket.OPEN) {
            try {
                state.ws.send(JSON.stringify({ action: 'disconnect' }));
                log('Sent disconnect message.');
            } catch (e) {
                console.error("Error sending disconnect message:", e);
            }
        }
        if (state.ws.readyState < WebSocket.CLOSING) {
            state.ws.close(1000, 'User stopped streaming');
        }
        state.ws = null;
    }

    if (state.converter) {
        try {
            state.converter.appendRawData(new Uint8Array([]));
            state.converter.pause();
        } catch (e) {
            console.error("Error during converter cleanup:", e);
        }
        state.converter = null;
        state.sourceBufferInternal = null;
    }

    if (state.audioContext) {
        state.audioContext.close().catch(e => console.error(`Error closing AudioContext: ${e}`));
        state.audioContext = null;
        state.audioBufferQueue.forEach(source => { try { source.stop(0); source.disconnect(); } catch (e) {} });
        state.audioBufferQueue = [];
        state.nextAudioTime = 0;
        state.audioCodecId = null;
        state.receivedFirstAudioPacket = false;
    }

    elements.videoElement.pause();
    try { 
        elements.videoElement.src = ""; 
        elements.videoElement.removeAttribute('src'); 
        elements.videoElement.load(); 
    } catch (e) {}

    Object.assign(state, {
        deviceWidth: 0,
        deviceHeight: 0,
        videoResolution: 'Unknown',
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
        frameTimestamps: []
    });

    elements.videoPlaceholder.classList.remove('hidden');
    elements.videoElement.classList.remove('visible');
    elements.streamArea.style.aspectRatio = '';

    if (document.fullscreenElement === elements.videoElement) {
        document.exitFullscreen().catch(e => console.error("Error exiting fullscreen:", e));
    }
    elements.videoElement.classList.remove('fullscreen');
    log('Stream stopped.');
};

// Event Listeners
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
            elements.videoElement.requestFullscreen().catch(err => {
                console.error(`Fullscreen error: ${err}`);
                log(`Failed to enter fullscreen: ${err.message}`);
            });
        } else {
            log("Cannot enter fullscreen: Stream not running.");
        }
    } else {
        document.exitFullscreen().catch(err => {
            console.error(`Exit fullscreen error: ${err}`);
            log(`Failed to exit fullscreen: ${err.message}`);
        });
    }
});

document.addEventListener('fullscreenchange', () => {
    elements.videoElement.classList.toggle('fullscreen', document.fullscreenElement === elements.videoElement);
    log(document.fullscreenElement ? 'Entered fullscreen' : 'Exited fullscreen');
});

elements.startButton.addEventListener('click', startStreaming);
elements.stopButton.addEventListener('click', () => stopStreaming(true));
window.addEventListener('beforeunload', () => {
    if (state.isRunning || (state.ws && state.ws.readyState === WebSocket.OPEN)) {
        stopStreaming(true);
    }
});

// Initialization
elements.stopButton.disabled = true;
updateStatus('Idle');
log('Page loaded. Ready.');