const util = require('util');
const { exec } = require('child_process');
const adbkit = require('@devicefarmer/adbkit');
const crypto = require('crypto');
const { log } = require('./logger');
const {
    LogLevel,
    SERVER_JAR_PATH,
    SERVER_DEVICE_PATH,
    SCRCPY_VERSION
} = require('./constants');

const adb = new adbkit.Client();
const execPromise = util.promisify(exec);

async function streamToString(stream) {
	return new Promise((resolve, reject) => {
		let output = '';
		stream.on('data', (data) => output += data.toString());
		stream.on('end', () => resolve(output.trim()));
		stream.on('error', (err) => reject(err));
	});
}

async function checkAdbAvailability() {
	return new Promise((resolve, reject) => {
		exec('adb version', (error) => {
			if (error) {
				log(LogLevel.ERROR, 'ADB not found. Please ensure ADB is installed and in your PATH.');
				return reject(new Error('ADB not found.'));
			}
			resolve();
		});
	});
}

async function executeCommand(command, description) {
	try {
		const { stdout, stderr } = await execPromise(command);
		if (stderr && !(description && description.includes('Remove') && stderr.includes('not found'))) {
            log(LogLevel.WARN, `[Exec] Stderr (${description || 'No description'}): ${stderr.trim()}`);
        } else if (stderr) {
            log(LogLevel.DEBUG, `[Exec] Stderr (${description || 'No description'}): ${stderr.trim()} (Ignored)`);
        }
		if (stdout) log(LogLevel.DEBUG, `[Exec] Stdout (${description || 'No description'}): ${stdout.trim()}`);
		return { success: true, stdout, stderr };
	} catch (error) {
		if (error.stderr) log(LogLevel.ERROR, `[Exec] Stderr: ${error.stderr.trim()}`);
		if (error.stdout) log(LogLevel.ERROR, `[Exec] Stdout: ${error.stdout.trim()}`);
		throw new Error(`Failed to execute: ${description || command} - ${error.message}`);
	}
}

async function executeAdbShellCommand(deviceId, command) {
	log(LogLevel.DEBUG, `[ADB Execute] Called for device: ${deviceId}, command: '${command}'`);
	try {
		const device = adb.getDevice(deviceId);
		const stream = await device.shell(command);
		stream.on('data', (dataChunk) => {
			log(LogLevel.DEBUG, `[ADB Execute Stream - ${deviceId} - '${command}'] Data chunk received (length: ${dataChunk.length})`);
		});
		stream.on('end', () => {
			log(LogLevel.DEBUG, `[ADB Execute Stream - ${deviceId} - '${command}'] Stream ended.`);
		});
		stream.on('error', (err) => {
			log(LogLevel.ERROR, `[ADB Execute Stream - ${deviceId} - '${command}'] Stream error: ${err.message}`);
		});
		const output = await streamToString(stream);
		log(LogLevel.INFO, `[ADB Execute] Command '${command}' for ${deviceId} completed. Output length: ${output.length}.`);
		return { success: true, output };
	} catch (error) {
		log(LogLevel.ERROR, `[ADB Execute] Error executing command '${command}' for ${deviceId}: ${error.message}`);
		if (error.stack) {
			log(LogLevel.ERROR, `[ADB Execute] Stacktrace: ${error.stack}`);
		}
		return { success: false, error: error.message };
	}
}

async function getAdbDevices() {
	try {
		const devices = await adb.listDevices();
		const activeDevices = devices.filter(d => d.type === 'device' || d.type === 'unauthorized' || d.type === 'offline');
		return activeDevices.map(d => ({ id: d.id, type: d.type }));
	} catch (error) {
		throw new Error(`Failed to list ADB devices: ${error.message}`);
	}
}

async function checkReverseTunnelExists(deviceId, tunnelString) {
	try {
		const { stdout } = await executeCommand(`adb -s ${deviceId} reverse --list`, `List reverse tunnels (Device: ${deviceId})`);
		return stdout.includes(tunnelString);
	} catch (error) {
		return false;
	}
}

async function adbPushServer(deviceId) {
    const device = adb.getDevice(deviceId);
    const transfer = await device.push(SERVER_JAR_PATH, SERVER_DEVICE_PATH);
    return new Promise((resolve, reject) => {
        transfer.on('end', resolve);
        transfer.on('error', reject);
    });
}

async function adbListDisplays(deviceId) {
    const scidForList = (crypto.randomBytes(4).readUInt32BE(0) & 0x7FFFFFFF).toString(16).padStart(8, '0');
    const listCmd = `CLASSPATH=${SERVER_DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} list_displays=true scid=${scidForList} log_level=info`;
    await adbPushServer(deviceId);
    const shellResult = await executeAdbShellCommand(deviceId, listCmd);
    if (shellResult.success) {
        const displays = [];
        const lines = shellResult.output.split('\n');
        lines.forEach(line => {
            const match = line.match(/--display-id=(\d+)\s*\(([^)]+)\)/);
            if (match) {
                displays.push({ id: parseInt(match[1], 10), resolution: match[2] });
            }
        });
        return { success: true, data: displays };
    }
    return shellResult;
}

async function getMediaVolumeInfo(deviceId, sessionsMap) {
    const session = Array.from(sessionsMap.values()).find(s => s.deviceId === deviceId);
	if (!session) throw new Error(`No session found for device ${deviceId}`);
	let androidVersion = session.androidVersion;
	if (!androidVersion) {
		try {
			const device = adb.getDevice(deviceId);
			const versionStream = await device.shell('getprop ro.build.version.release');
			const versionOutput = await streamToString(versionStream);
			const versionMatch = versionOutput.trim().match(/^(\d+)/);
			androidVersion = versionMatch ? parseInt(versionMatch[1], 10) : NaN;
			if (isNaN(androidVersion)) throw new Error(`Invalid Android version: ${versionOutput.trim()}`);
			session.androidVersion = androidVersion;
		} catch (error) {
			throw new Error(`Failed to get Android version: ${error.message}`);
		}
	}
	let maxVolume = session.maxVolume, currentVolume;
	let command = androidVersion <= 10 ? 'media volume --get' : 'cmd media_session volume --get --stream 3';
	try {
		const device = adb.getDevice(deviceId);
		const volumeStream = await device.shell(command);
		const volumeOutput = await streamToString(volumeStream);
		const match = volumeOutput.match(/volume is (\d+) in range \[(\d+)\.\.(\d+)\]|\[(\d+), (\d+)\]/);
		if (!match) throw new Error(`Unexpected volume output format: ${volumeOutput}`);
		currentVolume = parseInt(match[1] || match[4], 10);
		if (!session.maxVolume) {
			maxVolume = parseInt(match[3] || match[5], 10);
			session.maxVolume = maxVolume;
		} else {
            maxVolume = session.maxVolume;
        }
	} catch (error) {
		throw new Error(`Failed to get volume: ${error.message}`);
	}
	if (isNaN(maxVolume) || isNaN(currentVolume) || maxVolume < 1) throw new Error(`Invalid volume info: max=${maxVolume}, current=${currentVolume}`);
	return { maxVolume, currentVolume };
}

async function setMediaVolume(deviceId, percentage, sessionsMap) {
    let maxVolume;
    const session = Array.from(sessionsMap.values()).find(s => s.deviceId === deviceId);
	if (!session) throw new Error(`No session found for device ${deviceId}`);
	if (session.maxVolume) maxVolume = session.maxVolume;
	else try {
		maxVolume = (await getMediaVolumeInfo(deviceId, sessionsMap)).maxVolume;
	} catch (error) {
		throw error;
	}
	if (isNaN(maxVolume) || maxVolume < 1) throw new Error(`Invalid max volume info: ${maxVolume}`);
	const targetVolume = Math.round((percentage / 100) * maxVolume);
	const androidVersion = session.androidVersion;
	if (!androidVersion) throw new Error(`Android version not cached for device ${deviceId}`);
	try {
		const command = androidVersion <= 10 ? `media volume --set ${targetVolume}` : `cmd media_session volume --set ${targetVolume} --stream 3`;
		await adb.getDevice(deviceId).shell(command);
	} catch (error) {
		throw error;
	}
}

async function getBatteryLevel(deviceId) {
	try {
		const device = adb.getDevice(deviceId);
		const batteryOutput = await streamToString(await device.shell("dumpsys battery | grep 'level:' | cut -d':' -f2 | tr -d ' '"));
		const batteryLevel = parseInt(batteryOutput.trim(), 10);
		if (isNaN(batteryLevel) || batteryLevel < 0 || batteryLevel > 100) throw new Error(`Invalid battery level: ${batteryOutput.trim()}`);
		return batteryLevel;
	} catch (error) {
		throw error;
	}
}

async function getLauncherApps(deviceId) {
	try {
		const device = adb.getDevice(deviceId);
		const command = 'cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER';
		const rawOutput = await streamToString(await device.shell(command));
		const apps = [];
		const activityBlocks = rawOutput.split('Activity #').slice(1);
		const genericSuffixes = ['android', 'app', 'mobile', 'client', 'lite', 'pro', 'free', 'plus', 'core', 'base', 'main', 'ui', 'launcher', 'system', 'service'];
		for (const block of activityBlocks) {
			let packageName = 'N/A', label = 'Unknown App';
			const packageNameMatch = block.match(/packageName=([^\s]+)/);
			if (packageNameMatch) packageName = packageNameMatch[1];
			const appNonLocalizedLabelMatch = block.match(/ApplicationInfo:\s*[^]*?nonLocalizedLabel=([^\s]+)/is);
			if (appNonLocalizedLabelMatch && appNonLocalizedLabelMatch[1] !== 'null') label = appNonLocalizedLabelMatch[1];
			else {
				const activityNonLocalizedLabelMatch = block.match(/ActivityInfo:\s*[^]*?nonLocalizedLabel=([^\s]+)/is);
				if (activityNonLocalizedLabelMatch && activityNonLocalizedLabelMatch[1] !== 'null') label = activityNonLocalizedLabelMatch[1];
				else if (label === 'Unknown App' && packageName !== 'N/A') {
					let parts = packageName.split('.');
					let derivedLabel = parts[parts.length - 1];
					if (genericSuffixes.includes(derivedLabel.toLowerCase()) && parts.length > 1) derivedLabel = parts[parts.length - 2];
					derivedLabel = derivedLabel.replace(/([A-Z])/g, ' $1').replace(/[-_.]/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
					label = derivedLabel;
				}
			}
			if (packageName !== 'N/A' && label !== 'Unknown App') {
				apps.push({ packageName, label, letter: label.charAt(0).toUpperCase() });
			}
		}
		apps.sort((a, b) => a.label.localeCompare(b.label));
		return apps;
	} catch (error) {
		throw new Error(`Failed to get launcher apps: ${error.message}`);
	}
}

module.exports = {
    adb,
    checkAdbAvailability,
    executeCommand,
    executeAdbShellCommand,
    getAdbDevices,
    checkReverseTunnelExists,
    streamToString,
    adbPushServer,
    adbListDisplays,
    getMediaVolumeInfo,
    setMediaVolume,
    getBatteryLevel,
    getLauncherApps,
};