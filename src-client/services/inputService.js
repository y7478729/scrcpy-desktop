import { globalState } from '../state.js';
import { elements } from '../domElements.js';
import { sendControlMessageToServer } from '../websocketService.js';
import * as C from '../constants.js';

function getScaledCoordinates(event) {
    let targetElement;
    if (globalState.decoderType === C.DECODER_TYPES.BROADWAY) {
        targetElement = globalState.broadwayPlayer ? globalState.broadwayPlayer.canvas : null;
        if (!targetElement) {
            targetElement = elements.broadwayCanvas;
        }
    } else if (globalState.decoderType === C.DECODER_TYPES.WEBCODECS) {
        targetElement = elements.webcodecCanvas;
    } else { // MSE or default
        targetElement = elements.videoElement;
    }

    if (!targetElement || !targetElement.clientWidth || !targetElement.clientHeight || !globalState.deviceWidth || !globalState.deviceHeight) {
        return null;
    }

    const rect = targetElement.getBoundingClientRect();
    let { clientWidth, clientHeight } = targetElement;
    let touchX, touchY;

    if (event.touches) {
        touchX = event.touches[0].clientX - rect.left;
        touchY = event.touches[0].clientY - rect.top;
    } else {
        touchX = event.clientX - rect.left;
        touchY = event.clientY - rect.top;
    }

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

function handleTouchStart(event) {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || !globalState.deviceHeight) return;

    let activeRenderingElement;
    if (globalState.decoderType === C.DECODER_TYPES.BROADWAY) {
        activeRenderingElement = globalState.broadwayPlayer ? globalState.broadwayPlayer.canvas : elements.broadwayCanvas;
    } else if (globalState.decoderType === C.DECODER_TYPES.WEBCODECS) {
        activeRenderingElement = elements.webcodecCanvas;
    } else { // MSE or default
        activeRenderingElement = elements.videoElement;
    }

    if (!activeRenderingElement || !event.target || (event.target !== activeRenderingElement && !activeRenderingElement.contains(event.target))) {
        if (event.target !== elements.streamArea) return;
    }

    event.preventDefault();
    globalState.isMouseDown = true;

    let buttonFlag = C.AMOTION_EVENT_BUTTON_PRIMARY;
    globalState.currentMouseButtons |= buttonFlag;
    const coords = getScaledCoordinates(event);
    if (coords) {
        globalState.lastMousePosition = coords;
        sendMouseEvent(C.AMOTION_EVENT_ACTION_DOWN, globalState.currentMouseButtons, coords.x, coords.y);
    }
}

function handleTouchMove(event) {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || !globalState.deviceHeight || !globalState.isMouseDown) return;

    event.preventDefault();
    const coords = getScaledCoordinates(event);
    if (coords) {
        globalState.lastMousePosition = coords;
        sendMouseEvent(C.AMOTION_EVENT_ACTION_MOVE, globalState.currentMouseButtons, coords.x, coords.y);
    }
}

function handleTouchEnd(event) {
    if (!globalState.isMouseDown) return;
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || !globalState.deviceHeight) {
        globalState.isMouseDown = false;
        globalState.currentMouseButtons = 0;
        return;
    }

    let buttonFlag = C.AMOTION_EVENT_BUTTON_PRIMARY;

    if (!(globalState.currentMouseButtons & buttonFlag)) return;

    const coords = getScaledCoordinates(event) || globalState.lastMousePosition;
    //console.log('Sending touch end message', coords); // 添加日志
    sendMouseEvent(C.AMOTION_EVENT_ACTION_UP, globalState.currentMouseButtons, coords.x, coords.y);
    globalState.currentMouseButtons &= ~buttonFlag;
    if (globalState.currentMouseButtons === 0) {
        globalState.isMouseDown = false;
    }
    		//console.log('Mouse state reset', globalState.isMouseDown, globalState.currentMouseButtons); // 添加日志
    
}

function handleMouseDown(event) {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || !globalState.deviceHeight) return;

    let activeRenderingElement;
    if (globalState.decoderType === C.DECODER_TYPES.BROADWAY) {
        activeRenderingElement = globalState.broadwayPlayer ? globalState.broadwayPlayer.canvas : elements.broadwayCanvas;
    } else if (globalState.decoderType === C.DECODER_TYPES.WEBCODECS) {
        activeRenderingElement = elements.webcodecCanvas;
    } else { // MSE or default
        activeRenderingElement = elements.videoElement;
    }

    if (!activeRenderingElement || !event.target || (event.target !== activeRenderingElement && !activeRenderingElement.contains(event.target))) {
        if (event.target !== elements.streamArea) return;
    }

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

    let buttonFlag = 0;
    switch (event.button) {
        case 0: buttonFlag = C.AMOTION_EVENT_BUTTON_PRIMARY; break;
        case 1: buttonFlag = C.AMOTION_EVENT_BUTTON_TERTIARY; break;
        case 2: buttonFlag = C.AMOTION_EVENT_BUTTON_SECONDARY; break;
        default: return;
    }

    if (!(globalState.currentMouseButtons & buttonFlag)) return;

    const coords = getScaledCoordinates(event) || globalState.lastMousePosition;

    sendMouseEvent(C.AMOTION_EVENT_ACTION_UP, globalState.currentMouseButtons, coords.x, coords.y);
    globalState.currentMouseButtons &= ~buttonFlag;
    if (globalState.currentMouseButtons === 0) {
        globalState.isMouseDown = false;
    }
}

function handleMouseMove(event) {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || !globalState.deviceHeight || !globalState.isMouseDown) return;

    const coords = getScaledCoordinates(event);
    if (coords) {
        globalState.lastMousePosition = coords;
        sendMouseEvent(C.AMOTION_EVENT_ACTION_MOVE, globalState.currentMouseButtons, coords.x, coords.y);
    }
}

function handleMouseLeave(event) {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.isMouseDown || globalState.currentMouseButtons === 0) return;
    
    const coords = getScaledCoordinates(event) || globalState.lastMousePosition;
    sendMouseEvent(C.AMOTION_EVENT_ACTION_UP, globalState.currentMouseButtons, coords.x, coords.y);
    globalState.isMouseDown = false;
    globalState.currentMouseButtons = 0;
}

function handleWheelEvent(event) {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || globalState.deviceWidth <= 0 || !globalState.deviceHeight || globalState.deviceHeight <= 0) return;

    let activeRenderingElement;
    if (globalState.decoderType === C.DECODER_TYPES.BROADWAY) {
        activeRenderingElement = globalState.broadwayPlayer ? globalState.broadwayPlayer.canvas : elements.broadwayCanvas;
    }
    // 原文件此处代码未完成，可根据实际情况补充
}

// 添加 initInputService 函数
export function initInputService() {
    document.addEventListener('touchstart', handleTouchStart);
    document.addEventListener('touchmove', handleTouchMove);
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseleave', handleMouseLeave);
    document.addEventListener('wheel', handleWheelEvent);
}
