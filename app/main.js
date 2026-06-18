// =====================================================================
// TPTS WEB FRONTEND CORE - HIGH CONTRAST PRODUCTION (v14.5 - SYSFS MASTER)
// =====================================================================
const socket = new WebSocket(`ws://${window.location.host}/ws`);

let isDeviceConnected = false;
let isPipelineRunning = false; 
let monitorTimer = null;   
let wasMonitoringBeforePipeline = false; 
let hasSyncedTuningDefaults = false;
const tuningDefaults = { pl1: null, pl2: null, pl4: null };

// 🌊【移動平均快取】：供 Canvas 繪圖平滑化使用
const filterWindow = [];
const WINDOW_SIZE = 4; 

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

function setTuningFieldDefault(fieldId, watts) {
    const inputEl = document.getElementById(fieldId);
    if (!inputEl || inputEl.dataset.userEdited === "1") return;
    inputEl.value = formatPowerWatts(watts);
}

function tryFinishTuningDefaultsSync() {
    if (tuningDefaults.pl1 === null || tuningDefaults.pl2 === null || tuningDefaults.pl4 === null) return;
    hasSyncedTuningDefaults = true;
}

function requestTuningDefaults() {
    if (!isDeviceConnected || hasSyncedTuningDefaults) return;
    let ip = document.getElementById('ip').value.trim();
    if (!ip) return;
    if (!ip.includes(':')) ip = ip + ':5555';
    const command = "su 0 /data/local/tmp/iotools rdmsr 0 0x610; su 0 /data/local/tmp/iotools rdmsr 0 0x601";
    sendAdb(['-s', ip, 'shell', command]);
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
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const indexMap = { 'monitor': 0, 'tuning': 1, 'satlab': 2 };
    if (document.querySelectorAll('.tab-btn')[indexMap[tabName]]) {
        document.querySelectorAll('.tab-btn')[indexMap[tabName]].classList.add('active');
    }
    const tabEl = document.getElementById(`tab-${tabName}`);
    if (tabEl) tabEl.classList.add('active');
    if (tabName === 'tuning') requestTuningDefaults();
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
    let ip = ipEl.value.trim();
    if (!ip) return alert("Please enter IP");
    if (!ip.includes(':')) ip = ip + ':5555';
    
    const consoleBox = document.getElementById('console');
    consoleBox.innerText = `[TPTS] [1/2] Resetting ADB interface. Disconnecting ${ip}...\n`;
    
    sendAdb(['disconnect', ip]);

    setTimeout(() => {
        consoleBox.innerText += `[TPTS] [2/2] Re-establishing fresh connection link to ${ip}...\n`;
        sendAdb(['connect', ip]);
    }, 300);
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

    let ip = document.getElementById('ip').value.trim();
    if (!ip.includes(':')) ip = ip + ':5555';

    // 🎯【正確鎖定】：100% 走 Linux 核心 sysfs 指令，同時加入 MSR 暫存器轟炸
    monitorTimer = setInterval(() => {
        const megaCommand = `su 0 sh -c 'for z in /sys/class/thermal/thermal_zone*; do t=\$(cat \$z/type 2>/dev/null); if [ "\$t" = "x86_pkg_temp" ]; then echo "TARGET_SYSFS_TEMP: \$(cat \$z/temp)"; fi; done'; su 0 /data/local/tmp/iotools rdmsr 0 0x19C; su 0 /data/local/tmp/iotools rdmsr 0 0x610; su 0 /data/local/tmp/iotools rdmsr 0 0x601; su 0 /data/local/tmp/iotools rdmsr 0 0x64F; su 0 /data/local/tmp/iotools rdmsr 0 0x6B0`;
        sendAdb(['-s', ip, 'shell', megaCommand]);
    }, 1000);
}

// =========================================================
// CHART DIAGRAM ENGINE (REAL-TIME OSCILLOSCOPE)
// =========================================================
let canvas, ctx; const maxDataPoints = 60; const tempHistory = [];   
const paddingLeft = 50; 
const paddingRight = 65; 
const paddingTop = 20; const paddingBottom = 30;
let chartWidth = 0; let chartHeight = 0;

function initChart() {
    canvas = document.getElementById('trendChart'); if (!canvas) return;
    ctx = canvas.getContext('2d');
    chartWidth = canvas.width - paddingLeft - paddingRight; chartHeight = canvas.height - paddingTop - paddingBottom;
    drawChartGrid();
}

function drawChartGrid() {
    if (!ctx || !canvas) return; 
    ctx.clearRect(0, 0, canvas.width, canvas.height); 
    
    ctx.strokeStyle = '#444444'; 
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
        const tempVal = i * 20; 
        const y = paddingTop + chartHeight - (tempVal * (chartHeight / 100));
        ctx.beginPath(); ctx.moveTo(paddingLeft, y); ctx.lineTo(canvas.width - paddingRight, y); ctx.stroke();
        
        ctx.fillStyle = '#ffffff'; 
        ctx.font = 'bold 12px monospace'; 
        ctx.textAlign = 'right'; 
        ctx.fillText(`${tempVal}°C`, paddingLeft - 10, y + 4);
    }
    
    ctx.textAlign = 'center';
    for (let s = 0; s <= 6; s++) {
        const secLabel = (6 - s) * 10; 
        const x = paddingLeft + (s * (chartWidth / 6));
        ctx.beginPath(); ctx.moveTo(x, paddingTop); ctx.lineTo(x, canvas.height - paddingBottom); ctx.stroke();
        
        if (secLabel === 0) {
            ctx.fillStyle = '#00ffcc'; 
            ctx.font = 'bold 12px monospace';
            ctx.fillText("Live (0s)", x, canvas.height - paddingBottom + 18);
        } else {
            ctx.fillStyle = '#ffffff'; 
            ctx.font = 'bold 12px monospace';
            ctx.fillText(`-${secLabel}s`, x, canvas.height - paddingBottom + 18);
        }
    }
    
    ctx.strokeStyle = '#555555'; 
    ctx.strokeRect(paddingLeft, paddingTop, chartWidth, chartHeight);
}

function updateChart(newTemp) {
    if (!ctx) return; 

    filterWindow.push(newTemp);
    if (filterWindow.length > WINDOW_SIZE) filterWindow.shift();

    const sum = filterWindow.reduce((a, b) => a + b, 0);
    const smoothedTemp = Math.round((sum / filterWindow.length) * 10) / 10;

    tempHistory.push(smoothedTemp); 
    if (tempHistory.length > maxDataPoints) tempHistory.shift();
    
    drawChartGrid(); 
    if (tempHistory.length < 2) return; 

    ctx.beginPath(); 
    ctx.lineWidth = 3; 
    ctx.strokeStyle = '#00ffcc'; 
    const stepX = chartWidth / (maxDataPoints - 1);
    
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
    ctx.shadowColor = '#00ffcc';
    ctx.shadowBlur = 4;
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'left'; 
    ctx.fillText(` ${newTemp}°C`, lastX + 5, lastY - 2);
    ctx.shadowBlur = 0; 
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

        // ⚡ MSR 0x610 (PL1 / PL2) 安全字串切片拆解大腦 ➔ 直接填入 Label 靠右小字提示中
        const v610 = document.getElementById('v610'); 
        if (rawLog.includes("0x610") || (hexTokens && hexTokens.length > 0 && rawLog.includes("610"))) {
            const hex610 = hexTokens[hexTokens.length - 1]; 
            if (hex610 && hex610.startsWith("0x") && hex610.length >= 10) {
                try {
                    let hexStr = hex610.substring(2).padStart(16, '0');
                    let low32 = hexStr.substring(8);
                    let pl1_raw = parseInt(low32.substring(4), 16) & 0x7FFF;
                    let pl1_watts = pl1_raw * 0.125;

                    let high32 = hexStr.substring(0, 8);
                    let pl2_raw = parseInt(high32.substring(4), 16) & 0x7FFF;
                    let pl2_watts = pl2_raw * 0.125;

                    const pl1El = document.getElementById('v-pl1');
                    const pl2El = document.getElementById('v-pl2');
                    const pl1Text = formatPowerWatts(pl1_watts);
                    const pl2Text = formatPowerWatts(pl2_watts);
                    if (pl1El) pl1El.innerText = `${pl1Text} W`;
                    if (pl2El) pl2El.innerText = `${pl2Text} W`;
                    setTuningFieldDefault('tune-pl1', pl1_watts);
                    setTuningFieldDefault('tune-pl2', pl2_watts);
                    tuningDefaults.pl1 = pl1_watts;
                    tuningDefaults.pl2 = pl2_watts;
                    tryFinishTuningDefaultsSync();
                    if (v610) v610.innerText = hex610;
                } catch (e) {}
            }
        }

        // ⚡ MSR 0x601 (PL4) 安全直接解析大腦 ➔ 直接填入 PL4 Label 靠右小字提示中
        if (rawLog.includes("0x601") || (hexTokens && hexTokens.length > 0 && rawLog.includes("601"))) {
            const hex601 = hexTokens[hexTokens.length - 1];
            if (hex601 && hex601.startsWith("0x")) {
                try {
                    let pl4_raw = parseInt(hex601, 16) & 0xFFFF;
                    let pl4_watts = pl4_raw * 0.125;
                    const pl4El = document.getElementById('v-pl4');
                    const pl4Text = formatPowerWatts(pl4_watts);
                    if (pl4El) pl4El.innerText = `${pl4Text} W`;
                    setTuningFieldDefault('tune-pl4', pl4_watts);
                    tuningDefaults.pl4 = pl4_watts;
                    tryFinishTuningDefaultsSync();
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
            if (tempVEl) tempVEl.innerText = `${discoveredTemp} °C`; 
            updateChart(discoveredTemp); 
        }

        // 剩餘普通 MSR 欄位轉填
        const v64f = document.getElementById('v64f'); const v6b0 = document.getElementById('v6b0');
        if (rawLog.includes("TELEMETRY_DATA:")) {
            if (hexTokens && hexTokens.length >= 3) {
                if (v610 && !rawLog.includes("610")) v610.innerText = hexTokens[0]; 
                if (v64f) v64f.innerText = hexTokens[1];
                if (v6b0) v6b0.innerText = hexTokens[2];
            }
        } else if (!isPipelineRunning && hexTokens && hexTokens.length > 0) {
            for (let i = 0; i < hexTokens.length; i++) {
                const token = hexTokens[i];
                if (token.toLowerCase().includes("64f") && i + 1 < hexTokens.length && v64f) { v64f.innerText = hexTokens[i + 1]; }
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
            const tuningTab = document.getElementById('tab-tuning');
            if (tuningTab && tuningTab.classList.contains('active')) requestTuningDefaults();
        }
    }
};

window.addEventListener('load', () => {
    initChart();
    ['tune-pl1', 'tune-pl2', 'tune-pl4'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            el.dataset.userEdited = "1";
        });
    });
});