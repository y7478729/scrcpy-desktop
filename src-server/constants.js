const path = require('path');

const SERVER_PORT_BASE = 27183;
const WEBSOCKET_PORT = 8080;
const HTTP_PORT = 8000;
const SERVER_JAR_PATH = path.resolve(__dirname, '../public/vendor/Genymobile/scrcpy-server/scrcpy-server-v3.2');
const SERVER_DEVICE_PATH = '/data/local/tmp/scrcpy-server.jar';
const SCRCPY_VERSION = '3.2';
const WSS_QR_PORT = 3001;

const LogLevel = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

const CURRENT_LOG_LEVEL = LogLevel.INFO;

const BASE_SCRCPY_OPTIONS = {
    log_level: CURRENT_LOG_LEVEL === LogLevel.DEBUG ? 'debug' : 'info',
    video_codec: 'h264',
    audio_codec: 'aac'
};

const DEVICE_NAME_LENGTH = 64;
const VIDEO_METADATA_LENGTH = 12;
const AUDIO_METADATA_LENGTH = 4;
const PACKET_HEADER_LENGTH = 12;
const MESSAGE_TYPES = {
    DEVICE_NAME: 'deviceName',
    VIDEO_INFO: 'videoInfo',
    AUDIO_INFO: 'audioInfo',
    STATUS: 'status',
    ERROR: 'error',
    DEVICE_MESSAGE: 'deviceMessage',
    RESOLUTION_CHANGE: 'resolutionChange',
    BATTERY_INFO: 'batteryInfo',
    LAUNCHER_APPS_LIST: 'launcherAppsList',
    VOLUME_RESPONSE: 'volumeResponse',
    VOLUME_INFO: 'volumeInfo',
    NAV_RESPONSE: 'navResponse',
    WIFI_RESPONSE: 'wifiResponse',
    WIFI_STATUS: 'wifiStatus',
    LAUNCH_APP_RESPONSE: 'launchAppResponse',
    ADB_DEVICES_LIST: 'adbDevicesList',
};

const BINARY_TYPES = {
    VIDEO: 0,
    AUDIO: 1
};
const CODEC_IDS = {
    H264: 0x68323634,
    AAC: 0x00616163
};

const CONTROL_MSG_TYPE_SET_SCREEN_POWER_MODE = 10;

const SAMPLE_RATE_MAP = {
	0: 96000, 1: 88200, 2: 64000, 3: 48000, 4: 44100, 5: 32000,
	6: 24000, 7: 22050, 8: 16000, 9: 12000, 10: 11025, 11: 8000,
	12: 7350, 13: 0, 14: 0, 15: 0
};
const PROFILE_MAP = { 2: 1, 5: 4, 29: 28 };

const NAV_KEYCODES = {
    back: 4,
    home: 3,
    recents: 187
};

module.exports = {
    SERVER_PORT_BASE,
    WEBSOCKET_PORT,
    HTTP_PORT,
    SERVER_JAR_PATH,
    SERVER_DEVICE_PATH,
    SCRCPY_VERSION,
    WSS_QR_PORT,
    LogLevel,
    CURRENT_LOG_LEVEL,
    BASE_SCRCPY_OPTIONS,
    DEVICE_NAME_LENGTH,
    VIDEO_METADATA_LENGTH,
    AUDIO_METADATA_LENGTH,
    PACKET_HEADER_LENGTH,
    MESSAGE_TYPES,
    BINARY_TYPES,
    CODEC_IDS,
    CONTROL_MSG_TYPE_SET_SCREEN_POWER_MODE,
    SAMPLE_RATE_MAP,
    PROFILE_MAP,
    NAV_KEYCODES,
};