import { globalState } from '../state.js';
import { elements } from '../domElements.js';
import { sendControlMessageToServer } from '../websocketService.js';
import * as C from '../constants.js';

function getScaledCoordinates(event) {
	const video = elements.videoElement;
	if (!video || !globalState.deviceWidth || !globalState.deviceHeight) return null;

	const rect = video.getBoundingClientRect();
	let { clientWidth, clientHeight } = video;
	let touchX = event.clientX - rect.left;
	let touchY = event.clientY - rect.top;

	const videoRatio = globalState.deviceWidth / globalState.deviceHeight;
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

	let deviceX = Math.round((touchX * globalState.deviceWidth) / clientWidth);
	let deviceY = Math.round((touchY * globalState.deviceHeight) / clientHeight);
	deviceX = Math.max(0, Math.min(globalState.deviceWidth, deviceX));
	deviceY = Math.max(0, Math.min(globalState.deviceHeight, deviceY));
	return { x: deviceX, y: deviceY };
}

function sendMouseEvent(action, buttons, x, y) {
	if (!globalState.deviceWidth || !globalState.deviceHeight || !globalState.controlEnabledAtStart) return;
	const buffer = new ArrayBuffer(32);
	const dataView = new DataView(buffer);
	dataView.setUint8(0, C.CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT);
	dataView.setUint8(1, action);
	dataView.setBigInt64(2, C.POINTER_ID_MOUSE, false);
	dataView.setInt32(10, x, false);
	dataView.setInt32(14, y, false);
	dataView.setUint16(18, globalState.deviceWidth, false);
	dataView.setUint16(20, globalState.deviceHeight, false);
	dataView.setUint16(22, 0xFFFF, false);
	dataView.setUint32(24, 0, false);
	dataView.setUint32(28, buttons, false);
	sendControlMessageToServer(buffer);
}

function sendBackButtonControlInternal() {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart) return;
    const bufferDown = new ArrayBuffer(2);
    const dataViewDown = new DataView(bufferDown);
    dataViewDown.setUint8(0, C.CONTROL_MSG_TYPE_BACK_OR_SCREEN_ON_CLIENT);
    dataViewDown.setUint8(1, 0);
    sendControlMessageToServer(bufferDown);

    const bufferUp = new ArrayBuffer(2);
    const dataViewUp = new DataView(bufferUp);
    dataViewUp.setUint8(0, C.CONTROL_MSG_TYPE_BACK_OR_SCREEN_ON_CLIENT);
    dataViewUp.setUint8(1, 1);
    sendControlMessageToServer(bufferUp);
}


function handleMouseDown(event) {
	if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || !globalState.deviceHeight) return;
	event.preventDefault();
	globalState.isMouseDown = true;

    if (event.button === 2) {
        sendBackButtonControlInternal();
        globalState.isMouseDown = false;
        globalState.currentMouseButtons = 0;
        return;
    }

	let buttonFlag = 0;
	switch (event.button) {
		case 0: buttonFlag = C.AMOTION_EVENT_BUTTON_PRIMARY; break;
		case 1: buttonFlag = C.AMOTION_EVENT_BUTTON_TERTIARY; break;
		default: return;
	}
	globalState.currentMouseButtons |= buttonFlag;
	const coords = getScaledCoordinates(event);
	if (coords) {
		globalState.lastMousePosition = coords;
		sendMouseEvent(C.AMOTION_EVENT_ACTION_DOWN, globalState.currentMouseButtons, coords.x, coords.y);
	}
}

function handleMouseUp(event) {
	if (!globalState.isMouseDown) return;
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || !globalState.deviceHeight) {
        globalState.isMouseDown = false;
        globalState.currentMouseButtons = 0;
        return;
    }
	event.preventDefault();

	let buttonFlag = 0;
	switch (event.button) {
		case 0: buttonFlag = C.AMOTION_EVENT_BUTTON_PRIMARY; break;
		case 1: buttonFlag = C.AMOTION_EVENT_BUTTON_TERTIARY; break;
		case 2: buttonFlag = C.AMOTION_EVENT_BUTTON_SECONDARY; break;
		default: return;
	}

	if (!(globalState.currentMouseButtons & buttonFlag)) return;

	const coords = getScaledCoordinates(event);
	const finalCoords = coords || globalState.lastMousePosition;

	sendMouseEvent(C.AMOTION_EVENT_ACTION_UP, globalState.currentMouseButtons, finalCoords.x, finalCoords.y);
	globalState.currentMouseButtons &= ~buttonFlag;
	if (globalState.currentMouseButtons === 0) {
        globalState.isMouseDown = false;
    }
}

function handleMouseMove(event) {
	if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || !globalState.deviceHeight || !globalState.isMouseDown) return;
	event.preventDefault();
	const coords = getScaledCoordinates(event);
	if (coords) {
		globalState.lastMousePosition = coords;
		sendMouseEvent(C.AMOTION_EVENT_ACTION_MOVE, globalState.currentMouseButtons, coords.x, coords.y);
	}
}

function handleMouseLeave(event) {
	if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.isMouseDown || globalState.currentMouseButtons === 0) return;
	event.preventDefault();
	sendMouseEvent(C.AMOTION_EVENT_ACTION_UP, globalState.currentMouseButtons, globalState.lastMousePosition.x, globalState.lastMousePosition.y);
	globalState.isMouseDown = false;
	globalState.currentMouseButtons = 0;
}

function handleWheelEvent(event) {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || globalState.deviceWidth <= 0 || !globalState.deviceHeight || globalState.deviceHeight <= 0) return;
    event.preventDefault();
    let coords = getScaledCoordinates(event);
    if (!coords) {
        if (globalState.lastMousePosition.x > 0 || globalState.lastMousePosition.y > 0) coords = globalState.lastMousePosition;
        else return;
    }
    let hscroll_float = 0.0, vscroll_float = 0.0;
    const scrollSensitivity = 2.5;
    if (event.deltaX !== 0) hscroll_float = event.deltaX > 0 ? -scrollSensitivity : scrollSensitivity;
    if (event.deltaY !== 0) vscroll_float = event.deltaY > 0 ? -scrollSensitivity : scrollSensitivity;
    hscroll_float = Math.max(-1.0, Math.min(1.0, hscroll_float));
    vscroll_float = Math.max(-1.0, Math.min(1.0, vscroll_float));
    if (hscroll_float === 0.0 && vscroll_float === 0.0) return;

    const hscroll_fixed_point_short = Math.round(hscroll_float * 32767.0);
    const vscroll_fixed_point_short = Math.round(vscroll_float * 32767.0);
    const buffer = new ArrayBuffer(21);
    const dataView = new DataView(buffer);
    let offset = 0;
    dataView.setUint8(offset, C.CONTROL_MSG_TYPE_SCROLL_CLIENT); offset += 1;
    dataView.setInt32(offset, coords.x, false); offset += 4;
    dataView.setInt32(offset, coords.y, false); offset += 4;
    dataView.setUint16(offset, globalState.deviceWidth, false); offset += 2;
    dataView.setUint16(offset, globalState.deviceHeight, false); offset += 2;
    dataView.setInt16(offset, hscroll_fixed_point_short, false); offset += 2;
    dataView.setInt16(offset, vscroll_fixed_point_short, false); offset += 2;
    dataView.setInt32(offset, globalState.currentMouseButtons, false);
    sendControlMessageToServer(buffer);
}

export function initInputService() {
    if (elements.videoElement) {
        elements.videoElement.addEventListener('mousedown', handleMouseDown);
        elements.videoElement.addEventListener('mousemove', handleMouseMove);
        elements.videoElement.addEventListener('mouseleave', handleMouseLeave);
        elements.videoElement.addEventListener('wheel', handleWheelEvent, { passive: false });
        elements.videoElement.addEventListener('contextmenu', (e) => {
            if (globalState.controlEnabledAtStart && globalState.isRunning) e.preventDefault();
        });
    }
    document.addEventListener('mouseup', handleMouseUp);
}