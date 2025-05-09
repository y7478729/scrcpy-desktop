import { elements } from './domElements.js';
import { MAX_LOG_LINES } from './constants.js';

const logMessages = [];

export function appendLog(message, isError = false) {
	const timestamp = new Date().toLocaleTimeString('en-GB', {
		hour: '2-digit', minute: '2-digit', second: '2-digit'
	});
	logMessages.push({ message: `[${timestamp}] ${message}`, isError });
	if (logMessages.length > MAX_LOG_LINES) logMessages.shift();
	updateLogDisplay();
}

function updateLogDisplay() {
    if (elements.logContent) {
        elements.logContent.innerHTML = logMessages
            .map(({ message, isError }) => `<div style="${isError ? 'color: #ff4444;' : ''}">${message}</div>`)
            .join('');
        elements.logContent.scrollTop = elements.logContent.scrollHeight;
    }
}

export function updateStatus(message) {
    appendLog(message);
}

export function initGlobalErrorHandling() {
    const originalConsoleError = console.error;
    console.error = (message, ...args) => {
        const formattedMessage = [message, ...args].join(' ');
        appendLog(formattedMessage, true);
        originalConsoleError(message, ...args);
    };
}