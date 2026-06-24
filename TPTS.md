# TPTS v1.0 - Thermal & Power Tuning System

Thermal & Power Tuning System for Android device thermal management, stress testing, and power optimization.

## Quick Start (Windows)

1. **Run TPTS**: Double-click `start.bat` 
   - Automatically launches backend server and opens dashboard at `http://localhost:8080`

2. **Connect Device**: 
   - Enter device IP in "TPTS CORE LINK" panel
   - Click "Establish ADB Link"
   - Go backend initializes environment, loads `msr.ko`, and queries hardware registers
   - Wait for Tuning tab to display real power limits (15W / 35W / 150W)

3. **Pre-Test Setup**: 
   - Verify device connection status shows `[Connected]` (system ready for tuning & monitoring)

4. **Run Test**: 
   - Set duration and click "Run Automated Stress Test"
   - Monitor real-time metrics (Temperature, Power, Throttle Status)

## Quick Start (Linux)

1. Build Linux backend binary:
        - `cd proxy && GOOS=linux GOARCH=amd64 go build -o tpts_backend_linux_amd64 .`
2. Start dashboard:
        - `chmod +x start.sh && ./start.sh`
3. In dashboard, set device target IP (for example `10.225.75.45:5555`) and click **Establish ADB Link**.

## Quick Start (Android Local Device)

1. Build Android backend binary:
        - `cd proxy && GOOS=android GOARCH=arm64 go build -o tpts_backend_android_arm64 .`
2. Copy whole `TPTS_v1.0` folder to Android filesystem (recommended under `/data/local/tmp/TPTS_v1.0`).
3. Start local backend on Android:
        - `cd /data/local/tmp/TPTS_v1.0 && sh start_android.sh`
4. Open browser on Android and navigate to:
        - `http://127.0.0.1:8080`
        - You can also open `app/index.html` directly; frontend will fallback to `ws://127.0.0.1:8080/ws` automatically.
5. In dashboard target input, enter `local`, then click **Establish ADB Link**.

### Cross-Platform Runtime Rules

- **Windows/Linux host mode**: backend uses ADB to connect and control Android target device.
- **Android local mode**: backend executes local shell commands directly on the same device (no ADB hop).
- UI is the same `app/index.html`; it must be opened through backend server, not by opening file directly.

### Tuning Default Value Load (on first entry)

- When the **TUNING** tab is opened after device connection, the UI auto-runs `iotools` reads from the device.
- Register decode mapping:
  - **MSR 0x610** bits **[0:14]** ➔ **PL1**
  - **MSR 0x610** bits **[32:46]** ➔ **PL2**
        - **MSR 0x601** bits **[12:0]** ➔ **PL4**
- Parsed values are shown in the right-side hint labels and used as the initial tuning defaults.

## Architecture Overview

**Frontend** (`app/`: HTML/JS dashboard with WebSocket communication to Go backend)  
**Backend** (`proxy/main.go`: Go server source; outputs platform binaries) + **Tools** (`device_tools/`: stress/tuning tools) + **Logs** (`logs/`: MSR telemetry CSV files)

### System Flow: Establish ADB Link

```
【Web Click】 ➔ Emit 'connect' signal
        ↓
【Go Backend】 ➔ Execute 'adb connect' (physical network link)
        ↓
【Environment Init】 ➔ Push iotools + Mount msr.ko + Create /dev/cpu/0/msr channel
        ↓
【Hardware Query】 ➔ Read MSR registers (0x610 / 0x601) from device via iotools
        ↓
【Decode Display】 ➔ Decode bits [0:14], [32:46], [12:0] as PL1/PL2/PL4
        ↓
【Default Fill】 ➔ Tuning page fills initial PL1/PL2/PL4 defaults from device values
```

**Result**: System is now armed and ready for real-time power tuning & thermal monitoring

## Project Structure

```
TPTS_v1.0/
├── start.bat              # Launcher - runs backend & opens dashboard
├── start.sh               # Linux launcher
├── start_android.sh       # Android launcher (local mode)
├── TPTS.md                # Documentation
├── app/
│   ├── index.html         # Dashboard UI
│   └── main.js            # Frontend logic & WebSocket handler
├── device_tools/
│   ├── iotools
│   └── run_stressapp.sh
├── logs/                  # MSR telemetry CSV logs
└── proxy/
        ├── main.go            # Cross-platform backend source
        ├── go.mod
        ├── go.sum
    ├── adb.exe            # Android Debug Bridge
    ├── AdbWinApi.dll
    ├── AdbWinUsbApi.dll
        ├── tpts_backend.exe                 # Windows backend
        ├── tpts_backend_linux_amd64         # Linux backend
        └── tpts_backend_android_arm64       # Android backend
```
