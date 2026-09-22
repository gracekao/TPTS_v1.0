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
let monitoringElapsedTimer = null;
let monitoringStartedAt = null;
let lastMonitoringElapsedSeconds = 0;
let pipelineCountdownTimer = null;
let pipelineCountdownRemaining = 0;
let wasMonitoringBeforePipeline = false; 
let hasSyncedTuningDefaults = false;
const tuningDefaults = { pl1: null, pl2: null, pl4: null };
const tuningDefaultRegisters = { msr610: null, msr601: null };
let tuningSyncInProgress = false;
let tuningSyncBuffer = '';
let tuningSyncRetries = 0;
let latestPackagePower = null;
let latestPl1 = null;
let latestPl2 = null;
let namedRaplActive = false;
let detectedFanCount = 0;
let detectedFanRpms = [];
let detectedFanDuty = [];
const fanDutyUserEdited = new Set();
let fanControlRenderedCount = -1;
let fanReadbackActive = false;
let latestSocTemp = null;
let latestTcc = 0;
let latestProchot = 0;
let latestPowerLimit = 0;
let latestTelemetryAt = 0;
const thermalZoneMetricKeys = new Map();
const thermalZoneColors = ['#f472b6', '#a3e635', '#818cf8', '#facc15', '#2dd4bf', '#fb7185', '#c084fc'];
let latestIaPower = null;
let latestGtPower = null;
let latestCpuFreqGhz = null;
let currentPowerLimitRegister = '';
let currentPowerLimit4Register = '';
// Device identity, resolved once after connect.
let deviceProductName = '';
let devicePlatformName = '';
// Full-session snapshot log (one row per sample tick) used by the Export CSV Log button; reset whenever monitoring (re)starts.
let telemetryLog = [];
let telemetryExportSelection = null;
// uncore energy counter updates slower than the 1s in-sample window, so GT is derived across samples
let lastUncoreEnergyUj = null;
let lastUncoreSampleMs = 0;
let telemetrySampler = null;
// Cards sample continuously after connect; curves only draw when charting is on (Start Monitoring button).
let chartingActive = false;
let telemetryHistoryReadyAt = 0;
let telemetryDebugEnabled = false;
let pendingChartTemperature = null;
let pendingChartTimer = null;
let pendingStructuredTemperature = null;
let awaitingStructuredSampleEnd = false;
let thermalJsonPath = '';
let thermalJsonDefaultPath = '';
let thermalJsonDefaultText = '';
let thermalJsonLoadBuffer = '';
let thermalJsonLoading = false;
let thermalJsonApplyBuffer = '';
let thermalJsonApplying = false;
let thermalJsonPreviewOnly = false;
let autoTuneDryRun = null;
let autoTuneResult = null;
let thermalTuneSamples = [];
let thermalTuneTriggered = false;
let thermalTuneAverages = {};

// 🌊【移動平均快取】：供 Canvas 繪圖平滑化使用
const filterWindow = [];
const WINDOW_SIZE = 4; 
const powerFilterWindow = [];
const POWER_FILTER_WINDOW_SIZE = 4;
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

const MAX_CONSOLE_LINES = 500;

// Caps stored log lines so the DOM text node can't grow unbounded over a long session
function trimConsoleLog(consoleBox) {
    if (!consoleBox) return;
    const lines = consoleBox.innerText.split('\n');
    if (lines.length > MAX_CONSOLE_LINES) {
        consoleBox.innerText = lines.slice(lines.length - MAX_CONSOLE_LINES).join('\n');
    }
}

function appendConsole(message) {
    const consoleBox = document.getElementById('console');
    if (!consoleBox) return;
    consoleBox.innerText += `${message}\n`;
    trimConsoleLog(consoleBox);
    consoleBox.scrollTop = consoleBox.scrollHeight;
}

function setTelemetryDebug(enabled) {
    telemetryDebugEnabled = Boolean(enabled);
    appendConsole(`[Telemetry Debug] ${telemetryDebugEnabled ? 'Enabled' : 'Disabled'}`);
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

function switchSidebarTab(tabName) {
    document.querySelectorAll('[data-sidebar-tab]').forEach((button) => {
        button.classList.toggle('active', button.dataset.sidebarTab === tabName);
    });
    document.querySelectorAll('.sidebar-tab-content').forEach((content) => {
        content.hidden = content.id !== `sidebar-${tabName}`;
    });
    if (tabName === 'tuning' && isDeviceConnected) {
        clearTuningUserEditedFlags();
        requestTuningDefaults(true);
    }
}

function syncConnectionUi() {
    document.querySelectorAll('[data-requires-connection]:not(.sidebar-tab-content)').forEach((element) => {
        element.hidden = !isDeviceConnected;
    });
    if (isDeviceConnected) {
        switchSidebarTab('live');
    } else {
        document.querySelectorAll('.sidebar-tab-content').forEach((content) => { content.hidden = true; });
    }
    const note = document.getElementById('connection-ready-note');
    if (note) note.hidden = isDeviceConnected;
}

function captureTelemetryExportSelection() {
    const selectedMetrics = [];
    if (isMetricEnabled('soc-temp')) selectedMetrics.push({ header: 'temperature_c', value: (row) => row.temp });
    if (isMetricEnabled('cpu-freq')) selectedMetrics.push({ header: 'cpu_freq_ghz', value: (row) => row.cpuFreqGhz });
    if (isMetricEnabled('package-power')) selectedMetrics.push({ header: 'package_power_w', value: (row) => row.pkg });
    if (isMetricEnabled('ia-power')) selectedMetrics.push({ header: 'ia_power_w', value: (row) => row.ia });
    if (isMetricEnabled('gt-power')) selectedMetrics.push({ header: 'gt_power_w', value: (row) => row.gt });
    thermalZoneMetricKeys.forEach((zone) => {
        if (isMetricEnabled(zone.metricKey)) {
            selectedMetrics.push({ header: `${zone.label}_c`, value: (row) => row.thermalZones?.[zone.metricKey] });
        }
    });
    if (isMetricEnabled('fan')) selectedMetrics.push({ type: 'fan' });
    return selectedMetrics;
}

function exportTelemetryLog() {
    if (telemetryLog.length === 0) {
        alert('No telemetry data available to export yet. Start Monitoring first.');
        return;
    }
    const selectedMetrics = telemetryExportSelection ? telemetryExportSelection.slice() : captureTelemetryExportSelection();
    const fanMetricIndex = selectedMetrics.findIndex((metric) => metric.type === 'fan');
    if (fanMetricIndex >= 0) {
        const maxFans = telemetryLog.reduce((max, row) => Math.max(max, row.fans?.length || 0), 0);
        const fanColumns = Array.from({ length: maxFans }, (_, index) => ({ header: `fan${index}_rpm`, value: (row) => row.fans?.[index] }));
        selectedMetrics.splice(fanMetricIndex, 1, ...fanColumns);
    }
    const header = ['sample', 'elapsed_s', 'timestamp', ...selectedMetrics.map((metric) => metric.header)];
    const rows = [header.join(',')];
    const startMs = telemetryLog[0].t;
    telemetryLog.forEach((r, index) => {
        const cells = [
            index + 1, Math.round((r.t - startMs) / 1000), new Date(r.t).toISOString(),
            ...selectedMetrics.map((metric) => metric.value(r) ?? '')
        ];
        rows.push(cells.join(','));
    });
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tpts_telemetry_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}

function isMetricEnabled(metric) {
    const input = document.querySelector(`[data-metric="${metric}"]`);
    return Boolean(input && input.checked);
}

function syncDashboardMetrics() {
    document.querySelectorAll('[data-metric-card]').forEach((card) => {
        card.hidden = !isMetricEnabled(card.dataset.metricCard);
    });
    const temperaturePanel = document.querySelector('[data-chart-panel="temperature"]');
    const temperatureMetrics = ['soc-temp', ...[...thermalZoneMetricKeys.values()].map((zone) => zone.metricKey)];
    if (temperaturePanel) temperaturePanel.hidden = !temperatureMetrics.some(isMetricEnabled);
    const powerMetrics = ['package-power', 'pl1-power', 'pl2-power', 'ia-power', 'gt-power'];
    const powerPanel = document.querySelector('[data-chart-panel="power"]');
    if (powerPanel) powerPanel.hidden = !powerMetrics.some(isMetricEnabled);
    document.querySelectorAll('[data-power-legend]').forEach((legend) => {
        legend.hidden = !isMetricEnabled(legend.dataset.powerLegend);
    });
    renderTemperatureLegend();
    requestAnimationFrame(() => {
        if (temperaturePanel && !temperaturePanel.hidden) { resizeChartCanvas(); redrawChart(); }
        if (powerPanel && !powerPanel.hidden) { resizePowerChartCanvas(); redrawPowerChart(); }
    });
}

function renderTemperatureLegend() {
    const legend = document.getElementById('temperature-chart-legend');
    if (!legend) return;
    legend.replaceChildren();
    const series = [];
    if (isMetricEnabled('soc-temp')) series.push({ label: 'SoC', color: TEMP_CHART_COLOR });
    thermalZoneMetricKeys.forEach((zone) => {
        if (isMetricEnabled(zone.metricKey)) series.push({ label: zone.label, color: zone.color });
    });
    series.forEach(({ label, color }) => {
        const item = document.createElement('span');
        item.className = 'legend-item';
        item.style.color = color;
        item.innerText = label;
        legend.appendChild(item);
    });
}

function resetThermalZoneMetrics() {
    thermalZoneMetricKeys.clear();
    document.querySelectorAll('[data-thermal-zone]').forEach((element) => element.remove());
}

function renderThermalZoneMetric(zoneIndex, zoneType, rawTemperature) {
    const displayType = zoneType.replace(/_+$/, '');
    if (/^x86_pkg_temp$/i.test(displayType)) return;

    const metricKey = `thermal-zone-${zoneIndex}`;
    const safeType = displayType.replace(/[^a-zA-Z0-9_.-]/g, '_');
    let card = document.querySelector(`[data-metric-card="${metricKey}"]`);
    if (!card) {
        const color = thermalZoneColors[thermalZoneMetricKeys.size % thermalZoneColors.length];
        thermalZoneMetricKeys.set(zoneIndex, { metricKey, label: safeType, color, history: [] });
        const metricList = document.getElementById('live-metric-options');
        const metricCards = document.getElementById('live-metric-cards');
        if (!metricList || !metricCards) return;

        const option = document.createElement('label');
        option.className = 'check-row';
        option.dataset.thermalZone = zoneIndex;
        option.innerHTML = `<input type="checkbox" data-metric="${metricKey}"> ${safeType}`;
        const input = option.querySelector('input');
        if (input) input.addEventListener('change', syncDashboardMetrics);
        metricList.appendChild(option);

        card = document.createElement('div');
        card.className = 'metric';
        card.dataset.metricCard = metricKey;
        card.dataset.thermalZone = zoneIndex;
        card.style.setProperty('--accent', color);
        card.hidden = true;
        card.innerHTML = `<span class="metric-label">${safeType}</span><strong class="metric-value">-- °C</strong>`;
        metricCards.appendChild(card);
        renderTemperatureLegend();
    }

    const temperature = rawTemperature > 1000 ? rawTemperature / 1000 : rawTemperature;
    const value = card.querySelector('.metric-value');
    if (value) value.innerText = `${formatTemperatureCelsius(temperature)} °C`;
    updateThermalZoneChart(metricKey, temperature);
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
    fanEl.innerText = fanRpms.map((rpm, index) => `F${index + 1}: ${rpm ?? '--'}`).join('\n');
    fanEl.title = fanRpms.map((rpm, index) => `Fan ${index}: ${rpm ?? '--'} RPM`).join('\n');
    syncFanControlInputs();
}

function updateMonitorEvent(eventName, state, level = '') {
    const row = document.querySelector(`[data-event-row="${eventName}"]`);
    if (!row) return;
    row.classList.toggle('active', level === 'active');
    row.classList.toggle('warn', level === 'warn');
    const stateEl = row.querySelector('.event-state');
    if (stateEl) stateEl.innerText = state;
}

function updateMonitorEvents() {
    const temp = latestSocTemp;
    const fanReadings = detectedFanRpms.slice(0, detectedFanCount).filter((rpm) => Number.isFinite(rpm));
    const fanStalled = detectedFanCount > 0 && temp >= 70 && fanReadings.length >= detectedFanCount && fanReadings.every((rpm) => rpm <= 0);
    updateMonitorEvent('tcc', latestTcc ? 'ACTIVE' : 'OK', latestTcc ? 'active' : '');
    updateMonitorEvent('prochot', latestProchot ? 'ACTIVE' : 'OK', latestProchot ? 'active' : '');
    updateMonitorEvent('power', latestPowerLimit ? 'ACTIVE' : 'OK', latestPowerLimit ? 'active' : '');
    updateMonitorEvent('temperature', temp >= 92 ? 'CRITICAL' : temp >= 85 ? 'HIGH' : 'OK', temp >= 92 ? 'active' : temp >= 85 ? 'warn' : '');
    updateMonitorEvent('fan', fanStalled ? 'CHECK FAN' : detectedFanCount > 0 ? 'OK' : 'NOT DETECTED', fanStalled ? 'active' : detectedFanCount > 0 ? '' : 'warn');
    const telemetryAge = latestTelemetryAt ? Date.now() - latestTelemetryAt : Number.POSITIVE_INFINITY;
    updateMonitorEvent('telemetry', telemetryAge > 3000 ? 'STALE' : latestTelemetryAt ? 'LIVE' : 'WAITING', telemetryAge > 3000 ? 'warn' : '');
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
    latestPl1 = pl1_watts;
    latestPl2 = pl2_watts;
    const pl1Card = document.getElementById('v-pl1-live');
    const pl2Card = document.getElementById('v-pl2-live');
    if (pl1Card) pl1Card.innerText = `${pl1Text} W`;
    if (pl2Card) pl2Card.innerText = `${pl2Text} W`;
    currentPowerLimitRegister = hex610;
    if (v610) v610.innerText = hex610;

    setTuningFieldDefault('tune-pl1', pl1_watts);
    setTuningFieldDefault('tune-pl2', pl2_watts);

}

function decodeAndRenderPL4From601(hex601) {
    if (!hex601 || !hex601.startsWith('0x')) return;
    let pl4_raw = parseInt(hex601, 16) & 0x1FFF;     // bit 0:12
    let pl4_watts = pl4_raw * 0.125;

    const pl4El = document.getElementById('v-pl4');
    const pl4Text = formatPowerWatts(pl4_watts);
    if (pl4El) pl4El.innerText = `${pl4Text} W`;
    currentPowerLimit4Register = hex601;
    setTuningFieldDefault('tune-pl4', pl4_watts);
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
    sendBackendCommand(args);
}

function sendBackendCommand(args, content = '') {
    if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'exec', args: args, content: content }));
    } else {
        const consoleBox = document.getElementById('console');
        if (consoleBox) { consoleBox.innerHTML += `\n❌ [Error] WebSocket disconnected!\n`; trimConsoleLog(consoleBox); }
    }
}

function setThermalJsonStatus(message, isError = false) {
    const statusEl = document.getElementById('thermal-json-status');
    if (!statusEl) return;
    statusEl.innerText = message;
    statusEl.style.color = isError ? '#ff6672' : '#8990aa';
}

function getCurrentTarget() {
    return normalizeTarget(document.getElementById('ip') ? document.getElementById('ip').value : '');
}

function loadThermalJsonConfig() {
    if (!isDeviceConnected) return alert('Connect device first!');
    const target = getCurrentTarget();
    if (!target) return alert('Please enter IP or local');
    showThermalJsonWorkspace();
    setThermalJsonStatus('Loading thermal_info_config.json from device...');
    sendBackendCommand(['THERMAL_JSON_LOAD', target]);
}

function showThermalJsonWorkspace() {
    const workspace = document.getElementById('thermal-json-workspace');
    if (workspace) workspace.hidden = false;
}

function hideThermalJsonEditor() {
    const workspace = document.getElementById('thermal-json-workspace');
    if (workspace) workspace.hidden = true;
}

function openThermalJsonEditor(loadFromDevice = false) {
    showThermalJsonWorkspace();
    requestAnimationFrame(() => {
        document.getElementById('thermal-json-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.getElementById('thermal-json-editor')?.focus();
    });
    if (loadFromDevice) loadThermalJsonConfig();
}

function validateThermalJsonEditor(format = true) {
    const editor = document.getElementById('thermal-json-editor');
    if (!editor || !editor.value.trim()) {
        setThermalJsonStatus('No JSON loaded.', true);
        return false;
    }
    try {
        const result = parseThermalJsonText(editor.value);
        const parsed = result.value;
        if (format) editor.value = JSON.stringify(parsed, null, 2);
        setThermalJsonStatus(result.normalized ? 'JSON is valid. Trailing commas were normalized.' : 'JSON is valid.');
        return true;
    } catch (error) {
        setThermalJsonStatus(`JSON error: ${describeJsonParseError(editor.value, error)}`, true);
        return false;
    }
}

function stripJsonTrailingCommas(text) {
    let output = '';
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            output += char;
            continue;
        }
        if (char === ',') {
            let nextIndex = index + 1;
            while (nextIndex < text.length && /\s/.test(text[nextIndex])) nextIndex += 1;
            if (text[nextIndex] === '}' || text[nextIndex] === ']') continue;
        }
        output += char;
    }
    return output;
}

function parseThermalJsonText(text) {
    const cleaned = text.replace(/^\uFEFF/, '');
    try {
        return { value: JSON.parse(cleaned), normalized: false };
    } catch (strictError) {
        const normalized = stripJsonTrailingCommas(cleaned);
        if (normalized !== cleaned) {
            return { value: JSON.parse(normalized), normalized: true };
        }
        throw strictError;
    }
}

function describeJsonParseError(text, error) {
    const message = error && error.message ? error.message : String(error);
    const positionMatch = message.match(/position\s+(\d+)/i);
    if (!positionMatch) return message;
    const position = Number(positionMatch[1]);
    const before = text.slice(0, position);
    const line = before.split(/\r?\n/).length;
    const column = before.length - before.lastIndexOf('\n');
    return `${message} (line ${line}, column ${column})`;
}

function applyThermalJsonConfig() {
    if (!isDeviceConnected) return alert('Connect device first!');
    if (thermalJsonPreviewOnly) return alert('This is a HAL overlay preview, not a complete device JSON. Load the full device JSON before saving.');
    const editor = document.getElementById('thermal-json-editor');
    const pathEl = document.getElementById('thermal-json-path');
    const target = getCurrentTarget();
    const path = pathEl ? pathEl.value.trim() : thermalJsonPath;
    if (!target) return alert('Please enter IP or local');
    if (!editor || !editor.value.trim()) return alert('Load or paste thermal JSON first.');
    if (!path || path === 'Not loaded') return alert('Load the target file path from device first.');
    if (!validateThermalJsonEditor(false)) return;
    showThermalJsonWorkspace();
    setThermalJsonStatus('Saving JSON to /data/local/tmp and restarting thermal HAL...');
    sendBackendCommand(['THERMAL_JSON_APPLY', target, path], editor.value);
}

function restoreThermalJsonDefault() {
    if (!isDeviceConnected) return alert('Connect device first!');
    const target = getCurrentTarget();
    const pathEl = document.getElementById('thermal-json-path');
    const path = pathEl ? pathEl.value.trim() : thermalJsonPath;
    if (!target) return alert('Please enter IP or local');
    if (!path || path === 'Not loaded') return alert('Load the target file path from device first.');
    showThermalJsonWorkspace();
    setThermalJsonStatus('Restoring default thermal JSON and restarting thermal HAL...');
    sendBackendCommand(['THERMAL_JSON_RESTORE_DEFAULT', target, path]);
}

function processThermalJsonBackendOutput(rawLog) {
    if (rawLog.includes('TPTS_THERMAL_JSON_LOAD_BEGIN')) {
        thermalJsonLoading = true;
        thermalJsonLoadBuffer = '';
    }
    if (thermalJsonLoading) {
        thermalJsonLoadBuffer += rawLog;
        if (!rawLog.includes('TPTS_THERMAL_JSON_LOAD_END')) return true;
        thermalJsonLoading = false;
        const pathMatch = thermalJsonLoadBuffer.match(/TPTS_THERMAL_PATH:\s*([^\r\n]+)/);
        const defaultPathMatch = thermalJsonLoadBuffer.match(/TPTS_THERMAL_DEFAULT_PATH:\s*([^\r\n]+)/);
        const defaultCreatedMatch = thermalJsonLoadBuffer.match(/TPTS_THERMAL_DEFAULT_CREATED:\s*(\d+)/);
        const jsonMatch = thermalJsonLoadBuffer.match(/TPTS_THERMAL_JSON_BEGIN\r?\n([\s\S]*?)\r?\nTPTS_THERMAL_JSON_END/);
        if (pathMatch) {
            thermalJsonPath = pathMatch[1].trim();
            const pathEl = document.getElementById('thermal-json-path');
            if (pathEl) pathEl.value = thermalJsonPath;
        }
        if (defaultPathMatch) {
            thermalJsonDefaultPath = defaultPathMatch[1].trim();
            const defaultPathEl = document.getElementById('thermal-json-default-path');
            if (defaultPathEl) defaultPathEl.value = thermalJsonDefaultPath;
        }
        if (jsonMatch) {
            thermalJsonPreviewOnly = false;
            const editor = document.getElementById('thermal-json-editor');
            const jsonText = jsonMatch[1];
            let loadedNormalized = false;
            try {
                const result = parseThermalJsonText(jsonText);
                loadedNormalized = result.normalized;
                editor.value = JSON.stringify(result.value, null, 2);
            } catch (error) {
                editor.value = jsonText;
            }
            const backupText = defaultCreatedMatch && defaultCreatedMatch[1] === '1' ? ' Default backup created.' : ' Default backup ready.';
            const normalizeText = loadedNormalized ? ' Trailing commas normalized.' : '';
            setThermalJsonStatus(`Loaded ${jsonText.length} bytes from device.${backupText}${normalizeText}`);
            appendConsole(`[Thermal JSON] Loaded ${thermalJsonPath || 'thermal_info_config.json'} from device.${backupText}${normalizeText}`);
        } else {
            setThermalJsonStatus('Load failed: JSON markers were not found.', true);
        }
        const defaultJsonMatch = thermalJsonLoadBuffer.match(/TPTS_THERMAL_DEFAULT_JSON_BEGIN\r?\n([\s\S]*?)\r?\nTPTS_THERMAL_DEFAULT_JSON_END/);
        if (defaultJsonMatch) thermalJsonDefaultText = defaultJsonMatch[1].trim();
        thermalJsonLoadBuffer = '';
        return true;
    }

    if (rawLog.includes('TPTS_THERMAL_APPLY_BEGIN')) {
        thermalJsonApplying = true;
        thermalJsonApplyBuffer = '';
    }
    if (thermalJsonApplying) {
        thermalJsonApplyBuffer += rawLog;
        if (!rawLog.includes('TPTS_THERMAL_APPLY_END')) return true;
        thermalJsonApplying = false;
        const verifyMatch = thermalJsonApplyBuffer.match(/TPTS_THERMAL_VERIFY_BEGIN\r?\n([\s\S]*?)\r?\nTPTS_THERMAL_VERIFY_END/);
        const verifyText = verifyMatch ? verifyMatch[1].trim() : '';
        const errorMatch = thermalJsonApplyBuffer.match(/TPTS_THERMAL_ERROR:\s*([^\r\n]+)/);
        const restartConfirmedMatch = thermalJsonApplyBuffer.match(/TPTS_THERMAL_RESTART_CONFIRMED=(\d)/);
        const svcMatch = thermalJsonApplyBuffer.match(/TPTS_THERMAL_SVC_BEGIN\r?\n([\s\S]*?)\r?\nTPTS_THERMAL_SVC_END/);
        const svcText = svcMatch ? svcMatch[1].trim() : '';
        const logcatMatch = thermalJsonApplyBuffer.match(/TPTS_THERMAL_LOGCAT_BEGIN\r?\n([\s\S]*?)\r?\nTPTS_THERMAL_LOGCAT_END/);
        const logcatText = logcatMatch ? logcatMatch[1].trim() : '';
        if (thermalJsonApplyBuffer.includes('TPTS_THERMAL_APPLY_DONE')) {
            const restored = thermalJsonApplyBuffer.includes('TPTS_THERMAL_RESTORE_DEFAULT_DONE');
            const contentMatched = thermalJsonApplyBuffer.includes('CONTENT_MATCH=1');
            const restartConfirmed = restartConfirmedMatch ? restartConfirmedMatch[1] === '1' : null;
            const statusPrefix = restored ? 'Default restored' : 'Applied';
            const restartText = restartConfirmed === null ? 'vendor.thermal-hal restart not verified.' : (restartConfirmed ? 'vendor.thermal-hal confirmed restarted (running -> stopped -> running).' : 'vendor.thermal-hal restart NOT confirmed (stop did not take effect).');
            setThermalJsonStatus(`${statusPrefix}. ${contentMatched ? 'Target content verified.' : 'Check verification output.'} ${restartText}`, restartConfirmed === false);
            appendConsole(`[Thermal JSON] ${statusPrefix}. ${contentMatched ? 'Target content matches source.' : 'Content match was not confirmed.'} ${restartText} ${verifyText || 'Mount verification returned no matching line.'}`);
            if (svcText) appendConsole(`[Thermal JSON] vendor.thermal-hal state:\n${svcText}`);
            if (logcatText) appendConsole(`[Thermal JSON] Recent logcat (pixel-thermal):\n${logcatText}`);
            // Refresh the editor with what is now actually on device so it never shows stale content after a restore.
            if (restored && contentMatched) loadThermalJsonConfig();
        } else if (errorMatch) {
            setThermalJsonStatus(errorMatch[1], true);
            appendConsole(`[Thermal JSON] ${errorMatch[1]}`);
        } else {
            setThermalJsonStatus('Apply finished without success marker. Check system log.', true);
            appendConsole('[Thermal JSON] Apply finished without success marker.');
        }
        thermalJsonApplyBuffer = '';
        return true;
    }

    const errorMatch = rawLog.match(/TPTS_THERMAL_ERROR:\s*([^\r\n]+)/);
    if (errorMatch) {
        setThermalJsonStatus(errorMatch[1], true);
        appendConsole(`[Thermal JSON] ${errorMatch[1]}`);
        return true;
    }
    return false;
}

function prefetchThermalJsonReference(target) {
    if (!target) return;
    sendBackendCommand(['THERMAL_JSON_LOAD', target]);
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
    const command = "su 0 sh -c 'v610=$(/data/local/tmp/iotools rdmsr 0 0x610 2>/dev/null); [ -z \"$v610\" ] && v610=$(/data/local/tmp/iotools rdmsr 0x610 2>/dev/null); v601=$(/data/local/tmp/iotools rdmsr 0 0x601 2>/dev/null); [ -z \"$v601\" ] && v601=$(/data/local/tmp/iotools rdmsr 0x601 2>/dev/null); defaults=/data/local/tmp/tpts_power_limit_defaults; created=0; case \"$v610\" in 0x[0-9A-Fa-f]*) valid610=1;; *) valid610=0;; esac; case \"$v601\" in 0x[0-9A-Fa-f]*) valid601=1;; *) valid601=0;; esac; if [ \"$valid610\" = 1 ] && [ \"$valid601\" = 1 ] && { [ ! -s \"$defaults\" ] || ! grep -q \"^MSR_610=0x[0-9A-Fa-f]\" \"$defaults\" || ! grep -q \"^MSR_601=0x[0-9A-Fa-f]\" \"$defaults\"; }; then printf \"MSR_610=%s\\nMSR_601=%s\\n\" \"$v610\" \"$v601\" > \"$defaults\"; created=1; fi; d610=$(sed -n \"s/^MSR_610=//p\" \"$defaults\" | head -n 1); d601=$(sed -n \"s/^MSR_601=//p\" \"$defaults\" | head -n 1); echo TPTS_TUNING_SYNC_BEGIN; echo MSR_610: ${v610:-NA}; echo MSR_601: ${v601:-NA}; echo TPTS_DEFAULT_610: ${d610:-NA}; echo TPTS_DEFAULT_601: ${d601:-NA}; echo TPTS_DEFAULTS_CREATED: $created; echo TPTS_TUNING_SYNC_END'";
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
    tuningDefaultRegisters.msr610 = null;
    tuningDefaultRegisters.msr601 = null;
    ['tune-pl1', 'tune-pl2', 'tune-pl4'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) delete el.dataset.userEdited;
    });
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

// Resolves product name and CPU platform string once after connecting.
function requestDeviceProfile(target) {
    const resolved = normalizeTarget(target || (document.getElementById('ip') ? document.getElementById('ip').value : ''));
    if (!resolved) return;
    const cmd = "su 0 sh -c 'echo TPTS_PRODUCT: $(getprop ro.product.product.name); echo TPTS_CPUMODEL: $(grep -m1 \"model name\" /proc/cpuinfo | sed \"s/.*: //\")'";
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
    resetLiveDeviceState();
    
    const consoleBox = document.getElementById('console');
    consoleBox.innerText = `[TPTS] [1/2] Resetting ADB interface. Disconnecting ${ip}...\n`;
    
    if (isLocalTarget(ip)) {
        sendAdb(['disconnect', ip]);
    } else {
        sendAdb(['disconnect', ip]);
    }

    setTimeout(() => {
        consoleBox.innerText += `[TPTS] [2/2] Re-establishing fresh connection link to ${ip}...\n`;
        trimConsoleLog(consoleBox);
        if (isLocalTarget(ip)) {
            sendAdb(['LOCAL_CONNECT']);
        } else {
            sendAdb(['connect', ip]);
        }
    }, 300);
}

function resetLiveDeviceState() {
    latestPackagePower = null;
    latestPl1 = null;
    latestPl2 = null;
    latestIaPower = null;
    latestGtPower = null;
    latestSocTemp = null;
    clearTemperatureHistories();
    powerHistory.length = 0;
    pl1PowerHistory.length = 0;
    pl2PowerHistory.length = 0;
    iaPowerHistory.length = 0;
    gtPowerHistory.length = 0;
    powerFilterWindow.length = 0;
    lastUncoreEnergyUj = null;
    lastUncoreSampleMs = 0;
    drawChartGrid();
    drawPowerChartGrid();
    ['v-temp', 'v-power', 'v-pl1-live', 'v-pl2-live', 'v-ia-power', 'v-gt-power'].forEach((id) => {
        const element = document.getElementById(id);
        if (element) element.innerText = id === 'v-fan' ? '--' : '-- W';
    });
    const tempElement = document.getElementById('v-temp');
    if (tempElement) tempElement.innerText = '-- °C';
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
    const base610Text = v610El ? v610El.innerText.trim() : currentPowerLimitRegister;
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

    const base601Text = currentPowerLimit4Register;
    if (!/^0x[0-9a-fA-F]+$/.test(base601Text)) {
        alert("Cannot read current MSR 0x601. Open Tuning tab after connection to sync defaults first.");
        return;
    }

    const base601 = BigInt(base601Text);
    const pl4Mask = 0x1FFFn;           // 0x601[12:0]
    const msr610 = msr610Value.toString(16);
    const msr601 = ((base601 & ~pl4Mask) | (BigInt(pl4Raw) & pl4Mask)).toString(16);

    const cmd = `su 0 sh -c '/data/local/tmp/iotools wrmsr 0 0x610 0x${msr610}; /data/local/tmp/iotools wrmsr 0 0x601 0x${msr601}; echo MSR_610: $(/data/local/tmp/iotools rdmsr 0 0x610); echo MSR_601: $(/data/local/tmp/iotools rdmsr 0 0x601)'`;

    if (isLocalTarget(target)) {
        sendAdb(['shell', cmd]);
    } else {
        sendAdb(['-s', target, 'shell', cmd]);
    }

    const consoleBox = document.getElementById('console');
    if (consoleBox) {
        consoleBox.innerText += `[Tuning] Applied PL limits: PL1=${pl1}W, PL2=${pl2}W, PL4=${pl4}W\n`;
        trimConsoleLog(consoleBox);
        consoleBox.scrollTop = consoleBox.scrollHeight;
    }

    const pl1El = document.getElementById('v-pl1');
    const pl2El = document.getElementById('v-pl2');
    const pl4El = document.getElementById('v-pl4');
    latestPl1 = pl1;
    latestPl2 = pl2;
    if (pl1El) pl1El.innerText = `${formatPowerWatts(pl1)} W`;
    if (pl2El) pl2El.innerText = `${formatPowerWatts(pl2)} W`;
    if (pl4El) pl4El.innerText = `${formatPowerWatts(pl4)} W`;
    const pl1LiveEl = document.getElementById('v-pl1-live');
    const pl2LiveEl = document.getElementById('v-pl2-live');
    if (pl1LiveEl) pl1LiveEl.innerText = `${formatPowerWatts(pl1)} W`;
    if (pl2LiveEl) pl2LiveEl.innerText = `${formatPowerWatts(pl2)} W`;
    redrawPowerChart();
}

function resetPowerLimitsToSystemDefault() {
    const { msr610, msr601 } = tuningDefaultRegisters;
    if (!msr610 || !msr601) {
        alert('System default power limits are not available yet. Wait for tuning values to sync.');
        return;
    }
    const target = normalizeTarget(document.getElementById('ip') ? document.getElementById('ip').value : '');
    if (!target) return;
    const command = `su 0 sh -c '/data/local/tmp/iotools wrmsr 0 0x610 ${msr610}; /data/local/tmp/iotools wrmsr 0 0x601 ${msr601}; echo MSR_610: $(/data/local/tmp/iotools rdmsr 0 0x610); echo MSR_601: $(/data/local/tmp/iotools rdmsr 0 0x601)'`;
    if (isLocalTarget(target)) {
        sendAdb(['shell', command]);
    } else {
        sendAdb(['-s', target, 'shell', command]);
    }
    currentPowerLimitRegister = msr610;
    currentPowerLimit4Register = msr601;
    // "Reset" must overwrite the editable inputs even if the user had previously typed custom values.
    ['tune-pl1', 'tune-pl2', 'tune-pl4'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) delete el.dataset.userEdited;
    });
    const pl1Input = document.getElementById('tune-pl1');
    const pl2Input = document.getElementById('tune-pl2');
    const pl4Input = document.getElementById('tune-pl4');
    if (pl1Input && tuningDefaults.pl1 !== null) pl1Input.value = formatPowerWatts(tuningDefaults.pl1);
    if (pl2Input && tuningDefaults.pl2 !== null) pl2Input.value = formatPowerWatts(tuningDefaults.pl2);
    if (pl4Input && tuningDefaults.pl4 !== null) pl4Input.value = formatPowerWatts(tuningDefaults.pl4);
    const consoleBox = document.getElementById('console');
    if (consoleBox) appendConsole('[Tuning] Restored original PL1/PL2/PL4 register defaults.');
    requestTuningDefaults(true);
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
        trimConsoleLog(consoleBox);
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
            if (isPipelineRunning) restoreAllUiToIdle();
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
    monitorBtn.style.background = isRunning ? "#ff2670" : "#0e7490";
    monitorBtn.style.color = "#ffffff";
}

function updateMonitoringElapsed(isRunning) {
    const elapsedEl = document.getElementById('monitor-elapsed');
    if (!elapsedEl) return;
    if (monitoringStartedAt !== null) {
        lastMonitoringElapsedSeconds = Math.floor((Date.now() - monitoringStartedAt) / 1000);
    }
    elapsedEl.innerText = isRunning ? `Monitoring: ${lastMonitoringElapsedSeconds}s` : `Monitor: ${lastMonitoringElapsedSeconds}s`;
    updateMonitorEvents();
}

function startMonitoringElapsedCounter() {
    monitoringStartedAt = Date.now();
    lastMonitoringElapsedSeconds = 0;
    if (monitoringElapsedTimer !== null) clearInterval(monitoringElapsedTimer);
    updateMonitoringElapsed(true);
    monitoringElapsedTimer = setInterval(() => updateMonitoringElapsed(true), 1000);
}

function stopMonitoringElapsedCounter() {
    if (monitoringElapsedTimer !== null) {
        clearInterval(monitoringElapsedTimer);
        monitoringElapsedTimer = null;
    }
    updateMonitoringElapsed(false);
    monitoringStartedAt = null;
}

function restoreAllUiToIdle() {
    if (!isPipelineRunning) return;
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
        const resumeMonitoring = wasMonitoringBeforePipeline;
        wasMonitoringBeforePipeline = false;
        chartingActive = true;
        startLiveTelemetryLoop(!resumeMonitoring);
        renderMonitorButton(true);
    }
    toggleFanInput();
    toggleStressWorkloadOptions();
}

function toggleStressWorkloadOptions() {
    const aquariumEnabled = document.querySelector('input[name="stress-workload"][value="aquarium"]')?.checked;
    const fishCount = document.getElementById('aquarium-fish-count');
    if (fishCount) fishCount.disabled = !aquariumEnabled;
}

function startThermalPipeline() {
    if (!isDeviceConnected) return alert("Connect device first!");
    
    if (isPipelineRunning) {
        sendAdb(['STOP_PIPELINE']);
        stopPipelineCountdown();
        restoreAllUiToIdle();
        return;
    }

    const workloads = [...document.querySelectorAll('input[name="stress-workload"]:checked')].map((input) => input.value);
    if (workloads.length === 0) {
        return alert("Select at least one stress workload.");
    }

    if (monitorTimer !== null) {
        wasMonitoringBeforePipeline = true;
        clearInterval(monitorTimer);
        monitorTimer = null; 
    } else {
        wasMonitoringBeforePipeline = false;
    }

    lockGlobalUiForPipeline();
    thermalTuneSamples = [];
    thermalTuneTriggered = false;
    chartingActive = true;
    if (!wasMonitoringBeforePipeline) {
        clearTemperatureHistories();
        powerHistory.length = 0;
        pl1PowerHistory.length = 0;
        pl2PowerHistory.length = 0;
        iaPowerHistory.length = 0;
        gtPowerHistory.length = 0;
        powerFilterWindow.length = 0;
        filterWindow.length = 0;
        telemetryLog.length = 0;
        telemetryExportSelection = captureTelemetryExportSelection();
        drawChartGrid();
        drawPowerChartGrid();
    }
    const durationEl = document.getElementById('duration');
    const sec = durationEl ? durationEl.value : "60";
    const fishCountInput = document.getElementById('aquarium-fish-count');
    const fishCount = fishCountInput?.value || "30000";
    if (workloads.includes('aquarium') && (!/^\d+$/.test(fishCount) || Number(fishCount) < 1 || Number(fishCount) > 30000)) {
        restoreAllUiToIdle();
        return alert('Fish count must be an integer from 1 to 30,000.');
    }
    // Keep dashboard sampling independent from workload/browser startup. The stress
    // script can take several seconds to begin producing stdout, but charts should
    // continue receiving one telemetry sample per second immediately.
    startLiveTelemetryLoop();
    startPipelineCountdown(sec);
    
    document.getElementById('console').innerHTML += `\n[TPTS Pipeline] Starting: ${workloads.join(', ')} (${sec}s).\n`;
    sendAdb(['START_AUTOPILOT_PIPELINE', sec, workloads.join(','), fishCount]);
}

function average(values) {
    const valid = values.filter((value) => Number.isFinite(value));
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function readThermalTuneSources() {
    const values = {};
    if (Number.isFinite(latestSocTemp)) {
        values.soc = latestSocTemp;
    }
    thermalZoneMetricKeys.forEach((zone) => {
        const source = zone.label.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (source.includes('tsr0') && Number.isFinite(zone.latestTemperature)) values.tsr0 = zone.latestTemperature;
        if (source.includes('tsr1') && Number.isFinite(zone.latestTemperature)) values.tsr1 = zone.latestTemperature;
    });
    return values;
}

function getThermalTuneThresholds() {
    return {
        soc: Number(document.getElementById('auto-tune-soc-target')?.value),
        tsr0: Number(document.getElementById('auto-tune-tsr0-target')?.value),
        tsr1: Number(document.getElementById('auto-tune-tsr1-target')?.value)
    };
}

function getThermalTuneSocWindowSeconds() {
    return Number(document.getElementById('auto-tune-soc-window')?.value) || 5;
}

function findFanCoolingDevice(config) {
    const devices = Array.isArray(config?.CoolingDevices) ? config.CoolingDevices : [];
    const names = devices.map((device) => device?.Name).filter((name) => typeof name === 'string' && name.trim());
    const cdevRequests = [];
    const visit = (value) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (Array.isArray(value.BindedCdevInfo)) {
            value.BindedCdevInfo.forEach((binding) => {
                if (typeof binding?.CdevRequest === 'string') cdevRequests.push(binding);
            });
        }
        Object.values(value).forEach(visit);
    };
    visit(config);
    const binding = cdevRequests.find((item) => /fan|tfn/i.test(item.CdevRequest)) || cdevRequests[0] || null;
    return {
        name: binding?.CdevRequest || names.find((name) => /fan|tfn/i.test(name)) || names[0] || 'TFN1',
        limitInfo: Array.isArray(binding?.LimitInfo) ? binding.LimitInfo.slice() : [0, 1, 2, 3, 4, 5, 6],
        verifiedFromDefault: Boolean(binding)
    };
}

function buildFanCoolingOverlay(config, thresholds) {
    const device = findFanCoolingDevice(config);
    const makeSensor = (name, threshold, pollingDelay) => ({
        Name: `TPTS-${name}-FAN`,
        Type: 'UNKNOWN',
        VirtualSensor: true,
        Formula: 'MAXIMUM',
        Combination: [name],
        Coefficient: [1],
        Multiplier: 0.001,
        HotThreshold: ['NaN', threshold, 'NaN', 'NaN', 'NaN', 'NaN', 'NaN'],
        HotHysteresis: [0, 2, 2, 2, 2, 2, 2],
        TriggerSensor: name,
        PollingDelay: pollingDelay,
        BindedCdevInfo: [{ CdevRequest: device.name, LimitInfo: device.limitInfo }]
    });
    return {
        CoolingDevices: [{ Name: device.name }],
        Sensors: [
            makeSensor('SOC', thresholds.soc, getThermalTuneSocWindowSeconds() * 1000),
            makeSensor('TSR0', thresholds.tsr0, 1000),
            makeSensor('TSR1', thresholds.tsr1, 1000)
        ],
        deviceControl: {
            cdevRequest: device.name,
            limitInfo: device.limitInfo,
            verifiedFromDefaultJson: device.verifiedFromDefault,
            note: 'LimitInfo controls the cooling-device state vote. It is not a direct RPM value; verify the device WritePath mapping before applying. PollingDelay schedules HAL evaluation but does not calculate a five-second average; TPTS runtime guard performs the SOC average.'
        }
    };
}

function buildThermalTuneReference(trigger) {
    let baseConfig = {};
    const referenceText = thermalJsonDefaultText || document.getElementById('thermal-json-editor')?.value || '';
    if (referenceText.trim()) {
        try { baseConfig = parseThermalJsonText(referenceText).value; } catch (error) {}
    }
    const thresholds = getThermalTuneThresholds();
    const fanCoolingOverlay = buildFanCoolingOverlay(baseConfig, thresholds);
    const currentPl1 = Number(document.getElementById('tune-pl1')?.value);
    const currentPl2 = Number(document.getElementById('tune-pl2')?.value);
    const currentPl4 = Number(document.getElementById('tune-pl4')?.value);
    return {
        ...baseConfig,
        schemaVersion: 1,
        profileName: `thermal-tune-reference-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        source: 'tpts-thermal-tune-reference',
        tptsThermalTuneReference: {
            generatedAt: new Date().toISOString(),
            basedOn: thermalJsonDefaultPath || 'device default thermal_info_config.json',
            averagingWindowSeconds: getThermalTuneSocWindowSeconds(),
            thresholdsCelsius: thresholds,
            fanCoolingOverlay,
            triggeredBy: trigger,
            powerBeforeWatts: { pl1: currentPl1 + Number(document.getElementById('auto-tune-pl1-step')?.value || 0), pl2: currentPl2, pl4: currentPl4 },
            powerAfterWatts: { pl1: currentPl1, pl2: currentPl2, pl4: currentPl4 },
            note: 'Reference only. Review and apply manually; TPTS does not write this JSON automatically.'
        }
    };
}

function evaluateThermalTuneGuard() {
    if (!isPipelineRunning || !autoTuneDryRun || thermalTuneTriggered) return;
    const sources = readThermalTuneSources();
    if (!Object.keys(sources).length) return;
    thermalTuneSamples.push({ at: Date.now(), values: sources });
    const windowSeconds = getThermalTuneSocWindowSeconds();
    const now = Date.now();
    const cutoff = now - windowSeconds * 1000;
    thermalTuneSamples = thermalTuneSamples.filter((sample) => sample.at >= cutoff);
    const thresholds = getThermalTuneThresholds();
    const step = Number(document.getElementById('auto-tune-pl1-step')?.value);
    const currentPl1 = Number(document.getElementById('tune-pl1')?.value);
    if (!Number.isFinite(currentPl1) || !Number.isFinite(step)) return;
    const averages = {};
    const socValues = thermalTuneSamples.map((sample) => sample.values.soc).filter(Number.isFinite);
    const socWindowReady = thermalTuneSamples.length > 1 && (now - thermalTuneSamples[0].at) >= windowSeconds * 1000;
    if (socWindowReady && socValues.length) averages.soc = average(socValues);
    if (Number.isFinite(sources.tsr0)) averages.tsr0 = sources.tsr0;
    if (Number.isFinite(sources.tsr1)) averages.tsr1 = sources.tsr1;
    thermalTuneAverages = averages;
    const trigger = Object.entries(averages).find(([sensor, value]) => Number.isFinite(thresholds[sensor]) && value >= thresholds[sensor]);
    if (!trigger) return;
    const [triggeredSensor, averageTemperature] = trigger;
    const target = thresholds[triggeredSensor];
    const nextPl1 = Math.max(0.125, Math.round((currentPl1 - step) / 0.125) * 0.125);
    const pl1Input = document.getElementById('tune-pl1');
    if (pl1Input) {
        pl1Input.value = formatPowerWatts(nextPl1);
        pl1Input.dataset.userEdited = '1';
    }
    thermalTuneTriggered = true;
    applyPowerLimits();
    autoTuneResult = buildThermalTuneReference({ sensor: triggeredSensor, averageC: averageTemperature, thresholdC: target });
    appendConsole(`[Thermal Tune] ${triggeredSensor} 5s average ${averageTemperature.toFixed(1)} C reached limit ${target} C. PL1 reduced from ${currentPl1.toFixed(3)} W to ${nextPl1.toFixed(3)} W.`);
    const statusEl = document.getElementById('auto-tune-status');
    if (statusEl) statusEl.innerText = 'Thermal tune is running. SOC uses its average window; TSR0/TSR1 use current values.';
}

function formatTuneValue(value, digits = 1, suffix = '') {
    return Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : '--';
}

function renderThermalTuneResult(averages, triggeredSensor = null) {
    const resultEl = document.getElementById('auto-tune-result');
    const summaryEl = document.getElementById('auto-tune-summary');
    const stateEl = document.getElementById('auto-tune-result-state');
    if (!resultEl || !summaryEl || !stateEl) return;
    const thresholds = getThermalTuneThresholds();
    const lines = [`Thermal results (SOC ${getThermalTuneSocWindowSeconds()}s average; TSR0/TSR1 current):`];
    ['soc', 'tsr0', 'tsr1'].forEach((sensor) => {
        const averageValue = averages[sensor];
        const limit = thresholds[sensor];
        const mode = sensor === 'soc' ? 'avg' : 'now';
        const state = Number.isFinite(averageValue) ? (averageValue >= limit ? 'OVER' : 'OK') : 'NO DATA';
        lines.push(`${sensor.toUpperCase()} (${mode}): ${formatTuneValue(averageValue, 1, ' °C')} / limit ${formatTuneValue(limit, 1, ' °C')} ${state}`);
    });
    const currentPl1 = Number(document.getElementById('tune-pl1')?.value);
    lines.push(`PL1 now: ${formatTuneValue(currentPl1, 3, ' W')}`);
    lines.push(triggeredSensor ? `Triggered by: ${triggeredSensor.toUpperCase()}` : 'No sensor exceeded its limit.');
    resultEl.hidden = false;
    stateEl.innerText = triggeredSensor ? 'Power reduced' : 'Completed';
    summaryEl.innerText = lines.join('\n');
}

function updateAutoTuneObjectiveHint() {
    const hintEl = document.getElementById('auto-tune-objective-hint');
    if (!hintEl) return;
    const hints = {
        quiet: 'Recommended: Quiet<br>Reason: Prioritizes lower temperature and fan noise',
        balanced: 'Recommended: Balanced<br>Reason: Best starting point for sustained performance tuning',
        performance: 'Recommended: Performance<br>Reason: Prioritizes maximum sustained performance'
    };
    hintEl.innerHTML = hints[objective] || hints.balanced;
}

function startAutoTuneDryRun() {
    if (!isDeviceConnected) return alert('Connect device first!');
    if (isPipelineRunning) return;
    const thresholds = getThermalTuneThresholds();
    if (Object.values(thresholds).some((value) => !Number.isFinite(value) || value < 1 || value > 120)) return alert('Set valid SOC, TSR0, and TSR1 temperature limits.');
    const workloads = [...document.querySelectorAll('input[name="stress-workload"]:checked')].map((input) => input.value);
    if (!workloads.length) return alert('Select at least one stress workload.');
    const duration = Number(document.getElementById('duration')?.value || 60);
    autoTuneDryRun = { thresholds, workloads, duration, startedAt: Date.now() };
    autoTuneResult = null;
    const downloadButton = document.getElementById('auto-tune-download');
    if (downloadButton) downloadButton.title = 'Available after Thermal Tune generates a reference JSON.';
    thermalTuneSamples = [];
    thermalTuneTriggered = false;
    thermalTuneAverages = {};
    const resultEl = document.getElementById('auto-tune-result');
    const summaryEl = document.getElementById('auto-tune-summary');
    const stateEl = document.getElementById('auto-tune-result-state');
    if (resultEl) resultEl.hidden = true;
    if (summaryEl) summaryEl.textContent = '';
    if (stateEl) stateEl.textContent = 'Running';
    prefetchThermalJsonReference(getCurrentTarget());
    const statusEl = document.getElementById('auto-tune-status');
    if (statusEl) statusEl.innerText = 'Thermal tune in progress. Each sensor uses its own 5-second average limit.';
    startThermalPipeline();
}

function finishLegacyAutoTuneDryRun() {
    if (!autoTuneDryRun || autoTuneResult || telemetryLog.length === 0) return;
    const session = autoTuneDryRun;
    if (thermalTuneTriggered) {
        const statusEl = document.getElementById('auto-tune-status');
        if (statusEl) statusEl.innerText += ' Download the generated reference JSON for review.';
        autoTuneDryRun = null;
        return;
    }
    thermalTuneSamples = [];
    thermalTuneTriggered = false;
    const resultEl = document.getElementById('auto-tune-result');
    const summaryEl = document.getElementById('auto-tune-summary');
    const stateEl = document.getElementById('auto-tune-result-state');
    if (resultEl) resultEl.hidden = true;
    if (summaryEl) summaryEl.textContent = '';
    if (stateEl) stateEl.textContent = 'Running';
    const samples = telemetryLog.filter((sample) => sample.t >= session.startedAt - 2000 && Number.isFinite(sample.temp));
    if (samples.length < 3) {
        const statusEl = document.getElementById('auto-tune-status');
        if (statusEl) statusEl.innerText = 'Dry run ended without enough telemetry samples.';
        autoTuneDryRun = null;
        return;
    }
    const peakTempC = Math.max(...samples.map((sample) => sample.temp));
    const averageTempC = average(samples.map((sample) => sample.temp));
    const averagePowerW = average(samples.map((sample) => sample.pkg));
    const averageCpuFreqGhz = average(samples.map((sample) => sample.cpuFreqGhz));
    const throttleSeconds = samples.filter((sample) => sample.tcc || sample.prochot).length;
    const unsafe = peakTempC >= session.hardLimitC || throttleSeconds > 0;
    const currentPl1 = Number(document.getElementById('tune-pl1')?.value);
    const currentPl2 = Number(document.getElementById('tune-pl2')?.value);
    const currentPl4 = Number(document.getElementById('tune-pl4')?.value);
    const adjustment = unsafe ? -1 : peakTempC > session.targetTempC ? -0.5 : peakTempC < session.targetTempC - 4 ? 0.5 : 0;
    const recommendation = Number.isFinite(currentPl1) ? Math.max(0.125, Math.round((currentPl1 + adjustment) / 0.125) * 0.125) : null;
    autoTuneResult = { schemaVersion: 1, profileName: `dry-run-${session.objective}-${new Date().toISOString().slice(0, 10)}`, source: 'tpts-auto-tune-dry-run', objective: session.objective, safety: { targetTempC: session.targetTempC, hardLimitC: session.hardLimitC, abortOnTcc: true, abortOnProchot: true }, controls: { pl1Watts: recommendation, pl2Watts: Number.isFinite(currentPl2) ? currentPl2 : null, pl4Watts: Number.isFinite(currentPl4) ? currentPl4 : null, fanMode: document.getElementById('tune-fan-mode')?.value || 'auto' }, measured: { samples: samples.length, durationSec: session.duration, averageTempC, peakTempC, averagePackagePowerW: averagePowerW, averageCpuFreqGhz, throttleSeconds }, recommendation: unsafe ? 'Reduce PL1 before the next test; do not apply this result automatically.' : adjustment > 0 ? 'Thermal headroom remains. Test a small PL1 increase next.' : adjustment < 0 ? 'Target temperature was exceeded. Test a small PL1 reduction next.' : 'Current PL1 is within the target temperature band.' };
    const resultPanel = document.getElementById('auto-tune-result');
    const summaryText = document.getElementById('auto-tune-summary');
    const resultState = document.getElementById('auto-tune-result-state');
    if (resultPanel) resultPanel.hidden = false;
    if (resultState) resultState.innerText = unsafe ? 'Safety review required' : 'Recommendation ready';
    if (summaryText) summaryText.innerText = `Peak temperature: ${formatTuneValue(peakTempC, 1, ' °C')}\nAverage temperature: ${formatTuneValue(averageTempC, 1, ' °C')}\nAverage package power: ${formatTuneValue(averagePowerW, 2, ' W')}\nAverage CPU frequency: ${formatTuneValue(averageCpuFreqGhz, 2, ' GHz')}\nThrottle samples: ${throttleSeconds}\nRecommended PL1 next test: ${formatTuneValue(recommendation, 3, ' W')}\n${autoTuneResult.recommendation}`;
    const statusEl = document.getElementById('auto-tune-status');
    if (statusEl) statusEl.innerText = unsafe ? 'Dry run completed. Safety event detected; no settings were changed.' : 'Dry run completed. Export the suggestion or test the recommended PL1 manually.';
    appendConsole(`[Auto Tune] Dry run complete: peak=${formatTuneValue(peakTempC, 1, 'C')}, throttle samples=${throttleSeconds}, recommended PL1=${formatTuneValue(recommendation, 3, 'W')}.`);
    autoTuneDryRun = null;
}

function finishAutoTuneDryRun() {
    if (!autoTuneDryRun) return;
    const statusEl = document.getElementById('auto-tune-status');
    const triggeredSensor = thermalTuneTriggered
        ? Object.keys(thermalTuneAverages).find((sensor) => thermalTuneAverages[sensor] >= autoTuneDryRun.thresholds[sensor])
        : null;
    renderThermalTuneResult(thermalTuneAverages, triggeredSensor);
    if (statusEl) statusEl.innerText = thermalTuneTriggered
        ? 'Thermal tune completed. Download the generated reference JSON for review.'
        : 'Tune ended without any sensor exceeding its 5-second average limit.';
    autoTuneDryRun = null;
}

function exportAutoTuneProfile() {
    if (!autoTuneResult) {
        const statusEl = document.getElementById('auto-tune-status');
        if (statusEl) statusEl.innerText = 'No generated reference is available yet. Please refer to the device default thermal JSON.';
        return alert('No generated reference is available yet. Please refer to the device default thermal JSON.');
    }
    const blob = new Blob([JSON.stringify(autoTuneResult, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${autoTuneResult.profileName}.json`;
    link.click();
    URL.revokeObjectURL(url);
}

function buildThermalTuneDeviceConfig(reference) {
    const config = JSON.parse(JSON.stringify(reference));
    const metadata = config.tptsThermalTuneReference || {};
    const overlay = metadata.fanCoolingOverlay || {};
    delete config.schemaVersion;
    delete config.profileName;
    delete config.source;
    delete config.tptsThermalTuneReference;
    if (!Array.isArray(config.Sensors)) config.Sensors = [];
    const overlaySensors = Array.isArray(overlay.Sensors) ? overlay.Sensors : [];
    const overlayNames = new Set(overlaySensors.map((sensor) => sensor.Name));
    config.Sensors = config.Sensors.filter((sensor) => !overlayNames.has(sensor?.Name)).concat(overlaySensors);
    if (!Array.isArray(config.CoolingDevices)) config.CoolingDevices = [];
    (Array.isArray(overlay.CoolingDevices) ? overlay.CoolingDevices : []).forEach((device) => {
        if (!config.CoolingDevices.some((existing) => existing?.Name === device?.Name)) config.CoolingDevices.push(device);
    });
    return config;
}

function applyAutoTuneReference() {
    if (!autoTuneResult) {
        return alert('No Thermal Tune JSON is available yet. Run Thermal Tune to completion first.');
    }
    if (!isDeviceConnected) return alert('Connect device first!');
    const confirmed = confirm('Apply the generated Thermal Tune JSON to this connected device?\n\nThis will update thermal HAL policy, including cooling-device votes, and restart vendor.thermal-hal. The original default backup is kept for Restore Default.');
    if (!confirmed) return;
    const editor = document.getElementById('thermal-json-editor');
    const pathEl = document.getElementById('thermal-json-path');
    if (!editor) return;
    if (!pathEl?.value || pathEl.value === 'Not loaded') return alert('The connected device thermal JSON path is not available yet.');
    editor.value = JSON.stringify(buildThermalTuneDeviceConfig(autoTuneResult), null, 2);
    thermalJsonPreviewOnly = false;
    showThermalJsonWorkspace();
    setThermalJsonStatus('Applying generated Thermal Tune JSON after confirmation...', false);
    applyThermalJsonConfig();
}

function startLiveTelemetry() {
    if (!isDeviceConnected) return alert("Connect device first!");
    if (isPipelineRunning) return; 

    const consoleBox = document.getElementById('console');
    const monitorBtn = document.querySelector('.btn-secondary'); 
    if (!monitorBtn) return;

    if (chartingActive) {
        chartingActive = false;
        if (monitorTimer !== null) {
            clearInterval(monitorTimer);
            monitorTimer = null;
        }
        telemetrySampler = null;
        stopMonitoringElapsedCounter();
        renderMonitorButton(false);
        consoleBox.innerHTML += `[Monitor] ⏹ Monitoring stopped.\n`;
        trimConsoleLog(consoleBox);
        consoleBox.scrollTop = consoleBox.scrollHeight;
    } else {
        // Start drawing curves from a clean slate.
        chartingActive = true;
        clearTemperatureHistories();
        powerHistory.length = 0;
        pl1PowerHistory.length = 0;
        pl2PowerHistory.length = 0;
        iaPowerHistory.length = 0;
        gtPowerHistory.length = 0;
        powerFilterWindow.length = 0;
        filterWindow.length = 0;
        telemetryLog.length = 0;
        drawChartGrid();
        drawPowerChartGrid();
        startMonitoringElapsedCounter();
        if (monitorTimer === null) startLiveTelemetryLoop();
        renderMonitorButton(true);
        consoleBox.innerHTML += `\n[Monitor] ▶️ Starting live chart rendering...\n`;
        trimConsoleLog(consoleBox);
        consoleBox.scrollTop = consoleBox.scrollHeight;
    }
}

function startLiveTelemetryLoop(resetHistory = false) {
    if (monitorTimer) {
        clearInterval(monitorTimer);
    }
    monitorTimer = null; 
    
    if (resetHistory) {
        clearTemperatureHistories();
        powerHistory.length = 0;
        pl1PowerHistory.length = 0;
        pl2PowerHistory.length = 0;
        iaPowerHistory.length = 0;
        gtPowerHistory.length = 0;
        powerFilterWindow.length = 0;
        filterWindow.length = 0;
        telemetryLog.length = 0;
    }
    lastUncoreEnergyUj = null;
    lastUncoreSampleMs = 0;
    // A prior one-shot ADB command can finish after a new session begins.
    // Temperature/frequency are available from the first read. RAPL power still
    // needs its one-second delta window, but that must not delay the temperature chart.
    telemetryHistoryReadyAt = Date.now();
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
        let megaCommand = `su 0 sh -c 'temp_value=; for z in /sys/class/thermal/thermal_zone*; do t=\$(cat \$z/type 2>/dev/null); if [ "\$t" = "x86_pkg_temp" ]; then temp_value=\$(cat \$z/temp 2>/dev/null); break; fi; done; if [ -z "\$temp_value" ] && [ -f /sys/class/thermal/thermal_zone0/temp ]; then temp_value=\$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null); fi; freq_value=; f=/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq; [ -f "\$f" ] && freq_value=\$(cat "\$f" 2>/dev/null); fan_count=\$(ectool pwmgetnumfans 2>/dev/null | sed -n "s/.*= *//p"); fan_values=; if [ -n "\$fan_count" ]; then fan_values=\$(ectool pwmgetfanrpm 2>/dev/null | sed -n "s/.*RPM: *//p" | tr "\\n" ","); else fan_count=0; for fan in /sys/class/hwmon/hwmon*/fan*_input; do if [ -f "\$fan" ]; then rpm=\$(cat "\$fan" 2>/dev/null); if [ -n "\$rpm" ]; then fan_values="\${fan_values:+\$fan_values,}\$rpm"; fan_count=\$((fan_count + 1)); fi; fi; done; fi; power_mw=; ia_mw=; gt_mw=; p=/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj; m=/sys/class/powercap/intel-rapl/intel-rapl:0/max_energy_range_uj; iap=/sys/class/powercap/intel-rapl/intel-rapl:0/intel-rapl:0:0/energy_uj; gtp=/sys/class/powercap/intel-rapl/intel-rapl:0/intel-rapl:0:1/energy_uj; if [ -f "\$p" ]; then e1=\$(cat "\$p" 2>/dev/null); ia1=; [ -f "\$iap" ] && ia1=\$(cat "\$iap" 2>/dev/null); gt1=; [ -f "\$gtp" ] && gt1=\$(cat "\$gtp" 2>/dev/null); sleep 1; e2=\$(cat "\$p" 2>/dev/null); ia2=; [ -f "\$iap" ] && ia2=\$(cat "\$iap" 2>/dev/null); gt2=; [ -f "\$gtp" ] && gt2=\$(cat "\$gtp" 2>/dev/null); if [ -n "\$e1" ] && [ -n "\$e2" ]; then d=\$((e2 - e1)); if [ \$d -lt 0 ]; then mx=\$(cat "\$m" 2>/dev/null); [ -n "\$mx" ] && d=\$((d + mx)); fi; power_mw=\$((d / 1000)); fi; if [ -n "\$ia1" ] && [ -n "\$ia2" ]; then dia=\$((ia2 - ia1)); [ \$dia -lt 0 ] && dia=0; ia_mw=\$((dia / 1000)); fi; if [ -n "\$gt1" ] && [ -n "\$gt2" ]; then dgt=\$((gt2 - gt1)); [ \$dgt -lt 0 ] && dgt=0; gt_mw=\$((dgt / 1000)); fi; fi; echo "TPTS_SAMPLE: TARGET_SYSFS_TEMP: \${temp_value:-NA} CPU_FREQ_KHZ: \${freq_value:-NA} FAN_COUNT: \${fan_count:-0} FAN_RPMS: \${fan_values:-NA} PKG_POWER_MW: \${power_mw:-NA} IA_MW: \${ia_mw:-NA} GT_MW: \${gt_mw:-NA} MSR_19C: \$(/data/local/tmp/iotools rdmsr 0 0x19C 2>/dev/null) MSR_610: \$(/data/local/tmp/iotools rdmsr 0 0x610 2>/dev/null) MSR_601: \$(/data/local/tmp/iotools rdmsr 0 0x601 2>/dev/null) MSR_64F: \$(/data/local/tmp/iotools rdmsr 0 0x64F 2>/dev/null) MSR_6B0: \$(/data/local/tmp/iotools rdmsr 0 0x6B0 2>/dev/null)"'`;
        const thermalZoneSampleSuffix = '; for z in /sys/class/thermal/thermal_zone*; do [ -d "$z" ] || continue; index=${z##*thermal_zone}; type=$(cat "$z/type" 2>/dev/null | tr "[:space:]" "_"); temp=$(cat "$z/temp" 2>/dev/null); [ -n "$type" ] && [ -n "$temp" ] && echo TPTS_THERMAL_ZONE: $index:$type:$temp; done; echo TPTS_SAMPLE_END';
        megaCommand = megaCommand.replace(/'$/, `${thermalZoneSampleSuffix}'`);
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
const TEMP_CHART_COLOR = '#ff9d6c';
const paddingLeft = 50; 
const paddingRight = 50; 
const paddingTop = 20; const paddingBottom = 30;
const chartGridColor = '#2b3147';
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
        const relX = mouseX - paddingLeft;
        const stepX = chartWidth / (maxDataPoints - 1);
        const sampleOffset = Math.max(0, maxDataPoints - tempHistory.length);
        hoveredIndex = Math.round(relX / stepX) - sampleOffset;
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
    if (!ctx) return;
    drawChartGrid();
    const series = [];
    if (isMetricEnabled('soc-temp')) series.push({ label: 'SoC', color: TEMP_CHART_COLOR, values: tempHistory });
    thermalZoneMetricKeys.forEach((zone) => {
        if (isMetricEnabled(zone.metricKey)) series.push({ label: zone.label, color: zone.color, values: zone.history });
    });
    if (!series.some((item) => item.values.length >= 2)) return;

    const stepX = chartWidth / (maxDataPoints - 1);
    series.forEach(({ color, values }) => {
        if (values.length < 2) return;
        ctx.beginPath();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        let penDown = false;
        values.forEach((temperature, index) => {
            if (temperature == null) {
                penDown = false;
                return;
            }
            const x = paddingLeft + (maxDataPoints - values.length + index) * stepX;
            const y = paddingTop + chartHeight - temperature * (chartHeight / 100);
            if (!penDown) {
                ctx.moveTo(x, y);
                penDown = true;
            } else {
                ctx.lineTo(x, y);
            }
        });
        ctx.stroke();
    });

    const hoveredSeries = series.find((item) => item.values[hoveredIndex] != null) || series[0];
    if (hoveredIndex >= 0 && hoveredIndex < hoveredSeries.values.length) {
        const hoveredX = paddingLeft + (maxDataPoints - hoveredSeries.values.length + hoveredIndex) * stepX;
        const hoveredY = paddingTop + chartHeight - (hoveredSeries.values[hoveredIndex] * (chartHeight / 100));
        
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
        
        const tooltipText = `${hoveredSeries.label} ${hoveredSeries.values[hoveredIndex]}°C`;
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        const textWidth = ctx.measureText(tooltipText).width;
        const tooltipX = hoveredX;
        const tooltipY = hoveredY - 25;
        const boxPadding = 6;
        const boxHeight = 20;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(tooltipX - textWidth / 2 - boxPadding, tooltipY - 12 - boxPadding, textWidth + boxPadding * 2, boxHeight);
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 1;
        ctx.strokeRect(tooltipX - textWidth / 2 - boxPadding, tooltipY - 12 - boxPadding, textWidth + boxPadding * 2, boxHeight);
        
        ctx.fillStyle = '#ffaa00';
        ctx.fillText(tooltipText, tooltipX, tooltipY);
    }
}

function updateChart(newTemp) {
    if (!ctx || !chartingActive) return;

    let smoothedTemp = null;
    if (isMetricEnabled('soc-temp')) {
        filterWindow.push(newTemp);

        if (filterWindow.length > WINDOW_SIZE) filterWindow.shift();

        const sum = filterWindow.reduce((a, b) => a + b, 0);
        smoothedTemp = Math.round((sum / filterWindow.length) * 10) / 10;

        tempHistory.push(smoothedTemp);
        if (tempHistory.length > maxDataPoints) tempHistory.shift();
    }
    thermalZoneMetricKeys.forEach((zone) => {
        if (isMetricEnabled(zone.metricKey)) zone.history.push(zone.latestTemperature ?? null);
        if (zone.history.length > maxDataPoints) zone.history.shift();
    });

    redrawChart();
}

function scheduleChartUpdate(temperature) {
    pendingChartTemperature = temperature;
    if (pendingChartTimer !== null) return;
    pendingChartTimer = setTimeout(() => {
        pendingChartTimer = null;
        if (pendingChartTemperature === null) return;
        const nextTemperature = pendingChartTemperature;
        pendingChartTemperature = null;
        updateChart(nextTemperature);
    }, 100);
}

function recordTelemetrySample() {
    if (!chartingActive) return;
    telemetryLog.push({
        t: Date.now(),
        temp: latestSocTemp,
        cpuFreqGhz: latestCpuFreqGhz,
        pkg: latestPackagePower,
        ia: latestIaPower,
        gt: latestGtPower,
        tcc: latestTcc,
        prochot: latestProchot,
        fans: detectedFanRpms.slice(),
        thermalZones: Object.fromEntries([...thermalZoneMetricKeys.values()].map((zone) => [zone.metricKey, zone.latestTemperature]))
    });
}

function updateThermalZoneChart(metricKey, temperature) {
    const zone = [...thermalZoneMetricKeys.values()].find((item) => item.metricKey === metricKey);
    if (!ctx || !zone || !chartingActive || !isMetricEnabled(metricKey)) return;
    zone.latestTemperature = Math.round(temperature * 10) / 10;
}

function clearTemperatureHistories() {
    tempHistory.length = 0;
    thermalZoneMetricKeys.forEach((zone) => {
        zone.history.length = 0;
        zone.latestTemperature = null;
    });
}

let powerCanvas, powerCtx;
const powerHistory = [];
const pl1PowerHistory = [];
const pl2PowerHistory = [];
const iaPowerHistory = [];
const gtPowerHistory = [];
const PKG_POWER_COLOR = '#e8ecf5';
const IA_POWER_COLOR = '#ec4899';
const GT_POWER_COLOR = '#3ddc97';
const PL1_POWER_COLOR = '#facc15';
const PL2_POWER_COLOR = '#fb923c';
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
    const visibleValues = [
        ...(isMetricEnabled('package-power') ? powerHistory : []),
        ...(isMetricEnabled('pl1-power') ? pl1PowerHistory : []),
        ...(isMetricEnabled('pl2-power') ? pl2PowerHistory : []),
        ...(isMetricEnabled('ia-power') ? iaPowerHistory : []),
        ...(isMetricEnabled('gt-power') ? gtPowerHistory : [])
    ].filter((value) => value != null);
    const maxPower = Math.max(5, Math.ceil(Math.max(...visibleValues, 0) / 5) * 5);
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
    const visibleValues = [
        ...(isMetricEnabled('package-power') ? powerHistory : []),
        ...(isMetricEnabled('pl1-power') ? pl1PowerHistory : []),
        ...(isMetricEnabled('pl2-power') ? pl2PowerHistory : []),
        ...(isMetricEnabled('ia-power') ? iaPowerHistory : []),
        ...(isMetricEnabled('gt-power') ? gtPowerHistory : [])
    ].filter((value) => value != null);
    const maxPower = Math.max(5, Math.ceil(Math.max(...visibleValues, 0) / 5) * 5);
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
            const x = left + (maxDataPoints - series.length + index) * step;
            const y = top + height - value / maxPower * height;
            if (!penDown) { powerCtx.moveTo(x, y); penDown = true; } else { powerCtx.lineTo(x, y); }
        }
        powerCtx.stroke();
        powerCtx.restore();
    };
    if (isMetricEnabled('package-power')) drawSeries(powerHistory, PKG_POWER_COLOR, false);
    if (isMetricEnabled('pl1-power')) drawSeries(pl1PowerHistory, PL1_POWER_COLOR, true);
    if (isMetricEnabled('pl2-power')) drawSeries(pl2PowerHistory, PL2_POWER_COLOR, true);
    if (isMetricEnabled('ia-power')) drawSeries(iaPowerHistory, IA_POWER_COLOR, true);
    if (isMetricEnabled('gt-power')) drawSeries(gtPowerHistory, GT_POWER_COLOR, true);

    const powerSeries = [
        { key: 'package-power', label: 'Package', color: PKG_POWER_COLOR, values: powerHistory },
        { key: 'pl1-power', label: 'PL1', color: PL1_POWER_COLOR, values: pl1PowerHistory },
        { key: 'pl2-power', label: 'PL2', color: PL2_POWER_COLOR, values: pl2PowerHistory },
        { key: 'ia-power', label: 'IA', color: IA_POWER_COLOR, values: iaPowerHistory },
        { key: 'gt-power', label: 'GT', color: GT_POWER_COLOR, values: gtPowerHistory }
    ].filter((series) => isMetricEnabled(series.key) && series.values.length > 0);
    const latestSeries = powerSeries.filter((series) => series.values.at(-1) != null);
    latestSeries.forEach((series) => {
        const latestIndex = series.values.length - 1;
        const latestX = left + (maxDataPoints - series.values.length + latestIndex) * step;
        const latestY = top + height - series.values[latestIndex] / maxPower * height;
        powerCtx.beginPath(); powerCtx.arc(latestX, latestY, 4, 0, 2 * Math.PI); powerCtx.fillStyle = series.color; powerCtx.fill();
    });

    if (powerHoveredIndex >= 0 && powerHoveredIndex < powerHistory.length) {
        const hoverSeries = powerSeries.filter((series) => powerHoveredIndex < series.values.length && series.values[powerHoveredIndex] != null);
        if (!hoverSeries.length) return;
        const hx = left + (maxDataPoints - powerHistory.length + powerHoveredIndex) * step;
        powerCtx.strokeStyle = '#ffaa00'; powerCtx.lineWidth = 2; powerCtx.setLineDash([4, 4]);
        powerCtx.beginPath(); powerCtx.moveTo(hx, top); powerCtx.lineTo(hx, powerDisplayHeight - bottom); powerCtx.stroke();
        powerCtx.setLineDash([]);
        hoverSeries.forEach((series) => {
            const value = series.values[powerHoveredIndex];
            const hy = top + height - value / maxPower * height;
            powerCtx.beginPath(); powerCtx.arc(hx, hy, 5, 0, 2 * Math.PI); powerCtx.fillStyle = series.color; powerCtx.fill();
            powerCtx.strokeStyle = '#ffffff'; powerCtx.lineWidth = 2; powerCtx.stroke();
        });
        const tooltipLines = hoverSeries.map((series) => ({ text: `${series.label} ${series.values[powerHoveredIndex].toFixed(2)} W`, color: series.color }));
        powerCtx.font = 'bold 12px monospace'; powerCtx.textAlign = 'center';
        const tw = Math.max(...tooltipLines.map((line) => powerCtx.measureText(line.text).width), 0);
        const tx = hx; const ty = top + 16; const pad = 6;
        const boxH = tooltipLines.length * 14 + pad * 2;
        powerCtx.fillStyle = 'rgba(0, 0, 0, 0.8)'; powerCtx.fillRect(tx - tw / 2 - pad, ty - 12 - pad, tw + pad * 2, boxH);
        powerCtx.strokeStyle = '#ffaa00'; powerCtx.lineWidth = 1; powerCtx.strokeRect(tx - tw / 2 - pad, ty - 12 - pad, tw + pad * 2, boxH);
        tooltipLines.forEach((line, index) => { powerCtx.fillStyle = line.color; powerCtx.fillText(line.text, tx, ty + index * 14); });
    }
}

function updatePowerChart(powerWatts) {
    latestPackagePower = powerWatts;
    if (!chartingActive || !['package-power', 'pl1-power', 'pl2-power', 'ia-power', 'gt-power'].some(isMetricEnabled)) return;
    powerFilterWindow.push(powerWatts);
    if (powerFilterWindow.length > POWER_FILTER_WINDOW_SIZE) powerFilterWindow.shift();
    const smoothedPower = powerFilterWindow.reduce((sum, value) => sum + value, 0) / powerFilterWindow.length;
    powerHistory.push(Math.round(smoothedPower * 100) / 100);
    if (powerHistory.length > maxDataPoints) powerHistory.shift();
    pl1PowerHistory.push(latestPl1 != null ? Math.round(latestPl1 * 100) / 100 : null);
    if (pl1PowerHistory.length > maxDataPoints) pl1PowerHistory.shift();
    pl2PowerHistory.push(latestPl2 != null ? Math.round(latestPl2 * 100) / 100 : null);
    if (pl2PowerHistory.length > maxDataPoints) pl2PowerHistory.shift();
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
        const sampleOffset = Math.max(0, maxDataPoints - powerHistory.length);
        powerHoveredIndex = Math.round((mouseX - paddingLeft) / step) - sampleOffset;
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

        if (processThermalJsonBackendOutput(rawLog)) return;

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
            const defaultTagged610 = tuningSyncBuffer.match(/TPTS_DEFAULT_610:\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]+)/i);
            const defaultTagged601 = tuningSyncBuffer.match(/TPTS_DEFAULT_601:\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]+)/i);
            const syncTokens = tuningSyncBuffer.match(/0x[0-9a-fA-F]+|[0-9a-fA-F]{6,16}/g) || [];
            tuningSyncInProgress = false;
            tuningSyncBuffer = '';

            let sync610 = null;
            let sync601 = null;
            let default610 = null;
            let default601 = null;

            if (syncTagged610 && syncTagged610[1]) sync610 = normalizeHex(syncTagged610[1]);
            if (syncTagged601 && syncTagged601[1]) sync601 = normalizeHex(syncTagged601[1]);
            if (defaultTagged610 && defaultTagged610[1]) default610 = normalizeHex(defaultTagged610[1]);
            if (defaultTagged601 && defaultTagged601[1]) default601 = normalizeHex(defaultTagged601[1]);
            if (!sync610 && syncTokens.length >= 1) sync610 = normalizeHex(syncTokens[0]);
            if (!sync601 && syncTokens.length >= 2) sync601 = normalizeHex(syncTokens[1]);

            if (sync610 && sync601 && default610 && default601) {
                if (sync610) {
                    try { decodeAndRenderPLFrom610(sync610); } catch (e) {}
                }
                if (sync601) {
                    try { decodeAndRenderPL4From601(sync601); } catch (e) {}
                }
                if (tuningDefaults.pl1 === null && tuningDefaults.pl2 === null && tuningDefaults.pl4 === null) {
                    const default610Value = BigInt(default610);
                    const default601Value = BigInt(default601);
                    tuningDefaultRegisters.msr610 = default610;
                    tuningDefaultRegisters.msr601 = default601;
                    tuningDefaults.pl1 = Number(default610Value & 0x7FFFn) * 0.125;
                    tuningDefaults.pl2 = Number((default610Value >> 32n) & 0x7FFFn) * 0.125;
                    tuningDefaults.pl4 = Number(default601Value & 0x1FFFn) * 0.125;
                    setTuningFieldDefault('tune-pl1', tuningDefaults.pl1);
                    setTuningFieldDefault('tune-pl2', tuningDefaults.pl2);
                    setTuningFieldDefault('tune-pl4', tuningDefaults.pl4);
                    const pl1El = document.getElementById('v-pl1');
                    const pl2El = document.getElementById('v-pl2');
                    const pl4El = document.getElementById('v-pl4');
                    if (pl1El) pl1El.innerText = `${formatPowerWatts(tuningDefaults.pl1)} W`;
                    if (pl2El) pl2El.innerText = `${formatPowerWatts(tuningDefaults.pl2)} W`;
                    if (pl4El) pl4El.innerText = `${formatPowerWatts(tuningDefaults.pl4)} W`;
                    appendConsole(`[Tuning] System defaults saved: PL1=${formatPowerWatts(tuningDefaults.pl1)}W, PL2=${formatPowerWatts(tuningDefaults.pl2)}W, PL4=${formatPowerWatts(tuningDefaults.pl4)}W`);
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

        const productMatch = rawLog.match(/TPTS_PRODUCT:\s*(\S+)/i);
        if (productMatch) {
            deviceProductName = productMatch[1];
            const el = document.getElementById('v-product');
            if (el) el.innerText = deviceProductName;
        }
        const cpuModelMatch = rawLog.match(/TPTS_CPUMODEL:\s*(.+)/i);
        if (cpuModelMatch) {
            devicePlatformName = cpuModelMatch[1].trim();
            const el = document.getElementById('v-platform');
            if (el) el.innerText = devicePlatformName || '--';
        }
        for (const thermalZoneMatch of rawLog.matchAll(/TPTS_THERMAL_ZONE:\s*(\d+):([^:\s]+):(\d+(?:\.\d+)?)/g)) {
            renderThermalZoneMetric(thermalZoneMatch[1], thermalZoneMatch[2], Number(thermalZoneMatch[3]));
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
        
        if (telemetryDebugEnabled && (rawLog.includes('RAPL_NAMED:') || rawLog.includes('RAPL_RAW:'))) {
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
            latestCpuFreqGhz = Math.round((parseInt(frequencyMatch[1], 10) / 1000000) * 100) / 100;
            const frequencyEl = document.getElementById('v-freq');
            if (frequencyEl) frequencyEl.innerText = `${latestCpuFreqGhz.toFixed(2)} GHz`;
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
                latestPowerLimit = (thermReg & 1024) ? 1 : 0;
                
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
            latestTelemetryAt = Date.now();
            const tempVEl = document.getElementById('v-temp');
            if (tempVEl && isMetricEnabled('soc-temp')) tempVEl.innerText = `${formatTemperatureCelsius(discoveredTemp)} °C`;
            if (telemetryDebugEnabled) {
                consoleBox.innerHTML += `[Chart Update] Raw: ${formatTemperatureCelsius(discoveredTemp)}°C\n`;
                trimConsoleLog(consoleBox);
            }
            if (Date.now() >= telemetryHistoryReadyAt) {
                if (rawLog.includes('TPTS_SAMPLE:')) {
                    pendingStructuredTemperature = discoveredTemp;
                    awaitingStructuredSampleEnd = true;
                } else {
                    scheduleChartUpdate(discoveredTemp);
                }
            }
            updateMonitorEvents();
        }
        if (rawLog.includes('TPTS_SAMPLE_END')) {
            if (awaitingStructuredSampleEnd && pendingStructuredTemperature !== null) {
                scheduleChartUpdate(pendingStructuredTemperature);
            }
            pendingStructuredTemperature = null;
            awaitingStructuredSampleEnd = false;
        }
        if (isPipelineRunning) evaluateThermalTuneGuard();
        if (chartingActive && Date.now() >= telemetryHistoryReadyAt && (discoveredTemp !== null || rawLog.includes('TPTS_SAMPLE:'))) {
            recordTelemetrySample();
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
            trimConsoleLog(consoleBox);
            consoleBox.scrollTop = consoleBox.scrollHeight;
        }

        if (/^FINISHED:|^\[Complete\] Pipeline finished\./im.test(rawLog)) {
            finishAutoTuneDryRun();
            restoreAllUiToIdle();
        }

        if (lowOutput.includes("connected to") || lowOutput.includes("already connected")) {
            isDeviceConnected = true;
            syncConnectionUi();
            resetTuningDefaultSyncState();
            resetThermalZoneMetrics();
            const statusEl = document.getElementById('link-status');
            if (statusEl) { statusEl.innerText = "[Connected]"; statusEl.style.color = "#00ff66"; }
            const statusDot = document.querySelector('.status-dot');
            if (statusDot) { statusDot.style.background = '#18ca70'; statusDot.style.boxShadow = '0 0 10px rgba(24,202,112,.65)'; }
            
            if (!consoleBox.innerText.includes("Device is connected and ready")) {
                consoleBox.innerText += `[TPTS] Device is successfully connected and ready for actions.\n`;
                trimConsoleLog(consoleBox);
                consoleBox.scrollTop = consoleBox.scrollHeight;
            }

            const currentTarget = normalizeTarget(document.getElementById('ip') ? document.getElementById('ip').value : '');
            if (currentTarget) {
                appendConsole('[TPTS] Preparing device runtime (iotools/msr)...');
                sendAdb(['PREPARE_DEVICE', currentTarget]);
                appendConsole('[TPTS] Reading fan inventory (ectool pwmgetnumfans)...');
                requestFanInventory(currentTarget);
                setTimeout(() => requestFanInventory(currentTarget), 1200);
                requestDeviceProfile(currentTarget);
                prefetchThermalJsonReference(currentTarget);
                setTimeout(() => requestTuningDefaults(true), 350);
                // Dashboard runs continuously at 1s from connect (independent of the button).
                setTimeout(() => {
                    if (isDeviceConnected && !isPipelineRunning && monitorTimer === null) {
                        startLiveTelemetryLoop();
                        renderMonitorButton(false);
                        appendConsole('[TPTS] Dashboard live (cards, 1s). Press Start Monitoring to draw curves.');
                    }
                }, 1300);
            }

            const tuningTab = document.getElementById('sidebar-tuning');
            if (tuningTab && !tuningTab.hidden) {
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
    toggleStressWorkloadOptions();
    syncConnectionUi();
    document.querySelectorAll('[data-metric]').forEach((input) => input.addEventListener('change', syncDashboardMetrics));
    syncDashboardMetrics();
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