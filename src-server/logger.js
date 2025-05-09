const { LogLevel, CURRENT_LOG_LEVEL } = require('./constants');

function log(level, message, ...args) {
	if (level >= CURRENT_LOG_LEVEL) {
		const levelStr = Object.keys(LogLevel).find(key => LogLevel[key] === level);
		const timestamp = new Date().toISOString();
		console.log(`[${timestamp}] [${levelStr}]`, message, ...args);
	}
}

module.exports = { log };