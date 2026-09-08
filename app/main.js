// =====================================================================
// TPTS WEB FRONTEND CORE - HIGH CONTRAST PRODUCTION (v14.5 - SYSFS MASTER)
// =====================================================================
const wsHost = window.location.host || '127.0.0.1:8080';
const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const socket = new WebSocket(`${wsProtocol}://${wsHost}/ws`);
const isAndroidRuntime = /Android/i.test(navigator.userAgent || '');
const isFileMode = window.location.protocol === 'file:';
const shouldAutoLocalMode = isAndroidRuntime || isFileMode;
let hasAutoConnectedLocal = false;

let isDeviceConnected = false;
let isPipelineRunning = false; 
let monitorTimer = null;   
let pipelineCountdownTimer = null;
let pipelineCountdownRemaining = 0;
let wasMonitoringBeforePipeline = false; 
let hasSyncedTuningDefaults = false;
const tuningDefaults = { pl1: null, pl2: null, pl4: null };
let tuningSyncInProgress = false;
let tuningSyncBuffer = '';
let tuningSyncRetries = 0;
let latestPackagePower = null;
let namedRaplActive = false;
let detectedFanCount = 0;
let detectedFanRpms = [];
let detectedFanDuty = [];
const fanDutyUserEdited = new Set();
let fanControlRenderedCount = -1;
let fanReadbackActive = false;
// Fan-noise reproduction capture state
let latestSocTemp = null;
let latestTsr1Temp = null;
let latestEctoolTsr1Temp = null;
let ectoolTsr1SensorName = '';
let latestTcc = 0;
let latestProchot = 0;
let latestIaPower = null;
let latestGtPower = null;
// uncore energy counter updates slower than the 1s in-sample window, so GT is derived across samples
let lastUncoreEnergyUj = null;
let lastUncoreSampleMs = 0;
let latestFanTemps = '';
let reproTempsCollecting = false;
let reproTempsBuffer = '';
let reproActive = false;
let reproRows = [];
let reproStartMs = 0;
let reproTimer = null;
let reproDurationSec = 120;
let telemetrySampler = null;
// Cards sample continuously after connect; curves only draw when charting is on (Start Monitoring button).
let chartingActive = false;

// 🌊【移動平均快取】：供 Canvas 繪圖平滑化使用
const filterWindow = [];
const WINDOW_SIZE = 4; 
const SAMPLE_INTERVAL_SECONDS = 1;
const HISTORY_SECONDS = 60;

function normalizeTarget(value) {
    const raw = (value || '').trim();
    const lowered = raw.toLowerCase();
    if (!raw) return '';
    if (lowered === 'local' || lowered === 'localhost' || lowered === '127.0.0.1' || lowered === 'android' || lowered === 'device') {
        return 'local';
    }
    return raw.includes(':') ? raw : `${raw}:5555`;
}

function isLocalTarget(target) {
    return target === 'local';
}

function appendConsole(message) {
    const consoleBox = document.getElementById('console');
    if (!consoleBox) return;
    consoleBox.innerText += `${message}\n`;
    consoleBox.scrollTop = consoleBox.scrollHeight;
}

function copyLog(btn) {
    const consoleBox = document.getElementById('console');
    if (!consoleBox) return;
    const text = consoleBox.innerText;
    const showDone = () => {
        if (!btn) return;
        const original = btn.innerText;
        btn.innerText = '✔ 已複製';
        setTimeout(() => { btn.innerText = original; }, 1200);
    };
    const fallbackCopy = () => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(textarea);
        showDone();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(showDone).catch(fallbackCopy);
    } else {
        fallbackCopy();
    }
}

function switchPage(pageName) {
    document.querySelectorAll('.page').forEach((page) => page.classList.remove('active'));
    document.querySelectorAll('.page-nav-button').forEach((button) => {
        button.classList.toggle('active', button.dataset.page === pageName);
    });
    const page = document.getElementById(`page-${pageName}`);
    if (page) page.classList.add('active');

    if (pageName === 'dashboard') {
        requestAnimationFrame(() => {
            resizeChartCanvas();
            redrawChart();
            resizePowerChartCanvas();
            redrawPowerChart();
        });
    } else if (pageName === 'fine-tune' && isDeviceConnected) {
        clearTuningUserEditedFlags();
        requestTuningDefaults(true);
    }
}

function exportTelemetryLog() {
    if (tempHistory.length === 0 && powerHistory.length === 0) {
        alert('No telemetry data available to export yet.');
        return;
    }
    const rowCount = Math.max(tempHistory.length, powerHistory.length);
    const rows = ['sample,temperature_c,package_power_w'];
    for (let index = 0; index < rowCount; index++) {
        rows.push(`${index + 1},${tempHistory[index] ?? ''},${powerHistory[index] ?? ''}`);
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tpts_telemetry_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}

function startFanRepro() {
    if (!isDeviceConnected) return alert("Connect device first!");
    if (reproActive) { stopFanRepro(true); return; }

    const durEl = document.getElementById('repro-duration');
    reproDurationSec = Math.max(10, parseInt(durEl ? durEl.value : '120', 10) || 120);
    reproRows = [];
    reproStartMs = Date.now();
    reproActive = true;

    if (monitorTimer === null) startLiveTelemetryLoop();

    const btn = document.querySelector('button[onclick="startFanRepro()"]');
    if (btn) { btn.innerText = 'Stop & Export CSV'; btn.style.background = '#ff2670'; btn.style.color = '#fff'; }
    appendConsole(`[Repro] Fan-noise capture started (${reproDurationSec}s).`);

    const target = normalizeTarget(document.getElementById('ip') ? document.getElementById('ip').value : '');
    reproTimer = setInterval(() => {
        const tempsCmd = "su 0 sh -c 'echo RTEMP_BEGIN; ectool temps all 2>&1; echo RTEMP_END'";
        if (isLocalTarget(target)) sendAdb(['shell', tempsCmd]); else sendAdb(['-s', target, 'shell', tempsCmd]);

        const elapsed = Math.round((Date.now() - reproStartMs) / 1000);
        reproRows.push({
            elapsed,
            time: new Date().toISOString(),
            temp: latestSocTemp,
            tsr1: latestTsr1Temp,
            ectoolTsr1: latestEctoolTsr1Temp,
            pkg: latestPackagePower,
            ia: latestIaPower,
            gt: latestGtPower,
            fans: detectedFanRpms.slice(),
            fanCount: detectedFanCount,
            tcc: latestTcc,
            prochot: latestProchot,
            temps: latestFanTemps
        });

        const remain = Math.max(0, reproDurationSec - elapsed);
        if (btn) btn.innerText = `Stop & Export CSV (${remain}s)`;
        if (elapsed >= reproDurationSec) stopFanRepro(true);
    }, 1000);
}

function stopFanRepro(doExport) {
    if (reproTimer) { clearInterval(reproTimer); reproTimer = null; }
    reproActive = false;
    const btn = document.querySelector('button[onclick="startFanRepro()"]');
    if (btn) { btn.innerText = 'Start Fan Noise Capture'; btn.style.background = ''; btn.style.color = ''; }
    if (doExport && reproRows.length) exportFanReproCsv(reproRows);
    appendConsole(`[Repro] Capture stopped. Rows: ${reproRows.length}`);
}

function exportFanReproCsv(rows) {
    const maxFans = rows.reduce((m, r) => Math.max(m, r.fanCount || (r.fans ? r.fans.length : 0)), 0) || 1;
    const fanCols = Array.from({ length: maxFans }, (_, i) => `fan${i}_rpm`);
    const header = ['elapsed_s', 'timestamp', 'soc_temp_c', 'tsr1_sysfs_temp_c', 'tsr1_ectool_debug_temp_c', 'package_power_w', 'ia_power_w', 'gt_power_w', ...fanCols, 'tcc', 'prochot', 'ectool_temps'];
    const lines = [header.join(',')];
    for (const r of rows) {
        const fanVals = Array.from({ length: maxFans }, (_, i) => (r.fans && r.fans[i] != null) ? r.fans[i] : '');
        const cells = [
            r.elapsed, r.time,
            r.temp ?? '', r.tsr1 ?? '', r.ectoolTsr1 ?? '', r.pkg ?? '', r.ia ?? '', r.gt ?? '',
            ...fanVals, r.tcc, r.prochot,
            `"${(r.temps || '').replace(/"/g, "'")}"`
        ];
        lines.push(cells.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tpts_fan_repro_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}

function renderFanSpeeds() {
    const fanEl = document.getElementById('v-fan');
    if (!fanEl) return;
    if (detectedFanCount <= 0) {
        fanEl.innerText = 'No Fan';
        fanEl.title = '';
        return;
    }
    const fanRpms = Array.from({ length: detectedFanCount }, (_, index) => detectedFanRpms[index] ?? null);
    fanEl.innerText = `${fanRpms.map((rpm, index) => `F${index + 1} ${rpm ?? '--'}`).join(' / ')} RPM`;
    fanEl.title = fanRpms.map((rpm, index) => `Fan ${index}: ${rpm ?? '--'} RPM`).join('\n');
    syncFanControlInputs();
}

function preparePureWebMode() {
    if (!shouldAutoLocalMode) return;

    const ipEl = document.getElementById('ip');
    if (ipEl && !ipEl.value.trim()) {
        ipEl.value = 'local';
    } else if (ipEl) {
        ipEl.value = 'local';
    }

    const statusEl = document.getElementById('link-status');
    if (statusEl && !isDeviceConnected) {
        statusEl.innerText = '[Auto Local]';
        statusEl.style.color = '#ffaa00';
    }

    appendConsole('[TPTS] Pure web mode detected. Target set to local.');
}

function tryAutoConnectLocal() {
    if (!shouldAutoLocalMode || hasAutoConnectedLocal || isDeviceConnected) return;
    hasAutoConnectedLocal = true;

    const ipEl = document.getElementById('ip');
    if (ipEl) ipEl.value = 'local';
    appendConsole('[TPTS] Attempting automatic local connection...');
    connectDevice();
}

function decodeAndRenderPLFrom610(hex610) {
    if (!hex610 || !hex610.startsWith('0x')) return;
    let hexStr = hex610.substring(2).padStart(16, '0');
    let low32 = hexStr.substring(8);
    let high32 = hexStr.substring(0, 8);

    let pl1_raw = parseInt(low32, 16) & 0x7FFF;      // bit 0:14
    let pl2_raw = parseInt(high32, 16) & 0x7FFF;     // bit 32:46
    let pl1_watts = pl1_raw * 0.125;
    let pl2_watts = pl2_raw * 0.125;

    const pl1El = document.getElementById('v-pl1');
    const pl2El = document.getElementById('v-pl2');
    const v610 = document.getElementById('v610');
    const pl1Text = formatPowerWatts(pl1_watts);
    const pl2Text = formatPowerWatts(pl2_watts);
    if (pl1El) pl1El.innerText = `${pl1Text} W`;
    if (pl2El) pl2El.innerText = `${pl2Text} W`;
    if (v610) v610.innerText = hex610;

    const dashboard610 = document.getElementById('dashboard-v610');
    const dashboardPl1 = document.getElementById('dashboard-pl1');
    const dashboardPl2 = document.getElementById('dashboard-pl2');
    if (dashboard610) dashboard610.value = hex610;
    if (dashboardPl1) dashboardPl1.innerText = `${pl1Text} W`;
    if (dashboardPl2) dashboardPl2.innerText = `${pl2Text} W`;

    setTuningFieldDefault('tune-pl1', pl1_watts);
    setTuningFieldDefault('tune-pl2', pl2_watts);
    tuningDefaults.pl1 = pl1_watts;
    tuningDefaults.pl2 = pl2_watts;
    tryFinishTuningDefaultsSync();
}

function decodeAndRenderPL4From601(hex601) {
    if (!hex601 || !hex601.startsWith('0x')) return;
    let pl4_raw = parseInt(hex601, 16) & 0x1FFF;     // bit 0:12
    let pl4_watts = pl4_raw * 0.125;

    const pl4El = document.getElementById('v-pl4');
    const pl4Text = formatPowerWatts(pl4_watts);
    if (pl4El) pl4El.innerText = `${pl4Text} W`;

    setTuningFieldDefault('tune-pl4', pl4_watts);
    tuningDefaults.pl4 = pl4_watts;
    tryFinishTuningDefaultsSync();
}

function decodeAndRenderPowerFrom64F(hex64F) {
    if (!hex64F || !hex64F.startsWith('0x')) return null;
    
    let hexStr = hex64F.substring(2).padStart(16, '0');
    let low32 = hexStr.substring(8);
    let powerRaw = parseInt(low32, 16) & 0xFFFF;
    let powerWatts = powerRaw * 0.125;
    
    const powerEl = document.getElementById('v-power');
    if (powerEl) {
        const powerText = powerWatts < 10 ? powerWatts.toFixed(2) : Math.round(powerWatts);
        powerEl.innerText = `${powerText} W`;
    }
    
    return powerWatts;
}

function sendAdb(args) {
    if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'exec', args: args }));
    } else {
        const consoleBox = document.getElementById('console');
        if (consoleBox) consoleBox.innerHTML += `\n❌ [Error] WebSocket disconnected!\n`;
    }
}

function formatPowerWatts(value) {
    const rounded = Math.round(value * 1000) / 1000;
    return Number.isInteger(rounded) ? `${rounded}` : `${rounded}`;
}

function formatTemperatureCelsius(value) {
    const num = Number(value);
    if (Number.isNaN(num)) return "0.0";
    return num.toFixed(1);
}

function normalizeHex(value) {
    if (!value) return null;
    const cleaned = `${value}`.trim().replace(/\s+/g, '');
    if (!cleaned) return null;
    if (/^0x[0-9a-fA-F]+$/.test(cleaned)) return cleaned;
    if (/^[0-9a-fA-F]+$/.test(cleaned)) return `0x${cleaned}`;
    return null;
}

function setTuningFieldDefault(fieldId, watts) {
    const inputEl = document.getElementById(fieldId);
    if (!inputEl || inputEl.dataset.userEdited === "1") return;
    inputEl.value = formatPowerWatts(watts);
}

function tryFinishTuningDefaultsSync() {
    if (tuningDefaults.pl1 === null || tuningDefaults.pl2 === null || tuningDefaults.pl4 === null) return;
    hasSyncedTuningDefaults = true;
}

function requestTuningDefaults(force = false) {
    if (!isDeviceConnected) return;
    if (!force && hasSyncedTuningDefaults) return;
    const ipInput = document.getElementById('ip');
    if (!ipInput) return;
    const target = normalizeTarget(ipInput.value);
    if (!target) return;
    const command = "su 0 sh -c 'v610=$(/data/local/tmp/iotools rdmsr 0 0x610 2>/dev/null); [ -z \"$v610\" ] && v610=$(/data/local/tmp/iotools rdmsr 0x610 2>/dev/null); v601=$(/data/local/tmp/iotools rdmsr 0 0x601 2>/dev/null); [ -z \"$v601\" ] && v601=$(/data/local/tmp/iotools rdmsr 0x601 2>/dev/null); echo TPTS_TUNING_SYNC_BEGIN; echo MSR_610: ${v610:-NA}; echo MSR_601: ${v601:-NA}; echo TPTS_TUNING_SYNC_END'";
    if (isLocalTarget(target)) {
        sendAdb(['shell', command]);
    } else {
        sendAdb(['-s', target, 'shell', command]);
    }
}

function clearTuningUserEditedFlags() {
    ['tune-pl1', 'tune-pl2', 'tune-pl4'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) delete el.dataset.userEdited;
    });
}

function resetTuningDefaultSyncState() {
    hasSyncedTuningDefaults = false;
    tuningSyncRetries = 0;
    tuningDefaults.pl1 = null;
    tuningDefaults.pl2 = null;
    tuningDefaults.pl4 = null;
    ['tune-pl1', 'tune-pl2', 'tune-pl4'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) delete el.dataset.userEdited;
    });
}

function switchTab(tabName) {
    if (isPipelineRunning) return; 
    if (tabName === 'tuning' && !isDeviceConnected) {
        appendConsole('[TPTS] Please connect the device first.');
        alert('Please connect the device first.');
        return;
    }
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const indexMap = { 'monitor': 0, 'tuning': 1, 'satlab': 2 };
    if (document.querySelectorAll('.tab-btn')[indexMap[tabName]]) {
        document.querySelectorAll('.tab-btn')[indexMap[tabName]].classList.add('active');
    }
    const tabEl = document.getElementById(`tab-${tabName}`);
    if (tabEl) tabEl.classList.add('active');
    if (tabName === 'tuning') {
        clearTuningUserEditedFlags();
        requestTuningDefaults(true);
        // Retry once shortly after switching to absorb delayed adb/shell output.
        setTimeout(() => {
            if (!hasSyncedTuningDefaults) requestTuningDefaults(true);
        }, 450);
    }
}

function renderFanControlInputs() {
    const container = document.getElementById('fan-rpm-rows');
    if (!container) return;
    const modeEl = document.getElementById('tune-fan-mode');
    const isManual = modeEl && modeEl.value === 'manual';
    const count = detectedFanCount > 0 ? detectedFanCount : 1;

    const existing = {};
    container.querySelectorAll('input[data-fan-idx]').forEach((el) => { existing[el.dataset.fanIdx] = el.value; });

    container.innerHTML = '';
    for (let index = 0; index < count; index++) {
        const group = document.createElement('div');
        group.className = 'form-group';
        const label = document.createElement('label');
        label.textContent = `F${index + 1} RPM`;
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '100';
        input.dataset.fanIdx = String(index);
        const detectedRpm = detectedFanRpms[index];
        input.value = fanDutyUserEdited.has(index)
            ? (existing[index] ?? 3000)
            : (detectedRpm != null ? detectedRpm : (existing[index] ?? 3000));
        input.disabled = !isManual;
        input.addEventListener('input', () => fanDutyUserEdited.add(index));
        group.appendChild(label);
        group.appendChild(input);
        container.appendChild(group);
    }
    container.style.opacity = isManual ? '1.0' : '0.4';

    const hintEl = document.getElementById('fan-count-hint');
    if (hintEl) hintEl.innerText = detectedFanCount > 0 ? `${detectedFanCount} fans` : '-- fans';
}

function syncFanControlInputs() {
    if (detectedFanCount === fanControlRenderedCount) return;
    fanControlRenderedCount = detectedFanCount;
    renderFanControlInputs();
}

function requestFanInventory(target) {
    const resolved = normalizeTarget(target || (document.getElementById('ip') ? document.getElementById('ip').value : ''));
    if (!resolved) return;
    const cmd = "su 0 sh -c 'echo TPTS_FAN_BEGIN; ectool pwmgetnumfans 2>&1; ectool pwmgetfanrpm 2>&1; echo TPTS_FAN_END'";
    if (isLocalTarget(resolved)) {
        sendAdb(['shell', cmd]);
    } else {
        sendAdb(['-s', resolved, 'shell', cmd]);
    }
}

function toggleFanInput() {
    renderFanControlInputs();
}

function connectDevice() {
    let ipEl = document.getElementById('ip');
    if (!ipEl) return;
    const ip = normalizeTarget(ipEl.value);
    if (!ip) return alert("Please enter IP or local");
    ipEl.value = ip;
    
    const consoleBox = document.getElementById('console');
    consoleBox.innerText = `[TPTS] [1/2] Resetting ADB interface. Disconnecting ${ip}...\n`;
    
    if (isLocalTarget(ip)) {
        sendAdb(['disconnect', ip]);
    } else {
        sendAdb(['disconnect', ip]);
    }

    setTimeout(() => {
        consoleBox.innerText += `[TPTS] [2/2] Re-establishing fresh connection link to ${ip}...\n`;
        if (isLocalTarget(ip)) {
            sendAdb(['LOCAL_CONNECT']);
        } else {
            sendAdb(['connect', ip]);
        }
    }, 300);
}

function applyPowerLimits() {
    if (!isDeviceConnected) return alert("Connect device first!");

    const target = normalizeTarget(document.getElementById('ip') ? document.getElementById('ip').value : '');
    const pl1Input = document.getElementById('tune-pl1');
    const pl2Input = document.getElementById('tune-pl2');
    const pl4Input = document.getElementById('tune-pl4');

    if (!target || !pl1Input || !pl2Input || !pl4Input) return;

    const pl1 = parseFloat(pl1Input.value);
    const pl2 = parseFloat(pl2Input.value);
    const pl4 = parseFloat(pl4Input.value);

    if ([pl1, pl2, pl4].some((v) => Number.isNaN(v) || v <= 0)) {
        alert("PL1/PL2/PL4 must be positive numbers.");
        return;
    }

    const pl1Raw = Math.round(pl1 / 0.125) & 0x7FFF;
    const pl2Raw = Math.round(pl2 / 0.125) & 0x7FFF;
    const pl4Raw = Math.round(pl4 / 0.125) & 0x1FFF;

    const v610El = document.getElementById('v610');
    const base610Text = v610El ? v610El.innerText.trim() : '';
    if (!/^0x[0-9a-fA-F]+$/.test(base610Text)) {
        alert("Cannot read current MSR 0x610. Open Tuning tab after connection to sync defaults first.");
        return;
    }

    const base610 = BigInt(base610Text);
    const pl1Mask = 0x7FFFn;          // 0x610[14:0]
    const pl2Mask = 0x7FFFn << 32n;   // 0x610[46:32]
    const msr610Value = (base610 & ~pl1Mask & ~pl2Mask)
        | (BigInt(pl1Raw) & 0x7FFFn)
        | ((BigInt(pl2Raw) & 0x7FFFn) << 32n);

    const msr610 = msr610Value.toString(16);
    const msr601 = (BigInt(pl4Raw) & 0x1FFFn).toString(16);

    const cmd = `su 0 /data/local/tmp/iotools wrmsr 0 0x610 0x${msr610}; su 0 /data/local/tmp/iotools wrmsr 0 0x601 0x${msr601}; su 0 /data/local/tmp/iotools rdmsr 0 0x610; su 0 /data/local/tmp/iotools rdmsr 0 0x601`;

    if (isLocalTarget(target)) {
        sendAdb(['shell', cmd]);
    } else {
        sendAdb(['-s', target, 'shell', cmd]);
    }

    const consoleBox = document.getElementById('console');
    if (consoleBox) {
        consoleBox.innerText += `[Tuning] Applied PL limits: PL1=${pl1}W, PL2=${pl2}W, PL4=${pl4}W\n`;
        consoleBox.scrollTop = consoleBox.scrollHeight;
    }

    const pl1El = document.getElementById('v-pl1');
    const pl2El = document.getElementById('v-pl2');
    const pl4El = document.getElementById('v-pl4');
    if (pl1El) pl1El.innerText = `${formatPowerWatts(pl1)} W`;
    if (pl2El) pl2El.innerText = `${formatPowerWatts(pl2)} W`;
    if (pl4El) pl4El.innerText = `${formatPowerWatts(pl4)} W`;
}

function applyFanSettings() {
    if (!isDeviceConnected) return alert("Connect device first!");

    const target = normalizeTarget(document.getElementById('ip') ? document.getElementById('ip').value : '');
    const modeEl = document.getElementById('tune-fan-mode');
    const consoleBox = document.getElementById('console');
    if (!target || !modeEl) return;

    const mode = modeEl.value;
    let cmd = '';
    let summary = '';

    if (mode === 'manual') {
        const inputs = [...document.querySelectorAll('#fan-rpm-rows input[data-fan-idx]')];
        if (inputs.length === 0) {
            alert("No fan detected. Connect device or start monitoring first.");
            return;
        }
        const commands = [];
        const parts = [];
        for (const input of inputs) {
            const rpm = parseInt(input.value, 10);
            if (Number.isNaN(rpm) || rpm < 0) {
                alert("Fan RPM must be a non-negative number.");
                return;
            }
            const idx = input.dataset.fanIdx;
            commands.push(`ectool pwmsetfanrpm ${rpm} ${idx}`);
            parts.push(`F${Number(idx) + 1}=${rpm}`);
        }
        cmd = `su 0 sh -c '${commands.join('; ')}; echo FAN_SET_DONE'`;
        summary = `manual ${parts.join(' / ')} RPM`;
    } else {
        cmd = "su 0 sh -c 'ectool autofanctrl; echo FAN_SET_DONE'";
        summary = 'auto (autofanctrl)';
    }

    const sendShell = (command) => {
        if (isLocalTarget(target)) {
            sendAdb(['shell', command]);
        } else {
            sendAdb(['-s', target, 'shell', command]);
        }
    };

    sendShell(cmd);

    if (consoleBox) {
        consoleBox.innerText += `[Tuning] Fan policy applied: ${summary}\n`;
        consoleBox.innerText += `[Tuning] CMD: ${cmd}\n`;
        consoleBox.scrollTop = consoleBox.scrollHeight;
    }

    // Fan needs ~1-2s to spin up to the target; read back after a delay so RPM isn't reported as 0.
    appendConsole('[Tuning] Reading fan RPM back in 2s (spin-up)...');
    setTimeout(() => {
        sendShell("su 0 sh -c 'echo TPTS_FAN_BEGIN; ectool pwmgetfanrpm 2>&1; ectool temps all 2>&1; echo TPTS_FAN_END'");
    }, 2000);
}

function renderPipelineCountdown() {
    const countdownEl = document.getElementById('pipeline-countdown');
    if (!countdownEl) return;
    if (pipelineCountdownRemaining <= 0) {
        countdownEl.innerText = 'Countdown: --';
        countdownEl.style.color = '#8a8a9e';
        return;
    }
    countdownEl.innerText = `Countdown: ${pipelineCountdownRemaining}s`;
    countdownEl.style.color = '#00ffcc';
}

function startPipelineCountdown(seconds) {
    if (pipelineCountdownTimer) {
        clearInterval(pipelineCountdownTimer);
        pipelineCountdownTimer = null;
    }

    pipelineCountdownRemaining = Math.max(0, parseInt(seconds, 10) || 0);
    renderPipelineCountdown();
    if (pipelineCountdownRemaining <= 0) return;

    pipelineCountdownTimer = setInterval(() => {
        pipelineCountdownRemaining -= 1;
        if (pipelineCountdownRemaining <= 0) {
            pipelineCountdownRemaining = 0;
            renderPipelineCountdown();
            clearInterval(pipelineCountdownTimer);
            pipelineCountdownTimer = null;
            return;
        }
        renderPipelineCountdown();
    }, 1000);
}

function stopPipelineCountdown() {
    if (pipelineCountdownTimer) {
        clearInterval(pipelineCountdownTimer);
        pipelineCountdownTimer = null;
    }
    pipelineCountdownRemaining = 0;
    renderPipelineCountdown();
}

function lockGlobalUiForPipeline() {
    isPipelineRunning = true;
    document.querySelectorAll('button').forEach(btn => {
        btn.disabled = true; btn.style.opacity = "0.4"; btn.style.cursor = "not-allowed";
    });
    document.querySelectorAll('input, select').forEach(el => { el.disabled = true; el.style.opacity = "0.4"; });

    const runBtn = document.querySelector('button[onclick="startThermalPipeline()"]');
    if (runBtn) {
        runBtn.disabled = false; runBtn.style.opacity = "1.0"; runBtn.style.cursor = "pointer";
        runBtn.innerText = "Stop Stress Test";
        runBtn.style.background = "#ff4444"; runBtn.style.color = "#ffffff";
    }
}

function renderMonitorButton(isRunning) {
    const monitorBtn = document.querySelector('.btn-secondary');
    if (!monitorBtn) return;
    monitorBtn.innerText = isRunning ? "Stop Monitoring" : "Start Monitoring";
    monitorBtn.style.background = isRunning ? "#ff2670" : "#53618f";
    monitorBtn.style.color = "#ffffff";
}

function restoreAllUiToIdle() {
    isPipelineRunning = false; 
    stopPipelineCountdown();

    document.querySelectorAll('button, input, select').forEach(el => {
        el.disabled = false; el.style.opacity = "1.0"; el.style.cursor = "pointer";
    });

    const runBtn = document.querySelector('button[onclick="startThermalPipeline()"]');
    if (runBtn) {
        runBtn.innerText = "Start Stress Test";
        runBtn.style.background = "#ff2670"; runBtn.style.color = "#ffffff";
    }

    const monitorBtn = document.querySelector('.btn-secondary');
    if (monitorBtn) {
        // Resume sampling and keep drawing curves after a pipeline.
        wasMonitoringBeforePipeline = false;
        chartingActive = true;
        startLiveTelemetryLoop();
        renderMonitorButton(true);
    }
    toggleFanInput();
}

function startThermalPipeline() {
    if (!isDeviceConnected) return alert("Connect device first!");
    
    if (isPipelineRunning) {
        sendAdb(['STOP_PIPELINE']);
        stopPipelineCountdown();
        restoreAllUiToIdle();
        return;
    }

    if (monitorTimer !== null) {
        wasMonitoringBeforePipeline = true;
        clearInterval(monitorTimer);
        monitorTimer = null; 
    } else {
        wasMonitoringBeforePipeline = false;
    }

    lockGlobalUiForPipeline();
    chartingActive = true;
    tempHistory.length = 0;
    tsr1History.length = 0;
    powerHistory.length = 0;
    iaPowerHistory.length = 0;
    gtPowerHistory.length = 0;
    filterWindow.length = 0;
    drawChartGrid();
    drawPowerChartGrid();
    const durationEl = document.getElementById('duration');
    const sec = durationEl ? durationEl.value : "60";
    startPipelineCountdown(sec);
    
    document.getElementById('console').innerHTML += `\n[TPTS Pipeline] Activating Autopilot Thermal Pipeline...\n`;
    sendAdb(['START_AUTOPILOT_PIPELINE', sec]);
}

function startLiveTelemetry() {
    if (!isDeviceConnected) return alert("Connect device first!");
    if (isPipelineRunning) return; 

    const consoleBox = document.getElementById('console');
    const monitorBtn = document.querySelector('.btn-secondary'); 
    if (!monitorBtn) return;

    if (chartingActive) {
        // Stop drawing curves; cards keep updating.
        chartingActive = false;
        renderMonitorButton(false);
        consoleBox.innerHTML += `[Monitor] ⏸️ 曲線繪製已停止（卡片仍每 1s 更新）\n`;
        consoleBox.scrollTop = consoleBox.scrollHeight;
    } else {
        // Start drawing curves from a clean slate.
        chartingActive = true;
        tempHistory.length = 0;
        tsr1History.length = 0;
        powerHistory.length = 0;
        iaPowerHistory.length = 0;
        gtPowerHistory.length = 0;
        filterWindow.length = 0;
        drawChartGrid();
        drawPowerChartGrid();
        if (monitorTimer === null) startLiveTelemetryLoop();
        renderMonitorButton(true);
        consoleBox.innerHTML += `\n[Monitor] ▶️ Starting live chart rendering...\n`;
        consoleBox.scrollTop = consoleBox.scrollHeight;
    }
}

function startLiveTelemetryLoop() {
    if (monitorTimer) {
        clearInterval(monitorTimer);
    }
    monitorTimer = null; 
    
    tempHistory.length = 0;
    tsr1History.length = 0;
    powerHistory.length = 0;
    iaPowerHistory.length = 0;
    gtPowerHistory.length = 0;
    filterWindow.length = 0;
    lastUncoreEnergyUj = null;
    lastUncoreSampleMs = 0;
    drawChartGrid(); 
    drawPowerChartGrid();

    const ipEl = document.getElementById('ip');
    const target = normalizeTarget(ipEl ? ipEl.value : '');
    if (!target) return;

    const fanCommand = "su 0 sh -c 'ectool pwmgetnumfans 2>/dev/null; ectool pwmgetfanrpm 2>/dev/null'";
    if (isLocalTarget(target)) {
        sendAdb(['shell', fanCommand]);
    } else {
        sendAdb(['-s', target, 'shell', fanCommand]);
    }

    // 🎯【正確鎖定】：100% 走 Linux 核心 sysfs 指令，同時加入 MSR 暫存器轟炸
    telemetrySampler = () => {
        const target = normalizeTarget(document.getElementById('ip') ? document.getElementById('ip').value : '');
        if (!target) return;
        const tsr1Command = "su 0 sh -c 'product=$(getprop ro.product.product.name); config=./vendor/etc/thermal/$product/thermal_info_config.json; [ -f \"$config\" ] || config=/vendor/etc/thermal/$product/thermal_info_config.json; [ -f \"$config\" ] || config=$(find /vendor/etc/thermal -name thermal_info_config.json 2>/dev/null | head -n 1); sensor=$(grep -B 200 -E \"\\\"Combination\\\"[[:space:]]*:[[:space:]]*\\[[[:space:]]*\\\"TSR1\\\"\" \"$config\" 2>/dev/null | grep \"\\\"Name\\\"\" | tail -n 1 | sed -E \"s/.*\\\"Name\\\"[[:space:]]*:[[:space:]]*\\\"([^\\\"]+).*/\\1/\"); [ -n \"$sensor\" ] || sensor=regulator-thermistor; mapped_sensor=$sensor; sensor=${sensor%-METRICS}; echo TPTS_ECTOOL_CONFIG: $config; echo TPTS_ECTOOL_SENSOR_NAME: $mapped_sensor; echo TPTS_ECTOOL_PHYSICAL_SENSOR: $sensor; ectool temps all 2>&1'";
        const sysfsTsr1Command = "su 0 sh -c 'for z in /sys/class/thermal/thermal_zone*; do t=$(cat $z/type 2>/dev/null); if [ \"$t\" = \"TSR1\" ]; then echo TPTS_SYSFS_TSR1: $(cat $z/temp 2>/dev/null); break; fi; done'";
        const namedRaplCommand = "su 0 sh -c 'base=/sys/class/powercap/intel-rapl/intel-rapl:0; pkg=; core=; uncore=; pkg_name=$(cat \"$base/name\" 2>/dev/null); [ \"$pkg_name\" = package-0 ] && pkg=$base; for d in \"$base\"/intel-rapl:0:*; do n=$(cat \"$d/name\" 2>/dev/null); [ \"$n\" = core ] && core=$d; [ \"$n\" = uncore ] && uncore=$d; done; read_energy() { [ -n \"$1\" ] && cat \"$1/energy_uj\" 2>/dev/null; }; p1=$(read_energy \"$pkg\"); i1=$(read_energy \"$core\"); g1=$(read_energy \"$uncore\"); sleep 1; p2=$(read_energy \"$pkg\"); i2=$(read_energy \"$core\"); g2=$(read_energy \"$uncore\"); pm=; im=; gm=; [ -n \"$p1\" ] && [ -n \"$p2\" ] && pm=$(((p2-p1)/1000)); [ -n \"$i1\" ] && [ -n \"$i2\" ] && im=$(((i2-i1)/1000)); [ -n \"$g1\" ] && [ -n \"$g2\" ] && gm=$(((g2-g1)/1000)); echo RAPL_NAMED: PKG_MW=${pm:-NA} IA_MW=${im:-NA} GT_MW=${gm:-NA} PKG_PATH=${pkg:-NA} IA_PATH=${core:-NA} GT_PATH=${uncore:-NA}; echo RAPL_RAW: PKG_NAME=$pkg_name PKG_E1=${p1:-NA} PKG_E2=${p2:-NA} CORE_E1=${i1:-NA} CORE_E2=${i2:-NA} UNCORE_E1=${g1:-NA} UNCORE_E2=${g2:-NA}'";
        if (isLocalTarget(target)) {
            // sendAdb(['shell', tsr1Command]); // ectool temps read disabled for now
            sendAdb(['shell', sysfsTsr1Command]);
            sendAdb(['shell', namedRaplCommand]);
        } else {
            // sendAdb(['-s', target, 'shell', tsr1Command]); // ectool temps read disabled for now
            sendAdb(['-s', target, 'shell', sysfsTsr1Command]);
            sendAdb(['-s', target, 'shell', namedRaplCommand]);
        }
        const megaCommand = `su 0 sh -c 'temp_value=; for z in /sys/class/thermal/thermal_zone*; do t=\$(cat \$z/type 2>/dev/null); if [ "\$t" = "x86_pkg_temp" ]; then temp_value=\$(cat \$z/temp 2>/dev/null); break; fi; done; if [ -z "\$temp_value" ] && [ -f /sys/class/thermal/thermal_zone0/temp ]; then temp_value=\$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null); fi; freq_value=; f=/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq; [ -f "\$f" ] && freq_value=\$(cat "\$f" 2>/dev/null); fan_count=\$(ectool pwmgetnumfans 2>/dev/null | sed -n "s/.*= *//p"); fan_values=; if [ -n "\$fan_count" ]; then fan_values=\$(ectool pwmgetfanrpm 2>/dev/null | sed -n "s/.*RPM: *//p" | tr "\\n" ","); else fan_count=0; for fan in /sys/class/hwmon/hwmon*/fan*_input; do if [ -f "\$fan" ]; then rpm=\$(cat "\$fan" 2>/dev/null); if [ -n "\$rpm" ]; then fan_values="\${fan_values:+\$fan_values,}\$rpm"; fan_count=\$((fan_count + 1)); fi; fi; done; fi; power_mw=; ia_mw=; gt_mw=; p=/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj; m=/sys/class/powercap/intel-rapl/intel-rapl:0/max_energy_range_uj; iap=/sys/class/powercap/intel-rapl/intel-rapl:0/intel-rapl:0:0/energy_uj; gtp=/sys/class/powercap/intel-rapl/intel-rapl:0/intel-rapl:0:1/energy_uj; if [ -f "\$p" ]; then e1=\$(cat "\$p" 2>/dev/null); ia1=; [ -f "\$iap" ] && ia1=\$(cat "\$iap" 2>/dev/null); gt1=; [ -f "\$gtp" ] && gt1=\$(cat "\$gtp" 2>/dev/null); sleep 1; e2=\$(cat "\$p" 2>/dev/null); ia2=; [ -f "\$iap" ] && ia2=\$(cat "\$iap" 2>/dev/null); gt2=; [ -f "\$gtp" ] && gt2=\$(cat "\$gtp" 2>/dev/null); if [ -n "\$e1" ] && [ -n "\$e2" ]; then d=\$((e2 - e1)); if [ \$d -lt 0 ]; then mx=\$(cat "\$m" 2>/dev/null); [ -n "\$mx" ] && d=\$((d + mx)); fi; power_mw=\$((d / 1000)); fi; if [ -n "\$ia1" ] && [ -n "\$ia2" ]; then dia=\$((ia2 - ia1)); [ \$dia -lt 0 ] && dia=0; ia_mw=\$((dia / 1000)); fi; if [ -n "\$gt1" ] && [ -n "\$gt2" ]; then dgt=\$((gt2 - gt1)); [ \$dgt -lt 0 ] && dgt=0; gt_mw=\$((dgt / 1000)); fi; fi; echo "TPTS_SAMPLE: TARGET_SYSFS_TEMP: \${temp_value:-NA} CPU_FREQ_KHZ: \${freq_value:-NA} FAN_COUNT: \${fan_count:-0} FAN_RPMS: \${fan_values:-NA} PKG_POWER_MW: \${power_mw:-NA} IA_MW: \${ia_mw:-NA} GT_MW: \${gt_mw:-NA} MSR_19C: \$(/data/local/tmp/iotools rdmsr 0 0x19C 2>/dev/null) MSR_610: \$(/data/local/tmp/iotools rdmsr 0 0x610 2>/dev/null) MSR_601: \$(/data/local/tmp/iotools rdmsr 0 0x601 2>/dev/null) MSR_64F: \$(/data/local/tmp/iotools rdmsr 0 0x64F 2>/dev/null) MSR_6B0: \$(/data/local/tmp/iotools rdmsr 0 0x6B0 2>/dev/null)"'`;
        if (isLocalTarget(target)) {
            sendAdb(['shell', megaCommand]);
        } else {
            sendAdb(['-s', target, 'shell', megaCommand]);
        }
    };
    monitorTimer = setInterval(telemetrySampler, SAMPLE_INTERVAL_SECONDS * 1000);
    telemetrySampler();
}

// One-shot telemetry sample so cards populate right after ADB connect (no continuous loop).
function sampleTelemetryOnce() {
    if (!isDeviceConnected) return;
    const wasMonitoring = monitorTimer !== null;
    startLiveTelemetryLoop();
    if (!wasMonitoring && monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
    }
}

// =========================================================
// CHART DIAGRAM ENGINE (REAL-TIME OSCILLOSCOPE)
// =========================================================
let canvas, ctx; const maxDataPoints = Math.round(HISTORY_SECONDS / SAMPLE_INTERVAL_SECONDS); const tempHistory = [];   
const tsr1History = [];
const TEMP_CHART_COLOR = '#ff9d6c';
const TSR1_CHART_COLOR = '#c4b5fd';
const paddingLeft = 50; 
const paddingRight = 50; 
const paddingTop = 20; const paddingBottom = 30;
const chartGridColor = '#353a50';
const chartBorderColor = '#555555';
const chartLabelColor = '#c3c8d8';
const chartLabelFont = '10px Consolas';
let chartWidth = 0; let chartHeight = 0;
let canvasDisplayWidth = 0; let canvasDisplayHeight = 0;
let hoveredIndex = -1;

function resizeChartCanvas() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    canvasDisplayWidth = Math.max(1, Math.round(rect.width || canvas.clientWidth || canvas.width));
    canvasDisplayHeight = Math.max(1, Math.round(rect.height || canvas.clientHeight || canvas.height));

    canvas.width = Math.round(canvasDisplayWidth * dpr);
    canvas.height = Math.round(canvasDisplayHeight * dpr);

    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    chartWidth = canvasDisplayWidth - paddingLeft - paddingRight;
    chartHeight = canvasDisplayHeight - paddingTop - paddingBottom;
}

function initChart() {
    canvas = document.getElementById('trendChart'); if (!canvas) return;
    resizeChartCanvas();
    drawChartGrid();

    window.addEventListener('resize', () => {
        resizeChartCanvas();
        redrawChart();
    });
    
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        if (mouseX < paddingLeft || mouseX > canvasDisplayWidth - paddingRight) {
            hoveredIndex = -1;
            redrawChart();
            return;
        }
        const stepX = chartWidth / (maxDataPoints - 1);
        const relX = mouseX - paddingLeft;
        hoveredIndex = Math.round(relX / stepX);
        if (hoveredIndex < 0) hoveredIndex = 0;
        if (hoveredIndex >= tempHistory.length) hoveredIndex = tempHistory.length - 1;
        redrawChart();
    });
    
    canvas.addEventListener('mouseleave', () => {
        hoveredIndex = -1;
        redrawChart();
    });
}

function drawChartGrid() {
    if (!ctx || !canvas) return; 
    ctx.clearRect(0, 0, canvasDisplayWidth, canvasDisplayHeight); 
    
    ctx.strokeStyle = chartGridColor; 
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
        const tempVal = i * 20; 
        const y = paddingTop + chartHeight - (tempVal * (chartHeight / 100));
        ctx.beginPath(); ctx.moveTo(paddingLeft, y); ctx.lineTo(canvasDisplayWidth - paddingRight, y); ctx.stroke();
        
        ctx.fillStyle = chartLabelColor; 
        ctx.font = chartLabelFont; 
        ctx.textAlign = 'right'; 
        ctx.fillText(`${tempVal}°C`, paddingLeft - 10, y + 4);
    }
    
    ctx.textAlign = 'center';
    for (let s = 0; s <= 6; s++) {
        const secAgo = (6 - s) * 10; 
        const x = paddingLeft + (s * (chartWidth / 6));
        ctx.beginPath(); ctx.moveTo(x, paddingTop); ctx.lineTo(x, canvasDisplayHeight - paddingBottom); ctx.stroke();
        
        if (secAgo === 0) {
            ctx.fillStyle = TEMP_CHART_COLOR; 
            ctx.font = chartLabelFont;
            ctx.fillText("Now", x, canvasDisplayHeight - paddingBottom + 18);
        } else {
            ctx.fillStyle = chartLabelColor; 
            ctx.font = chartLabelFont;
            ctx.fillText(`${secAgo}s ago`, x, canvasDisplayHeight - paddingBottom + 18);
        }
    }
    
    ctx.strokeStyle = chartBorderColor; 
    ctx.strokeRect(paddingLeft, paddingTop, chartWidth, chartHeight);
}

function redrawChart() {
    if (!ctx || tempHistory.length === 0) return;
    
    drawChartGrid();
    if (tempHistory.length < 2) return;
    
    const stepX = chartWidth / (maxDataPoints - 1);
    
    ctx.beginPath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = TEMP_CHART_COLOR;
    
    for (let i = 0; i < tempHistory.length; i++) {
        const x = paddingLeft + (i * stepX);
        const y = paddingTop + chartHeight - (tempHistory[i] * (chartHeight / 100));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    
    // TSR1 overlay: dashed second series, broken where samples are unavailable.
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = TSR1_CHART_COLOR;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    let tsr1PenDown = false;
    for (let i = 0; i < tsr1History.length; i++) {
        const value = tsr1History[i];
        if (value == null) { tsr1PenDown = false; continue; }
        const x = paddingLeft + (i * stepX);
        const y = paddingTop + chartHeight - (value * (chartHeight / 100));
        if (!tsr1PenDown) { ctx.moveTo(x, y); tsr1PenDown = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
    ctx.restore();

    const lastIdx = tempHistory.length - 1;
    const lastX = paddingLeft + (lastIdx * stepX);
    const lastY = paddingTop + chartHeight - (tempHistory[lastIdx] * (chartHeight / 100));
    ctx.beginPath(); ctx.arc(lastX, lastY, 4, 0, 2 * Math.PI); ctx.fillStyle = '#ffffff'; ctx.fill();
    
    ctx.fillStyle = TEMP_CHART_COLOR;
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(` ${tempHistory[lastIdx]}°C`, lastX + 5, lastY - 2);
    
    if (hoveredIndex >= 0 && hoveredIndex < tempHistory.length) {
        const hoveredX = paddingLeft + (hoveredIndex * stepX);
        const hoveredY = paddingTop + chartHeight - (tempHistory[hoveredIndex] * (chartHeight / 100));
        
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(hoveredX, paddingTop);
        ctx.lineTo(hoveredX, canvasDisplayHeight - paddingBottom);
        ctx.stroke();
        ctx.setLineDash([]);
        
        ctx.beginPath();
        ctx.arc(hoveredX, hoveredY, 5, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffaa00';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        const tooltipText = `${tempHistory[hoveredIndex]}°C`;
        const tsr1Hovered = tsr1History[hoveredIndex];
        const tooltipLine2 = tsr1Hovered != null ? `TSR1 ${tsr1Hovered}°C` : null;
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        const textWidth = Math.max(
            ctx.measureText(tooltipText).width,
            tooltipLine2 ? ctx.measureText(tooltipLine2).width : 0
        );
        const tooltipX = hoveredX;
        const tooltipY = hoveredY - 25;
        const boxPadding = 6;
        const boxHeight = tooltipLine2 ? 34 : 20;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(tooltipX - textWidth / 2 - boxPadding, tooltipY - 12 - boxPadding, textWidth + boxPadding * 2, boxHeight);
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 1;
        ctx.strokeRect(tooltipX - textWidth / 2 - boxPadding, tooltipY - 12 - boxPadding, textWidth + boxPadding * 2, boxHeight);
        
        ctx.fillStyle = '#ffaa00';
        ctx.fillText(tooltipText, tooltipX, tooltipY);
        if (tooltipLine2) {
            ctx.fillStyle = TSR1_CHART_COLOR;
            ctx.fillText(tooltipLine2, tooltipX, tooltipY + 14);
        }
    }
}

function updateChart(newTemp) {
    if (!ctx || !chartingActive) return; 

    filterWindow.push(newTemp);
    if (filterWindow.length > WINDOW_SIZE) filterWindow.shift();

    const sum = filterWindow.reduce((a, b) => a + b, 0);
    const smoothedTemp = Math.round((sum / filterWindow.length) * 10) / 10;

    tempHistory.push(smoothedTemp); 
    if (tempHistory.length > maxDataPoints) tempHistory.shift();

    const tsr1Now = latestEctoolTsr1Temp != null ? latestEctoolTsr1Temp : latestTsr1Temp;
    tsr1History.push(tsr1Now != null ? Math.round(tsr1Now * 10) / 10 : null);
    if (tsr1History.length > maxDataPoints) tsr1History.shift();
    
    redrawChart();
}

let powerCanvas, powerCtx;
const powerHistory = [];
const iaPowerHistory = [];
const gtPowerHistory = [];
const PKG_POWER_COLOR = '#e8ecf5';
const IA_POWER_COLOR = '#4fd1ff';
const GT_POWER_COLOR = '#3ddc97';
let powerDisplayWidth = 0;
let powerDisplayHeight = 0;
let powerHoveredIndex = -1;

function resizePowerChartCanvas() {
    if (!powerCanvas) return;
    const rect = powerCanvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    powerDisplayWidth = Math.max(1, Math.round(rect.width || powerCanvas.clientWidth));
    powerDisplayHeight = Math.max(1, Math.round(rect.height || powerCanvas.clientHeight));
    powerCanvas.width = Math.round(powerDisplayWidth * dpr);
    powerCanvas.height = Math.round(powerDisplayHeight * dpr);
    powerCtx = powerCanvas.getContext('2d');
    powerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawPowerChartGrid() {
    if (!powerCtx || !powerCanvas) return;
    const left = paddingLeft;
    const right = paddingRight;
    const top = paddingTop;
    const bottom = paddingBottom;
    const width = powerDisplayWidth - left - right;
    const height = powerDisplayHeight - top - bottom;
    const maxPower = Math.max(5, Math.ceil(Math.max(...powerHistory, 0) / 5) * 5);
    powerCtx.clearRect(0, 0, powerDisplayWidth, powerDisplayHeight);
    powerCtx.strokeStyle = chartGridColor;
    powerCtx.fillStyle = chartLabelColor;
    powerCtx.font = chartLabelFont;
    powerCtx.lineWidth = 1;
    for (let row = 0; row <= 5; row++) {
        const y = top + height * row / 5;
        powerCtx.beginPath(); powerCtx.moveTo(left, y); powerCtx.lineTo(powerDisplayWidth - right, y); powerCtx.stroke();
        powerCtx.textAlign = 'right';
        powerCtx.fillText((maxPower * (5 - row) / 5).toFixed(1), left - 10, y + 4);
    }
    for (let column = 0; column <= 6; column++) {
        const x = left + width * column / 6;
        powerCtx.beginPath(); powerCtx.moveTo(x, top); powerCtx.lineTo(x, powerDisplayHeight - bottom); powerCtx.stroke();
        const secAgo = Math.round(HISTORY_SECONDS - HISTORY_SECONDS * column / 6);
        powerCtx.textAlign = 'center';
        powerCtx.fillStyle = secAgo === 0 ? TEMP_CHART_COLOR : chartLabelColor;
        powerCtx.fillText(secAgo === 0 ? 'Now' : `${secAgo}s ago`, x, powerDisplayHeight - bottom + 18);
    }
    powerCtx.strokeStyle = chartBorderColor;
    powerCtx.strokeRect(left, top, width, height);
}

function redrawPowerChart() {
    if (!powerCtx) return;
    drawPowerChartGrid();
    if (powerHistory.length < 2) return;
    const left = paddingLeft;
    const right = paddingRight;
    const top = paddingTop;
    const bottom = paddingBottom;
    const width = powerDisplayWidth - left - right;
    const height = powerDisplayHeight - top - bottom;
    const maxPower = Math.max(5, Math.ceil(Math.max(...powerHistory, 0) / 5) * 5);
    const step = width / (maxDataPoints - 1);
    const drawSeries = (series, color, dashed) => {
        powerCtx.save();
        powerCtx.beginPath();
        powerCtx.strokeStyle = color;
        powerCtx.lineWidth = 2;
        if (dashed) powerCtx.setLineDash([6, 4]);
        let penDown = false;
        for (let index = 0; index < series.length; index++) {
            const value = series[index];
            if (value == null) { penDown = false; continue; }
            const x = left + index * step;
            const y = top + height - value / maxPower * height;
            if (!penDown) { powerCtx.moveTo(x, y); penDown = true; } else { powerCtx.lineTo(x, y); }
        }
        powerCtx.stroke();
        powerCtx.restore();
    };
    drawSeries(powerHistory, PKG_POWER_COLOR, false);
    drawSeries(iaPowerHistory, IA_POWER_COLOR, true);
    drawSeries(gtPowerHistory, GT_POWER_COLOR, true);

    const lastIdx = powerHistory.length - 1;
    const lastX = left + lastIdx * step;
    const lastY = top + height - powerHistory[lastIdx] / maxPower * height;
    powerCtx.beginPath(); powerCtx.arc(lastX, lastY, 4, 0, 2 * Math.PI); powerCtx.fillStyle = '#ffffff'; powerCtx.fill();
    powerCtx.fillStyle = '#f3f5fb'; powerCtx.font = 'bold 13px monospace'; powerCtx.textAlign = 'left';
    powerCtx.fillText(` ${powerHistory[lastIdx].toFixed(2)}W`, lastX + 5, lastY - 2);

    if (powerHoveredIndex >= 0 && powerHoveredIndex < powerHistory.length) {
        const hx = left + powerHoveredIndex * step;
        const hy = top + height - powerHistory[powerHoveredIndex] / maxPower * height;
        powerCtx.strokeStyle = '#ffaa00'; powerCtx.lineWidth = 2; powerCtx.setLineDash([4, 4]);
        powerCtx.beginPath(); powerCtx.moveTo(hx, top); powerCtx.lineTo(hx, powerDisplayHeight - bottom); powerCtx.stroke();
        powerCtx.setLineDash([]);
        powerCtx.beginPath(); powerCtx.arc(hx, hy, 5, 0, 2 * Math.PI); powerCtx.fillStyle = '#ffaa00'; powerCtx.fill();
        powerCtx.strokeStyle = '#ffffff'; powerCtx.lineWidth = 2; powerCtx.stroke();
        const txt = `${powerHistory[powerHoveredIndex].toFixed(2)} W`;
        const iaTxt = iaPowerHistory[powerHoveredIndex] != null ? `IA ${iaPowerHistory[powerHoveredIndex].toFixed(2)} W` : null;
        const gtTxt = gtPowerHistory[powerHoveredIndex] != null ? `GT ${gtPowerHistory[powerHoveredIndex].toFixed(2)} W` : null;
        const extraLines = [iaTxt, gtTxt].filter(Boolean);
        powerCtx.font = 'bold 12px monospace'; powerCtx.textAlign = 'center';
        const tw = Math.max(powerCtx.measureText(txt).width, ...extraLines.map((line) => powerCtx.measureText(line).width), 0);
        const tx = hx; const ty = hy - 25 - extraLines.length * 14; const pad = 6;
        const boxH = 20 + extraLines.length * 14;
        powerCtx.fillStyle = 'rgba(0, 0, 0, 0.8)'; powerCtx.fillRect(tx - tw / 2 - pad, ty - 12 - pad, tw + pad * 2, boxH);
        powerCtx.strokeStyle = '#ffaa00'; powerCtx.lineWidth = 1; powerCtx.strokeRect(tx - tw / 2 - pad, ty - 12 - pad, tw + pad * 2, boxH);
        powerCtx.fillStyle = '#ffaa00'; powerCtx.fillText(txt, tx, ty);
        if (iaTxt) { powerCtx.fillStyle = IA_POWER_COLOR; powerCtx.fillText(iaTxt, tx, ty + 14); }
        if (gtTxt) { powerCtx.fillStyle = GT_POWER_COLOR; powerCtx.fillText(gtTxt, tx, ty + 14 * extraLines.length); }
    }
}

function updatePowerChart(powerWatts) {
    latestPackagePower = powerWatts;
    if (!chartingActive) return;
    powerHistory.push(Math.round(powerWatts * 100) / 100);
    if (powerHistory.length > maxDataPoints) powerHistory.shift();
    iaPowerHistory.push(latestIaPower != null ? Math.round(latestIaPower * 100) / 100 : null);
    if (iaPowerHistory.length > maxDataPoints) iaPowerHistory.shift();
    gtPowerHistory.push(latestGtPower != null ? Math.round(latestGtPower * 100) / 100 : null);
    if (gtPowerHistory.length > maxDataPoints) gtPowerHistory.shift();
    redrawPowerChart();
}

function initPowerChart() {
    powerCanvas = document.getElementById('powerChart');
    if (!powerCanvas) return;
    resizePowerChartCanvas();
    drawPowerChartGrid();

    window.addEventListener('resize', () => {
        resizePowerChartCanvas();
        redrawPowerChart();
    });

    powerCanvas.addEventListener('mousemove', (e) => {
        const rect = powerCanvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const width = powerDisplayWidth - paddingLeft - paddingRight;
        if (mouseX < paddingLeft || mouseX > powerDisplayWidth - paddingRight) {
            powerHoveredIndex = -1;
            redrawPowerChart();
            return;
        }
        const step = width / (maxDataPoints - 1);
        powerHoveredIndex = Math.round((mouseX - paddingLeft) / step);
        if (powerHoveredIndex < 0) powerHoveredIndex = 0;
        if (powerHoveredIndex >= powerHistory.length) powerHoveredIndex = powerHistory.length - 1;
        redrawPowerChart();
    });

    powerCanvas.addEventListener('mouseleave', () => {
        powerHoveredIndex = -1;
        redrawPowerChart();
    });
}

// =========================================================
// WEBSOCKET TELEMETRY SIGNAL DECONSTRUCTOR
// =========================================================
socket.onmessage = (event) => {
    const res = JSON.parse(event.data);
    const consoleBox = document.getElementById('console');
    if (!consoleBox) return;

    if (res.type === 'stdout') {
        const rawLog = `${res.output || res.message || ''}`;
        const lowOutput = rawLog.toLowerCase();

        const ectoolSensorMatch = rawLog.match(/TPTS_ECTOOL_SENSOR_NAME:\s*(\S+)/i);
        if (ectoolSensorMatch) ectoolTsr1SensorName = ectoolSensorMatch[1];
        const ectoolPhysicalSensorMatch = rawLog.match(/TPTS_ECTOOL_PHYSICAL_SENSOR:\s*(\S+)/i);
        if (ectoolPhysicalSensorMatch) ectoolTsr1SensorName = ectoolPhysicalSensorMatch[1];
        const ectoolConfigMatch = rawLog.match(/TPTS_ECTOOL_CONFIG:\s*(\S+)/i);
        if (ectoolConfigMatch) appendConsole(`[TSR1 Debug] config=${ectoolConfigMatch[1]}`);
        if (ectoolSensorMatch) appendConsole(`[TSR1 Debug] mapped sensor=${ectoolSensorMatch[1]}`);
        if (ectoolPhysicalSensorMatch) appendConsole(`[TSR1 Debug] ectool sensor=${ectoolPhysicalSensorMatch[1]}`);

        let tsr1Match = null;
        if (ectoolTsr1SensorName) {
            const escapedSensorName = ectoolTsr1SensorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            tsr1Match = rawLog.match(new RegExp(`^\\s*${escapedSensorName}\\s+.*?\\(=\\s*(-?\\d+(?:\\.\\d+)?)\\s+C\\)`, 'i'));
            if (rawLog.toLowerCase().includes(ectoolTsr1SensorName.toLowerCase())) {
                appendConsole(`[TSR1 Debug] raw ectool: ${rawLog.trim()}`);
            }
        }
        if (tsr1Match) {
            let tsr1Temp = Number(tsr1Match[1]);
            if (tsr1Temp > 1000) tsr1Temp /= 1000;
            if (tsr1Temp >= -40 && tsr1Temp < 150) {
                latestEctoolTsr1Temp = tsr1Temp;
                const ectoolTsr1El = document.getElementById('v-tsr1-ectool-temp');
                if (ectoolTsr1El) ectoolTsr1El.innerText = `${tsr1Temp.toFixed(1)} °C`;
                appendConsole(`[TSR1 Debug] matched ${ectoolTsr1SensorName}: ${tsr1Temp.toFixed(1)} °C`);
            }
        }

        if (rawLog.includes('RTEMP_BEGIN')) { reproTempsCollecting = true; reproTempsBuffer = ''; }
        if (reproTempsCollecting) {
            const clean = rawLog.replace(/RTEMP_(BEGIN|END)/g, '').replace(/\r?\n/g, ' ').trim();
            if (clean) reproTempsBuffer += (reproTempsBuffer ? ' | ' : '') + clean;
        }
        if (rawLog.includes('RTEMP_END')) { reproTempsCollecting = false; latestFanTemps = reproTempsBuffer.trim(); }

        if (rawLog.includes("TPTS_TUNING_SYNC_BEGIN")) {
            tuningSyncInProgress = true;
            tuningSyncBuffer = '';
        }
        if (tuningSyncInProgress) {
            tuningSyncBuffer += rawLog;
        }
        if (tuningSyncInProgress && rawLog.includes("TPTS_TUNING_SYNC_END")) {
            const syncTagged610 = tuningSyncBuffer.match(/MSR_610:\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]+)/i);
            const syncTagged601 = tuningSyncBuffer.match(/MSR_601:\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]+)/i);
            const syncTokens = tuningSyncBuffer.match(/0x[0-9a-fA-F]+|[0-9a-fA-F]{6,16}/g) || [];
            tuningSyncInProgress = false;
            tuningSyncBuffer = '';

            let sync610 = null;
            let sync601 = null;

            if (syncTagged610 && syncTagged610[1]) sync610 = normalizeHex(syncTagged610[1]);
            if (syncTagged601 && syncTagged601[1]) sync601 = normalizeHex(syncTagged601[1]);
            if (!sync610 && syncTokens.length >= 1) sync610 = normalizeHex(syncTokens[0]);
            if (!sync601 && syncTokens.length >= 2) sync601 = normalizeHex(syncTokens[1]);

            if (sync610 && sync601) {
                if (sync610) {
                    try { decodeAndRenderPLFrom610(sync610); } catch (e) {}
                }
                if (sync601) {
                    try { decodeAndRenderPL4From601(sync601); } catch (e) {}
                }
                hasSyncedTuningDefaults = true;
            } else {
                if (tuningSyncRetries < 4 && isDeviceConnected) {
                    tuningSyncRetries += 1;
                    setTimeout(() => requestTuningDefaults(true), 1500);
                }
            }
        }

        if (rawLog.trim().includes("[TPTS_SIGNAL_FORCE_UNLOCKED]") || rawLog.includes("FORCE_UNLOCKED")) {
            restoreAllUiToIdle();
            return;
        }

        let discoveredTemp = null;
        const hexTokens = rawLog.match(/0x[0-9a-fA-F]+/g);

        const sysfsTsr1Match = rawLog.match(/TPTS_SYSFS_TSR1:\s*(-?\d+(?:\.\d+)?)/i);
        if (sysfsTsr1Match) {
            const rawVal = Number(sysfsTsr1Match[1]);
            latestTsr1Temp = rawVal > 1000 ? rawVal / 1000 : rawVal;
            const tsr1El = document.getElementById('v-tsr1-temp');
            if (tsr1El) tsr1El.innerText = `${latestTsr1Temp.toFixed(1)} °C`;
        }
        
        // 🎯【核心對齊】：精準捕獲 TARGET_SYSFS_TEMP 標籤與自動壓測標籤
        if (rawLog.includes("SOC_TEMP_CELSIUS:")) {
            const match = rawLog.match(/SOC_TEMP_CELSIUS:\s*(\d+)/i);
            if (match) discoveredTemp = parseInt(match[1], 10);
        } else if (rawLog.includes("TARGET_SYSFS_TEMP:")) {
            const match = rawLog.match(/TARGET_SYSFS_TEMP:\s*(\d+)/i);
            if (match) {
                const rawVal = parseInt(match[1], 10);
                discoveredTemp = (rawVal > 1000) ? Math.round(rawVal / 1000) : rawVal;
            }
        }
        
        if (rawLog.includes('RAPL_NAMED:') || rawLog.includes('RAPL_RAW:')) {
            appendConsole(`[RAPL Debug] ${rawLog.trim()}`);
        }
        const namedRaplMatch = rawLog.match(/RAPL_NAMED:\s+PKG_MW=(\d+|NA)\s+IA_MW=(\d+|NA)\s+GT_MW=(\d+|NA)\s+PKG_PATH=(\S+)\s+IA_PATH=(\S+)\s+GT_PATH=(\S+)/i);
        if (namedRaplMatch) {
            namedRaplActive = true;
            const [packageMw, iaMw, gtMw] = namedRaplMatch.slice(1, 4).map((value) => value === 'NA' ? null : Number(value));
            if (iaMw === null) {
                latestIaPower = null;
                const iaEl = document.getElementById('v-ia-power');
                if (iaEl) iaEl.innerText = '-- W';
            } else {
                latestIaPower = iaMw / 1000;
                const iaEl = document.getElementById('v-ia-power');
                if (iaEl) iaEl.innerText = `${latestIaPower.toFixed(2)} W`;
            }
            if (gtMw === null) {
                latestGtPower = null;
                const gtEl = document.getElementById('v-gt-power');
                if (gtEl) gtEl.innerText = '-- W';
            } else {
                latestGtPower = gtMw / 1000;
                const gtEl = document.getElementById('v-gt-power');
                if (gtEl) gtEl.innerText = `${latestGtPower.toFixed(2)} W`;
            }
            const packageEl = document.getElementById('v-power');
            if (packageMw === null) {
                latestPackagePower = null;
                if (packageEl) packageEl.innerText = '-- W';
            } else {
                const packageWatts = packageMw / 1000;
                if (packageEl) packageEl.innerText = `${packageWatts.toFixed(2)} W`;
                updatePowerChart(packageWatts);
            }
        }

        const rawUncoreMatch = rawLog.match(/RAPL_RAW:.*?UNCORE_E1=(\d+|NA)\s+UNCORE_E2=(\d+|NA)/i);
        if (rawUncoreMatch && rawUncoreMatch[2] !== 'NA') {
            const uncoreEnergyUj = Number(rawUncoreMatch[2]);
            const nowMs = Date.now();
            const elapsedMs = nowMs - lastUncoreSampleMs;
            if (lastUncoreEnergyUj !== null && uncoreEnergyUj >= lastUncoreEnergyUj && elapsedMs > 0) {
                latestGtPower = (uncoreEnergyUj - lastUncoreEnergyUj) / elapsedMs / 1000;
                const gtEl = document.getElementById('v-gt-power');
                if (gtEl) gtEl.innerText = `${latestGtPower.toFixed(2)} W`;
                // RAPL_RAW arrives after RAPL_NAMED, so patch the point just plotted.
                if (gtPowerHistory.length > 0) {
                    gtPowerHistory[gtPowerHistory.length - 1] = Math.round(latestGtPower * 100) / 100;
                    redrawPowerChart();
                }
            }
            lastUncoreEnergyUj = uncoreEnergyUj;
            lastUncoreSampleMs = nowMs;
        }

        // 📊【功率解析】：優先讀毫瓦標籤 (低功耗仍有解析度)，退回整數瓦相容壓測腳本
        if (!namedRaplActive && rawLog.includes("PKG_POWER_MW:")) {
            const mwMatch = rawLog.match(/PKG_POWER_MW:\s*(\d+)/i);
            if (mwMatch) {
                const powerWatts = parseInt(mwMatch[1], 10) / 1000;
                const powerEl = document.getElementById('v-power');
                if (powerEl) {
                    powerEl.innerText = `${powerWatts.toFixed(2)} W`;
                }
                updatePowerChart(powerWatts);
            }
        } else if (rawLog.includes("PKG_POWER_WATTS:")) {
            const powerMatch = rawLog.match(/PKG_POWER_WATTS:\s*(\d+)/i);
            if (powerMatch) {
                const powerWatts = parseInt(powerMatch[1], 10);
                const powerEl = document.getElementById('v-power');
                if (powerEl) {
                    powerEl.innerText = `${powerWatts} W`;
                }
                updatePowerChart(powerWatts);
            }
        }

        const frequencyMatch = rawLog.match(/CPU_FREQ_KHZ:\s*(\d+)/i);
        if (frequencyMatch) {
            const frequencyEl = document.getElementById('v-freq');
            if (frequencyEl) frequencyEl.innerText = `${(parseInt(frequencyMatch[1], 10) / 1000000).toFixed(2)} GHz`;
        }
        const iaMatch = rawLog.match(/IA_MW:\s*(\d+)/i);
        if (iaMatch) {
            latestIaPower = parseInt(iaMatch[1], 10) / 1000;
            const iaEl = document.getElementById('v-ia-power');
            if (iaEl) iaEl.innerText = `${latestIaPower.toFixed(2)} W`;
        }
        const gtMatch = rawLog.match(/GT_MW:\s*(\d+)/i);
        if (gtMatch) {
            latestGtPower = parseInt(gtMatch[1], 10) / 1000;
            const gtEl = document.getElementById('v-gt-power');
            if (gtEl) gtEl.innerText = `${latestGtPower.toFixed(2)} W`;
        }
        const rawFanCountMatch = rawLog.match(/Number of fans\s*=\s*(\d+)/i);
        if (rawFanCountMatch) {
            detectedFanCount = parseInt(rawFanCountMatch[1], 10);
            detectedFanRpms = Array.from({ length: detectedFanCount }, (_, index) => detectedFanRpms[index] ?? null);
            renderFanSpeeds();
        }
        if (rawLog.includes('TPTS_FAN_BEGIN')) fanReadbackActive = true;
        const isFanLike = /Number of fans|Fan\s+\d+\s+RPM|pwm(get|set)|fanduty|autofanctrl|unrecognized subcommand/i.test(rawLog);
        if ((fanReadbackActive || isFanLike) && !rawLog.includes('TPTS_SAMPLE')) {
            const cleaned = rawLog.replace(/TPTS_FAN_(BEGIN|END)/g, '').trim();
            if (cleaned) appendConsole(`[Fan] ${cleaned}`);
        }
        if (rawLog.includes('TPTS_FAN_END')) fanReadbackActive = false;
        for (const rawFanMatch of rawLog.matchAll(/Fan\s+(\d+)\s+RPM:\s*(\d+)/gi)) {
            const fanIndex = parseInt(rawFanMatch[1], 10);
            detectedFanRpms[fanIndex] = parseInt(rawFanMatch[2], 10);
            detectedFanCount = Math.max(detectedFanCount, fanIndex + 1);
            renderFanSpeeds();
        }
        let dutyDetected = false;
        for (const dutyMatch of rawLog.matchAll(/Fan\s+(\d+)[^\n%]*?(\d{1,3})\s*%/gi)) {
            const fanIndex = parseInt(dutyMatch[1], 10);
            const pct = parseInt(dutyMatch[2], 10);
            if (pct >= 0 && pct <= 100) {
                detectedFanDuty[fanIndex] = pct;
                detectedFanCount = Math.max(detectedFanCount, fanIndex + 1);
                dutyDetected = true;
            }
        }
        if (dutyDetected) {
            fanControlRenderedCount = -1;
            syncFanControlInputs();
        }
        const fanCountMatch = rawLog.match(/FAN_COUNT:\s*(\d+)/i);
        const fanListMatch = rawLog.match(/FAN_RPMS:\s*([^\s]+)/i);
        const fanMatch = rawLog.match(/FAN_RPM:\s*(\d+)/i);
        if (fanCountMatch || fanListMatch || fanMatch) {
            const reportedRpms = fanListMatch && fanListMatch[1] !== 'NA'
                ? fanListMatch[1].split(',').map((rpm) => /^\d+$/.test(rpm) ? parseInt(rpm, 10) : null)
                : fanMatch ? [parseInt(fanMatch[1], 10)] : [];
            const reportedCount = fanCountMatch ? parseInt(fanCountMatch[1], 10) : reportedRpms.length;
            // Ignore transient empty samples so a good fan readout isn't blanked to "No Fan".
            const hasValidData = reportedCount > 0 && reportedRpms.some((rpm) => rpm != null);
            if (hasValidData || detectedFanCount === 0) {
                const fanCount = Math.max(reportedCount, detectedFanCount);
                detectedFanCount = fanCount;
                detectedFanRpms = Array.from({ length: fanCount }, (_, index) => reportedRpms[index] ?? null);
                renderFanSpeeds();
            }
        }

        // ⚡ MSR 0x610 (PL1 / PL2) 安全字串切片拆解大腦 ➔ 直接填入 Label 靠右小字提示中
        const v610 = document.getElementById('v610'); 
        const tagged610 = rawLog.match(/MSR_610:\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]+)/i);
        if (tagged610 && tagged610[1]) {
            const normalized610 = normalizeHex(tagged610[1]);
            if (normalized610) {
                try { decodeAndRenderPLFrom610(normalized610); } catch (e) {}
            }
        }

        if (!tagged610 && (rawLog.includes("0x610") || (hexTokens && hexTokens.length > 0 && rawLog.includes("610")))) {
            const hex610 = hexTokens[hexTokens.length - 1]; 
            if (hex610 && hex610.startsWith("0x") && hex610.length >= 10) {
                try {
                    decodeAndRenderPLFrom610(hex610);
                } catch (e) {}
            }
        }

        // ⚡ MSR 0x601 (PL4) 安全直接解析大腦 ➔ 直接填入 PL4 Label 靠右小字提示中
        const tagged601 = rawLog.match(/MSR_601:\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]+)/i);
        if (tagged601 && tagged601[1]) {
            const normalized601 = normalizeHex(tagged601[1]);
            if (normalized601) {
                try { decodeAndRenderPL4From601(normalized601); } catch (e) {}
            }
        }
        if (!tagged601 && (rawLog.includes("0x601") || (hexTokens && hexTokens.length > 0 && rawLog.includes("601")))) {
            const hex601 = hexTokens[hexTokens.length - 1];
            if (hex601 && hex601.startsWith("0x")) {
                try {
                    decodeAndRenderPL4From601(hex601);
                } catch (e) {}
            }
        }

        // 狀態燈號控制 (0x19C)
        const tagged19c = rawLog.match(/MSR_19C:\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]+)/i);
        if ((tagged19c && tagged19c[1]) || (rawLog.includes("19C") && hexTokens && hexTokens.length >= 1)) {
            const thermToken = tagged19c && tagged19c[1] ? normalizeHex(tagged19c[1]) : hexTokens[hexTokens.length - 1];
            const thermReg = parseInt(thermToken, 16);
            if (!isNaN(thermReg) && thermReg > 0x100000) {
                const lampT = document.getElementById('lamp-thermal');
                const lampP = document.getElementById('lamp-prochot');
                const lampPw = document.getElementById('lamp-power');
                if (lampT) lampT.className = (thermReg & 1) ? "lamp active-red" : "lamp";
                if (lampP) lampP.className = (thermReg & 4) ? "lamp active-red" : "lamp";
                if (lampPw) lampPw.className = (thermReg & 1024) ? "lamp active-red" : "lamp";
                latestTcc = (thermReg & 1) ? 1 : 0;
                latestProchot = (thermReg & 4) ? 1 : 0;
                
                // 兜底防護：若壓測腳本剛好沒印出 SOC_TEMP_CELSIUS，用 MSR 暫存器算出來防空包彈
                // 壓測期間溫度以 SOC_TEMP_CELSIUS 為準，避免 0x19C 額外推點造成溫度比功耗快
                if (discoveredTemp === null && !isPipelineRunning) {
                    const digitalReadout = (thermReg >> 16) & 0x7F;
                    if (digitalReadout > 0 && digitalReadout < 100) {
                        discoveredTemp = 100 - digitalReadout;
                    }
                }
            }
        }

        // 🚀 更新溫度到大卡片與畫布
        if (discoveredTemp !== null && !isNaN(discoveredTemp) && discoveredTemp >= 10 && discoveredTemp < 110) {
            latestSocTemp = discoveredTemp;
            const tempVEl = document.getElementById('v-temp');
            if (tempVEl) tempVEl.innerText = `${formatTemperatureCelsius(discoveredTemp)} °C`;
            consoleBox.innerHTML += `[Chart Update] Raw: ${formatTemperatureCelsius(discoveredTemp)}°C\n`;
            updateChart(discoveredTemp); 
        }

        // 剩餘普通 MSR 欄位轉填
        const v64f = document.getElementById('v64f'); const v6b0 = document.getElementById('v6b0');
        const tagged64f = rawLog.match(/MSR_64F:\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]+)/i);
        if (tagged64f && tagged64f[1] && v64f) {
            const normalized64f = normalizeHex(tagged64f[1]);
            if (normalized64f) v64f.innerText = normalized64f;
        }
        const tagged6b0 = rawLog.match(/MSR_6B0:\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]+)/i);
        if (tagged6b0 && tagged6b0[1] && v6b0) {
            const normalized6b0 = normalizeHex(tagged6b0[1]);
            if (normalized6b0) v6b0.innerText = normalized6b0;
        }
        if (rawLog.includes("TELEMETRY_DATA:")) {
            if (hexTokens && hexTokens.length >= 3) {
                if (v610 && !rawLog.includes("610")) v610.innerText = hexTokens[0]; 
                if (v64f) v64f.innerText = hexTokens[1];
                if (v6b0) v6b0.innerText = hexTokens[2];
            }
        } else if (!isPipelineRunning && hexTokens && hexTokens.length > 0) {
            for (let i = 0; i < hexTokens.length; i++) {
                const token = hexTokens[i];
                if (token.toLowerCase().includes("64f") && i + 1 < hexTokens.length && v64f) { 
                    v64f.innerText = hexTokens[i + 1]; 
                }
                if (token.toLowerCase().includes("6b0") && i + 1 < hexTokens.length && v6b0) { v6b0.innerText = hexTokens[i + 1]; }
            }
        }

        if (isPipelineRunning) {
            consoleBox.innerText += rawLog;
            consoleBox.scrollTop = consoleBox.scrollHeight;
        }

        if (lowOutput.includes("success") || lowOutput.includes("complete") || lowOutput.includes("archived") || lowOutput.includes("finished")) {
            if (lowOutput.includes("stage 4 complete") || lowOutput.includes("success") || lowOutput.includes("archived") || lowOutput.includes("finished")) {
                restoreAllUiToIdle();
            }
        }

        if (lowOutput.includes("connected to") || lowOutput.includes("already connected")) {
            isDeviceConnected = true;
            resetTuningDefaultSyncState();
            const statusEl = document.getElementById('link-status');
            if (statusEl) { statusEl.innerText = "[Connected]"; statusEl.style.color = "#00ff66"; }
            const statusDot = document.querySelector('.status-dot');
            if (statusDot) { statusDot.style.background = '#18ca70'; statusDot.style.boxShadow = '0 0 10px rgba(24,202,112,.65)'; }
            
            if (!consoleBox.innerText.includes("Device is connected and ready")) {
                consoleBox.innerText += `[TPTS] Device is successfully connected and ready for actions.\n`;
                consoleBox.scrollTop = consoleBox.scrollHeight;
            }

            const currentTarget = normalizeTarget(document.getElementById('ip') ? document.getElementById('ip').value : '');
            if (currentTarget) {
                appendConsole('[TPTS] Preparing device runtime (iotools/msr)...');
                sendAdb(['PREPARE_DEVICE', currentTarget]);
                appendConsole('[TPTS] Reading fan inventory (ectool pwmgetnumfans)...');
                requestFanInventory(currentTarget);
                setTimeout(() => requestFanInventory(currentTarget), 1200);
                // Dashboard runs continuously at 1s from connect (independent of the button).
                setTimeout(() => {
                    if (isDeviceConnected && !isPipelineRunning && monitorTimer === null) {
                        startLiveTelemetryLoop();
                        renderMonitorButton(false);
                        appendConsole('[TPTS] Dashboard live (cards, 1s). Press Start Monitoring to draw curves.');
                    }
                }, 1300);
            }

            const tuningTab = document.getElementById('tab-tuning');
            if (tuningTab && tuningTab.classList.contains('active')) {
                clearTuningUserEditedFlags();
                setTimeout(() => requestTuningDefaults(true), 350);
                setTimeout(() => {
                    if (!hasSyncedTuningDefaults) requestTuningDefaults(true);
                }, 900);
            }

            // Auto-bootstrap Android backend when connected via ADB (non-local)
            if (!isLocalTarget(currentTarget) && currentTarget) {
                appendConsole('[TPTS] ADB link established. Bootstrapping Android backend...');
                sendAdb(['BOOTSTRAP_ANDROID', currentTarget]);
            }
        }
    }
};

socket.onopen = () => {
    appendConsole(`[TPTS] WebSocket connected (${wsHost}).`);
    tryAutoConnectLocal();
};

socket.onerror = () => {
    appendConsole('[TPTS] WebSocket error. If running in pure web mode, start backend first.');
};

socket.onclose = () => {
    appendConsole('[TPTS] WebSocket closed.');
};

window.addEventListener('load', () => {
    initChart();
    initPowerChart();
    preparePureWebMode();
    renderFanControlInputs();
    ['tune-pl1', 'tune-pl2', 'tune-pl4'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            el.dataset.userEdited = "1";
        });
    });

    if (socket.readyState === 1) {
        tryAutoConnectLocal();
    }
});