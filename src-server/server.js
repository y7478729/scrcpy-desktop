const express = require('express');
const path = require('path');
const C = require('./constants');
const { log } = require('./logger');
const { checkAdbAvailability } = require('./adbService');
const { createWebSocketServer } = require('./websocketHandlers');
const { setupQrPairingRoutes, createQrWebSocketServer, resetQrSession } = require('./qrPairingService');
const sessionManager = require('./scrcpySession');

async function start() {
    let httpServer, mainWss, qrWss;
	try {
		await checkAdbAvailability();
        resetQrSession();

		mainWss = createWebSocketServer();
		qrWss = createQrWebSocketServer();

		const app = express();
		app.use(express.json());
		app.use(express.static(path.resolve(__dirname, '../public/dist')));
		setupQrPairingRoutes(app);

		httpServer = app.listen(C.HTTP_PORT, () => {
			log(C.LogLevel.INFO, `[System] HTTP server listening on port ${C.HTTP_PORT}`);
			log(C.LogLevel.INFO, `[System] Access UI at http://localhost:${C.HTTP_PORT}`);
		});
		httpServer.on('error', (err) => {
			log(C.LogLevel.ERROR, `[System] HTTP server error: ${err.message}`);
			process.exit(1);
		});

        const gracefulShutdownHandler = async () => {
            log(C.LogLevel.INFO, '[System] Initiating graceful shutdown...');
            if (qrWss) {
                log(C.LogLevel.INFO, '[System] Closing QR WebSocket server...');
                await new Promise(resolve => qrWss.close(resolve));
                log(C.LogLevel.INFO, '[System] QR WebSocket server closed.');
            }
            const activeSessions = Array.from(sessionManager.sessions.keys());
            log(C.LogLevel.INFO, `[System] Cleaning up ${activeSessions.length} active sessions...`);
 		    await Promise.allSettled(activeSessions.map(scid => sessionManager.cleanupSession(scid, new Map())));
            if(mainWss) {
                log(C.LogLevel.INFO, '[System] Closing main WebSocket server...');
                await new Promise(resolve => mainWss.close(resolve));
                log(C.LogLevel.INFO, '[System] Main WebSocket server closed.');
            }

            if(httpServer) {
                log(C.LogLevel.INFO, '[System] Closing HTTP server...');
                await new Promise(resolve => httpServer.close(resolve));
                log(C.LogLevel.INFO, '[System] HTTP server closed.');
            }

            log(C.LogLevel.INFO, '[System] All services closed. Exiting.');
            process.exit(0);
            setTimeout(() => {
                log(C.LogLevel.WARN, '[System] Force exiting after timeout.');
                process.exit(1);
            }, 5000);
        };


		process.on('SIGINT', gracefulShutdownHandler);
		process.on('SIGTERM', gracefulShutdownHandler);
		process.on('uncaughtException', (err, origin) => {
			log(C.LogLevel.ERROR, `[System] Uncaught Exception: ${err.message} at ${origin}. Stack: ${err.stack}`);
			process.exit(1);
		});
		process.on('unhandledRejection', (reason, promise) => {
			log(C.LogLevel.ERROR, `[System] Unhandled Rejection at: ${promise}, reason: ${reason instanceof Error ? reason.stack : reason}`);
			process.exit(1);
		});

	} catch (error) {
		log(C.LogLevel.ERROR, `[System] Startup error: ${error.message}`);
		process.exit(1);
	}
}

start();