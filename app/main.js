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

// 🌊【移動平均快取】：供 Canvas 繪圖平滑化使用
const filterWindow = [];
const WINDOW_SIZE = 4; 

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

function toggleFanInput() {
    const modeEl = document.getElementById('tune-fan-mode');
    const dutyEl = document.getElementById('tune-fan-duty');
    const rowEl = document.getElementById('fan-duty-row');
    if (modeEl && dutyEl && rowEl) {
        const isManual = modeEl.value === 'manual';
        dutyEl.disabled = !isManual;
        rowEl.style.opacity = isManual ? "1.0" : "0.4";
    }
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
    const dutyEl = document.getElementById('tune-fan-duty');
    const consoleBox = document.getElementById('console');
    if (!target || !modeEl || !dutyEl) return;

    const mode = modeEl.value;
    let cmd = '';

    if (mode === 'manual') {
        const duty = parseInt(dutyEl.value, 10);
        if (Number.isNaN(duty) || duty < 0 || duty > 100) {
            alert("Manual fan duty must be 0~100.");
            return;
        }
        cmd = `su 0 setprop vendor.tpts.fan.mode manual; su 0 setprop vendor.tpts.fan.duty ${duty}; echo FAN_MODE:manual DUTY:${duty}`;
    } else {
        cmd = "su 0 setprop vendor.tpts.fan.mode auto; echo FAN_MODE:auto";
    }

    if (isLocalTarget(target)) {
        sendAdb(['shell', cmd]);
    } else {
        sendAdb(['-s', target, 'shell', cmd]);
    }

    if (consoleBox) {
        consoleBox.innerText += `[Tuning] Fan policy applied: ${mode === 'manual' ? `manual ${dutyEl.value}%` : 'auto'}\n`;
        consoleBox.scrollTop = consoleBox.scrollHeight;
    }
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
        runBtn.innerText = "Stop Automated Stress Test";
        runBtn.style.background = "#ff4444"; runBtn.style.color = "#ffffff";
    }
}

function restoreAllUiToIdle() {
    isPipelineRunning = false; 
    stopPipelineCountdown();

    document.querySelectorAll('button, input, select').forEach(el => {
        el.disabled = false; el.style.opacity = "1.0"; el.style.cursor = "pointer";
    });

    const runBtn = document.querySelector('button[onclick="startThermalPipeline()"]');
    if (runBtn) {
        runBtn.innerText = "Run Automated Stress Test";
        runBtn.style.background = "#00ffcc"; runBtn.style.color = "#0f0f14";
    }

    const monitorBtn = document.querySelector('.btn-secondary');
    if (monitorBtn) {
        if (wasMonitoringBeforePipeline) {
            monitorBtn.innerText = "Stop Live Thermal Monitor";
            monitorBtn.style.background = "#ff4444"; monitorBtn.style.color = "#ffffff";
            wasMonitoringBeforePipeline = false; 
            startLiveTelemetryLoop(); 
        } else {
            if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
            monitorBtn.innerText = "Start Live Thermal Monitor";
            monitorBtn.style.background = "#aaff55"; monitorBtn.style.color = "#0f0f14";
        }
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

    const isCurrentlyRunning = monitorBtn.innerText.includes("Stop");

    if (isCurrentlyRunning) {
        if (monitorTimer !== null) {
            clearInterval(monitorTimer);
            monitorTimer = null; 
        }
        monitorBtn.innerText = "Start Live Thermal Monitor";
        monitorBtn.style.background = "#aaff55"; monitorBtn.style.color = "#0f0f14";
        consoleBox.innerHTML += `[Monitor] ⏸️ Telemetry paused. Oscilloscope frozen.\n`;
        consoleBox.scrollTop = consoleBox.scrollHeight;
    } else {
        consoleBox.innerHTML += `\n[Monitor] ▶️ Live Telemetry Started. Oscilloscope refreshing...\n`;
        consoleBox.scrollTop = consoleBox.scrollHeight;
        
        monitorBtn.innerText = "Stop Live Thermal Monitor";
        monitorBtn.style.background = "#ff4444"; monitorBtn.style.color = "#ffffff";
        
        startLiveTelemetryLoop(); 
    }
}

function startLiveTelemetryLoop() {
    if (monitorTimer) {
        clearInterval(monitorTimer);
    }
    monitorTimer = null; 
    
    tempHistory.length = 0;
    filterWindow.length = 0;
    drawChartGrid(); 

    const ipEl = document.getElementById('ip');
    const target = normalizeTarget(ipEl ? ipEl.value : '');
    if (!target) return;

    // 🎯【正確鎖定】：100% 走 Linux 核心 sysfs 指令，同時加入 MSR 暫存器轟炸
    monitorTimer = setInterval(() => {
        const megaCommand = `su 0 sh -c 'found=0; for z in /sys/class/thermal/thermal_zone*; do t=\$(cat \$z/type 2>/dev/null); if [ "\$t" = "x86_pkg_temp" ]; then echo "TARGET_SYSFS_TEMP: \$(cat \$z/temp)"; found=1; break; fi; done; if [ \$found -eq 0 ] && [ -f /sys/class/thermal/thermal_zone0/temp ]; then echo "TARGET_SYSFS_TEMP: \$(cat /sys/class/thermal/thermal_zone0/temp)"; fi; p=/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj; m=/sys/class/powercap/intel-rapl/intel-rapl:0/max_energy_range_uj; if [ -f "\$p" ]; then e1=\$(cat "\$p" 2>/dev/null); sleep 1; e2=\$(cat "\$p" 2>/dev/null); if [ -n "\$e1" ] && [ -n "\$e2" ]; then d=\$((e2 - e1)); if [ \$d -lt 0 ]; then mx=\$(cat "\$m" 2>/dev/null); [ -n "\$mx" ] && d=\$((d + mx)); fi; echo "PKG_POWER_MW: \$((d / 1000))"; fi; fi; echo "MSR_19C: \$(/data/local/tmp/iotools rdmsr 0 0x19C 2>/dev/null)"; echo "MSR_610: \$(/data/local/tmp/iotools rdmsr 0 0x610 2>/dev/null)"; echo "MSR_601: \$(/data/local/tmp/iotools rdmsr 0 0x601 2>/dev/null)"; echo "MSR_64F: \$(/data/local/tmp/iotools rdmsr 0 0x64F 2>/dev/null)"; echo "MSR_6B0: \$(/data/local/tmp/iotools rdmsr 0 0x6B0 2>/dev/null)"'`;
        if (isLocalTarget(target)) {
            sendAdb(['shell', megaCommand]);
        } else {
            sendAdb(['-s', target, 'shell', megaCommand]);
        }
    }, 1500);
}

// =========================================================
// CHART DIAGRAM ENGINE (REAL-TIME OSCILLOSCOPE)
// =========================================================
let canvas, ctx; const maxDataPoints = 60; const tempHistory = [];   
const paddingLeft = 50; 
const paddingRight = 65; 
const paddingTop = 20; const paddingBottom = 30;
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
    
    ctx.strokeStyle = '#444444'; 
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
        const tempVal = i * 20; 
        const y = paddingTop + chartHeight - (tempVal * (chartHeight / 100));
        ctx.beginPath(); ctx.moveTo(paddingLeft, y); ctx.lineTo(canvasDisplayWidth - paddingRight, y); ctx.stroke();
        
        ctx.fillStyle = '#ffffff'; 
        ctx.font = 'bold 12px monospace'; 
        ctx.textAlign = 'right'; 
        ctx.fillText(`${tempVal}°C`, paddingLeft - 10, y + 4);
    }
    
    ctx.textAlign = 'center';
    for (let s = 0; s <= 6; s++) {
        const secAgo = (6 - s) * 10; 
        const x = paddingLeft + (s * (chartWidth / 6));
        ctx.beginPath(); ctx.moveTo(x, paddingTop); ctx.lineTo(x, canvasDisplayHeight - paddingBottom); ctx.stroke();
        
        if (secAgo === 0) {
            ctx.fillStyle = '#00ffcc'; 
            ctx.font = 'bold 12px monospace';
            ctx.fillText("Now", x, canvasDisplayHeight - paddingBottom + 18);
        } else {
            ctx.fillStyle = '#ffffff'; 
            ctx.font = 'bold 12px monospace';
            ctx.fillText(`${secAgo}s ago`, x, canvasDisplayHeight - paddingBottom + 18);
        }
    }
    
    ctx.strokeStyle = '#555555'; 
    ctx.strokeRect(paddingLeft, paddingTop, chartWidth, chartHeight);
}

function redrawChart() {
    if (!ctx || tempHistory.length === 0) return;
    
    drawChartGrid();
    if (tempHistory.length < 2) return;
    
    const stepX = chartWidth / (maxDataPoints - 1);
    
    ctx.beginPath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#00ffcc';
    
    for (let i = 0; i < tempHistory.length; i++) {
        const x = paddingLeft + (i * stepX);
        const y = paddingTop + chartHeight - (tempHistory[i] * (chartHeight / 100));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    
    const lastIdx = tempHistory.length - 1;
    const lastX = paddingLeft + (lastIdx * stepX);
    const lastY = paddingTop + chartHeight - (tempHistory[lastIdx] * (chartHeight / 100));
    ctx.beginPath(); ctx.arc(lastX, lastY, 4, 0, 2 * Math.PI); ctx.fillStyle = '#ffffff'; ctx.fill();
    
    ctx.fillStyle = '#00ffcc';
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
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        const textWidth = ctx.measureText(tooltipText).width;
        const tooltipX = hoveredX;
        const tooltipY = hoveredY - 25;
        const boxPadding = 6;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(tooltipX - textWidth / 2 - boxPadding, tooltipY - 12 - boxPadding, textWidth + boxPadding * 2, 20);
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 1;
        ctx.strokeRect(tooltipX - textWidth / 2 - boxPadding, tooltipY - 12 - boxPadding, textWidth + boxPadding * 2, 20);
        
        ctx.fillStyle = '#ffaa00';
        ctx.fillText(tooltipText, tooltipX, tooltipY);
    }
}

function updateChart(newTemp) {
    if (!ctx) return; 

    filterWindow.push(newTemp);
    if (filterWindow.length > WINDOW_SIZE) filterWindow.shift();

    const sum = filterWindow.reduce((a, b) => a + b, 0);
    const smoothedTemp = Math.round((sum / filterWindow.length) * 10) / 10;

    tempHistory.push(smoothedTemp); 
    if (tempHistory.length > maxDataPoints) tempHistory.shift();
    
    redrawChart();
}

// =========================================================
// WEBSOCKET TELEMETRY SIGNAL DECONSTRUCTOR
// =========================================================
socket.onmessage = (event) => {
    const res = JSON.parse(event.data);
    const consoleBox = document.getElementById('console');
    if (!consoleBox) return;

    if (res.type === 'stdout') {
        const rawLog = res.output;
        const lowOutput = rawLog.toLowerCase();

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
                const preview = (syncTokens.length > 0) ? syncTokens.join(', ') : 'none';
                appendConsole(`[TPTS] Tuning sync failed: missing MSR value(s). tokens=${preview}`);
            }
        }

        if (rawLog.trim().includes("[TPTS_SIGNAL_FORCE_UNLOCKED]") || rawLog.includes("FORCE_UNLOCKED")) {
            restoreAllUiToIdle();
            return;
        }

        let discoveredTemp = null;
        const hexTokens = rawLog.match(/0x[0-9a-fA-F]+/g);
        
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
        
        // 📊【功率解析】：優先讀毫瓦標籤 (低功耗仍有解析度)，退回整數瓦相容壓測腳本
        if (rawLog.includes("PKG_POWER_MW:")) {
            const mwMatch = rawLog.match(/PKG_POWER_MW:\s*(\d+)/i);
            if (mwMatch) {
                const powerWatts = parseInt(mwMatch[1], 10) / 1000;
                const powerEl = document.getElementById('v-power');
                if (powerEl) {
                    powerEl.innerText = `${powerWatts.toFixed(2)} W`;
                }
            }
        } else if (rawLog.includes("PKG_POWER_WATTS:")) {
            const powerMatch = rawLog.match(/PKG_POWER_WATTS:\s*(\d+)/i);
            if (powerMatch) {
                const powerWatts = parseInt(powerMatch[1], 10);
                const powerEl = document.getElementById('v-power');
                if (powerEl) {
                    powerEl.innerText = `${powerWatts} W`;
                }
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

        if (rawLog.includes("0x610") || (hexTokens && hexTokens.length > 0 && rawLog.includes("610"))) {
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
        if (rawLog.includes("0x601") || (hexTokens && hexTokens.length > 0 && rawLog.includes("601"))) {
            const hex601 = hexTokens[hexTokens.length - 1];
            if (hex601 && hex601.startsWith("0x")) {
                try {
                    decodeAndRenderPL4From601(hex601);
                } catch (e) {}
            }
        }

        // 狀態燈號控制 (0x19C)
        if (rawLog.includes("19C") && hexTokens && hexTokens.length >= 1) {
            const thermReg = parseInt(hexTokens[hexTokens.length - 1], 16);
            if (!isNaN(thermReg) && thermReg > 0x100000) {
                const lampT = document.getElementById('lamp-thermal');
                const lampP = document.getElementById('lamp-prochot');
                const lampPw = document.getElementById('lamp-power');
                if (lampT) lampT.className = (thermReg & 1) ? "lamp active-red" : "lamp";
                if (lampP) lampP.className = (thermReg & 4) ? "lamp active-red" : "lamp";
                if (lampPw) lampPw.className = (thermReg & 1024) ? "lamp active-red" : "lamp";
                
                // 兜底防護：若壓測腳本剛好沒印出 SOC_TEMP_CELSIUS，用 MSR 暫存器算出來防空包彈
                if (discoveredTemp === null) {
                    const digitalReadout = (thermReg >> 16) & 0x7F;
                    if (digitalReadout > 0 && digitalReadout < 100) {
                        discoveredTemp = 100 - digitalReadout;
                    }
                }
            }
        }

        // 🚀 更新溫度到大卡片與畫布
        if (discoveredTemp !== null && !isNaN(discoveredTemp) && discoveredTemp >= 10 && discoveredTemp < 110) {
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
            
            if (!consoleBox.innerText.includes("Device is connected and ready")) {
                consoleBox.innerText += `[TPTS] Device is successfully connected and ready for actions.\n`;
                consoleBox.scrollTop = consoleBox.scrollHeight;
            }

            const currentTarget = normalizeTarget(document.getElementById('ip') ? document.getElementById('ip').value : '');
            if (currentTarget) {
                appendConsole('[TPTS] Preparing device runtime (iotools/msr)...');
                sendAdb(['PREPARE_DEVICE', currentTarget]);
                setTimeout(() => {
                    if (isDeviceConnected && !isPipelineRunning) {
                        appendConsole('[TPTS] Live temperature and package power telemetry started.');
                        startLiveTelemetryLoop();
                    }
                }, 1000);
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
    preparePureWebMode();
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