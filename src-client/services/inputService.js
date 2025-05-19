import { globalState } from '../state.js';
import { elements } from '../domElements.js';
import { sendControlMessageToServer } from '../websocketService.js';
import * as C from '../constants.js';

/**
 * 存储所有事件监听器的引用，用于后续移除
 * 键为DOM元素，值为该元素上注册的所有监听器信息
 */
const eventListeners = new Map();

/**
 * 将屏幕坐标转换为设备坐标，考虑视频渲染元素的缩放和黑边
 * @param {MouseEvent|TouchEvent} event - 鼠标或触控事件
 * @returns {{x: number, y: number}|null} - 转换后的设备坐标，或null（如果无法计算）
 */
function getScaledCoordinates(event) {
    // 根据当前解码器类型确定渲染目标元素
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
	// 检查必要条件
    if (!targetElement || !targetElement.clientWidth || !targetElement.clientHeight || !globalState.deviceWidth || !globalState.deviceHeight) {
        return null;
    }

    const rect = targetElement.getBoundingClientRect();
    let { clientWidth, clientHeight } = targetElement;
    let touchX, touchY;

	// 获取事件坐标（区分鼠标和触控）
    if (event.touches) {
        touchX = event.touches[0].clientX - rect.left;
        touchY = event.touches[0].clientY - rect.top;
    } else {
        touchX = event.clientX - rect.left;
        touchY = event.clientY - rect.top;
    }

	// 计算视频宽高比和元素宽高比
    const videoRatio = globalState.deviceWidth / globalState.deviceHeight;
    const elementRatio = clientWidth / clientHeight;

	// 处理黑边（letterbox/pillarbox）情况
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

	// 缩放坐标到设备尺寸
    let deviceX = Math.round((touchX * globalState.deviceWidth) / clientWidth);
    let deviceY = Math.round((touchY * globalState.deviceHeight) / clientHeight);
    deviceX = Math.max(0, Math.min(globalState.deviceWidth, deviceX));
    deviceY = Math.max(0, Math.min(globalState.deviceHeight, deviceY));
    return { x: deviceX, y: deviceY };
}

/**
 * 发送鼠标事件到服务器
 * @param {number} action - 动作类型（如按下、移动、释放）
 * @param {number} buttons - 按钮标志
 * @param {number} x - X坐标
 * @param {number} y - Y坐标
 */
function sendMouseEvent(action, buttons, x, y) {
    if (!globalState.deviceWidth || !globalState.deviceHeight || !globalState.controlEnabledAtStart) return;
    
    // 创建并填充二进制消息缓冲区
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

    // 发送消息到服务器
    sendControlMessageToServer(buffer);
}

/**
 * 发送返回按钮控制消息（模拟Android返回键）
 */
function sendBackButtonControlInternal() {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart) return;
    
    // 创建并发送按键按下消息
    const bufferDown = new ArrayBuffer(2);
    const dataViewDown = new DataView(bufferDown);
    dataViewDown.setUint8(0, C.CONTROL_MSG_TYPE_BACK_OR_SCREEN_ON_CLIENT);
    dataViewDown.setUint8(1, 0);
    sendControlMessageToServer(bufferDown);

	// 创建并发送按键释放消息
    const bufferUp = new ArrayBuffer(2);
    const dataViewUp = new DataView(bufferUp);
    dataViewUp.setUint8(0, C.CONTROL_MSG_TYPE_BACK_OR_SCREEN_ON_CLIENT);
    dataViewUp.setUint8(1, 1);
    sendControlMessageToServer(bufferUp);
}

/**
 * 处理触控开始事件
 * @param {TouchEvent} event - 触控事件
 */
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

	// 检查事件是否发生在渲染元素内
    if (!activeRenderingElement || !event.target || (event.target !== activeRenderingElement && !activeRenderingElement.contains(event.target))) {
        if (event.target !== elements.streamArea) return;
    }

	// 阻止默认行为并记录触控状态
    event.preventDefault();
    
    // 添加touch-action属性以消除300ms延迟
    if (activeRenderingElement) {
        activeRenderingElement.style.touchAction = 'manipulation';
    }
    
    globalState.isMouseDown = true;

    // 设置主按钮标志并发送触控事件

	// 设置主按钮标志并发送触控事件
    let buttonFlag = C.AMOTION_EVENT_BUTTON_PRIMARY;
    globalState.currentMouseButtons |= buttonFlag;
    const coords = getScaledCoordinates(event);
    if (coords) {
        globalState.lastMousePosition = coords;
        sendMouseEvent(C.AMOTION_EVENT_ACTION_DOWN, globalState.currentMouseButtons, coords.x, coords.y);
    }
}

/**
 * 处理触控移动事件
 * @param {TouchEvent} event - 触控事件
 */
function handleTouchMove(event) {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || !globalState.deviceHeight || !globalState.isMouseDown) return;

	// 阻止默认行为并发送移动事件
    event.preventDefault();
    const coords = getScaledCoordinates(event);
    if (coords) {
        globalState.lastMousePosition = coords;
        sendMouseEvent(C.AMOTION_EVENT_ACTION_MOVE, globalState.currentMouseButtons, coords.x, coords.y);
    }
}

/**
 * 处理触控结束事件
 * @param {TouchEvent} event - 触控事件
 */
function handleTouchEnd(event) {
    if (!globalState.isMouseDown) return;
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || !globalState.deviceHeight) {
        globalState.isMouseDown = false;
        globalState.currentMouseButtons = 0;
        return;
    }

    let buttonFlag = C.AMOTION_EVENT_BUTTON_PRIMARY;

	// 检查按钮状态并发送释放事件
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

/**
 * 处理触控取消事件
 * @param {TouchEvent} event - 触控事件
 */
function handleTouchCancel(event) {
    if (!globalState.isMouseDown) return;
    // 重置状态，与handleTouchEnd类似
    globalState.isMouseDown = false;
    globalState.currentMouseButtons = 0;
}

/**
 * 处理鼠标按下事件
 * @param {MouseEvent} event - 鼠标事件
 */
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
	
	// 检查事件是否发生在渲染元素内
    if (!activeRenderingElement || !event.target || (event.target !== activeRenderingElement && !activeRenderingElement.contains(event.target))) {
        if (event.target !== elements.streamArea) return;
    }

	// 阻止默认行为并记录鼠标状态
    event.preventDefault();
    globalState.isMouseDown = true;

    if (event.button === 2) {
        sendBackButtonControlInternal();
        globalState.isMouseDown = false;
        globalState.currentMouseButtons = 0;
        return;
    }

	// 根据鼠标按钮设置标志并发送按下事件
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

/**
 * 处理鼠标释放事件
 * @param {MouseEvent} event - 鼠标事件
 */
function handleMouseUp(event) {
    if (!globalState.isMouseDown) return;
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || !globalState.deviceHeight) {
        globalState.isMouseDown = false;
        globalState.currentMouseButtons = 0;
        return;
    }

    // 根据鼠标按钮获取标志
    let buttonFlag = 0;
    switch (event.button) {
        case 0: buttonFlag = C.AMOTION_EVENT_BUTTON_PRIMARY; break;
        case 1: buttonFlag = C.AMOTION_EVENT_BUTTON_TERTIARY; break;
        case 2: buttonFlag = C.AMOTION_EVENT_BUTTON_SECONDARY; break;
        default: return;
    }

    // 检查按钮状态并发送释放事件
    if (!(globalState.currentMouseButtons & buttonFlag)) return;

    const coords = getScaledCoordinates(event) || globalState.lastMousePosition;

    sendMouseEvent(C.AMOTION_EVENT_ACTION_UP, globalState.currentMouseButtons, coords.x, coords.y);
    globalState.currentMouseButtons &= ~buttonFlag;
    if (globalState.currentMouseButtons === 0) {
        globalState.isMouseDown = false;
    }
}

/**
 * 处理鼠标移动事件
 * @param {MouseEvent} event - 鼠标事件
 */
function handleMouseMove(event) {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || !globalState.deviceHeight || !globalState.isMouseDown) return;

    // 获取坐标并发送移动事件
    const coords = getScaledCoordinates(event);
    if (coords) {
        globalState.lastMousePosition = coords;
        sendMouseEvent(C.AMOTION_EVENT_ACTION_MOVE, globalState.currentMouseButtons, coords.x, coords.y);
    }
}

/**
 * 处理鼠标离开事件
 * @param {MouseEvent} event - 鼠标事件
 */
function handleMouseLeave(event) {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.isMouseDown || globalState.currentMouseButtons === 0) return;
    
    // 获取坐标并发送释放事件
    const coords = getScaledCoordinates(event) || globalState.lastMousePosition;
    sendMouseEvent(C.AMOTION_EVENT_ACTION_UP, globalState.currentMouseButtons, coords.x, coords.y);
    
    // 重置鼠标状态
    globalState.isMouseDown = false;
    globalState.currentMouseButtons = 0;
}

/**
 * 处理滚轮事件，实现缩放功能
 * @param {WheelEvent} event - 滚轮事件
 */
function handleWheelEvent(event) {
    if (!globalState.isRunning || !globalState.controlEnabledAtStart || !globalState.deviceWidth || globalState.deviceWidth <= 0 || !globalState.deviceHeight || globalState.deviceHeight <= 0) return;
    
    let activeRenderingElement;
    if (globalState.decoderType === C.DECODER_TYPES.BROADWAY) {
        activeRenderingElement = globalState.broadwayPlayer ? globalState.broadwayPlayer.canvas : elements.broadwayCanvas;
    } else if (globalState.decoderType === C.DECODER_TYPES.WEBCODECS) {
        activeRenderingElement = elements.webcodecCanvas;
    } else { // MSE or default
        activeRenderingElement = elements.videoElement;
    }

    // 检查事件是否发生在渲染元素内
    if (!activeRenderingElement || !event.target || (event.target !== activeRenderingElement && !activeRenderingElement.contains(event.target))) {
       return;
    }

    // 阻止默认滚动行为
    event.preventDefault();

    let coords = getScaledCoordinates(event);
    if (!coords) {
        if (globalState.lastMousePosition.x > 0 || globalState.lastMousePosition.y > 0) {
            coords = globalState.lastMousePosition;
        } else {
            return;
        }
    }
    let hscroll_float = 0.0, vscroll_float = 0.0;
    const scrollSensitivity = 1.0;
    if (event.deltaX !== 0) {
        hscroll_float = event.deltaX > 0 ? -scrollSensitivity : scrollSensitivity;
    }
    if (event.deltaY !== 0) {
        vscroll_float = event.deltaY > 0 ? -scrollSensitivity : scrollSensitivity;
    }
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


/**
 * 初始化输入服务，绑定所有事件监听器
 */
export function initInputService() {
    if (elements.streamArea) {
        // 鼠标事件绑定到streamArea元素
        bindEvent(elements.streamArea, 'mousedown', handleMouseDown);
        bindEvent(elements.streamArea, 'mousemove', handleMouseMove);
        bindEvent(elements.streamArea, 'mouseleave', handleMouseLeave);
        bindEvent(elements.streamArea, 'wheel', handleWheelEvent, { passive: false });
        
        // 触控事件绑定到streamArea元素
        bindEvent(elements.streamArea, 'touchstart', handleTouchStart, { passive: false });
        bindEvent(elements.streamArea, 'touchmove', handleTouchMove, { passive: false });
        bindEvent(elements.streamArea, 'touchend', handleTouchEnd);
        bindEvent(elements.streamArea, 'touchcancel', handleTouchCancel);
        
        // 右键菜单控制
        bindEvent(elements.streamArea, 'contextmenu', (e) => {
            let activeRenderingElement;
            if (globalState.decoderType === C.DECODER_TYPES.BROADWAY) {
                activeRenderingElement = globalState.broadwayPlayer ? globalState.broadwayPlayer.canvas : elements.broadwayCanvas;
            } else if (globalState.decoderType === C.DECODER_TYPES.WEBCODECS) {
                activeRenderingElement = elements.webcodecCanvas;
            } else { // MSE or default
                activeRenderingElement = elements.videoElement;
            }
            
            if (globalState.controlEnabledAtStart && globalState.isRunning && activeRenderingElement && 
                (e.target === activeRenderingElement || activeRenderingElement.contains(e.target))) {
                e.preventDefault(); // 根据条件禁用右键菜单
            }
        });
    }
    
    // 全局鼠标释放事件（确保拖动出streamArea也能正确释放）
    bindEvent(document, 'mouseup', handleMouseUp);
}

/**
 * 清理输入服务，移除所有事件监听器
 */
export function cleanupInputService() {
    for (const [element, listeners] of eventListeners.entries()) {
        for (const { type, listener, options } of listeners) {
            element.removeEventListener(type, listener, options);
        }
    }
    eventListeners.clear();
}

/**
 * 辅助函数：绑定事件并记录，用于后续移除
 * @param {HTMLElement} element - 要绑定事件的DOM元素
 * @param {string} type - 事件类型
 * @param {Function} listener - 事件监听器
 * @param {Object} [options] - 事件选项
 */
function bindEvent(element, type, listener, options) {
    element.addEventListener(type, listener, options);
    if (!eventListeners.has(element)) {
        eventListeners.set(element, []);
    }
    eventListeners.get(element).push({ type, listener, options });
}
