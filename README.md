# TPTS v1.0

Thermal & Power Tuning System for Android device thermal management, stress testing, and power optimization.

## Download

1. Open repository page: https://github.com/gracekao/TPTS_v1.0
2. Click `Code` -> `Download ZIP`
3. Extract ZIP

## End User Quick Start

### Windows

1. Double-click `start.bat` — it automatically opens your browser to `http://localhost:8080`
2. Enter the Android target IP and click **Establish ADB Link**
3. Go to the **Thermal Fine Tune** tab to check the current PL1/PL2/PL4 power limits — these control how much power (in watts) the CPU is allowed to use; higher limits mean better performance but more heat (see `TPTS.md` for register-level details)
4. Start a stress test from the **Auto Stress Test** section to run thermal/power testing

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
