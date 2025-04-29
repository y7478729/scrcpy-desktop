# Scrcpy Desktop

[![](https://img.shields.io/travis/your_username/scrcpy-desktop.svg?style=flat-square)](https://travis-ci.org/your_username/scrcpy-desktop) <!-- Replace with your CI badge -->
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT) <!-- Choose appropriate license -->
[![GitHub stars](https://img.shields.io/github/stars/serifpersia/scrcpy-desktop.svg?style=flat-square)](https://github.com/serifpersia/scrcpy-desktop/stargazers)

**Scrcpy Desktop** is a user-friendly web application that streams your Android device's screen and audio directly to your browser. It utilizes the powerful `scrcpy` server for efficient screen and audio capture.

![Scrcpy Desktop Screenshot Placeholder](placeholder.png)
*Replace this with an actual screenshot or GIF of your application!*

## ? Prerequisites

Before you begin, ensure you have the following installed and configured:

*   **Node.js**: Version 16 or higher ([Download](https://nodejs.org/)).
*   **ADB (Android Debug Bridge)**: Part of the Android SDK Platform Tools. Ensure it's in your system's PATH ([ADB](https://developer.android.com/tools/releases/platform-tools)).
*   **Android Device**:
---

## ??? Installation

Follow these steps to get Scrcpy Desktop running locally:

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/serifpersia/scrcpy-desktop.git
    cd scrcpy-desktop
    ```

2.  **Install Dependencies:**
    ```bash
    npm install
    ```
## Usage

1.  **Start the Application:**
    ```bash
    npm start

2.  **Access the Web Interface:**
    *   Open your web browser and navigate to the URL provided in the terminal (usually `http://localhost:3000` or similar).

3.  **Control Streaming:**
    *   Use the web interface controls to select your desired settings (resolution, bitrate, FPS, audio).
    *   Click the "Start Stream" button (or similar).
    *   Enjoy your device's screen and audio in the browser!
---

## ?? Configuration

Most streaming parameters can be configured directly through the web interface:

*   **Resolution:** Adjust the streaming video width and height.
*   **FPS (Frames Per Second):** Control the smoothness of the video.
*   **Bitrate:** Set the video encoding bitrate (higher means better quality but more bandwidth).
*   **Audio:** Toggle audio streaming on or off.
---

## ?? Acknowledgements

*   [scrcpy](https://github.com/Genymobile/scrcpy) - For the core screen mirroring server.
*   [Broadway H.264 Decoder](https://github.com/mbebenita/Broadway) - For in-browser video decoding.
---

## License
This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.