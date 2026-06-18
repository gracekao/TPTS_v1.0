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

### Tuning Default Value Load (on first entry)

- When the **TUNING** tab is opened after device connection, the UI auto-runs `iotools` reads from the device.
- Register decode mapping:
  - **MSR 0x610** bits **[0:14]** ➔ **PL1**
  - **MSR 0x610** bits **[32:46]** ➔ **PL2**
  - **MSR 0x601** bits **[0:15]** ➔ **PL4**
- Parsed values are shown in the right-side hint labels and used as the initial tuning defaults.

## Architecture Overview

**Frontend** (`app/`: HTML/JS dashboard with WebSocket communication to Go backend)  
**Backend** (`proxy/tpts_backend.exe`: Go server) + **Tools** (`device_tools/`: ADB stress utilities) + **Logs** (`logs/`: MSR telemetry CSV files)

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
【Decode Display】 ➔ Decode bits [0:14], [32:46], [0:15] as PL1/PL2/PL4
        ↓
【Default Fill】 ➔ Tuning page fills initial PL1/PL2/PL4 defaults from device values
```

**Result**: System is now armed and ready for real-time power tuning & thermal monitoring

## Project Structure

```
TPTS_v1.0/
├── start.bat              # Launcher - runs backend & opens dashboard
├── TPTS.md                # Documentation
├── app/
│   ├── index.html         # Dashboard UI
│   └── main.js            # Frontend logic & WebSocket handler
├── device_tools/
│   ├── iotools
│   └── run_stressapp.sh
├── logs/                  # MSR telemetry CSV logs
└── proxy/
    ├── adb.exe            # Android Debug Bridge
    ├── AdbWinApi.dll
    ├── AdbWinUsbApi.dll
    └── tpts_backend.exe   # Go backend server
```
