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
DEVICE_SERIAL = None  # Global variable to track device serial
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
        # Improve regex to handle potential IPv6 link-local addresses or other formats if needed
        if re.match(r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$', device):  # Basic IPv4:port format
            network_devices.append(device)
        elif ':' not in device: # Assume non-IP format is USB/emulator serial
            usb_devices.append(device)
        # else: might be IPv6 or other format, currently ignored
    return usb_devices, network_devices

def run_adb_command(args, serial=None, check=False, timeout=10):
    """Helper function to run ADB commands with optional serial and error checking."""
    cmd = [ADB_PATH]
    if serial:
        cmd.extend(['-s', serial])
    cmd.extend(args)
    print(f"Server Executing: {' '.join(cmd)}")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=check, timeout=timeout)
        if result.returncode != 0 and check:
             # If check=True, CalledProcessError is raised automatically
             # If check=False, we might want to log stderr manually if returncode != 0
             if result.stderr:
                 print(f"ADB Command Warning/Error: {result.stderr.strip()}")
        elif result.stderr:
             # Log stderr even on success if it contains info (e.g., 'daemon started successfully')
             print(f"ADB Command Info: {result.stderr.strip()}")
        return result
    except subprocess.TimeoutExpired:
        print(f"ADB Command Timed Out: {' '.join(cmd)}")
        raise TimeoutError(f"ADB command timed out: {' '.join(args)}")
    except FileNotFoundError:
        print(f"Error: '{ADB_PATH}' command not found. Make sure ADB is installed and in your PATH.")
        raise FileNotFoundError(f"'{ADB_PATH}' command not found.")
    except subprocess.CalledProcessError as e:
        print(f"ADB Command Failed: {e}")
        print(f"Stderr: {e.stderr.strip()}")
        raise e # Re-raise the exception


def get_device_ip(serial):
    """Get the IP address of a device via adb"""
    try:
        # Try wlan0 first
        ip_result = run_adb_command(['shell', 'ip', 'addr', 'show', 'wlan0'], serial=serial)
        if ip_result.returncode == 0 and 'inet ' in ip_result.stdout:
            match = re.search(r'inet (\d+\.\d+\.\d+\.\d+)/\d+', ip_result.stdout)
            if match:
                print(f"Found IP on wlan0: {match.group(1)}")
                return match.group(1)

        # Fallback: try listing all interfaces (less reliable parsing)
        ip_result_all = run_adb_command(['shell', 'ip', 'addr'], serial=serial)
        if ip_result_all.returncode == 0:
             # Look for common patterns like wlan, eth - prioritize non-localhost
             for line in ip_result_all.stdout.splitlines():
                 if 'inet ' in line and 'scope global' in line: # Often indicates usable IP
                     match = re.search(r'inet (\d+\.\d+\.\d+\.\d+)/\d+', line)
                     if match and not match.group(1).startswith('127.'):
                         print(f"Found global IP: {match.group(1)}")
                         return match.group(1)
             # Fallback to any non-localhost IP if no global found
             for line in ip_result_all.stdout.splitlines():
                 if 'inet ' in line:
                     match = re.search(r'inet (\d+\.\d+\.\d+\.\d+)/\d+', line)
                     if match and not match.group(1).startswith('127.'):
                          print(f"Found non-localhost IP: {match.group(1)}")
                          return match.group(1)
        print(f"Could not determine IP address for device {serial}")
        return None
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"Error getting IP for {serial}: {e}")
        return None

def get_device_model(serial):
    """Get the device model."""
    try:
        model_result = run_adb_command(['shell', 'getprop', 'ro.product.model'], serial=serial)
        if model_result.returncode == 0:
            return model_result.stdout.strip()
        return "Unknown"
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"Error getting model for {serial}: {e}")
        return "Error Fetching Model"


@app.route('/detect-device', methods=['POST'])
def detect_device():
    """Detect Android device via adb"""
    global DEVICE_SERIAL
    data = request.json
    mode = data.get('mode')
    ip_input = data.get('ip') # User provided IP

    try:
        # Get list of all currently recognized devices
        devices_result = run_adb_command(['devices'], check=True)
        all_devices = [line.split('\t')[0] for line in devices_result.stdout.splitlines()[1:] if '\tdevice' in line]
        print(f"ADB detected devices: {all_devices}")

        usb_devices, network_devices = classify_devices(all_devices)
        print(f"Classified USB: {usb_devices}, Network: {network_devices}")

        if mode == 'usb':
            if not usb_devices:
                return jsonify({'success': False, 'message': 'No USB device detected. Ensure device is connected and USB debugging is enabled.'})
            DEVICE_SERIAL = usb_devices[0]  # Use the first USB device
            model = get_device_model(DEVICE_SERIAL)
            # Attempt to get IP even in USB mode for potential WiFi transition later
            ip_address = get_device_ip(DEVICE_SERIAL)
            print(f"USB Mode: Selected {DEVICE_SERIAL}, Model: {model}, Detected IP: {ip_address}")
            return jsonify({'success': True, 'model': model, 'ip': ip_address}) # Return detected IP

        elif mode == 'wifi':
            target_ip = ip_input
            # 1. Auto-detect IP via USB if no IP provided
            if not target_ip:
                if not usb_devices:
                     return jsonify({'success': False, 'message': 'WiFi mode requires an IP address or a connected USB device for auto-detection.'})
                print("WiFi Mode: No IP provided, attempting auto-detection via USB.")
                usb_serial_for_ip = usb_devices[0]
                target_ip = get_device_ip(usb_serial_for_ip)
                if not target_ip:
                    return jsonify({'success': False, 'message': 'Could not auto-detect IP address from USB device. Please ensure WiFi is connected.'})
                print(f"Auto-detected IP: {target_ip}. Enabling TCP/IP mode.")
                # Enable TCP/IP mode on the USB device
                try:
                    run_adb_command(['tcpip', '5555'], serial=usb_serial_for_ip, check=True, timeout=15)
                    time.sleep(2) # Give ADB server time to restart in TCP mode
                except (subprocess.CalledProcessError, TimeoutError) as e:
                    return jsonify({'success': False, 'message': f'Failed to enable TCP/IP mode on {usb_serial_for_ip}: {e}'})

            # 2. Connect to the target IP
            wifi_device_serial = f"{target_ip}:5555"
            print(f"WiFi Mode: Attempting to connect to {wifi_device_serial}")

            # Disconnect first, in case it's already connected with issues
            run_adb_command(['disconnect', wifi_device_serial], timeout=5) # Don't check errors here
            time.sleep(1)

            try:
                connect_result = run_adb_command(['connect', wifi_device_serial], check=True, timeout=15)
                if 'connected to' not in connect_result.stdout and 'already connected' not in connect_result.stdout:
                     # Should be caught by check=True, but double-check
                     raise ConnectionError(f"Failed to connect to {wifi_device_serial}. Response: {connect_result.stdout} {connect_result.stderr}")
                print(f"Successfully connected or already connected to {wifi_device_serial}")
            except (subprocess.CalledProcessError, TimeoutError, ConnectionError) as e:
                 # Attempt to connect again after a short delay
                 print(f"Initial connection failed, retrying once... Error: {e}")
                 time.sleep(2)
                 try:
                     connect_result = run_adb_command(['connect', wifi_device_serial], check=True, timeout=15)
                     if 'connected to' not in connect_result.stdout and 'already connected' not in connect_result.stdout:
                          raise ConnectionError(f"Retry failed. Response: {connect_result.stdout} {connect_result.stderr}")
                     print(f"Successfully connected to {wifi_device_serial} on retry.")
                 except (subprocess.CalledProcessError, TimeoutError, ConnectionError) as e_retry:
                    message = f"Failed to connect to {wifi_device_serial} after retry: {e_retry}"
                    # Check if the original USB device is still available
                    if not ip_input and usb_devices and get_device_ip(usb_devices[0]):
                         message += " Check if device is still on the same Wi-Fi network."
                    else:
                         message += " Ensure the IP address is correct and the device is reachable."
                    return jsonify({'success': False, 'message': message})


            # 3. Verify connection and get model
            DEVICE_SERIAL = wifi_device_serial
            # Verify by getting model, which implicitly checks the connection again
            model = get_device_model(DEVICE_SERIAL)
            if model == "Error Fetching Model": # Check if get_model failed
                 # Rerun adb devices to see if it's listed
                 devices_result_after_connect = run_adb_command(['devices'])
                 if DEVICE_SERIAL not in devices_result_after_connect.stdout:
                     return jsonify({'success': False, 'message': f'Device {DEVICE_SERIAL} disappeared after connection attempt.'})
                 else: # It's listed but couldn't get model, might still work but warn user
                      print(f"Warning: Connected to {DEVICE_SERIAL} but failed to retrieve model name.")
                      model = "Unknown (Connected)"

            print(f"WiFi Mode: Selected {DEVICE_SERIAL}, Model: {model}")
            return jsonify({'success': True, 'model': model, 'ip': target_ip}) # Return the IP used

        else:
            return jsonify({'success': False, 'message': 'Invalid connection mode specified'})

    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        return jsonify({'success': False, 'message': f'ADB Operation Error: {str(e)}'})
    except Exception as e:
        # Catch-all for unexpected errors
        print(f"Unexpected error in detect_device: {e}")
        return jsonify({'success': False, 'message': f'An unexpected server error occurred: {str(e)}'})


@app.route('/connect-device', methods=['POST'])
def connect_device():
    """Confirm connection (mostly a placeholder now, real connection happens in detect)"""
    global DEVICE_SERIAL
    if not DEVICE_SERIAL:
         return jsonify({'success': False, 'message': 'No device is currently selected.'})

    # Optional: Add a quick check here to see if the DEVICE_SERIAL is still valid
    try:
        run_adb_command(['get-state'], serial=DEVICE_SERIAL, check=True, timeout=5)
        print(f"Device {DEVICE_SERIAL} confirmed.")
        return jsonify({'success': True, 'message': f'Device {DEVICE_SERIAL} ready.'})
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"Device {DEVICE_SERIAL} check failed: {e}")
        DEVICE_SERIAL = None # Invalidate serial if check fails
        return jsonify({'success': False, 'message': f'Device connection lost or timed out: {e}. Please re-detect.'})

# --- Display Reset and Scrcpy Execution Logic ---

def reset_display(serial):
    """Reset wm size, density, rotation, and overlay displays."""
    print(f"Resetting display settings for {serial}...")
    try:
        # Use helper function for robustness
        run_adb_command(['shell', 'settings', 'put', 'global', 'overlay_display_devices', 'none'], serial=serial, timeout=5)
        run_adb_command(['shell', 'wm', 'size', 'reset'], serial=serial, timeout=5)
        run_adb_command(['shell', 'wm', 'density', 'reset'], serial=serial, timeout=5)
        run_adb_command(['shell', 'settings', 'put', 'system', 'user_rotation', '0'], serial=serial, timeout=5)
        print(f"Display settings reset for {serial}.")
        time.sleep(1) # Short delay after reset
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"Warning: Failed to fully reset display settings for {serial}: {e}")
        # Don't halt execution, but log the warning

def run_scrcpy_with_reset(cmd, serial, reset_needed):
    """Run scrcpy and reset display settings when it exits if needed."""
    print(f"Executing Scrcpy: {' '.join(cmd)}")
    process = None
    try:
        # Use Popen to run scrcpy asynchronously
        process = subprocess.Popen(cmd)
        process.wait()  # Wait for scrcpy process to terminate
        print("Scrcpy process finished.")
    except FileNotFoundError:
        print(f"Error: '{SCRCPY_PATH}' command not found. Make sure Scrcpy is installed and in your PATH.")
        # Handle case where scrcpy isn't found
    except Exception as e:
        print(f"Error running or waiting for scrcpy: {e}")
    finally:
        # Ensure reset happens even if scrcpy crashes, but only if needed
        if reset_needed:
            print(f"Scrcpy exited, performing display reset for {serial}.")
            reset_display(serial)
        else:
            print(f"Scrcpy exited, no display reset needed for this mode.")

def get_dynamic_display_id(serial, resolution, dpi):
    """Get dynamic overlay display ID (Use with caution, less stable)."""
    print(f"Attempting to get dynamic display ID for {resolution}/{dpi} on {serial}")
    # Step 1: Reset overlays first to get a clean slate
    reset_display(serial)

    # Step 2: List displays *before* creating the new overlay
    initial_ids = set()
    try:
        list_cmd = [SCRCPY_PATH, '-s', serial, '--list-displays']
        print(f"Server Executing: {' '.join(list_cmd)}")
        initial_result = subprocess.run(list_cmd, capture_output=True, text=True, timeout=10)
        if initial_result.returncode == 0:
            for line in initial_result.stdout.splitlines():
                match = re.search(r'--display-id=(\d+)', line)
                if match:
                    initial_ids.add(int(match.group(1)))
            print(f"Initial display IDs: {initial_ids}")
        else:
            print(f"Warning: scrcpy --list-displays failed initially: {initial_result.stderr}")
            # Proceed cautiously, assuming 0 is the only static ID usually present
            initial_ids.add(0)
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
         print(f"Error listing initial displays: {e}. Cannot determine dynamic ID.")
         return None

    # Step 3: Create overlay display with user-specified resolution and DPI
    overlay_setting = f"{resolution}/{dpi}"
    try:
        run_adb_command(['shell', 'settings', 'put', 'global', 'overlay_display_devices', overlay_setting], serial=serial, check=True, timeout=5)
        time.sleep(2) # Give the system time to register the new display
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"Error setting overlay display: {e}. Cannot create dynamic display.")
        reset_display(serial) # Attempt to clean up
        return None

    # Step 4: List displays *after* creating the overlay
    updated_ids = set()
    try:
        list_cmd = [SCRCPY_PATH, '-s', serial, '--list-displays']
        print(f"Server Executing: {' '.join(list_cmd)}")
        updated_result = subprocess.run(list_cmd, capture_output=True, text=True, timeout=10)
        if updated_result.returncode == 0:
            for line in updated_result.stdout.splitlines():
                match = re.search(r'--display-id=(\d+)', line)
                if match:
                    updated_ids.add(int(match.group(1)))
            print(f"Updated display IDs: {updated_ids}")
        else:
            print(f"Warning: scrcpy --list-displays failed after setting overlay: {updated_result.stderr}")
            # If listing fails now, we can't be sure, clean up and fail
            reset_display(serial)
            return None
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"Error listing updated displays: {e}. Cannot determine dynamic ID.")
        reset_display(serial) # Attempt to clean up
        return None

    # Step 5: Identify the new display ID(s)
    new_ids = updated_ids - initial_ids
    print(f"New dynamic IDs found: {new_ids}")

    if not new_ids:
        print("Error: No new display ID found after creating overlay. Resetting.")
        reset_display(serial)
        return None

    # Usually, there's only one new ID. If multiple, pick the lowest > 0? Or highest?
    # Picking the smallest new ID seems safer.
    dynamic_display_id = min(new_ids)
    print(f"Dynamic display ID selected: {dynamic_display_id} for {overlay_setting}.")
    return dynamic_display_id

@app.route('/start-scrcpy', methods=['POST'])
def start_scrcpy():
    """Start scrcpy with provided config"""
    global DEVICE_SERIAL
    if not DEVICE_SERIAL:
        return 'Error: No device selected or connection lost.', 500

    # Verify device is still connected before proceeding
    try:
        run_adb_command(['get-state'], serial=DEVICE_SERIAL, check=True, timeout=5)
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        current_serial = DEVICE_SERIAL # Store potentially invalid serial for error message
        DEVICE_SERIAL = None # Invalidate serial
        return f'Error: Device {current_serial} connection lost: {e}. Please re-detect.', 500

    data = request.json
    print(f"Received Scrcpy Config: {data}") # Log received config

    resolution = data.get('resolution')
    dpi = data.get('dpi')
    bitrate = data.get('bitrate')
    max_fps = data.get('maxFps')
    rotation_lock = data.get('rotationLock') # e.g., --capture-orientation=N
    options = data.get('options', []) # List of additional flags like -f, --no-audio
    useVirtualDisplay = data.get('useVirtualDisplay', False)
    useNativeTaskbar = data.get('useNativeTaskbar', False)
    useSamsungDex = data.get('useSamsungDex', False) # Get the new flag

    cmd = [SCRCPY_PATH, '-s', DEVICE_SERIAL]
    reset_needed = False # Flag to indicate if reset_display should be called on exit
    apply_rotation_lock_param = True # Default to applying rotation lock if specified

    # --- Determine Display Mode and Settings ---

    if useSamsungDex:
        print("Mode: Samsung DeX")
        cmd.append('--display-id=2')
        # Ignore resolution, dpi, rotation_lock for DeX mode
        reset_needed = False # No system settings changed
        apply_rotation_lock_param = False # Don't add --capture-orientation
        # Resolution/DPI are ignored implicitly by not adding params

    elif useVirtualDisplay:
        print("Mode: Virtual Display")
        if resolution and dpi:
             display_id = get_dynamic_display_id(DEVICE_SERIAL, resolution, dpi)
             if display_id is not None:
                 cmd.append(f'--display-id={display_id}')
                 reset_needed = True # Created an overlay, need reset
             else:
                 print("Error: Failed to create dynamic display for Virtual Mode. Aborting.")
                 return 'Error: Could not create virtual display.', 500
        else:
             print("Warning: Virtual Display selected but Resolution/DPI missing. Using default display.")
        # Allow rotation lock for Virtual Display mode (apply_rotation_lock_param remains True)
        print("Applying rotation lock (if specified) for Virtual Display mode.")


    elif useNativeTaskbar:
        print("Mode: Native Taskbar")
        # Apply Res/DPI via wm commands
        if resolution:
            try:
                # Validate format WxH
                width, height = map(int, resolution.split('x'))
                target_resolution = resolution
                run_adb_command(['shell', 'wm', 'size', target_resolution], serial=DEVICE_SERIAL, check=True)
                reset_needed = True
            except (ValueError, subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
                print(f"Warning: Failed to set resolution {resolution} for Native Taskbar: {e}. Skipping.")
        if dpi:
            try:
                # Validate DPI is integer
                int_dpi = int(dpi)
                run_adb_command(['shell', 'wm', 'density', str(int_dpi)], serial=DEVICE_SERIAL, check=True)
                reset_needed = True
            except (ValueError, subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
                 print(f"Warning: Failed to set DPI {dpi} for Native Taskbar: {e}. Skipping.")

        # Force landscape rotation via settings
        try:
            run_adb_command(['shell', 'settings', 'put', 'system', 'user_rotation', '1'], serial=DEVICE_SERIAL, check=True)
            reset_needed = True
        except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
             print(f"Warning: Failed to set rotation for Native Taskbar: {e}. Skipping.")

        cmd.append('--display-id=0') # Target the primary display
        # Ignore separate --capture-orientation setting for this mode
        apply_rotation_lock_param = False # Don't add --capture-orientation
        print("Ignoring separate orientation lock for Native Taskbar mode (using forced landscape).")

    else: # Default mode
        print("Mode: Default / Dynamic Display")
        if resolution and dpi:
             # Attempt to use dynamic display if Res/DPI provided
             display_id = get_dynamic_display_id(DEVICE_SERIAL, resolution, dpi)
             if display_id is not None:
                 cmd.append(f'--display-id={display_id}')
                 reset_needed = True # Created overlay, need reset
             else:
                 print("Warning: Failed to create dynamic display ID. Using default display 0.")
                 # Falls through to using default display 0 without specific ID
        # Allow rotation lock for Default mode (apply_rotation_lock_param remains True)


    # --- Add Common Options ---
    if bitrate: cmd.append(bitrate)
    if max_fps: cmd.append(max_fps)

    # Add rotation lock param if applicable for the selected mode and if provided by user
    if apply_rotation_lock_param and rotation_lock:
        cmd.append(rotation_lock)
    elif not apply_rotation_lock_param and rotation_lock:
        print(f"Ignoring user-specified orientation lock ({rotation_lock}) due to selected mode.")


    # Add other boolean options from the checkbox list
    cmd.extend(options)

    # --- Start Scrcpy in a Thread ---
    try:
        print(f"Final Scrcpy Command: {' '.join(cmd)}")
        thread = threading.Thread(target=run_scrcpy_with_reset, args=(cmd, DEVICE_SERIAL, reset_needed))
        thread.daemon = True
        thread.start()
        return 'Scrcpy session started!'
    except Exception as e:
        print(f"Error starting scrcpy thread: {e}")
        if reset_needed: # Attempt reset if settings might have been changed
            reset_display(DEVICE_SERIAL)
        return f'Error: Failed to start Scrcpy thread: {str(e)}', 500

# --- Update App Function (Minor improvements) ---
@app.route('/update-app', methods=['POST'])
def update_app():
    try:
        repo_owner = "serifpersia"
        repo_name = "scrcpy-desktop"
        api_url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/releases/latest"
        print(f"Checking for updates at: {api_url}")

        # Fetch the latest release info
        response = requests.get(api_url, timeout=15)
        response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)
        release_data = response.json()
        tag = release_data.get("tag_name")
        if not tag:
            return "Error: Could not find tag_name in latest release data.", 500

        print(f"Latest release tag: {tag}")
        # Construct ZIP URL (adjust if repo structure changes)
        zip_url = f"https://github.com/{repo_owner}/{repo_name}/archive/refs/tags/{tag}.zip"
        print(f"Downloading source code ZIP from: {zip_url}")

        # Download the release ZIP
        zip_response = requests.get(zip_url, timeout=30) # Longer timeout for download
        zip_response.raise_for_status()

        # Define temporary directory and target files
        temp_update_dir = "temp_update_dir"
        files_to_update = ["index.html", "server.py"] # Add server.ps1 if needed

        # Clean up old temp dir if it exists
        if os.path.exists(temp_update_dir):
            shutil.rmtree(temp_update_dir)
        os.makedirs(temp_update_dir, exist_ok=True)

        # Extract the ZIP contents into the temp directory
        print("Extracting update files...")
        with zipfile.ZipFile(io.BytesIO(zip_response.content)) as z:
            z.extractall(temp_update_dir)

        # Find the actual source directory inside the temp dir (usually named repo-tag)
        extracted_folders = [d for d in os.listdir(temp_update_dir) if os.path.isdir(os.path.join(temp_update_dir, d))]
        if not extracted_folders:
            return "Error: Could not find extracted source folder in ZIP.", 500
        source_dir = os.path.join(temp_update_dir, extracted_folders[0])
        print(f"Source directory found: {source_dir}")

        # Replace current files with updated ones
        print("Replacing application files...")
        all_copied = True
        for filename in files_to_update:
            source_file = os.path.join(source_dir, filename)
            target_file = filename # Root directory relative to server.py
            if os.path.exists(source_file):
                try:
                    shutil.copy2(source_file, target_file) # copy2 preserves metadata
                    print(f"  - Updated {target_file}")
                except Exception as copy_err:
                    print(f"  - Error copying {filename}: {copy_err}")
                    all_copied = False
            else:
                print(f"  - Warning: {filename} not found in downloaded update.")
                all_copied = False # Consider it not fully successful if a file is missing

        # Clean up the temporary directory
        print("Cleaning up temporary files...")
        shutil.rmtree(temp_update_dir)

        if all_copied:
             return "Update successful! Please close this window and restart the server (e.g., re-run server.ps1)."
        else:
             return "Update partially completed with warnings. Check console log. Restart required.", 200 # Still OK, but indicate issues

    except requests.exceptions.RequestException as e:
        print(f"Network error during update check/download: {e}")
        return f"Error updating: Network issue ({e})", 500
    except zipfile.BadZipFile:
        print("Error: Downloaded file is not a valid ZIP.")
        return "Error updating: Invalid download file.", 500
    except Exception as e:
        print(f"Unexpected error during update: {e}")
        # Clean up temp dir if error occurred mid-process
        if 'temp_update_dir' in locals() and os.path.exists(temp_update_dir):
            try:
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
    # Use threaded=True for better handling of concurrent requests if needed,
    # but keep debug=False for production/general use.
    # Setting host='0.0.0.0' makes it accessible on your network.
    app.run(host='0.0.0.0', port=PORT, debug=False)