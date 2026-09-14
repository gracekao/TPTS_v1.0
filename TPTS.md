# TPTS v1.0 - Technical Documentation

Thermal & Power Tuning System for Android device thermal management, stress testing, and power optimization.

> End-user quick start is in `README.md`.

## Quick Start (Windows, Technical)

1. **Run TPTS**: Double-click `start.bat`.
   - Starts the local backend server and opens the dashboard at `http://localhost:8080`.
   - This starts the dashboard only; it does not yet connect an Android device.

2. **Connect Device**:
   - Enter the device IP in the **Device Connection** panel.
   - Click **Establish ADB Link**.
   - The Go backend prepares `iotools` and the MSR device node.
   - Wait for status `[Connected]`, then open **Thermal Tune** to load the real PL1/PL2/PL4 defaults.

3. **Pre-Test Setup**:
   - Verify device connection status shows `[Connected]` (system ready for tuning & monitoring)

4. **Tune or Test**:
        - Use **Live Monitor** to view real-time temperature, power, fan, and selected thermal-zone metrics.
        - Use **Thermal Tune** to change CPU power limits, select automatic/manual fan control, or select one or more stress workloads.
        - Before a stress test, TPTS closes Chrome and Settings, returns to the Android launcher, and clears background app processes.
        - WebGL Aquarium runs Chrome in fullscreen; system bars are restored when the test completes or is stopped.
        - **WebGL Aquarium** runs in Chrome at 60 FPS with a 1024 × 1024 canvas; choose 1 to 30,000 fish.
        - Click **Start Stress Test** and review Temperature, Power, and Throttle Status for the selected duration.

## Quick Start (Linux, Technical)

1. Build Linux backend binary:
        - `cd proxy && GOOS=linux GOARCH=amd64 go build -o tpts_backend_linux_amd64 .`
2. Start dashboard:
        - `chmod +x start.sh && ./start.sh`
3. In dashboard, set device target IP (for example `10.225.75.45:5555`) and click **Establish ADB Link**.

## Quick Start (Android Local Device, Technical)

1. Build Android backend binary:
        - `cd proxy && GOOS=android GOARCH=arm64 go build -o tpts_backend_android_arm64 .`
2. Copy whole `TPTS_v1.0` folder to Android filesystem (recommended under `/data/local/tmp/TPTS_v1.0`).
3. Start local backend on Android:
        - `cd /data/local/tmp/TPTS_v1.0 && sh start_android.sh`
4. Open browser on Android and navigate to:
        - `http://127.0.0.1:8080`
5. In dashboard target input, enter `local`, then click **Establish ADB Link**.

### Cross-Platform Runtime Rules

- **Windows/Linux host mode**: backend uses ADB to connect and control Android target device.
- **Android local mode**: backend executes local shell commands directly on the same device (no ADB hop).
- **Android local stress tests**: TPTS closes Chrome for a clean workload run, then closes all workload tabs and reopens `http://127.0.0.1:8080` when the test finishes or is stopped.
- UI is the same `app/index.html`; it must be opened through backend server, not by opening file directly.

### Tuning Default Value Load (on first entry)

- When the **Thermal Tune** tab is opened after device connection, the UI auto-runs `iotools` reads from the device.
- Register decode mapping:
  - **MSR 0x610** bits **[0:14]** ➔ **PL1**
  - **MSR 0x610** bits **[32:46]** ➔ **PL2**
        - **MSR 0x601** bits **[12:0]** ➔ **PL4**
- Parsed values are shown beside each input and used as the initial tuning defaults.

### Active Telemetry Sources

TPTS collects the following data from the connected Android device. Live Monitor polls at approximately one-second intervals; the stress script records one sample per second during a stress test.

| Dashboard data | Primary source | Fallback / calculation | Unit | Used by |
| --- | --- | --- | --- | --- |
| Package Power | `/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj` | Delta between samples. If unavailable: MSR `0x611` (package energy status) using energy unit from MSR `0x606`. | mW / W | Package Power card, live power chart, CSV log |
| SoC Temp | Thermal zone whose `type` is `x86_pkg_temp` | `thermal_zone0/temp`, then MSR `0x19C` digital temperature sensor; final safety value is 42 C when no usable source exists. | C | SoC Temp card, temperature chart, CSV log |
| Thermal-zone temperatures | `/sys/class/thermal/thermal_zone*/temp` and matching `type` | None; zones are shown when readable. Raw values above 1000 are converted from millidegrees C for display. | C | Optional thermal-zone cards and temperature chart |
| CPU frequency | `/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq` | None | kHz, displayed as GHz | CPU Freq card and CSV log |
| Fan count and RPM | `ectool pwmgetnumfans` and `ectool pwmgetfanrpm` | `/sys/class/hwmon/hwmon*/fan*_input` | RPM | Fan cards and CSV log |
| PL1 / PL2 | MSR `0x610` | Bits `[0:14]` for PL1 and `[32:46]` for PL2; each raw unit is 0.125 W. | W | Thermal Tune defaults and applied-limit display |
| PL4 | MSR `0x601` | Bits `[12:0]`; each raw unit is 0.125 W. | W | Thermal Tune defaults and applied-limit display |
| Thermal / PROCHOT / power-limit flags | MSR `0x19C` | Bit 0: thermal status, bit 2: PROCHOT, bit 10: power-limit status. | Boolean | Status lamps |
| Raw tuning registers | MSR `0x610`, `0x64F`, `0x6B0`, `0x19C` | No fallback beyond zero placeholder when a read fails. | Hexadecimal | System Log and stress CSV |

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
