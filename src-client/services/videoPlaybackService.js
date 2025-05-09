import { globalState } from '../state.js';
import { elements } from '../domElements.js';
import { appendLog } from '../loggerService.js';
import * as C from '../constants.js';

import * as H264ConverterModule from 'h264-converter';

const VideoConverter = H264ConverterModule.default;

const setLoggerFunc = H264ConverterModule.setLogger;

if (typeof setLoggerFunc === 'function') {
    setLoggerFunc(() => {}, (message) => appendLog(message, true));
} else {
    console.error('h264-converter.setLogger is not a function. Available exports:', H264ConverterModule);
}

if (typeof VideoConverter !== 'function') {
    console.error('h264-converter.default (VideoConverter) is not a constructor. Available exports:', H264ConverterModule);
}


function onVideoCanPlay() {
	if (globalState.isRunning && elements.videoElement && typeof VideoConverter === 'function') {
        elements.videoElement.play().catch(e => {
            appendLog(`Video play error: ${e.message}`, true)
        });
    }
}

function onVideoError(e) {
    appendLog(`Video element error: ${e.message || JSON.stringify(e)}`, true);
}

export function handleVideoInfo(width, height) {
    globalState.deviceWidth = width;
    globalState.deviceHeight = height;
    globalState.videoResolution = `${width}x${height}`;
    if (elements.streamArea) {
        elements.streamArea.style.aspectRatio = globalState.deviceWidth > 0 && globalState.deviceHeight > 0 ? `${globalState.deviceWidth} / ${globalState.deviceHeight}` : '9 / 16';
    }
    if (elements.videoPlaceholder) {
        if (width > 0 || height > 0) {
            elements.videoPlaceholder.classList.add('hidden');
        } else {
            elements.videoPlaceholder.classList.remove('hidden');
        }
    }
    if (elements.videoElement) {
        if (width > 0 || height > 0) {
            elements.videoElement.classList.add('visible');
        } else {
            elements.videoElement.classList.remove('visible');
        }
    }
}


export function initializeVideoConverter() {
    if (typeof VideoConverter !== 'function') {
        appendLog('VideoConverter class not available from h264-converter. Cannot initialize.', true);
        return;
    }
	const fps = parseInt(elements.maxFpsSelect.value) || C.DEFAULT_FRAMES_PER_SECOND;
	globalState.converter = new VideoConverter(elements.videoElement, fps, C.DEFAULT_FRAMES_PER_FRAGMENT);
	globalState.sourceBufferInternal = globalState.converter?.sourceBuffer || null;

    if (elements.videoElement) {
        elements.videoElement.removeEventListener('canplay', onVideoCanPlay);
        elements.videoElement.addEventListener('canplay', onVideoCanPlay, { once: true });
        elements.videoElement.removeEventListener('error', onVideoError);
        elements.videoElement.addEventListener('error', onVideoError);
    }
    handleVideoInfo(0, 0);
}

export function stopVideoConverter() {
    if (globalState.converter) {
		try {
			globalState.converter.appendRawData(new Uint8Array([]));
			globalState.converter.pause();
			globalState.converter = null;
		} catch (e) {
            appendLog(`Error stopping video converter: ${e.message}`, true);
        }
	}
	globalState.sourceBufferInternal = null;
    if (elements.videoElement) {
        elements.videoElement.pause();
        try {
            elements.videoElement.src = "";
            elements.videoElement.removeAttribute('src');
            elements.videoElement.load();
        } catch (e) {
             appendLog(`Error resetting video element: ${e.message}`, true);
        }
    }
    handleVideoInfo(0,0);
}

function isIFrame(frameData) {
	if (!frameData || frameData.length < 4) return false;
	let offset = 0;
	if (frameData[0] === 0 && frameData[1] === 0) {
		if (frameData[2] === 1) offset = 3;
		else if (frameData.length > 3 && frameData[2] === 0 && frameData[3] === 1) offset = 4;
	}
	return offset > 0 && frameData.length > offset && (frameData[offset] & 0x1F) === C.NALU_TYPE_IDR;
}

function cleanSourceBuffer() {
	if (!globalState.sourceBufferInternal || globalState.sourceBufferInternal.updating || globalState.removeStart < 0 || globalState.removeEnd <= globalState.removeStart) {
		globalState.sourceBufferInternal?.removeEventListener('updateend', cleanSourceBuffer);
		globalState.removeStart = globalState.removeEnd = -1;
		return;
	}
	try {
		globalState.sourceBufferInternal.remove(globalState.removeStart, globalState.removeEnd);
		globalState.sourceBufferInternal.addEventListener('updateend', cleanSourceBuffer, { once: true });
	} catch (e) {
		appendLog(`Error cleaning source buffer: ${e.message}`, true);
		globalState.sourceBufferInternal?.removeEventListener('updateend', cleanSourceBuffer);
		globalState.removeStart = globalState.removeEnd = -1;
	}
}

function checkForIFrameAndCleanBuffer(frameData) {
	if (C.IS_SAFARI) return;
	globalState.frameCheckCounter = (globalState.frameCheckCounter + 1) % C.FRAME_CHECK_INTERVAL;
	if (globalState.frameCheckCounter !== 0) return;

	if (!elements.videoElement?.buffered || !elements.videoElement.buffered.length) return;
	const buffered = elements.videoElement.buffered.end(0) - elements.videoElement.currentTime;
	const MAX_BUFFER_CLEAN = C.IS_SAFARI ? 2 : (C.IS_CHROME && C.IS_MAC ? 1.2 : 0.5);
	if (buffered < MAX_BUFFER_CLEAN * 1.5) return;

	if (!globalState.sourceBufferInternal) {
		globalState.sourceBufferInternal = globalState.converter?.sourceBuffer || null;
		if (!globalState.sourceBufferInternal) return;
	}
	if (!isIFrame(frameData)) return;

	const start = elements.videoElement.buffered.start(0);
	const end = elements.videoElement.buffered.end(0) | 0;
	if (end !== 0 && start < end) {
		if (globalState.removeEnd !== -1) globalState.removeEnd = Math.max(globalState.removeEnd, end);
		else { globalState.removeStart = start; globalState.removeEnd = end; }
		if(globalState.sourceBufferInternal) {
		    globalState.sourceBufferInternal.addEventListener('updateend', cleanSourceBuffer, { once: true });
        }
	}
}

export function handleVideoData(payloadArrayBuffer) {
    if (!globalState.converter || typeof VideoConverter !== 'function') return;
    const payloadUint8 = new Uint8Array(payloadArrayBuffer);
    if (globalState.inputBytes.length > 200) globalState.inputBytes.shift();
    globalState.inputBytes.push({ timestamp: Date.now(), bytes: payloadArrayBuffer.byteLength });
    globalState.converter.appendRawData(payloadUint8);
    checkForIFrameAndCleanBuffer(payloadUint8);
}


function getVideoPlaybackQuality() {
	const video = elements.videoElement;
	if (!video) return null;
	const now = Date.now();
	if (typeof video.getVideoPlaybackQuality === 'function') {
		const temp = video.getVideoPlaybackQuality();
		return { timestamp: now, decodedFrames: temp.totalVideoFrames, droppedFrames: temp.droppedVideoFrames };
	}
	if (typeof video.webkitDecodedFrameCount !== 'undefined') {
        return { timestamp: now, decodedFrames: video.webkitDecodedFrameCount, droppedFrames: video.webkitDroppedFrameCount };
    }
	return null;
}

function calculateMomentumStats() {
	const stat = getVideoPlaybackQuality(); if (!stat) return;
	const timestamp = Date.now();
	globalState.videoStats.push(stat);
	globalState.inputBytes.push({ timestamp, bytes: globalState.inputBytes.length > 0 ? globalState.inputBytes[globalState.inputBytes.length - 1].bytes : 0 });
	if (globalState.videoStats.length > 10) { globalState.videoStats.shift(); globalState.inputBytes.shift(); }
	const inputBytesSum = globalState.inputBytes.reduce((sum, item) => sum + item.bytes, 0);
	const inputFrames = globalState.inputBytes.length;
	if (globalState.videoStats.length > 1) {
		const oldest = globalState.videoStats[0];
		const decodedFrames = stat.decodedFrames - oldest.decodedFrames;
		const droppedFrames = stat.droppedFrames - oldest.droppedFrames;
		globalState.momentumQualityStats = { decodedFrames, droppedFrames, inputBytes: inputBytesSum, inputFrames, timestamp };
	}
}

export function checkForBadState() {
	if (!globalState.isRunning || !globalState.converter || !elements.videoElement || elements.videoElement.paused || typeof VideoConverter !== 'function') return;
	const { currentTime } = elements.videoElement; const now = Date.now();
	let hasReasonToJump = false;
	if (elements.videoElement.buffered && elements.videoElement.buffered.length > 0) {
		const end = elements.videoElement.buffered.end(0);
		const buffered = end - currentTime;
		const MAX_BUFFER_CHECK = C.IS_SAFARI ? 2 : (C.IS_CHROME && C.IS_MAC ? 1.2 : 0.5);
		if (buffered > MAX_BUFFER_CHECK || buffered < C.MAX_AHEAD) calculateMomentumStats();
	}
	if (globalState.momentumQualityStats && globalState.momentumQualityStats.decodedFrames === 0 && globalState.momentumQualityStats.inputFrames > 0) {
		if (globalState.noDecodedFramesSince === -1) globalState.noDecodedFramesSince = now;
		else if (now - globalState.noDecodedFramesSince > C.MAX_TIME_TO_RECOVER) hasReasonToJump = true;
	} else globalState.noDecodedFramesSince = -1;

	if (currentTime === globalState.lastVideoTime && globalState.currentTimeNotChangedSince === -1) globalState.currentTimeNotChangedSince = now;
	else if (currentTime !== globalState.lastVideoTime) globalState.currentTimeNotChangedSince = -1;
	globalState.lastVideoTime = currentTime;

	if (elements.videoElement.buffered && elements.videoElement.buffered.length > 0) {
		const end = elements.videoElement.buffered.end(0);
		const buffered = end - currentTime;
		const MAX_BUFFER_JUMP = C.IS_SAFARI ? 2 : (C.IS_CHROME && C.IS_MAC ? 1.2 : 0.5);
		if (buffered > MAX_BUFFER_JUMP) {
			if (globalState.bigBufferSince === -1) globalState.bigBufferSince = now;
			else if (now - globalState.bigBufferSince > C.MAX_TIME_TO_RECOVER) hasReasonToJump = true;
		} else globalState.bigBufferSince = -1;
		if (buffered < C.MAX_AHEAD) {
			if (globalState.aheadOfBufferSince === -1) globalState.aheadOfBufferSince = now;
			else if (now - globalState.aheadOfBufferSince > C.MAX_TIME_TO_RECOVER) hasReasonToJump = true;
		} else globalState.aheadOfBufferSince = -1;
		if (globalState.currentTimeNotChangedSince !== -1 && now - globalState.currentTimeNotChangedSince > C.MAX_TIME_TO_RECOVER) hasReasonToJump = true;
		if (!hasReasonToJump) return;
		if (globalState.seekingSince !== -1 && now - globalState.seekingSince < C.MAX_SEEK_WAIT_MS) return;
		const onSeekEnd = () => {
			globalState.seekingSince = -1;
			elements.videoElement.removeEventListener('seeked', onSeekEnd);
			elements.videoElement.play().catch(e => { appendLog(`Video play error after seek: ${e.message}`, true); });
		};
		if (globalState.seekingSince !== -1) appendLog('Seek already in progress, but attempting again due to bad state.', true);
		globalState.seekingSince = now;
		elements.videoElement.addEventListener('seeked', onSeekEnd);
		elements.videoElement.currentTime = end;
        appendLog(`Jumped video to ${end} due to bad state.`);
	}
}

export function updateVideoResolutionInStream(width, height) {
    if (!globalState.isRunning) return;
	if (width !== globalState.deviceWidth || height !== globalState.deviceHeight) {
        handleVideoInfo(width, height);
        appendLog(`Resolution changed to ${globalState.videoResolution}`);
	}
}