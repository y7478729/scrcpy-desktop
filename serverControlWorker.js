const { parentPort, workerData } = require('worker_threads');

const { scid, clientId, CURRENT_LOG_LEVEL } = workerData;

const LogLevel = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function log(level, message, ...args) {
    if (level >= CURRENT_LOG_LEVEL) {
        const levelStr = Object.keys(LogLevel).find(key => LogLevel[key] === level);
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${levelStr}]`, message, ...args);
    }
}

parentPort.on('message', (msg) => {
    const { type, data, scid: msgScid, clientId: msgClientId } = msg;
    if (type === 'controlData') {
        try {
            // Validate and process control data
            const controlData = Buffer.from(data, 'base64');
            if (controlData.length === 0) {
                throw new Error('Empty control data');
            }
            log(LogLevel.DEBUG, `[Worker ${scid}] Processing control data: ${controlData.length} bytes for SCID ${msgScid}`);
            parentPort.postMessage({
                type: 'writeToSocket',
                scid: msgScid,
                clientId: msgClientId,
                data: controlData.toString('base64')
            });
        } catch (error) {
            parentPort.postMessage({
                type: 'error',
                scid: msgScid,
                clientId: msgClientId,
                error: error.message
            });
        }
    } else if (type === 'stop') {
        // Cleanup and exit worker
        log(LogLevel.DEBUG, `[Worker ${scid}] Stopping`);
        process.exit(0);
    }
});