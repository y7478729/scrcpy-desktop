import VideoConverter from 'h264-converter';
import { setLogger } from 'h264-converter';


const startButton = document.getElementById('startBtn');
const stopButton = document.getElementById('stopBtn');
const bitrateSelect = document.getElementById('bitrate');
const maxSizeSelect = document.getElementById('maxSize');
const maxFpsSelect = document.getElementById('maxFps');
const enableAudioInput = document.getElementById('enableAudio');
const statusDiv = document.getElementById('status');
const themeToggle = document.getElementById('themeToggle');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const streamArea = document.getElementById('streamArea'); // New wrapper div
const videoPlaceholder = document.getElementById('videoPlaceholder');
const videoElement = document.getElementById('screen');
const infoDiv = document.getElementById('info');


let ws = null;
let converter = null;
let isRunning = false;
let audioContext = null;
let audioBufferQueue = [];
let nextAudioTime = 0;
let audioCodecId = null;
let receivedFirstAudioPacket = false;
let deviceWidth = 0;
let deviceHeight = 0;
let videoResolution = 'Unknown';
const MAX_AUDIO_QUEUE_SIZE = 10;

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_BYTES_PER_SAMPLE = 2;
const AUDIO_SAMPLE_SIZE = AUDIO_CHANNELS * AUDIO_BYTES_PER_SAMPLE;

const BINARY_TYPES = {
    VIDEO: 0,
    AUDIO: 1
};

const CODEC_IDS = {
    H264: 0x68323634,
    RAW: 0x00726177,
};

function log(message) {
    console.log(message);
    infoDiv.textContent = message;
}

function setupAudioPlayer(codecId) {
    if (codecId !== CODEC_IDS.RAW) {
        log(`Unsupported audio codec ID: 0x${codecId.toString(16)}`);
        return;
    }
    if (!window.AudioContext && !window.webkitAudioContext) {
        log('Web Audio API not supported');
        return;
    }
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(e => console.error(`Error closing previous AudioContext: ${e}`));
    }
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: AUDIO_SAMPLE_RATE });
        audioBufferQueue = [];
        nextAudioTime = 0;
        receivedFirstAudioPacket = false;
        audioCodecId = codecId;
        log('Audio player setup for RAW audio');
    } catch (e) {
        log(`Failed to create AudioContext: ${e}`);
        audioContext = null;
    }
}

function handleAudioData(arrayBuffer) {
    if (!audioContext || !isRunning || audioCodecId !== CODEC_IDS.RAW) return;
    if (arrayBuffer.byteLength === 0) return;
    if (arrayBuffer.byteLength % AUDIO_SAMPLE_SIZE !== 0) {
        console.warn(`Invalid audio data length: ${arrayBuffer.byteLength} bytes`);
        return;
    }

    const frameCount = arrayBuffer.byteLength / AUDIO_SAMPLE_SIZE;
    try {
        const audioBuffer = audioContext.createBuffer(AUDIO_CHANNELS, frameCount, AUDIO_SAMPLE_RATE);
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
}

function playAudioBuffer(buffer) {
    if (!audioContext || audioContext.state === 'closed') {
        console.warn('Cannot play audio, context is closed or null.');
        return;
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume().catch(e => console.error(`Audio context resume error: ${e}`));
    }
    if (audioBufferQueue.length >= MAX_AUDIO_QUEUE_SIZE) {
        const oldSource = audioBufferQueue.shift();
        try { oldSource.stop(0); oldSource.disconnect(); } catch (e) {}
    }
    if (!receivedFirstAudioPacket) {
        nextAudioTime = audioContext.currentTime + 0.05;
        receivedFirstAudioPacket = true;
    }

    try {
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        const startTime = Math.max(audioContext.currentTime, nextAudioTime);
        source.start(startTime);
        nextAudioTime = startTime + buffer.duration;

        audioBufferQueue.push(source);
        source.onended = () => {
            const index = audioBufferQueue.indexOf(source);
            if (index > -1) audioBufferQueue.splice(index, 1);
            try { source.disconnect(); } catch (e) {}
        };
    } catch (e) {
        console.error(`Error playing audio buffer: ${e}`);
        if (e.name === 'InvalidStateError' && audioContext.state === 'closed') {
            console.warn('AudioContext was closed during audio playback attempt.');
            audioContext = null;
        }
    }
}

function initVideoConverter() {
    if (converter) {
        converter = null;
    }
    const options = {
        fps: parseInt(maxFpsSelect.value),
        bitrate: parseInt(bitrateSelect.value),
    };
    converter = new VideoConverter(videoElement, options.fps, 1);
    videoElement.addEventListener('loadedmetadata', () => {
        if (isRunning && videoPlaceholder.classList.contains('hidden')) {
             videoElement.play().catch(e => console.warn("Autoplay prevented:", e));
        }
    }, { once: true });
}

function updateStatus(message) {
    statusDiv.textContent = `Status: ${message}`;
}

function startStreaming() {
    if (isRunning || (ws && ws.readyState === WebSocket.OPEN)) {
        log('Cannot start stream: Already running or WebSocket open.');
        return;
    }
    updateStatus('Connecting...');
    startButton.disabled = true;

    maxSizeSelect.disabled = true;
    maxFpsSelect.disabled = true;
    bitrateSelect.disabled = true;
    enableAudioInput.disabled = true;

    const wsUrl = `ws://${window.location.hostname}:8080`;
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    initVideoConverter();

    ws.onopen = () => {
        updateStatus('Connected. Requesting stream...');
        log('WebSocket opened. Sending start options.');
        const options = {
            action: 'start',
            maxSize: parseInt(maxSizeSelect.value) || 0,
            maxFps: parseInt(maxFpsSelect.value) || 0,
            bitrate: (parseInt(bitrateSelect.value) || 8) * 1000000,
            enableAudio: enableAudioInput.checked,
        };
        ws.send(JSON.stringify(options));
    };

    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            if (!isRunning) return;

            const dataView = new DataView(event.data);
            if (dataView.byteLength < 1) return;

            const type = dataView.getUint8(0);
            const payload = event.data.slice(1);

            if (type === BINARY_TYPES.VIDEO && converter) {
                converter.appendRawData(new Uint8Array(payload));
            } else if (type === BINARY_TYPES.AUDIO && enableAudioInput.checked && audioContext) {
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
                            isRunning = true;
                            startButton.disabled = true;
                            stopButton.disabled = false;
                            maxSizeSelect.disabled = true;
                            maxFpsSelect.disabled = true;
                            bitrateSelect.disabled = true;
                            enableAudioInput.disabled = true;
                        } else if (message.message === 'Streaming stopped') {
                            stopStreaming(false);
                        }
                        break;
                    case 'videoInfo':
                        videoResolution = `${message.width}x${message.height}`;
                        deviceWidth = message.width;
                        deviceHeight = message.height;
                        log(`Video dimensions: ${videoResolution}`);

                        if (deviceWidth > 0 && deviceHeight > 0) {
                             streamArea.style.aspectRatio = `${deviceWidth} / ${deviceHeight}`;
                        } else {
                             streamArea.style.aspectRatio = ''; // Revert to CSS default
                        }

                        videoPlaceholder.classList.add('hidden');
                        videoElement.classList.add('visible'); // Make video visible

                        if (converter && !converter.isPlaying) {
                            converter.play();
                            // Delay play slightly to ensure element is visible? Sometimes needed.
                            requestAnimationFrame(() => {
                                videoElement.play().catch(e => console.warn("Autoplay prevented:", e));
                            });
                        }
                        break;
                    case 'audioInfo':
                        log(`Audio info: Codec ID 0x${message.codecId?.toString(16)}`);
                        if (enableAudioInput.checked) {
                            setupAudioPlayer(message.codecId);
                        }
                        break;
                    default:
                        log(`Unknown message type: ${message.type}`);
                }
            } catch (e) {
                console.error('Error parsing JSON message:', e, 'Raw data:', event.data);
                updateStatus('Error processing server message');
            }
        }
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        updateStatus('WebSocket error');
        log('WebSocket error occurred.');
        stopStreaming(false);
    };

    ws.onclose = (event) => {
        const reason = event.reason || `code ${event.code}`;
        const statusMsg = event.wasClean ? `Disconnected (${reason})` : `Connection Lost (${reason})`;
        updateStatus(statusMsg);
        log(`WebSocket closed: ${statusMsg}`);
        stopStreaming(false);
    };
}

function stopStreaming(sendDisconnect = true) {
    if (!isRunning && !sendDisconnect && !(ws && ws.readyState < WebSocket.CLOSING)) {
         if (ws && ws.readyState === WebSocket.OPEN) {
             ws.close(1000, 'Cleanup closure');
         }
         return;
    }

    isRunning = false;
    startButton.disabled = false;
    stopButton.disabled = true;

    maxSizeSelect.disabled = false;
    maxFpsSelect.disabled = false;
    bitrateSelect.disabled = false;
    enableAudioInput.disabled = false;

    if (ws) {
        if (sendDisconnect && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({ action: 'disconnect' }));
                log('Sent disconnect message.');
            } catch (e) {
                console.error("Error sending disconnect message:", e);
            }
        }
        if (ws.readyState < WebSocket.CLOSING) {
            ws.close(1000, 'User stopped streaming');
        }
        ws = null;
    }

    if (converter) {
        converter.pause();
        converter = null;
    }

    if (audioContext) {
        audioContext.close().then(() => log('AudioContext closed.')).catch(e => console.error(`Error closing AudioContext: ${e}`));
        audioContext = null;
        audioBufferQueue.forEach(source => { try { source.stop(0); source.disconnect(); } catch (e) {} });
        audioBufferQueue = [];
        nextAudioTime = 0;
        audioCodecId = null;
        receivedFirstAudioPacket = false;
    }

    videoElement.pause();
    if (!videoElement.ended) {
        videoElement.currentTime = 0;
    }
    try { videoElement.src = ""; videoElement.removeAttribute('src'); } catch (e) {} // Clear src
    try { videoElement.load(); } catch (e) {} // Reset element state

    deviceWidth = 0;
    deviceHeight = 0;
    videoResolution = 'Unknown';
    log('Stream stopped.');

    videoPlaceholder.classList.remove('hidden');
    videoElement.classList.remove('visible'); // Hide video
    streamArea.style.aspectRatio = ''; // Revert to CSS default (9/16)


    if (document.fullscreenElement === videoElement) {
        document.exitFullscreen().catch(e => console.error("Error exiting fullscreen:", e));
    }
    videoElement.classList.remove('fullscreen'); // Ensure class is removed if exiting fullscreen via stop

}

themeToggle.addEventListener('click', () => {
    const body = document.body;
    const currentTheme = body.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    body.setAttribute('data-theme', newTheme);
    log(`Theme switched to ${newTheme}`);
});

let themeToggleTimeout;
function showThemeToggle() {
    themeToggle.classList.remove('hidden');
    clearTimeout(themeToggleTimeout);
    themeToggleTimeout = setTimeout(() => {
        themeToggle.classList.add('hidden');
    }, 3000);
}

document.addEventListener('mousemove', showThemeToggle);
document.addEventListener('scroll', showThemeToggle);
document.addEventListener('touchstart', showThemeToggle);
showThemeToggle();

fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        // Only go fullscreen if the stream is running (video is visible)
        if (isRunning && videoElement.classList.contains('visible')) {
            videoElement.requestFullscreen().then(() => {
                // Class is added via event listener
            }).catch((err) => {
                console.error(`Fullscreen error: ${err}`);
                log(`Failed to enter fullscreen: ${err.message}`);
            });
        } else {
            log("Cannot enter fullscreen: Stream not running.");
        }
    } else {
        document.exitFullscreen().then(() => {
            // Class is removed via event listener
        }).catch((err) => {
            console.error(`Exit fullscreen error: ${err}`);
            log(`Failed to exit fullscreen: ${err.message}`);
        });
    }
});

document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement === videoElement) {
         if (!videoElement.classList.contains('fullscreen')) {
             videoElement.classList.add('fullscreen');
             log('Entered fullscreen');
         }
    } else {
        // Check if the video *was* the fullscreen element
        if (videoElement.classList.contains('fullscreen')) {
           videoElement.classList.remove('fullscreen');
           log('Exited fullscreen');
        }
    }
});

startButton.addEventListener('click', startStreaming);
stopButton.addEventListener('click', () => stopStreaming(true));

window.addEventListener('beforeunload', () => {
    if (isRunning || (ws && ws.readyState === WebSocket.OPEN)) {
        stopStreaming(true);
    }
});

stopButton.disabled = true;
updateStatus('Idle');
log('Page loaded. Ready.');