# TPTS v1.0

Thermal & Power Tuning System for Android device thermal management, stress testing, and power optimization.

## Download

1. Open repository page: https://github.com/gracekao/TPTS_v1.0
2. Click `Code` -> `Download ZIP`
3. Extract ZIP

## End User Quick Start

### Windows

1. Double-click `start.bat` — it starts the local dashboard and opens `http://localhost:8080`.
2. Enter the Android target IP (for example, `10.225.75.45:5555`) and click **Establish ADB Link**.
3. When the status changes to `[Connected]`, use **Live Monitor** for real-time temperatures, package power, and fan speed. Select extra metrics only when required.
4. Open **Thermal Tune** to manage:
	- **CPU Power Limits**: PL1, PL2, and PL4. Device values load as the starting defaults; use **Reset to System Default** to restore them.
	- **Fan Control**: leave Automatic selected or switch to Manual and set an RPM per detected fan.
	- **Stress Test**: enter a duration and run the workload while reviewing thermal, power, and throttle status.

### Linux

1. `chmod +x start.sh`
2. `./start.sh`
3. Open `http://localhost:8080`
4. Enter Android target IP and click **Establish ADB Link**

### Android Local Mode

1. Copy this folder to device (recommended: `/data/local/tmp/TPTS_v1.0`)
2. Run `sh start_android.sh`
3. Open `http://127.0.0.1:8080`
4. Target IP field uses `local`

## What Is Included

- Frontend UI (`app/`)
- Device scripts/tools (`device_tools/`)
- Prebuilt backend binaries (`proxy/tpts_backend.exe`, `proxy/tpts_backend_linux_amd64`, `proxy/tpts_backend_android_arm64`)

## Notes

- Log files under `logs/` are not uploaded to repository.
- Go source/module files are not included for end users.

## Technical Documentation

For architecture and register mapping details, see `TPTS.md`.
