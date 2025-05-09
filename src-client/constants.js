export const CHECK_STATE_INTERVAL_MS = 500;
export const MAX_SEEK_WAIT_MS = 1000;
export const MAX_TIME_TO_RECOVER = 200;
export const IS_SAFARI = !!window.safari;
export const IS_CHROME = navigator.userAgent.includes('Chrome');
export const IS_MAC = navigator.platform.startsWith('Mac');
export const MAX_BUFFER = IS_SAFARI ? 2 : IS_CHROME && IS_MAC ? 0.9 : 0.2;
export const MAX_AHEAD = -0.2;
export const DEFAULT_FRAMES_PER_SECOND = 30;
export const DEFAULT_FRAMES_PER_FRAGMENT = 1;
export const NALU_TYPE_IDR = 5;

export const AUDIO_BYTES_PER_SAMPLE = 2;
export const BINARY_TYPES = {
	VIDEO: 0,
	AUDIO: 1
};
export const CODEC_IDS = {
	H264: 0x68323634,
	AAC: 0x00616163
};
export const CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT = 2;
export const AMOTION_EVENT_ACTION_DOWN = 0;
export const AMOTION_EVENT_ACTION_UP = 1;
export const AMOTION_EVENT_ACTION_MOVE = 2;
export const AMOTION_EVENT_BUTTON_PRIMARY = 1;
export const AMOTION_EVENT_BUTTON_SECONDARY = 2;
export const AMOTION_EVENT_BUTTON_TERTIARY = 4;
export const POINTER_ID_MOUSE = -1n;

export const CONTROL_MSG_TYPE_SET_SCREEN_POWER_MODE_CLIENT = 10;
export const SCREEN_POWER_MODE_OFF_CLIENT = 0;

export const CONTROL_MSG_TYPE_BACK_OR_SCREEN_ON_CLIENT = 4;
export const CONTROL_MSG_TYPE_SCROLL_CLIENT = 3;

export const VOLUME_THROTTLE_MS = 150;
export const APPS_PER_PAGE = 9;
export const MAX_LOG_LINES = 509
export const FRAME_CHECK_INTERVAL = 2;
export const HIDE_TASKBAR_TIMEOUT_MS = 2000;
export const DOUBLE_CLICK_THRESHOLD_MS = 200;
export const HIDE_HEADER_TIMEOUT_MS = 2500;