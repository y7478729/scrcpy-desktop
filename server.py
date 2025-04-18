from flask import Flask, request, jsonify, send_from_directory
import subprocess
import os
import re
import threading
import time

import requests
import zipfile
import io
import shutil

app = Flask(__name__, static_folder='.', static_url_path='')
PORT = 8000
DEVICE_SERIAL = None
# Ensure adb and scrcpy are in PATH or provide full paths
ADB_PATH = "adb"
SCRCPY_PATH = "scrcpy"

@app.route('/')
def serve_index():
    """Serve the index.html file"""
    return send_from_directory('.', 'index.html')

def classify_devices(devices):
    """Classify devices into USB and network categories."""
    usb_devices = []
    network_devices = []
    for device in devices:
        if re.match(r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$', device):
            network_devices.append(device)
        elif ':' not in device:
            usb_devices.append(device)
    print(f"Classified USB: {usb_devices}, Network: {network_devices}")
    return usb_devices, network_devices

def run_adb_command(args, serial=None, check=False, timeout=10):
    """Helper function to run ADB commands with optional serial and error checking."""
    cmd = [ADB_PATH]
    if serial:
        cmd.extend(['-s', serial])
    cmd.extend(args)
    print(f"Executing ADB: {' '.join(cmd)}")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=check, timeout=timeout)
        if result.stdout.strip():
            print(f"  Stdout: {result.stdout.strip()}")
        if result.stderr.strip():
             # Log stderr even on success if it contains info
             print(f"  Stderr: {result.stderr.strip()}")
        if result.returncode != 0 and not check: # Log error if check is False but command failed
             print(f"  Command failed with exit code {result.returncode}")
        return result
    except subprocess.TimeoutExpired:
        print(f"  Command Timed Out.")
        raise TimeoutError(f"ADB command timed out: {' '.join(args)}")
    except FileNotFoundError:
        print(f"  Error: '{ADB_PATH}' command not found.")
        raise FileNotFoundError(f"'{ADB_PATH}' command not found.")
    except subprocess.CalledProcessError as e:
        print(f"  Command Failed.")
        raise e

def get_device_ip(serial):
    """Get the IP address of a device via adb"""
    print(f"Attempting to get IP for device: {serial}")
    try:
        ip_result = run_adb_command(['shell', 'ip', 'addr', 'show', 'wlan0'], serial=serial)
        if ip_result.returncode == 0 and 'inet ' in ip_result.stdout:
            match = re.search(r'inet (\d+\.\d+\.\d+\.\d+)/\d+', ip_result.stdout)
            if match:
                print(f"  Found IP on wlan0: {match.group(1)}")
                return match.group(1)

        ip_result_all = run_adb_command(['shell', 'ip', 'addr'], serial=serial)
        if ip_result_all.returncode == 0:
             for line in ip_result_all.stdout.splitlines():
                 if 'inet ' in line and 'scope global' in line:
                     match = re.search(r'inet (\d+\.\d+\.\d+\.\d+)/\d+', line)
                     if match and not match.group(1).startswith('127.'):
                         print(f"  Found global IP: {match.group(1)}")
                         return match.group(1)
             for line in ip_result_all.stdout.splitlines():
                 if 'inet ' in line:
                     match = re.search(r'inet (\d+\.\d+\.\d+\.\d+)/\d+', line)
                     if match and not match.group(1).startswith('127.'):
                          print(f"  Found non-localhost IP: {match.group(1)}")
                          return match.group(1)
        print(f"  Could not determine IP address.")
        return None
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"  Error getting IP: {e}")
        return None

def get_device_model(serial):
    """Get the device model."""
    print(f"Attempting to get model for device: {serial}")
    try:
        model_result = run_adb_command(['shell', 'getprop', 'ro.product.model'], serial=serial)
        if model_result.returncode == 0:
            model = model_result.stdout.strip()
            print(f"  Found model: {model}")
            return model
        print("  Could not determine model.")
        return "Unknown"
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"  Error getting model: {e}")
        return "Error Fetching Model"


@app.route('/detect-device', methods=['POST'])
def detect_device():
    """Detect Android device via adb"""
    global DEVICE_SERIAL
    data = request.json
    mode = data.get('mode')
    ip_input = data.get('ip')

    print(f"Received /detect-device request (Mode: {mode}, IP: {ip_input})")

    try:
        devices_result = run_adb_command(['devices'], check=True)
        all_devices = [line.split('\t')[0] for line in devices_result.stdout.splitlines()[1:] if '\tdevice' in line]
        print(f"ADB detected devices: {all_devices}")

        usb_devices, network_devices = classify_devices(all_devices)

        if mode == 'usb':
            if not usb_devices:
                print("No USB devices found.")
                return jsonify({'success': False, 'message': 'No USB device detected. Ensure device is connected and USB debugging is enabled.'})
            DEVICE_SERIAL = usb_devices[0]
            print(f"Selected USB device: {DEVICE_SERIAL}")
            model = get_device_model(DEVICE_SERIAL)
            ip_address = get_device_ip(DEVICE_SERIAL) # Attempt to get IP even for USB
            return jsonify({'success': True, 'model': model, 'ip': ip_address})

        elif mode == 'wifi':
            target_ip = ip_input
            if not target_ip:
                print("No IP provided for WiFi, attempting auto-detection via USB...")
                if not usb_devices:
                     print("No USB devices found for auto-detection.")
                     return jsonify({'success': False, 'message': 'WiFi mode requires an IP address or a connected USB device for auto-detection.'})
                usb_serial_for_ip = usb_devices[0]
                print(f"Using USB device {usb_serial_for_ip} for IP detection.")
                target_ip = get_device_ip(usb_serial_for_ip)
                if not target_ip:
                    print("Could not auto-detect IP from USB device.")
                    return jsonify({'success': False, 'message': 'Could not auto-detect IP address from USB device. Please ensure WiFi is connected.'})
                print(f"Auto-detected IP: {target_ip}. Enabling TCP/IP mode.")
                try:
                    run_adb_command(['tcpip', '5555'], serial=usb_serial_for_ip, check=True, timeout=15)
                    time.sleep(2)
                    print("TCP/IP mode enabled.")
                except (subprocess.CalledProcessError, TimeoutError) as e:
                    print(f"Failed to enable TCP/IP mode: {e}")
                    return jsonify({'success': False, 'message': f'Failed to enable TCP/IP mode on {usb_serial_for_ip}: {e}'})

            wifi_device_serial = f"{target_ip}:5555"
            print(f"Attempting to connect to WiFi device: {wifi_device_serial}")

            # Disconnect first for clean state
            run_adb_command(['disconnect', wifi_device_serial], timeout=5)
            time.sleep(1)

            try:
                connect_result = run_adb_command(['connect', wifi_device_serial], check=True, timeout=15)
                if 'connected to' not in connect_result.stdout and 'already connected' not in connect_result.stdout:
                     raise ConnectionError(f"Failed to connect to {wifi_device_serial}. Response: {connect_result.stdout} {connect_result.stderr}")
                print(f"Successfully connected or already connected to {wifi_device_serial}")
            except (subprocess.CalledProcessError, TimeoutError, ConnectionError) as e:
                 print(f"Initial connection failed, retrying once... Error: {e}")
                 time.sleep(2)
                 try:
                     connect_result = run_adb_command(['connect', wifi_device_serial], check=True, timeout=15)
                     if 'connected to' not in connect_result.stdout and 'already connected' not in connect_result.stdout:
                          raise ConnectionError(f"Retry failed. Response: {connect_result.stdout} {connect_result.stderr}")
                     print(f"Successfully connected to {wifi_device_serial} on retry.")
                 except (subprocess.CalledProcessError, TimeoutError, ConnectionError) as e_retry:
                    message = f"Failed to connect to {wifi_device_serial} after retry: {e_retry}"
                    if not ip_input and usb_devices and get_device_ip(usb_devices[0]):
                         message += " Check if device is still on the same Wi-Fi network."
                    else:
                         message += " Ensure the IP address is correct and the device is reachable."
                    print(message)
                    return jsonify({'success': False, 'message': message})

            DEVICE_SERIAL = wifi_device_serial
            model = get_device_model(DEVICE_SERIAL)
            if model == "Error Fetching Model":
                 devices_result_after_connect = run_adb_command(['devices'])
                 if DEVICE_SERIAL not in devices_result_after_connect.stdout:
                     print(f"Device {DEVICE_SERIAL} disappeared after connection attempt.")
                     return jsonify({'success': False, 'message': f'Device {DEVICE_SERIAL} disappeared after connection attempt.'})
                 else:
                      print(f"Warning: Connected to {DEVICE_SERIAL} but failed to retrieve model name.")
                      model = "Unknown (Connected)"

            print(f"Selected WiFi device: {DEVICE_SERIAL}, Model: {model}")
            return jsonify({'success': True, 'model': model, 'ip': target_ip})

        else:
            print(f"Invalid connection mode specified: {mode}")
            return jsonify({'success': False, 'message': 'Invalid connection mode specified'})

    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"ADB Operation Error: {str(e)}")
        return jsonify({'success': False, 'message': f'ADB Operation Error: {str(e)}'})
    except Exception as e:
        print(f"An unexpected server error occurred: {e}")
        return jsonify({'success': False, 'message': f'An unexpected server error occurred: {str(e)}'})


@app.route('/connect-device', methods=['POST'])
def connect_device():
    """Confirm connection (mostly a placeholder now, real connection happens in detect)"""
    global DEVICE_SERIAL
    print("Received /connect-device request")
    if not DEVICE_SERIAL:
         print("No device is currently selected.")
         return jsonify({'success': False, 'message': 'No device is currently selected.'})

    try:
        run_adb_command(['get-state'], serial=DEVICE_SERIAL, check=True, timeout=5)
        print(f"Device {DEVICE_SERIAL} confirmed.")
        return jsonify({'success': True, 'message': f'Device {DEVICE_SERIAL} ready.'})
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"Device {DEVICE_SERIAL} check failed: {e}")
        current_serial = DEVICE_SERIAL
        DEVICE_SERIAL = None
        return jsonify({'success': False, 'message': f'Device connection lost or timed out: {e}. Please re-detect.'})

def reset_display(serial):
    """Reset wm size, density, rotation, and overlay displays."""
    print(f"Resetting display settings for {serial}...")
    try:
        run_adb_command(['shell', 'settings', 'put', 'global', 'overlay_display_devices', 'none'], serial=serial, timeout=5)
        run_adb_command(['shell', 'wm', 'size', 'reset'], serial=serial, timeout=5)
        run_adb_command(['shell', 'wm', 'density', 'reset'], serial=serial, timeout=5)
        run_adb_command(['shell', 'settings', 'put', 'system', 'user_rotation', '0'], serial=serial, timeout=5)
        print(f"Display settings reset for {serial}.")
        time.sleep(1)
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"Warning: Failed to fully reset display settings for {serial}: {e}")

def run_scrcpy_with_reset(cmd, serial, reset_needed):
    """Run scrcpy and reset display settings when it exits if needed."""
    print(f"Starting Scrcpy process: {' '.join(cmd)}")
    process = None
    try:
        process = subprocess.Popen(cmd)
        process.wait()
        print("Scrcpy process finished.")
    except FileNotFoundError:
        print(f"Error: '{SCRCPY_PATH}' command not found. Make sure Scrcpy is installed and in your PATH.")
    except Exception as e:
        print(f"Error running or waiting for scrcpy: {e}")
    finally:
        if reset_needed:
            print(f"Scrcpy exited, performing display reset for {serial}.")
            reset_display(serial)
        else:
            print(f"Scrcpy exited, no display reset needed for this mode.")

def get_dynamic_display_id(serial, resolution, dpi):
    """Get dynamic overlay display ID (Use with caution, less stable)."""
    print(f"Attempting to get dynamic display ID for {resolution}/{dpi} on {serial}")
    reset_display(serial)

    initial_ids = set()
    try:
        list_cmd = [SCRCPY_PATH, '-s', serial, '--list-displays']
        print(f"Executing scrcpy --list-displays: {' '.join(list_cmd)}")
        initial_result = subprocess.run(list_cmd, capture_output=True, text=True, timeout=10)
        if initial_result.returncode == 0:
            for line in initial_result.stdout.splitlines():
                match = re.search(r'--display-id=(\d+)', line)
                if match:
                    initial_ids.add(int(match.group(1)))
            print(f"  Initial display IDs: {initial_ids}")
        else:
            print(f"  Warning: scrcpy --list-displays failed initially: {initial_result.stderr.strip()}")
            initial_ids.add(0) # Assume primary display is always present
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
         print(f"  Error listing initial displays: {e}. Cannot determine dynamic ID.")
         return None

    overlay_setting = f"{resolution}/{dpi}"
    print(f"  Creating overlay display with setting: {overlay_setting}")
    try:
        run_adb_command(['shell', 'settings', 'put', 'global', 'overlay_display_devices', overlay_setting], serial=serial, check=True, timeout=5)
        time.sleep(2)
        print("  Overlay setting applied.")
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"  Error setting overlay display: {e}. Cannot create dynamic display.")
        reset_display(serial)
        return None

    updated_ids = set()
    try:
        list_cmd = [SCRCPY_PATH, '-s', serial, '--list-displays']
        print(f"Executing scrcpy --list-displays again: {' '.join(list_cmd)}")
        updated_result = subprocess.run(list_cmd, capture_output=True, text=True, timeout=10)
        if updated_result.returncode == 0:
            for line in updated_result.stdout.splitlines():
                match = re.search(r'--display-id=(\d+)', line)
                if match:
                    updated_ids.add(int(match.group(1)))
            print(f"  Updated display IDs: {updated_ids}")
        else:
            print(f"  Warning: scrcpy --list-displays failed after setting overlay: {updated_result.stderr.strip()}")
            reset_display(serial)
            return None
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"  Error listing updated displays: {e}. Cannot determine dynamic ID.")
        reset_display(serial)
        return None

    new_ids = updated_ids - initial_ids
    print(f"  New dynamic IDs found: {new_ids}")

    if not new_ids:
        print("  Error: No new display ID found after creating overlay. Resetting.")
        reset_display(serial)
        return None

    dynamic_display_id = min(new_ids)
    print(f"  Dynamic display ID selected: {dynamic_display_id}.")
    return dynamic_display_id

@app.route('/start-scrcpy', methods=['POST'])
def start_scrcpy():
    """Start scrcpy with provided config"""
    global DEVICE_SERIAL
    print("Received /start-scrcpy request")
    if not DEVICE_SERIAL:
        print("Error: No device selected or connection lost.")
        return 'Error: No device selected or connection lost.', 500

    try:
        print(f"Verifying device connection: {DEVICE_SERIAL}")
        run_adb_command(['get-state'], serial=DEVICE_SERIAL, check=True, timeout=5)
        print("Device connection verified.")
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"Error: Device {DEVICE_SERIAL} connection lost: {e}.")
        current_serial = DEVICE_SERIAL
        DEVICE_SERIAL = None
        return f'Error: Device {current_serial} connection lost: {e}. Please re-detect.', 500

    data = request.json
    print(f"Received Scrcpy Config: {data}")

    resolution = data.get('resolution')
    dpi = data.get('dpi')
    bitrate = data.get('bitrate')
    max_fps = data.get('maxFps')
    rotation_lock = data.get('rotationLock')
    options = data.get('options', [])
    useVirtualDisplay = data.get('useVirtualDisplay', False)
    useNativeTaskbar = data.get('useNativeTaskbar', False)
    useSamsungDex = data.get('useSamsungDex', False)

    cmd = [SCRCPY_PATH, '-s', DEVICE_SERIAL]
    reset_needed = False
    apply_rotation_lock_param = True

    if useSamsungDex:
        print("Mode: Samsung DeX selected.")
        cmd.append('--display-id=2')
        reset_needed = False
        apply_rotation_lock_param = False

    elif useVirtualDisplay:
        if resolution and dpi:
             virtual_display = f'{resolution}/{dpi}'
             if virtual_display is not None:
                 cmd.append(f'--new-display={virtual_display}')
                 reset_needed = False
             else:
                 return 'Error: Could not create virtual display.', 500

    elif useNativeTaskbar:
        print("Mode: Native Taskbar selected.")
        cmd.append('--display-id=0')
        apply_rotation_lock_param = False
        reset_needed = True
        height = None

        if resolution:
            try:
                print(f"  Attempting to set resolution: {resolution}")
                width, height = map(int, resolution.split('x'))
                swapped_resolution = f"{height}x{width}"
                run_adb_command(['shell', 'wm', 'size', swapped_resolution], serial=DEVICE_SERIAL, check=True)
                print("  Resolution set OK.")
                reset_needed = True
            except ValueError:
                print(f"  Invalid resolution format: '{swapped_resolution}'. Skipping.")
                height = None
            except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
                print(f"  Failed to set resolution: {e}. Skipping.")
                height = None

        final_dpi_to_set = None
        if dpi:
            try:
                print(f"  Attempting to set DPI: {dpi}")
                int_dpi = int(dpi)

                if isinstance(height, int) and height > 0:
                    max_dpi = round(0.2667 * height)
                    print(f"  Calculated max allowed DPI based on height ({height}): {max_dpi}")
                    if int_dpi > max_dpi:
                        print(f"  User-provided DPI ({int_dpi}) exceeds max allowed DPI ({max_dpi}). Using max DPI: {max_dpi}")
                        int_dpi = max_dpi
                    final_dpi_to_set = int_dpi
                else:
                    print(f"  Height not determined or invalid ({height}). Using user-provided DPI {int_dpi} without max check.")
                    final_dpi_to_set = int_dpi

            except ValueError:
                print(f"  Invalid DPI value: '{dpi}'. Skipping.")

        if final_dpi_to_set is not None:
            try:
                run_adb_command(['shell', 'wm', 'density', str(final_dpi_to_set)], serial=DEVICE_SERIAL, check=True)
                print(f"  Set density to {final_dpi_to_set}")
                reset_needed = True
            except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
                 print(f"  Failed to set density: {e}. Skipping.")


        try:
            print("  Setting rotation to landscape.")
            run_adb_command(['shell', 'settings', 'put', 'system', 'user_rotation', '1'], serial=DEVICE_SERIAL, check=True)
            print("  Rotation set OK.")
            reset_needed = True
        except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
             print(f"  Failed to set rotation: {e}. Skipping.")


    else: # Default mode
        print("Mode: Default selected.")
        if resolution and dpi:
            print(f"  Resolution: {resolution}, DPI: {dpi}")
            display_id = get_dynamic_display_id(DEVICE_SERIAL, resolution, dpi)
            if display_id is not None:
                cmd.append(f'--display-id={display_id}')
                reset_needed = True
            else:
                print("  Warning: Failed to create dynamic display for Default mode. Using primary display.")
                reset_needed = False # No overlay created
        else:
             print("  Resolution/DPI not provided for Default mode. Using primary display.")
             reset_needed = False # No overlay created

    if bitrate: cmd.append(bitrate)
    if max_fps: cmd.append(max_fps)

    if apply_rotation_lock_param and rotation_lock:
        cmd.append(rotation_lock)
    elif not apply_rotation_lock_param and rotation_lock:
        print(f"Ignoring user-specified orientation lock ({rotation_lock}) due to selected mode.")


    cmd.extend(options)

    final_scrcpy_command_str = ' '.join(cmd)
    print(f"Final Scrcpy Command: {final_scrcpy_command_str}")

    try:
        thread = threading.Thread(target=run_scrcpy_with_reset, args=(cmd, DEVICE_SERIAL, reset_needed))
        thread.daemon = True
        thread.start()
        # Return success message and the command string separated by a marker
        return f'Scrcpy session started!---COMMAND---{final_scrcpy_command_str}'
    except Exception as e:
        print(f"Error starting scrcpy thread: {e}")
        if reset_needed:
            print("Attempting display reset due to thread startup error.")
            reset_display(DEVICE_SERIAL)
        return f'Error: Failed to start Scrcpy thread: {str(e)}---COMMAND---{final_scrcpy_command_str}', 500

@app.route('/update-app', methods=['POST'])
def update_app():
    print("Received /update-app request")
    try:
        repo_owner = "serifpersia"
        repo_name = "scrcpy-desktop"
        api_url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/releases/latest"
        print(f"Checking for updates at: {api_url}")

        response = requests.get(api_url, timeout=15)
        response.raise_for_status()
        release_data = response.json()
        tag = release_data.get("tag_name")
        if not tag:
            print("Error: Could not find tag_name in latest release data.")
            return "Error: Could not find tag_name in latest release data.", 500

        print(f"Latest release tag: {tag}")
        zip_url = f"https://github.com/{repo_owner}/{repo_name}/archive/refs/tags/{tag}.zip"
        print(f"Downloading source code ZIP from: {zip_url}")

        zip_response = requests.get(zip_url, timeout=30)
        zip_response.raise_for_status()
        print("Download complete.")

        temp_update_dir = "temp_update_dir"
        files_to_update = ["index.html", "server.py", "server.ps1"]

        if os.path.exists(temp_update_dir):
            print(f"Removing existing temp directory: {temp_update_dir}")
            shutil.rmtree(temp_update_dir)
        os.makedirs(temp_update_dir, exist_ok=True)
        print(f"Created temp directory: {temp_update_dir}")

        print("Extracting update files...")
        with zipfile.ZipFile(io.BytesIO(zip_response.content)) as z:
            z.extractall(temp_update_dir)
        print("Extraction complete.")

        extracted_folders = [d for d in os.listdir(temp_update_dir) if os.path.isdir(os.path.join(temp_update_dir, d))]
        if not extracted_folders:
            print("Error: Could not find extracted source folder in ZIP.")
            return "Error: Could not find extracted source folder in ZIP.", 500
        source_dir = os.path.join(temp_update_dir, extracted_folders[0])
        print(f"Source directory found: {source_dir}")

        print("Replacing application files...")
        all_copied = True
        for filename in files_to_update:
            source_file = os.path.join(source_dir, filename)
            target_file = filename
            if os.path.exists(source_file):
                try:
                    shutil.copy2(source_file, target_file)
                    print(f"  - Updated {target_file}")
                except Exception as copy_err:
                    print(f"  - Error copying {filename}: {copy_err}")
                    all_copied = False
            else:
                print(f"  - Warning: {filename} not found in downloaded update.")
                all_copied = False

        print("Cleaning up temporary files...")
        shutil.rmtree(temp_update_dir)
        print("Cleanup complete.")

        if all_copied:
             print("Update successful.")
             return "Update successful! Please close this window and restart the server (e.g., re-run server.ps1)."
        else:
             print("Update partially completed with warnings.")
             return "Update partially completed with warnings. Check console log. Restart required.", 200

    except requests.exceptions.RequestException as e:
        print(f"Network error during update check/download: {e}")
        return f"Error updating: Network issue ({e})", 500
    except zipfile.BadZipFile:
        print("Error: Downloaded file is not a valid ZIP.")
        return "Error updating: Invalid download file.", 500
    except Exception as e:
        print(f"Unexpected error during update: {e}")
        if 'temp_update_dir' in locals() and os.path.exists(temp_update_dir):
            try:
                print(f"Attempting cleanup of temp dir: {temp_update_dir}")
                shutil.rmtree(temp_update_dir)
            except Exception as cleanup_err:
                print(f"Error during cleanup: {cleanup_err}")
        return f"Error updating app: {str(e)}", 500

if __name__ == '__main__':
    print(f"Starting Scrcpy Desktop server...")
    print(f"Using ADB: {shutil.which(ADB_PATH) or 'Not found in PATH'}")
    print(f"Using Scrcpy: {shutil.which(SCRCPY_PATH) or 'Not found in PATH'}")
    if not shutil.which(ADB_PATH) or not shutil.which(SCRCPY_PATH):
         print("\n*** WARNING: adb or scrcpy not found in PATH. Functionality will be limited. ***\n")
    print(f"Server running on http://localhost:{PORT}/")
    app.run(host='0.0.0.0', port=PORT, debug=False)