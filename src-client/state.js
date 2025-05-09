import { APPS_PER_PAGE } from './constants.js';

export const globalState = {
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
    volumeChangeTimeout: null,
    lastVolumeSendTime: 0,
    pendingVolumeValue: null,
    frameCheckCounter: 0,
    qrWs: null,
    qrCodeInstance: null,
    isTaskbarPinned: false,
    taskbarHideTimeout: null,
    activePanel: null,
    lastPinToggleClickTime: 0,
    pendingAdbCommands: new Map(),
};

export function resetStreamRelatedState() {
    globalState.converter = null;
	globalState.audioContext = null;
	globalState.audioDecoder = null;
	globalState.sourceBufferInternal = null;
	globalState.currentTimeNotChangedSince = -1;
	globalState.bigBufferSince = -1;
	globalState.aheadOfBufferSince = -1;
	globalState.lastVideoTime = -1;
	globalState.seekingSince = -1;
	globalState.removeStart = -1;
	globalState.removeEnd = -1;
	globalState.receivedFirstAudioPacket = false;
	globalState.audioMetadata = null;
	globalState.videoStats = [];
	globalState.inputBytes = [];
	globalState.momentumQualityStats = null;
	globalState.noDecodedFramesSince = -1;
	globalState.isMouseDown = false;
	globalState.currentMouseButtons = 0;
	globalState.lastMousePosition = { x: 0, y: 0 };
	globalState.nextAudioTime = 0;
	globalState.totalAudioFrames = 0;
	globalState.deviceWidth = 0;
	globalState.deviceHeight = 0;
	globalState.videoResolution = 'Unknown';
}