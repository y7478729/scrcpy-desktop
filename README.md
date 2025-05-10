<div align="center">

# Scrcpy Desktop

[![](https://img.shields.io/travis/your_username/scrcpy-desktop.svg?style=flat-square)](https://travis-ci.org/your_username/scrcpy-desktop)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/serifpersia/scrcpy-desktop.svg?style=flat-square)](https://github.com/serifpersia/scrcpy-desktop/stargazers)

![442328283-17fda434-b2b0-4cd3-bde5-bb16d69faa28](https://github.com/user-attachments/assets/704efc85-6aab-4ff9-93d7-9086cffdeeba)

</div align="center">


**Scrcpy Desktop** is a user-friendly web application that streams your Android device's screen and audio directly to your browser. It utilizes the powerful `scrcpy` server for efficient screen and audio capture.

## ✅ Prerequisites

Before you begin, ensure you have the following installed and configured:

*   **Node.js**: Version 16 or higher ([Download](https://nodejs.org/)).
*   **ADB (Android Debug Bridge)**: Part of the Android SDK Platform Tools. Ensure it's in your system's PATH ([ADB](https://developer.android.com/tools/releases/platform-tools)).
*   **Android Device**:
---

## 🛠️ Installation

Follow these steps to get Scrcpy Desktop running locally:

1.  **Clone or Download the Repository:**

    You can also download prebuilt release. Just run start script to get started.

    ```bash
	Clone this repository or download the ZIP file. 
    git clone https://github.com/serifpersia/scrcpy-desktop.git
    cd scrcpy-desktop
    ```

3.  **Install Dependencies & Build:**
    ```bash
    npm install
	npm run build
    ```
    Automated run.bat/sh script do a full rebuild. Make sure you chmod +x run.sh before calling it.

## Usage

1.  **Start the Application:**

    ```bash
    npm start
    ```
	Use run.bat/.sh to start automatic install/build/start process or start it manually after npm install & build steps
	If you are using release zip build, just run start.bat/sh (chmod +x on linux before calling the start.sh script)
	These start scripts are automating npm install and start commands(npm install step is using ommit to avoid installing dev npm packages used for build, release build already has javascript files prebuilt)

3.  **Access the Web Interface:**
    *   Open your web browser and navigate to the URL provided in the terminal (`http://localhost:8000`).
    *   Supermium chrome fork might work best if your pc struggles to play video.

4.  **Control Streaming:**
    *   Use the web interface controls to select your desired settings (resolution, bitrate, FPS, audio).
    *   Click the "Start Stream" button.
---

## ⚙️ Configuration

Most scrcpy streaming parameters can be configured directly through the web interface and custom adb commands like screen rotation, wm size and density can be used for modes like native taskbar...

## 🙏 Acknowledgements

*   [scrcpy](https://github.com/Genymobile/scrcpy) - For the core screen mirroring server.
*   [h264-converter](https://github.com/xevojapan/h264-converter) - For in-browser fmp4 muxing.
---


## Legacy

You can checkout earlier commmit or download legacy release to use legacy scrcpy-desktop which uses python and native scrcpy client
Read more about that version in [LEGACY_README](LEGACY_README)

## License
This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.
