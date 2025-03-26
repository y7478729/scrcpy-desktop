# scrcpy-desktop
<div align="center">

  ![image](https://github.com/user-attachments/assets/b459af96-a3ec-4029-b446-73d1f42aa7e1)

</div>


## User-Friendly Scrcpy Frontend For Desktop

A simple and intuitive frontend for setting up and using Scrcpy on your desktop to mirror and control Android devices.

### Requirements
- **Windows PC/Laptop**: This tool is currently Windows-only (Linux support may be added in the future - WIP).
- **Android Device**: Android 11+ is recommended to utilize Scrcpy's virtual display feature (available in Scrcpy 3.x).
- **Desktop Launcher**: A desktop launcher like Taskbar installed and configured for desktop mode on your Android device.
- **ADB Debugging**: Enabled on your Android device (activate Developer Options by tapping the build number in "About Phone" or "Software Info" multiple times).

### Installation
1. **Clone or Download the Repository**:
   - Clone this repository or download the ZIP file.
2. **Extract Files**:
   - Extract `index.html` and `server.ps1` into your Scrcpy directory (where Scrcpy is installed).
3. **Enable PowerShell Script Execution**:
   - Open Windows PowerShell and run the following command to allow script execution:
     ```
     Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
     ```
   - Confirm with "Y" when prompted.

### Usage
1. **Run the Server**:
   - Open Windows Terminal or PowerShell.
   - Navigate to your Scrcpy directory and run:
     ```
     .\server.ps1
     ```
   - A local website will be hosted at `localhost:8000`.
2. **Access the Frontend**:
   - Open your browser and go to `localhost:8000`.
3. **Configure and Start**:
   - Adjust Scrcpy desktop parameters as needed in the interface.
   - Press the "Start" button to begin mirroring your Android device.

### License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
