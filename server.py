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

import socket
import random
import string
import logging
from zeroconf import ServiceInfo, Zeroconf, ServiceBrowser, ServiceListener

from typing import Union, Tuple  # Add this import at the top of server.py

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
log = logging.getLogger('adb_qr_auto')

app = Flask(__name__, static_folder='.', static_url_path='')
PORT = 8000
DEVICE_SERIAL = None
ADB_PATH = "adb"
SCRCPY_PATH = "scrcpy"

ADB_PAIRING_SERVICE_TYPE = "_adb-tls-pairing._tcp.local."
ADB_CONNECT_SERVICE_TYPE = "_adb-tls-connect._tcp.local."
HOST_ADVERTISE_PORT = 43212

zeroconf_instance = None
qr_stop_event = threading.Event()

phone_pairing_details = []
phone_connect_details = []
discovery_lock = threading.Lock()

host_pairing_code = None
host_service_name = None
host_service_name_full = None
pc_local_ip = None

qr_workflow_active = False
qr_pairing_attempted = False
qr_paired_successfully = False
qr_connection_attempted = False
qr_connected_successfully = False
qr_status_message = "Idle"
qr_error = None

rotation_states = {}

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')


def get_local_ip_address():
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        log.info(f"Determined local IP: {ip}")
        return ip
    except Exception as e:
        log.warning(f"Could not determine local IP address using socket: {e}. Attempting hostname fallback.")
        try:
             ip = socket.gethostbyname(socket.gethostname())
             log.info(f"Determined local IP using hostname: {ip}")
             if ip.startswith('127.'):
                 log.warning(f"Hostname fallback returned localhost ({ip}). This might not work for QR pairing across network.")
                 return None
             return ip
        except Exception as e_inner:
            log.error(f"Hostname fallback failed: {e_inner}. Cannot get local IP.")
            return None
    finally:
        if s:
            s.close()

def generate_random_string(length=6):
    return ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(length))

def generate_pairing_code(length=6):
    return ''.join(random.choice(string.digits) for _ in range(length))

class AdbServiceListenerBase(ServiceListener):
    def _extract_ip_port(self, zeroconf: Zeroconf, type: str, name: str) -> Tuple[Union[str, None], Union[int, None]]:        
        log.debug(f"Querying details for service: {name}")
        info = zeroconf.get_service_info(type, name, timeout=1000)

        if not info:
            log.warning(f"Could not get service info for {name} within timeout.")
            return None, None

        device_ip = None
        if info.addresses:
            try:
                for addr_bytes in info.addresses:
                    if len(addr_bytes) == 4:
                        addr_str = socket.inet_ntoa(addr_bytes)
                        device_ip = addr_str
                        break

                if not device_ip and info.addresses:
                     try:
                         if len(info.addresses[0]) == 4:
                              device_ip = socket.inet_ntop(socket.AF_INET, info.addresses[0])
                         else:
                              log.warning(f"Found only non-IPv4 address for {name}, skipping for adb connect simplicity.")
                              return None, None
                     except Exception as e:
                         log.error(f"Error decoding first address for {name}: {e}")
                         return None, None


            except Exception as e:
                log.error(f"Error processing addresses for {name}: {e}")
                return None, None

            if not device_ip:
                 log.warning(f"No usable IPv4 address found in service info for {name}")
                 return None, None

            log.debug(f"Found IP Address for {name}: {device_ip}")
        else:
            log.warning(f"No addresses found in service info for {name}")
            return None, None

        device_port = info.port
        if not device_port:
            log.warning(f"No port found in service info for {name}")
            return device_ip, None
        log.debug(f"Found Port for {name}: {device_port}")

        return device_ip, device_port

    def add_service(self, zeroconf: Zeroconf, type: str, name: str):
        global discovery_lock, phone_pairing_details, phone_connect_details, host_service_name_full, qr_workflow_active, qr_stop_event

        if not qr_workflow_active or qr_stop_event.is_set():
            log.debug(f"Ignoring service discovery ({name}) as QR workflow is inactive or stopping.")
            return

        if name == host_service_name_full:
            log.debug(f"Ignoring self-advertised service: {name}")
            return

        log.info(f"Service detected: {name} of type {type}")
        ip, port = self._extract_ip_port(zeroconf, type, name)

        if ip and port:
             with discovery_lock:
                 if type == ADB_PAIRING_SERVICE_TYPE:
                     if not phone_pairing_details:
                         log.info(f"Storing phone pairing details: {ip}:{port} from {name}")
                         phone_pairing_details.extend([ip, port])
                         print(f"\n>>> Phone Pairing Service Found: {name} at {ip}:{port}")
                 elif type == ADB_CONNECT_SERVICE_TYPE:
                     if not phone_connect_details:
                         log.info(f"Storing phone connect details: {ip}:{port} from {name}")
                         phone_connect_details.extend([ip, port])
                         print(f"\n>>> Phone Connect Service Found: {name} at {ip}:{port}")
                 else:
                      log.debug(f"Ignoring unknown service type: {type}")


    def remove_service(self, zeroconf: Zeroconf, type: str, name: str):
        global qr_workflow_active
        if not qr_workflow_active: return

        log.info(f"Service removed: {name} of type {type}")

    def update_service(self, zeroconf: Zeroconf, type: str, name: str):
        self.add_service(zeroconf, type, name)


def qr_workflow_thread_func():
    global discovery_lock
    global phone_pairing_details, phone_connect_details
    global qr_workflow_active, qr_pairing_attempted, qr_paired_successfully, qr_connection_attempted, qr_connected_successfully, qr_status_message, qr_error
    global host_pairing_code, host_service_name_full, DEVICE_SERIAL
    global qr_stop_event, zeroconf_instance

    log.info("QR workflow thread started.")
    qr_workflow_active = True
    qr_pairing_attempted = False
    qr_paired_successfully = False
    qr_connection_attempted = False
    qr_connected_successfully = False
    qr_status_message = "Scan the QR code on your phone..."
    qr_error = None
    DEVICE_SERIAL = None

    start_time = time.time()
    overall_timeout = 180

    try:
        while not qr_stop_event.is_set() and (time.time() - start_time) < overall_timeout:
            try:
                if not qr_pairing_attempted:
                     p_details = None
                     with discovery_lock:
                         if phone_pairing_details:
                             p_details = list(phone_pairing_details)
                             phone_pairing_details.clear()

                     if p_details:
                         p_ip, p_port = p_details
                         qr_pairing_attempted = True
                         qr_status_message = f"Phone pairing service discovered at {p_ip}:{p_port}. Attempting pairing..."
                         log.info(f"Attempting adb pair to {p_ip}:{p_port} with code {host_pairing_code}")
                         pair_success = run_adb_pair(p_ip, p_port, host_pairing_code)
                         if pair_success:
                             qr_paired_successfully = True
                             qr_status_message = "Pairing successful! Waiting for connection service..."
                             log.info("adb pair command reported success.")
                             start_time = time.time()
                         else:
                             qr_error = "ADB pairing failed. Check phone and try again."
                             qr_status_message = qr_error
                             log.warning("adb pair command reported failure.")
                             qr_stop_event.set()

                elif qr_paired_successfully and not qr_connection_attempted:
                     c_details = None
                     with discovery_lock:
                         if phone_connect_details:
                             c_details = list(phone_connect_details)
                             phone_connect_details.clear()

                     if c_details:
                         c_ip, c_port = c_details
                         qr_connection_attempted = True
                         qr_status_message = f"Phone connect service discovered at {c_ip}:{c_port}. Attempting connection..."
                         log.info(f"Attempting adb connect to {c_ip}:{c_port}")
                         connect_success = run_adb_connect(c_ip, c_port)
                         if connect_success:
                             qr_connected_successfully = True
                             DEVICE_SERIAL = f"{c_ip}:{c_port}"
                             qr_status_message = f"Connection successful! Device: {DEVICE_SERIAL}"
                             log.info(f"adb connect command reported success. DEVICE_SERIAL set to {DEVICE_SERIAL}")
                             qr_stop_event.set()
                         else:
                             qr_error = "ADB connection failed after pairing. Try pressing 'Start' manually or restart the app."
                             qr_status_message = qr_error
                             log.warning("adb connect command reported failure.")
                             qr_stop_event.set()

            except Exception as e:
                log.error(f"Error in QR workflow thread step: {e}", exc_info=True)
                qr_error = f"Workflow Error: {e}"
                qr_status_message = qr_error
                qr_stop_event.set()

            time.sleep(0.5)

        if not qr_stop_event.is_set() and (time.time() - start_time) >= overall_timeout:
             log.warning("QR workflow thread timed out.")
             if not qr_paired_successfully:
                  qr_error = qr_error or "Pairing process timed out. Check phone settings and network."
             elif not qr_connected_successfully:
                  qr_error = qr_error or "Connection process timed out after pairing. Try connecting manually."
             else:
                  qr_error = qr_error or "QR workflow timed out."

             qr_status_message = qr_error
             print("\nQR pairing/connection process timed out.")

    finally:
        log.info("QR workflow thread finishing.")
        qr_workflow_active = False
        stop_zeroconf()

def stop_zeroconf():
    global zeroconf_instance
    log.info("Stopping Zeroconf...")
    if zeroconf_instance:
        try:
            zeroconf_instance.close()
            log.info("Zeroconf instance closed.")
        except Exception as e:
            log.error(f"Error closing Zeroconf instance: {e}")
        finally:
             zeroconf_instance = None

@app.route('/initiate-qr', methods=['POST'])
def initiate_qr():
    global zeroconf_instance, qr_stop_event
    global host_pairing_code, host_service_name, host_service_name_full, pc_local_ip
    global phone_pairing_details, phone_connect_details
    global qr_workflow_active, qr_pairing_attempted, qr_paired_successfully, qr_connection_attempted, qr_connected_successfully, qr_status_message, qr_error
    global DEVICE_SERIAL

    log.info("Received /initiate-qr request.")

    if qr_workflow_active:
        log.info("QR workflow already active. Returning current status.")
        qr_string = f"WIFI:T:ADB;S:{host_service_name};P:{host_pairing_code};;" if host_service_name and host_pairing_code else ""
        return jsonify({
             'success': True,
             'workflow_active': True,
             'qr_string': qr_string,
             'qr_message': qr_status_message,
             'qr_status': {
                 'workflow_active': qr_workflow_active,
                 'qr_paired_successfully': qr_paired_successfully,
                 'qr_connected_successfully': qr_connected_successfully,
                 'qr_status_message': qr_status_message,
                 'qr_error': qr_error
             },
             'info': qr_status_message # Also send current status for main message bar
        })


    if zeroconf_instance is not None:
        log.info("Existing Zeroconf instance found during new initiation. Stopping.")
        qr_stop_event.set()
        time.sleep(1)
        stop_zeroconf()

    qr_stop_event.clear()
    phone_pairing_details.clear()
    phone_connect_details.clear()
    qr_workflow_active = True
    qr_pairing_attempted = False
    qr_paired_successfully = False
    qr_connection_attempted = False
    qr_connected_successfully = False
    qr_status_message = "Initializing QR pairing..."
    qr_error = None
    DEVICE_SERIAL = None

    pc_local_ip = get_local_ip_address()
    if not pc_local_ip:
        log.error("Failed to get local PC IP. Cannot initiate QR flow.")
        qr_workflow_active = False
        qr_error = 'Could not determine PC IP address for QR pairing.'
        qr_status_message = qr_error
        return jsonify({'success': False, 'message': qr_error, 'needs_qr': False})

    hostname = socket.gethostname().split('.')[0]
    random_part = generate_random_string(4)
    host_service_name = f"PyAutoADB-{hostname}-{random_part}"
    host_pairing_code = generate_pairing_code()
    host_service_name_full = f"{host_service_name}.{ADB_PAIRING_SERVICE_TYPE}"

    # QR string format: WIFI:T:ADB;S:<service_name>;P:<pairing_code>;;
    qr_string = f"WIFI:T:ADB;S:{host_service_name};P:{host_pairing_code};;"

    log.info(f"Generated Host Info for QR Pairing: IP={pc_local_ip}, Service Name={host_service_name}, Pairing Code={host_pairing_code}")

    try:
        zeroconf_instance = Zeroconf()

        host_properties = {
            "pairing_code": host_pairing_code.encode('utf-8'),
            "host": hostname.encode('utf-8')
        }
        host_service_info = ServiceInfo(
            type_=ADB_PAIRING_SERVICE_TYPE,
            name=host_service_name_full,
            addresses=[socket.inet_aton(pc_local_ip)],
            port=HOST_ADVERTISE_PORT,
            properties=host_properties,
            server=f"{hostname}.local.",
        )
        log.info(f"Registering Host Pairing Service: {host_service_name_full} at {pc_local_ip}:{HOST_ADVERTISE_PORT}")
        zeroconf_instance.register_service(host_service_info)
        log.info("Host service registered.")

        pairing_listener = AdbServiceListenerBase()
        connect_listener = AdbServiceListenerBase()
        ServiceBrowser(zeroconf_instance, ADB_PAIRING_SERVICE_TYPE, pairing_listener)
        ServiceBrowser(zeroconf_instance, ADB_CONNECT_SERVICE_TYPE, connect_listener)
        log.info("Zeroconf Service Browsers started.")

        qr_workflow_thread = threading.Thread(target=qr_workflow_thread_func, daemon=True)
        qr_workflow_thread.start()
        log.info("QR workflow thread started.")

    except Exception as e:
        log.critical(f"Failed to initiate Zeroconf or workflow thread: {e}", exc_info=True)
        stop_zeroconf()
        qr_workflow_active = False
        qr_error = f'Failed to start QR pairing services: {e}.'
        qr_status_message = qr_error
        return jsonify({'success': False, 'message': qr_error, 'needs_qr': False})

    qr_status_message = (
        "Scan this QR code on your phone using the 'Pair device with QR code' option "
        "in Developer options -> Wireless debugging. "
        f"Ensure your PC and phone are on the same Wi-Fi network."
        "\n\nAfter scanning press the Start button."
        "\n\nIf you have issues with pairing re-enable wireless debugging and try again."
    )

    return jsonify({
        'success': False,
        'needs_qr': True,
        'qr_string': qr_string,
        'qr_message': qr_status_message,
        'host_ip': pc_local_ip,
        'pairing_code': host_pairing_code,
        'info': 'QR pairing initiated. Scan the code on your device.'
    })

@app.route('/qr-status', methods=['GET'])
def get_qr_status():
    global qr_workflow_active, qr_paired_successfully, qr_connected_successfully, qr_status_message, qr_error
    return jsonify({
        'workflow_active': qr_workflow_active,
        'qr_paired_successfully': qr_paired_successfully,
        'qr_connected_successfully': qr_connected_successfully,
        'qr_status_message': qr_status_message,
        'qr_error': qr_error,
        'device_serial': DEVICE_SERIAL
    })

@app.route('/cancel-qr-flow', methods=['POST'])
def cancel_qr_flow():
    global qr_stop_event, qr_workflow_active
    log.info("Received /cancel-qr-flow request. Setting stop event.")
    qr_stop_event.set()
    qr_workflow_active = False
    return jsonify({'success': True, 'message': 'QR workflow cancellation requested.'})


def classify_devices(devices):
    usb_devices = []
    network_devices = []
    for device in devices:
        if re.match(r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$', device):
            network_devices.append(device)
        elif ':' not in device:
            usb_devices.append(device)
    log.debug(f"Classified USB: {usb_devices}, Network: {network_devices}")
    return usb_devices, network_devices

def run_adb_command(args, serial=None, check=False, timeout=10, input_text=None):
    cmd = [ADB_PATH]
    if serial:
        cmd.extend(['-s', serial])
    cmd.extend(args)
    log.info(f"Executing ADB: {' '.join(cmd)}")
    try:
        process = subprocess.run(cmd, capture_output=True, text=True, check=check, timeout=timeout, encoding='utf-8', input=input_text)
        if process.stdout.strip():
            log.debug(f"  Stdout: {process.stdout.strip()}")
        if process.stderr.strip():
             log.debug(f"  Stderr: {process.stderr.strip()}")
        if process.returncode != 0 and not check:
             log.warning(f"  Command failed with exit code {process.returncode}")
        return process
    except subprocess.TimeoutExpired:
        log.error(f"  Command Timed Out.")
        raise TimeoutError(f"ADB command timed out: {' '.join(args)}")
    except FileNotFoundError:
        log.error(f"  Error: '{ADB_PATH}' command not found.")
        raise FileNotFoundError(f"'{ADB_PATH}' command not found. Ensure ADB is installed and in your system's PATH.")
    except subprocess.CalledProcessError as e:
        log.error(f"  Command Failed: {e.stderr.strip()}")
        error_message = f"ADB command failed ({' '.join(args)}):\n{e.stderr.strip()}"
        if e.stdout.strip():
             error_message += f"\n{e.stdout.strip()}"
        raise subprocess.CalledProcessError(e.returncode, e.cmd, output=e.stdout, stderr=error_message)
    except Exception as e:
        log.error(f"  An unexpected error occurred while running adb: {e}", exc_info=True)
        raise e


def run_adb_pair(device_ip, device_port, pairing_code_to_use):
    log.info(f"Attempting to pair with device {device_ip}:{device_port} using code {pairing_code_to_use}...")
    command = ["pair", f"{device_ip}:{device_port}"]
    try:
        result = run_adb_command(command, input_text=f"{pairing_code_to_use}\n", timeout=30)
        output = result.stdout + result.stderr
        if result.returncode == 0 and ("Successfully paired" in output or "already paired" in output):
            log.info("Pairing command reported SUCCESS!")
            print(">>> ADB Pairing SUCCESS!")
            return True
        else:
            log.warning("Pairing command reported FAILURE.")
            log.warning(f"ADB Output:\n{output}")
            print(">>> ADB Pairing FAILED.")
            return False
    except Exception as e:
        log.error(f"Error during adb pair execution: {e}")
        print(">>> ADB Pairing FAILED due to error.")
        return False


def run_adb_connect(device_ip, connect_port):
    log.info(f"Attempting to connect to device {device_ip}:{connect_port}...")
    command = ["connect", f"{device_ip}:{connect_port}"]
    try:
        result = run_adb_command(command, timeout=15)
        output = result.stdout + result.stderr
        if result.returncode == 0 and ("connected to" in output or "already connected to" in output):
            log.info("Connect command reported SUCCESS!")
            print(">>> ADB Connect SUCCESS!")
            return True
        else:
            log.warning("Connect command reported FAILURE.")
            log.warning(f"ADB Output:\n{output}")
            print(">>> ADB Connect FAILED.")
            return False
    except Exception as e:
        log.error(f"Error during adb connect execution: {e}")
        print(">>> ADB Connect FAILED due to error.")
        return False


def get_device_ip(serial):
    log.info(f"Attempting to get IP for device: {serial}")
    try:
        interfaces = ['wlan0', 'eth0', 'ccmni0', 'rmnet_data0']
        for iface in interfaces:
            log.debug(f"  Checking interface: {iface}")
            ip_result = run_adb_command(['shell', 'ip', 'addr', 'show', iface], serial=serial, timeout=5)
            if ip_result.returncode == 0:
                match = re.search(r'inet (\d+\.\d+\.\d+\.\d+)/\d+', ip_result.stdout)
                if match:
                    ip_address = match.group(1)
                    if not ip_address.startswith('127.'):
                        log.info(f"  Found IP on {iface} using 'ip addr show': {ip_address}")
                        return ip_address

            ip_route_result = run_adb_command(['shell', 'ip', 'route', 'show', 'dev', iface], serial=serial, timeout=5)
            if ip_route_result.returncode == 0:
                 match = re.search(r' src (\d+\.\d+\.\d+\.\d+)', ip_route_result.stdout)
                 if match:
                      ip_address = match.group(1)
                      if not ip_address.startswith('127.'):
                           log.info(f"  Found IP on {iface} using 'ip route show': {ip_address}")
                           return ip_address

        log.debug("  Specific interface checks failed. Checking all interfaces via 'ip addr'.")
        ip_result_all = run_adb_command(['shell', 'ip', 'addr'], serial=serial, timeout=5)
        if ip_result_all.returncode == 0:
             for line in ip_result_all.stdout.splitlines():
                 if 'inet ' in line and 'scope global' in line:
                     match = re.search(r'inet (\d+\.\d+\.\d+\.\d+)/\d+', line)
                     if match:
                         ip_address = match.group(1)
                         if not ip_address.startswith('127.'):
                             log.info(f"  Found global scope IP using 'ip addr': {ip_address}")
                             return ip_address

             for line in ip_result_all.stdout.splitlines():
                 if 'inet ' in line:
                     match = re.search(r'inet (\d+\.\d+\.\d+\.\d+)/\d+', line)
                     if match:
                         ip_address = match.group(1)
                         if not ip_address.startswith('127.'):
                              log.info(f"  Found any non-localhost IP using 'ip addr': {ip_address}")
                              return ip_address


        log.warning(f"  Could not determine IP address for {serial} after trying common methods.")
        return None
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        log.error(f"  Error getting IP for {serial}: {e}")
        return None


def get_device_model(serial):
    log.info(f"Attempting to get model for device: {serial}")
    try:
        model_result = run_adb_command(['shell', 'getprop', 'ro.product.model'], serial=serial, timeout=5)
        if model_result.returncode == 0:
            model = model_result.stdout.strip()
            log.info(f"  Found model: {model}")
            return model if model else "Unknown"
        log.warning("  Could not determine model using 'ro.product.model'. Trying 'ro.product.device'.")
        device_result = run_adb_command(['shell', 'getprop', 'ro.product.device'], serial=serial, timeout=5)
        if device_result.returncode == 0:
             device = device_result.stdout.strip()
             log.info(f"  Found device name: {device}")
             return device if device else "Unknown"

        log.warning("  Could not determine model or device name.")
        return "Unknown"
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        log.error(f"  Error getting model/device for {serial}: {e}")
        return "Error Fetching Info"

@app.route('/detect-device', methods=['POST'])
def detect_device():
    global DEVICE_SERIAL

    data = request.json
    if data is None:
        log.error("Received /detect-device request with invalid/missing JSON body.")
        return jsonify({'success': False, 'message': 'Invalid request format (missing JSON data).'}), 400

    mode = data.get('mode')
    ip_input = (data.get('ip') or '').strip()

    log.info(f"Received /detect-device request (Mode: {mode}, IP: '{ip_input}')")

    try:
        devices_result = run_adb_command(['devices'], check=True)
        all_devices = [line.split('\t')[0] for line in devices_result.stdout.splitlines()[1:] if '\tdevice' in line]
        log.info(f"ADB detected active devices: {all_devices}")

        usb_devices, network_devices = classify_devices(all_devices)
        DEVICE_SERIAL = None


        if mode == 'usb':
            if not usb_devices:
                log.warning("Mode 'usb' selected, but no USB devices found.")
                return jsonify({'success': False, 'message': 'No USB device detected. Ensure device is connected and USB debugging is enabled.'})

            DEVICE_SERIAL = usb_devices[0]
            log.info(f"Selected USB device: {DEVICE_SERIAL}")
            model = get_device_model(DEVICE_SERIAL)
            ip_address = get_device_ip(DEVICE_SERIAL)
            return jsonify({'success': True, 'model': model, 'ip': ip_address, 'serial': DEVICE_SERIAL})

        elif mode == 'wifi':
            wifi_device_serial = None
            device_found_or_attempted = False

            if network_devices:
                device_found_or_attempted = True
                selected_network_device = network_devices[0]
                log.info(f"Found existing connected network device: {selected_network_device}. Validating...")
                try:
                    run_adb_command(['get-state'], serial=selected_network_device, check=True, timeout=5)
                    DEVICE_SERIAL = selected_network_device
                    target_ip = DEVICE_SERIAL.split(':')[0]
                    model = get_device_model(DEVICE_SERIAL)
                    log.info(f"Successfully validated existing network device {DEVICE_SERIAL}. Model: {model}")
                    return jsonify({'success': True, 'model': model, 'ip': target_ip, 'serial': DEVICE_SERIAL})
                except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
                    log.warning(f"Existing network device {selected_network_device} listed but failed validation check: {e}. Continuing detection...")
                    DEVICE_SERIAL = None

            if ip_input and not DEVICE_SERIAL:
                device_found_or_attempted = True
                if ':' not in ip_input:
                    wifi_device_serial = f"{ip_input}:5555"
                else:
                    wifi_device_serial = ip_input

                log.info(f"Attempting direct connect to user-provided address: {wifi_device_serial}")
                try:
                    run_adb_command(['disconnect', wifi_device_serial], timeout=5)
                    time.sleep(0.5)
                except Exception as e:
                    log.debug(f"Ignoring disconnect error for {wifi_device_serial}: {e}")

                try:
                    connect_result = run_adb_command(['connect', wifi_device_serial], check=True, timeout=15)
                    if 'connected to' in connect_result.stdout or 'already connected' in connect_result.stdout:
                         DEVICE_SERIAL = wifi_device_serial
                         target_ip = DEVICE_SERIAL.split(':')[0]
                         model = get_device_model(DEVICE_SERIAL)
                         log.info(f"Successfully connected to {DEVICE_SERIAL} via user-provided address. Model: {model}")
                         return jsonify({'success': True, 'model': model, 'ip': target_ip, 'serial': DEVICE_SERIAL})
                    else:
                         log.warning(f"Direct connect command succeeded but output unexpected for {wifi_device_serial}. Response: {connect_result.stdout.strip()} {connect_result.stderr.strip()}")
                except Exception as e:
                    log.warning(f"Exception during direct connect attempt to {wifi_device_serial}: {e}")

            # Only attempt if a user IP was NOT provided AND there's a USB device and we haven't found a device yet
            if not ip_input and usb_devices and not DEVICE_SERIAL:
                device_found_or_attempted = True
                usb_serial_for_ip = usb_devices[0]
                log.info(f"No user IP provided. Using USB device {usb_serial_for_ip} for IP detection and TCP/IP setup.")
                detected_ip = get_device_ip(usb_serial_for_ip)
                if detected_ip:
                    target_ip = detected_ip
                    wifi_device_serial = f"{target_ip}:5555"
                    log.info(f"Auto-detected IP via USB: {target_ip}. Attempting to enable TCP/IP and connect.")
                    try:
                        run_adb_command(['tcpip', '5555'], serial=usb_serial_for_ip, check=True, timeout=15)
                        log.info(f"TCP/IP enabled on port 5555 for {usb_serial_for_ip}. Waiting briefly...")
                        time.sleep(2.5)
                        try:
                            run_adb_command(['disconnect', wifi_device_serial], timeout=5)
                            time.sleep(0.5)
                        except Exception as e:
                             log.debug(f"Ignoring disconnect error for {wifi_device_serial}: {e}")
                        connect_result = run_adb_command(['connect', wifi_device_serial], check=True, timeout=15)
                        if 'connected to' in connect_result.stdout or 'already connected' in connect_result.stdout:
                            DEVICE_SERIAL = wifi_device_serial
                            model = get_device_model(DEVICE_SERIAL)
                            log.info(f"Successfully connected to {DEVICE_SERIAL} via USB auto-detect. Model: {model}")
                            return jsonify({'success': True, 'model': model, 'ip': target_ip, 'serial': DEVICE_SERIAL})
                        else:
                            log.warning(f"Connect command succeeded but output unexpected after USB auto-detect for {wifi_device_serial}. Response: {connect_result.stdout.strip()} {connect_result.stderr.strip()}")
                    except Exception as e:
                        log.warning(f"Exception during USB auto-detect/connect flow: {e}")
                else:
                    log.warning(f"Could not auto-detect IP address from USB device {usb_serial_for_ip}. Cannot use USB auto-detect method.")

            if mode == 'wifi' and not DEVICE_SERIAL:
                 message = "Could not connect via Wi-Fi."
                 if ip_input:
                      message += f" Failed to connect to {ip_input}. Ensure the device is on the network and wireless debugging is enabled."
                 elif usb_devices:
                      message += " Failed to auto-detect IP via USB or connect. Ensure the device is connected via USB and wireless debugging is enabled."
                 else:
                      message += " No network devices found, no IP provided, and no USB device to auto-detect from. Ensure device is on the network or connected via USB."

                 # Add suggestion for QR pairing if it's a Wi-Fi issue
                 qr_suggestion = " If your device supports it, try 'Pair with QR Code' from the Connection section."
                 message += qr_suggestion

                 log.warning(message)

                 # Return information needed for QR pairing if it's a likely Wi-Fi/pairing issue
                 if not qr_workflow_active and pc_local_ip:
                     hostname = socket.gethostname().split('.')[0]
                     random_part = generate_random_string(4)
                     host_service_name = f"PyAutoADB-{hostname}-{random_part}"
                     host_pairing_code = generate_pairing_code()
                     qr_string_for_info = f"WIFI:T:ADB;S:{host_service_name};P:{host_pairing_code};;"
                     qr_message_for_info = (
                         "Wi-Fi connection failed. Try manual IP or QR pairing."
                         "\n\nScan the QR code below if your device supports 'Pair device with QR code' in Developer Options -> Wireless debugging."
                         "\nEnsure your PC and phone are on the same Wi-Fi network."
                         "\n\nAfter scanning, press the Start button on the modal."
                     )
                     return jsonify({
                         'success': False,
                         'message': message, # Primary error message for main status
                         'needs_qr': True,
                         'qr_string': qr_string_for_info,
                         'qr_message': qr_message_for_info,
                         'host_ip': pc_local_ip,
                         'pairing_code': host_pairing_code,
                         'info': message # Also send for main status bar
                     })
                 else:
                      # If QR workflow is already active or IP not found for QR, just return the basic error
                     return jsonify({'success': False, 'message': message, 'needs_qr': False})


        elif mode is None:
             log.warning("Request received with missing 'mode' field in JSON data.")
             return jsonify({'success': False, 'message': "Invalid request format (missing 'mode')."}), 400
        else:
             log.warning(f"Invalid connection mode specified: {mode}")
             return jsonify({'success': False, 'message': 'Invalid connection mode specified'})

    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        log.error(f"ADB Operation Error in /detect-device: {str(e)}")
        DEVICE_SERIAL = None
        return jsonify({'success': False, 'message': f'ADB Operation Error: {str(e)}. Is ADB installed and in PATH?'})
    except Exception as e:
        log.critical(f"An unexpected server error occurred in /detect-device: {e}", exc_info=True)
        DEVICE_SERIAL = None
        return jsonify({'success': False, 'message': f'An unexpected server error occurred: {str(e)}'})

    log.error("Detect device function reached end without returning a response. This is an internal error.")
    return jsonify({'success': False, 'message': 'Internal server error: Detection logic failed to return.'}), 500

@app.route('/connect-device', methods=['POST'])
def connect_device():
    global DEVICE_SERIAL, rotation_states
    log.info("Received /connect-device request")
    if not DEVICE_SERIAL:
         log.warning("No device is currently selected.")
         return jsonify({'success': False, 'message': 'No device is currently selected.'})

    try:
        devices_result = run_adb_command(['devices'], check=True, timeout=5)
        active_devices = [line.split('\t')[0] for line in devices_result.stdout.splitlines()[1:] if '\tdevice' in line]

        if DEVICE_SERIAL in active_devices:
             log.info(f"Device {DEVICE_SERIAL} confirmed and active.")
             model = get_device_model(DEVICE_SERIAL)
             ip_address = None
             if ':' in DEVICE_SERIAL:
                 ip_address = DEVICE_SERIAL.split(':')[0]
             elif '-' not in DEVICE_SERIAL and '.' not in DEVICE_SERIAL:
                  ip_address = get_device_ip(DEVICE_SERIAL)

             return jsonify({'success': True, 'message': f'Device {DEVICE_SERIAL} ready.', 'model': model, 'ip': ip_address})
        else:
            log.warning(f"Device {DEVICE_SERIAL} is no longer listed as active.")
            current_serial = DEVICE_SERIAL
            rotation_states.pop(current_serial, None)  # Clear stored rotation states
            DEVICE_SERIAL = None
            return jsonify({'success': False, 'message': f'Device {current_serial} connection lost. Please re-detect.'})

    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        log.error(f"Device {DEVICE_SERIAL} check failed: {e}")
        current_serial = DEVICE_SERIAL
        rotation_states.pop(current_serial, None)  # Clear stored rotation states
        DEVICE_SERIAL = None
        return jsonify({'success': False, 'message': f'Device connection lost or timed out: {e}. Please re-detect.'})
    except Exception as e:
         log.critical(f"An unexpected server error occurred in /connect-device: {e}", exc_info=True)
         return jsonify({'success': False, 'message': f'An unexpected server error occurred: {str(e)}'})

def reset_display(serial):
    print(f"Resetting display and rotation settings for {serial}...")
    try:
        # Reset display settings
        run_adb_command(['shell', 'settings', 'put', 'global', 'overlay_display_devices', 'none'], serial=serial, timeout=5)
        run_adb_command(['shell', 'wm', 'size', 'reset'], serial=serial, timeout=5)
        run_adb_command(['shell', 'wm', 'density', 'reset'], serial=serial, timeout=5)

        # Reset rotation settings
        try:
            response = requests.post('http://localhost:8000/reset-rotation')
            response_data = response.json()
            if response_data['success']:
                print(f"Rotation settings reset for {serial}.")
            else:
                print(f"Warning: Failed to reset rotation settings: {response_data['message']}")
        except requests.exceptions.RequestException as e:
            print(f"Warning: Failed to call reset-rotation endpoint: {e}")

        print(f"Display and rotation settings reset for {serial}.")
        time.sleep(1)
    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        print(f"Warning: Failed to fully reset display/rotation settings for {serial}: {e}")

def run_scrcpy_with_reset(cmd, serial, reset_needed):
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
            initial_ids.add(0)
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
    global DEVICE_SERIAL
    print("Received /start-scrcpy request")
    if not DEVICE_SERIAL:
        print("Error: No device selected or connection lost.")
        return 'Error: No device selected or connection lost.', 500

    try:
        print(f"Verifying device connection: {DEVICE_SERIAL}")
        run_adb_command(['get-state'], serial=DEVICE_SERIAL, check=True, timeout=5)
        print("Device connection verified.")
    except (subprocess.CalledProcessError, TimeoutExpired, FileNotFoundError) as e:
        print(f"Error: Device {DEVICE_SERIAL} connection lost: {e}.")
        current_serial = DEVICE_SERIAL
        DEVICE_SERIAL = None
        return f'Error: Device {current_serial} connection lost: {e}. Please re-detect.', 500

    data = request.json
    if data is None:
        log.error("Received /start-scrcpy request with invalid/missing JSON body.")
        return 'Error: Invalid request format (missing JSON data).', 400

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


    else:
        print("Mode: Default selected.")
        if resolution and dpi:
            print(f"  Resolution: {resolution}, DPI: {dpi}")
            display_id = get_dynamic_display_id(DEVICE_SERIAL, resolution, dpi)
            if display_id is not None:
                cmd.append(f'--display-id={display_id}')
                reset_needed = True
            else:
                print("  Warning: Failed to create dynamic display for Default mode. Using primary display.")
                reset_needed = False
        else:
             print("  Resolution/DPI not provided for Default mode. Using primary display.")
             reset_needed = False

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
        files_to_update = ["requirements.txt", "index.html", "server.py", "server.ps1"]

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
             # Return 200 even if partial, as some files might have updated
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

@app.route('/rotate-screen', methods=['POST'])
def rotate_screen():
    global DEVICE_SERIAL, rotation_states
    if not DEVICE_SERIAL:
        log.warning("No device is currently selected for rotation.")
        return jsonify({'success': False, 'message': 'No device is currently selected.'}), 400

    try:
        # Initialize state for this device if not already stored
        if DEVICE_SERIAL not in rotation_states:
            rotation_states[DEVICE_SERIAL] = {'user_rotation': None, 'accelerometer_rotation': None}

        # Get current rotation (user_rotation)
        current_rotation_result = run_adb_command(
            ['shell', 'settings', 'get', 'system', 'user_rotation'],
            serial=DEVICE_SERIAL,
            timeout=5
        )
        current_rotation = int(current_rotation_result.stdout.strip()) if current_rotation_result.stdout.strip().isdigit() else 0

        # Get current auto-rotation setting (accelerometer_rotation)
        auto_rotation_result = run_adb_command(
            ['shell', 'settings', 'get', 'system', 'accelerometer_rotation'],
            serial=DEVICE_SERIAL,
            timeout=5
        )
        auto_rotation = int(auto_rotation_result.stdout.strip()) if auto_rotation_result.stdout.strip().isdigit() else 0

        # Store initial states if not already stored
        if rotation_states[DEVICE_SERIAL]['user_rotation'] is None:
            rotation_states[DEVICE_SERIAL]['user_rotation'] = current_rotation
            log.info(f"Stored initial user_rotation for {DEVICE_SERIAL}: {current_rotation}")
        if rotation_states[DEVICE_SERIAL]['accelerometer_rotation'] is None:
            rotation_states[DEVICE_SERIAL]['accelerometer_rotation'] = auto_rotation
            log.info(f"Stored initial accelerometer_rotation for {DEVICE_SERIAL}: {auto_rotation}")

        # Disable auto-rotation
        run_adb_command(
            ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'],
            serial=DEVICE_SERIAL,
            check=True,
            timeout=5
        )
        log.info(f"Disabled auto-rotation for {DEVICE_SERIAL}")

        # Calculate next rotation (90 degrees clockwise)
        next_rotation = (current_rotation + 1) % 4  # Cycles through 0, 1, 2, 3

        # Set new rotation
        run_adb_command(
            ['shell', 'settings', 'put', 'system', 'user_rotation', str(next_rotation)],
            serial=DEVICE_SERIAL,
            check=True,
            timeout=5
        )
        log.info(f"Rotated screen for {DEVICE_SERIAL} to user_rotation={next_rotation}")

        return jsonify({
            'success': True,
            'message': f'Screen rotated to {next_rotation * 90} degrees.',
            'new_rotation': next_rotation
        })

    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        log.error(f"Failed to rotate screen for {DEVICE_SERIAL}: {e}")
        return jsonify({'success': False, 'message': f'Failed to rotate screen: {str(e)}'}), 500
    except Exception as e:
        log.critical(f"Unexpected error during screen rotation: {e}", exc_info=True)
        return jsonify({'success': False, 'message': f'Unexpected error: {str(e)}'}), 500

@app.route('/reset-rotation', methods=['POST'])
def reset_rotation():
    global DEVICE_SERIAL, rotation_states
    if not DEVICE_SERIAL:
        log.warning("No device is currently selected for rotation reset.")
        return jsonify({'success': False, 'message': 'No device is currently selected.'}), 400

    try:
        # Check if we have stored states for this device
        if DEVICE_SERIAL not in rotation_states or rotation_states[DEVICE_SERIAL]['user_rotation'] is None:
            log.info(f"No stored rotation state for {DEVICE_SERIAL}. Setting default values.")
            rotation_states[DEVICE_SERIAL] = {'user_rotation': 0, 'accelerometer_rotation': 0}

        # Reset user_rotation to 0
        run_adb_command(
            ['shell', 'settings', 'put', 'system', 'user_rotation', '0'],
            serial=DEVICE_SERIAL,
            check=True,
            timeout=5
        )
        log.info(f"Reset user_rotation to 0 for {DEVICE_SERIAL}")

        # Restore original accelerometer_rotation
        original_auto_rotation = rotation_states[DEVICE_SERIAL]['accelerometer_rotation']
        run_adb_command(
            ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', str(original_auto_rotation)],
            serial=DEVICE_SERIAL,
            check=True,
            timeout=5
        )
        log.info(f"Restored accelerometer_rotation to {original_auto_rotation} for {DEVICE_SERIAL}")

        # Clear stored states
        rotation_states.pop(DEVICE_SERIAL, None)
        log.info(f"Cleared stored rotation states for {DEVICE_SERIAL}")

        return jsonify({
            'success': True,
            'message': 'Screen rotation and auto-rotation settings restored.'
        })

    except (subprocess.CalledProcessError, TimeoutError, FileNotFoundError) as e:
        log.error(f"Failed to reset rotation for {DEVICE_SERIAL}: {e}")
        return jsonify({'success': False, 'message': f'Failed to reset rotation: {str(e)}'}), 500
    except Exception as e:
        log.critical(f"Unexpected error during rotation reset: {e}", exc_info=True)
        return jsonify({'success': False, 'message': f'Unexpected error: {str(e)}'}), 500
        
if __name__ == '__main__':
    print(f"Using ADB: {shutil.which(ADB_PATH) or 'Not found in PATH'}")
    print(f"Using Scrcpy: {shutil.which(SCRCPY_PATH) or 'Not found in PATH'}")
    if not shutil.which(ADB_PATH) or not shutil.which(SCRCPY_PATH):
         print("\n*** WARNING: adb or scrcpy not found in PATH. Functionality will be limited. ***\n")
    print(f"Server running on http://localhost:{PORT}/")
    app.run(host='0.0.0.0', port=PORT, debug=False)