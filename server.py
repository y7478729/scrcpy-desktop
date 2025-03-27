from flask import Flask, request, jsonify, send_from_directory
import subprocess
import os
import re
import threading
import time

app = Flask(__name__, static_folder='.', static_url_path='')
PORT = 8000
DEVICE_SERIAL = None  # Global variable to track device serial

@app.route('/')
def serve_index():
    """Serve the index.html file"""
    return send_from_directory('.', 'index.html')

def classify_devices(devices):
    """Classify devices into USB and network categories."""
    usb_devices = []
    network_devices = []
    for device in devices:
        if re.match(r'^\d+\.\d+\.\d+\.\d+:\d+$', device):  # Matches IP:port format
            network_devices.append(device)
        else:
            usb_devices.append(device)
    return usb_devices, network_devices

def get_device_ip(serial):
    """Get the IP address of a device via adb"""
    ip_result = subprocess.run(['adb', '-s', serial, 'shell', 'ip', 'addr', 'show', 'wlan0'],
                             capture_output=True, text=True)
    if ip_result.returncode == 0 and 'inet ' in ip_result.stdout:
        match = re.search(r'inet (\d+\.\d+\.\d+\.\d+)/', ip_result.stdout)
        if match:
            return match.group(1)
    return None

def get_dynamic_display_id(serial):
    """Get the dynamically created overlay display ID by comparing before and after states."""
    
    # Step 0: Reset overlays
    reset_display(serial)
    
    # Step 1: List displays before creating overlay
    initial_ids = []
    initial_result = subprocess.run(['scrcpy', '-s', serial, '--list-displays'],
                                    capture_output=True, text=True)
    if initial_result.returncode == 0:
        for line in initial_result.stdout.splitlines():
            match = re.search(r'--display-id=(\d+)', line)
            if match:
                initial_ids.append(int(match.group(1)))

    # Log the static display IDs
    print(f"Static display IDs detected: {initial_ids}. These will be ignored.")

    # Step 2: Create overlay display
    subprocess.run(['adb', '-s', serial, 'shell', 'settings', 'put', 'global', 'overlay_display_devices', '1920x1080/160'])

    # Step 3: List displays after creating overlay
    updated_ids = []
    updated_result = subprocess.run(['scrcpy', '-s', serial, '--list-displays'],
                                    capture_output=True, text=True)
    if updated_result.returncode == 0:
        for line in updated_result.stdout.splitlines():
            match = re.search(r'--display-id=(\d+)', line)
            if match:
                updated_ids.append(int(match.group(1)))

    # Step 4: Identify the new display ID
    new_ids = list(set(updated_ids) - set(initial_ids))
    if not new_ids:
        print("No new display ID found after creating overlay.")
        return None

    dynamic_display_id = new_ids[0]
    print(f"Dynamic display ID detected: {dynamic_display_id}. Display ID selected: {dynamic_display_id}")
    return dynamic_display_id

@app.route('/detect-device', methods=['POST'])
def detect_device():
    """Detect Android device via adb"""
    global DEVICE_SERIAL
    data = request.json
    mode = data.get('mode')
    ip = data.get('ip')

    try:
        result = subprocess.run(['adb', 'devices'], capture_output=True, text=True, check=True)
        devices = [line.split('\t')[0] for line in result.stdout.splitlines() if '\tdevice' in line]
        
        # Classify devices
        usb_devices, network_devices = classify_devices(devices)

        if mode == 'usb':
            if not usb_devices:
                return jsonify({'success': False, 'message': 'No USB devices found'})
            DEVICE_SERIAL = usb_devices[0]  # Use the first USB device
            model = subprocess.run(['adb', '-s', DEVICE_SERIAL, 'shell', 'getprop', 'ro.product.model'],
                                 capture_output=True, text=True).stdout.strip()
            ip_address = get_device_ip(DEVICE_SERIAL)
            return jsonify({'success': True, 'model': model, 'ip': ip_address})
        
        elif mode == 'wifi':
            # Disconnect any existing network connections to avoid conflicts
            for device in network_devices:
                subprocess.run(['adb', 'disconnect', device], capture_output=True, text=True)
            
            if not ip and usb_devices:
                usb_serial = usb_devices[0]
                ip = get_device_ip(usb_serial)
                if ip:
                    tcp_result = subprocess.run(['adb', '-s', usb_serial, 'tcpip', '5555'],
                                              capture_output=True, text=True)
                    if tcp_result.returncode != 0:
                        return jsonify({'success': False, 'message': f'Failed to enable TCP/IP: {tcp_result.stderr}'})
            
            if not ip:
                return jsonify({'success': False, 'message': 'IP address required for WiFi mode and could not be auto-detected'})
            wifi_device = f"{ip}:5555"
            connect_result = subprocess.run(['adb', 'connect', wifi_device], capture_output=True, text=True)
            if 'connected to' not in connect_result.stdout and 'already connected' not in connect_result.stdout:
                return jsonify({'success': False, 'message': f'Failed to connect to {wifi_device}: {connect_result.stderr}'})
            
            result = subprocess.run(['adb', 'devices'], capture_output=True, text=True, check=True)
            if wifi_device not in result.stdout:
                return jsonify({'success': False, 'message': f'{wifi_device} not found after connection attempt'})
            
            DEVICE_SERIAL = wifi_device
            model = subprocess.run(['adb', '-s', DEVICE_SERIAL, 'shell', 'getprop', 'ro.product.model'],
                                 capture_output=True, text=True).stdout.strip()
            return jsonify({'success': True, 'model': model, 'ip': ip})
        
        else:
            return jsonify({'success': False, 'message': 'Invalid connection mode'})
    except subprocess.CalledProcessError as e:
        return jsonify({'success': False, 'message': f'ADB error: {e.stderr}'})

@app.route('/connect-device', methods=['POST'])
def connect_device():
    """Confirm connection"""
    data = request.json
    mode = data.get('mode')
    ip = data.get('ip')
    if mode == 'wifi' and not ip and not DEVICE_SERIAL:
        return jsonify({'success': False, 'message': 'IP address required for WiFi mode or auto-detection failed'})
    return jsonify({'success': True, 'message': f'{mode.capitalize()} connection complete'})

def reset_display(serial):
    """Reset the overlay display to none"""
    subprocess.run(['adb', '-s', serial, 'shell', 'settings', 'put', 'global', 'overlay_display_devices', 'none'])

def run_scrcpy_with_reset(cmd, serial, reset_needed):
    """Run scrcpy and reset display when it exits if needed"""
    process = subprocess.Popen(cmd)
    if reset_needed:
        process.wait()  # Wait for scrcpy to exit
        reset_display(serial)
    return process

@app.route('/start-scrcpy', methods=['POST'])
def start_scrcpy():
    """Start scrcpy with provided config"""
    global DEVICE_SERIAL
    if not DEVICE_SERIAL:
        return 'Error: No device detected yet', 500

    data = request.json
    resolution = data.get('resolution')
    dpi = data.get('dpi')
    bitrate = data.get('bitrate')
    max_fps = data.get('maxFps')
    rotation_lock = data.get('rotationLock')
    options = data.get('options', [])
    use_android_11 = data.get('useAndroid_11', False)

    cmd = ['scrcpy', '-s', DEVICE_SERIAL]
    reset_needed = False

    if use_android_11:
        if resolution:
            cmd.append(f'--new-display={resolution}/{dpi or "160"}')
    else:
        if resolution and dpi:
            # Set the overlay display
            subprocess.run(['adb', '-s', DEVICE_SERIAL, 'shell', 'settings', 'put', 'global', 'overlay_display_devices', f'{resolution}/{dpi}'])

            # Get the correct display ID
            display_id = get_dynamic_display_id(DEVICE_SERIAL)
            if display_id is not None:
                cmd.append(f'--display-id={display_id}')
            else:
                return 'Error: Could not find a valid display ID', 500
            reset_needed = True  # Mark that we need to reset later

    if bitrate:
        cmd.append(bitrate)
    if max_fps:
        cmd.append(max_fps)
    if rotation_lock:
        cmd.append(rotation_lock)
    cmd.extend(options)

    try:
        # Run scrcpy in a background thread to avoid blocking Flask
        thread = threading.Thread(target=run_scrcpy_with_reset, args=(cmd, DEVICE_SERIAL, reset_needed))
        thread.start()
        return 'Scrcpy Desktop is running!'
    except Exception as e:
        return f'Error: {str(e)}', 500

if __name__ == '__main__':
    print(f"Server running on http://localhost:{PORT}/")
    app.run(host='0.0.0.0', port=PORT, debug=False)