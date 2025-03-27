scrcpy-desktop

User-Friendly Scrcpy Frontend For Desktop

A simple and intuitive frontend for setting up and using Scrcpy on your desktop to mirror and control Android devices. This project now supports running via Flask (Python 3.9+) for a cross-platform experience or via PowerShell for legacy Windows users.

Requirements

Primary Method (Flask - Cross-Platform)
- Python 3.9 or newer: Required for Flask dependencies.
- Scrcpy 3.x: Installed and added to your system's PATH. Scrcpy 3.x is required to support virtual display mode for Android 11+ devices.
- ADB: Installed and added to your system's PATH for device communication.
- Flask: Automatically installed in a virtual environment when you run the provided scripts.

Legacy Method (PowerShell - Windows Only)
- Windows 10 or newer: PowerShell must be available.
- Scrcpy 3.x: The `server.ps1` and `index.html` files must be placed inside the Scrcpy directory for this method to work.

Installation

Primary Method (Flask - Cross-Platform)
1. Clone or Download the Repository:
   - Clone this repository or download the ZIP file.
2. Install Dependencies:
   - Ensure Python 3.9+ is installed. You can verify by running:
     python --version
   - Install Scrcpy and ADB, and ensure they are added to your system's PATH.
3. Run the Application:
   - Use the provided `run.bat` (Windows) or `run.sh` (Linux/macOS) script to start the Flask server. These scripts will automatically create and activate a virtual environment, install Flask, and start the server.
   - On Linux/macOS, make the script executable if needed:
     chmod +x run.sh
     ./run.sh

Legacy Method (PowerShell - Windows Only)
1. Extract Files:
   - Extract `index.html` and `server.ps1` into your Scrcpy directory (where Scrcpy is installed).
2. Enable PowerShell Script Execution:
   - Open Windows PowerShell and run the following command to allow script execution:
     Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   - Confirm with "Y" when prompted.

Usage

Primary Method (Flask - Cross-Platform)
1. Run the Server:
   - Execute the `run.bat` (Windows) or `run.sh` (Linux/macOS) script.
   - The Flask server will host the frontend at http://<your-ip>:5000.
2. Access the Frontend:
   - Open your browser and navigate to the IP address displayed in the terminal (e.g., http://127.0.0.1:5000 for local access).
3. Configure and Start:
   - Adjust Scrcpy desktop parameters as needed in the interface.
   - Press the "Start" button to begin mirroring your Android device.

Legacy Method (PowerShell - Windows Only)
1. Run the Server:
   - Open Windows Terminal or PowerShell.
   - Navigate to your Scrcpy directory and run:
     .\server.ps1
   - A local website will be hosted at http://localhost:8000.
2. Access the Frontend:
   - Open your browser and go to http://localhost:8000.
3. Configure and Start:
   - Adjust Scrcpy desktop parameters as needed in the interface.
   - Press the "Start" button to begin mirroring your Android device.

Notes
- Virtual Display: Ensure your Android device is running Android 11+ and that Scrcpy 3.x is installed to utilize virtual display mode and audio streaming.
- Cross-Platform Support: The Flask-based method ensures compatibility across Windows, Linux, and macOS, making it the recommended approach.
- Legacy Support: The PowerShell method is retained for Windows users who prefer not to install Python 3.9+.

License
This project is licensed under the MIT License - see the LICENSE file for details.