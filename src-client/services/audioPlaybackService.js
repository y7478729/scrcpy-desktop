import { globalState } from '../state.js';
import { elements } from '../domElements.js';
import { appendLog } from '../loggerService.js';
import * as C from '../constants.js';

export function setupAudioPlayer(codecId, metadata) {
	if (codecId !== C.CODEC_IDS.AAC) {
        appendLog(`Unsupported audio codec ID: ${codecId}`, true);
        return;
    }
	if (!window.AudioContext || !window.AudioDecoder) {
        appendLog('AudioContext or AudioDecoder not supported by browser.', true);
        return;
    }
	try {
		if (!globalState.audioContext || globalState.audioContext.state === 'closed') {
            globalState.audioContext = new AudioContext({ sampleRate: metadata.sampleRate || 48000 });
        }
		globalState.audioDecoder = new AudioDecoder({
			output: (audioData) => {
				try {
					if (!globalState.audioContext || globalState.audioContext.state === 'closed') return;
					const numberOfChannels = audioData.numberOfChannels;
					const sampleRate = audioData.sampleRate;
					const buffer = globalState.audioContext.createBuffer(numberOfChannels, audioData.numberOfFrames, sampleRate);
					const isInterleaved = audioData.format === 'f32' || audioData.format === 'f32-interleaved';
					if (isInterleaved) {
						const interleavedData = new Float32Array(audioData.numberOfFrames * numberOfChannels);
						audioData.copyTo(interleavedData, { planeIndex: 0 });
						for (let channel = 0; channel < numberOfChannels; channel++) {
							const channelData = buffer.getChannelData(channel);
							for (let i = 0; i < audioData.numberOfFrames; i++) channelData[i] = interleavedData[i * numberOfChannels + channel];
						}
					} else {
                        for (let channel = 0; channel < numberOfChannels; channel++) {
                            audioData.copyTo(buffer.getChannelData(channel), { planeIndex: channel });
                        }
                    }
					const source = globalState.audioContext.createBufferSource();
					source.buffer = buffer;
					source.connect(globalState.audioContext.destination);
					const currentTime = globalState.audioContext.currentTime;
					const bufferDuration = audioData.numberOfFrames / sampleRate;
                    const videoTime = elements.videoElement ? elements.videoElement.currentTime : 0;

					if (!globalState.receivedFirstAudioPacket) {
						globalState.nextAudioTime = Math.max(currentTime, videoTime);
						globalState.receivedFirstAudioPacket = true;
					}
					if (globalState.nextAudioTime < currentTime) globalState.nextAudioTime = currentTime;
					source.start(globalState.nextAudioTime);
					globalState.nextAudioTime += bufferDuration;
				} catch (e) {
                    appendLog(`Error playing audio data: ${e.message}`, true);
                } finally {
                    audioData.close();
                }
			},
			error: (error) => {
                appendLog(`AudioDecoder error: ${error.message}`, true);
            },
		});
		globalState.audioDecoder.configure({
			codec: 'mp4a.40.2',
			sampleRate: metadata.sampleRate || 48000,
			numberOfChannels: metadata.channelConfig || 2
		});
		globalState.audioCodecId = codecId;
		globalState.audioMetadata = metadata;
		globalState.receivedFirstAudioPacket = false;
		globalState.nextAudioTime = 0;
		globalState.totalAudioFrames = 0;
        appendLog('Audio player initialized.');
	} catch (e) {
		appendLog(`Error setting up audio player: ${e.message}`, true);
		globalState.audioDecoder = null;
		globalState.audioContext = null;
	}
}

export function handleAudioData(arrayBuffer) {
	if (!globalState.audioDecoder || !globalState.isRunning || globalState.audioCodecId !== C.CODEC_IDS.AAC || arrayBuffer.byteLength === 0) return;
	try {
		const uint8Array = new Uint8Array(arrayBuffer);
		const sampleRate = globalState.audioMetadata?.sampleRate || 48000;
		const frameDuration = 1024 / sampleRate * 1000000;
		globalState.audioDecoder.decode(new EncodedAudioChunk({
			type: 'key',
			timestamp: globalState.totalAudioFrames * frameDuration,
			data: uint8Array
		}));
		globalState.totalAudioFrames += 1024;
	} catch (e) {
        appendLog(`Error decoding audio data: ${e.message}`, true);
    }
}

export function closeAudio() {
    if (globalState.audioDecoder) {
		if (globalState.audioDecoder.state !== 'closed') globalState.audioDecoder.close();
		globalState.audioDecoder = null;
	}
	if (globalState.audioContext) {
		if (globalState.audioContext.state !== 'closed') globalState.audioContext.close();
		globalState.audioContext = null;
	}
	globalState.audioMetadata = null;
	globalState.receivedFirstAudioPacket = false;
	globalState.nextAudioTime = 0;
	globalState.totalAudioFrames = 0;
}