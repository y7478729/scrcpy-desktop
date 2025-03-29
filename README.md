<div align="center">

![scrcp-desktop](https://github.com/user-attachments/assets/747cac8e-9635-46d2-bbe1-3d6c04bfeb0a)

</div>

# scrcpy-desktop

**User-Friendly Scrcpy Frontend For Desktop**

A simple and intuitive frontend for setting up and using Scrcpy on your desktop to mirror and control Android devices. This project supports two methods:
- **Primary Method**: Flask-based (Cross-Platform)
- **Legacy Method**: PowerShell-based (Windows Only)

---

## Requirements

### Primary Method (Flask - Cross-Platform)
- **Python 3.9 or newer**: Required for Flask dependencies.
- **Scrcpy 3.x**: Installed and added to your system's PATH. Scrcpy 3.x is required to support virtual display mode for Android 11+ devices.
- **Flask**: Automatically installed in a virtual environment when you run the provided scripts.

### Legacy Method (PowerShell - Windows Only)
- **Windows 10 or newer**: PowerShell must be available.
- **Scrcpy 3.x**: The `server.ps1` and `index.html` files must be placed inside the Scrcpy directory for this method to work or have adb and scrcpy in System Path.

---

## Installation

### Primary Method (Flask - Cross-Platform)
1. **Clone or Download the Repository**:
   - Clone this repository or download the ZIP file.
     ```bash
     git clone https://github.com/serifpersia/scrcpy-desktop.git
     ```
2. **Install Dependencies**:
   - Ensure Python 3.9+ is installed. You can verify by running:

     Windows:
     ```bash
     python --version
     ```
     Linux/MacOS
     ```bash
     python3 --version
     ```
   Installing Scrcpy via Package Managers

   Most Linux distributions provide Scrcpy in their official repositories. Use your distribution's package manager to install it:
   
   Debian/Ubuntu-based distributions:
   sudo apt update
   sudo apt install scrcpy
   
   Fedora:
    ```bash
   sudo dnf install scrcpy
    ```
   Arch Linux/Manjaro:
    ```bash
   sudo pacman -S scrcpy
    ```
   Handling Older Versions of Scrcpy
   If your distribution provides an outdated version of Scrcpy, you can download the latest release from official GitHub repository:
   
   1. Download the latest release tarball:
      Scrcpy Releases: [scrcpy](https://github.com/Genymobile/scrcpy/releases)
       ```bash
       wget <scrcpy_release.tar>
        ```
   2. Extract the tarball:
       ```bash
      tar -xvzf <filename>.tar.gz
       ```
   3. Move the extracted binaries to a directory in your PATH (e.g., /usr/local/bin):
       ```bash
      sudo mv scrcpy /usr/local/bin/
       ```
   4. Verify the installation:
       ```bash
      scrcpy --version
       ```
   Installing Python Virtual Environment Support
   To create and use virtual environments in Python, ensure the venv module is installed:
   
   Debian/Ubuntu-based distributions:
    ```bash
   sudo apt install python3-venv
    ```
   Fedora:
    ```bash
   sudo dnf install python3-virtualenv
    ```
   Arch Linux/Manjaro:
    ```bash
   sudo pacman -S python-virtualenv
    ```

   - Install Scrcpy, and ensure that its added to your system's PATH.
3. **Run the Application**:
   - Use the provided `run.bat` (Windows) or `run.sh` (Linux/macOS) script to start the Flask server. These scripts will automatically create and activate a virtual environment, install Flask, and start the server.
     - On Linux/macOS, make the script executable if needed:
       ```bash
       chmod +x run.sh
       ./run.sh
       ```
### Legacy Method (PowerShell - Windows 10 or newer only)
1. **Extract Files**:
   - Extract `index.html` and `server.ps1` into your Scrcpy directory (where Scrcpy is installed).
2. **Enable PowerShell Script Execution**:
   - Open Windows PowerShell and run the following command to allow script execution:
     ```powershell
     Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
     ```
   - Confirm with "Y" when prompted.

## Usage

### Primary Method (Flask - Cross-Platform)
1. **Run the Server**:
   - Execute the `run.bat` (Windows) or `run.sh` (Linux/macOS) script.
   - The Flask server will host the frontend at `http://<your-ip>:8000`.
2. **Access the Frontend**:
   - Open your browser and navigate to the IP address displayed in the terminal (e.g., `http://127.0.0.1:8000` for local access).
3. **Configure and Start**:
   - Adjust Scrcpy desktop parameters as needed in the interface.
   - Press the "Start" button to begin mirroring your Android device.

### Legacy Method (PowerShell - Windows Only)
1. **Run the Server**:
   - Open Windows Terminal or PowerShell.
   - Navigate to your Scrcpy directory and run:
     ```powershell
     .\server.ps1
     ```
   - A local website will be hosted at `http://localhost:8000`.
2. **Access the Frontend**:
   - Open your browser and go to `http://localhost:8000`.
3. **Configure and Start**:
   - Adjust Scrcpy desktop parameters as needed in the interface.
   - Press the "Start" button to begin mirroring your Android device.

---

## Notes
- **Virtual Display**: Ensure your Android device is running Android 11+ and that Scrcpy 3.x is installed to utilize virtual display mode and audio streaming.
- **Cross-Platform Support**: The Flask-based method ensures compatibility across Windows, Linux, and macOS, making it the recommended approach.
- **Legacy Support**: The PowerShell method is retained for Windows users who prefer not to install Python 3.9+.
- Apps like Taskbar are needed to get desktop like launcher/mode on your android phone if your android system vendor didn't provide implemented desktop mode
- ADB debugging needs to be enabled via developer tools(tapping on build number few times will enable this hidden option in About phone>Software Info section of your Settings app)
- Forced Desktop Mode is required for options Virtual Display and default, for native taskbar option you would need at least android 12 and android 13 to get app drawer on taskbar
- Native taskbar option is recommended if you don't want to mess with force desktop mode and 3rd party launchers for desktop experience

---

## License
This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.
