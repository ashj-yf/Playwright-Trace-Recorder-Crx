// Panel script — runs inside panel.html (DevTools panel or side panel context).

'use strict';

import { getTrace } from './traceStore.js';

const recordBtn          = document.getElementById('recordBtn');
const statusBadge        = document.getElementById('statusBadge');
const recordingNameInput = document.getElementById('recordingName');
const outputDiv          = document.getElementById('output');
const refreshBtn         = document.getElementById('refreshBtn');
const outputToggle       = document.getElementById('outputToggle');
const themeSwitcher      = document.querySelector('.theme-switcher');

// ── Port connection to service worker ────────────────────────────────────────
let port = null;

function connectToServiceWorker() {
  port = chrome.runtime.connect({ name: 'ventriloquist-panel' });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectToServiceWorker, 1000);
  });
}

function onPortMessage(message) {
  switch (message.type) {
    case 'RECORDING_STATUS':
      applyStatus(message.recording, message.currentRecording);
      break;
    case 'RECORDING_STARTED':
      applyStatus(true);
      addLog('Recording started');
      break;
    case 'RECORDING_STOPPED':
      applyStatus(false);
      break;
    case 'TRACE_SAVED':
      addLog(`Trace saved locally: ${message.name || ''}`);
      loadTraces();
      break;
    case 'TRACE_ERROR':
      addLog(`Error saving trace: ${message.error}`);
      break;
    case 'EVENT_CAPTURED':
      addLog(`Captured: ${message.eventType} on ${message.selector || '(unknown)'}`);
      break;
    case 'RECORDING_LIMIT':
      addLog(message.message || 'Capture budget reached.');
      break;
    case 'TRACES_UPDATED':
      renderTraces(message.traces || []);
      break;
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function applyStatus(recording, currentRecording) {
  if (recording) {
    statusBadge.textContent = currentRecording ? `Recording: ${currentRecording.name}` : 'Recording…';
    statusBadge.className = 'status status-recording';
    recordBtn.textContent = 'Stop Recording';
    recordBtn.className = 'btn-stop';
    recordingNameInput.disabled = true;
  } else {
    statusBadge.textContent = 'Idle';
    statusBadge.className = 'status status-idle';
    recordBtn.textContent = 'Start Recording';
    recordBtn.className = 'btn-record';
    recordingNameInput.disabled = false;
  }
}

// A long recording emits an entry per captured event; without a ceiling the log
// itself becomes a memory leak in the panel document.
const MAX_LOG_ENTRIES = 200;

function addLog(message) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const ts = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="log-ts">${ts}</span>${escapeHtml(message)}`;
  outputDiv.appendChild(entry);
  outputDiv.scrollTop = outputDiv.scrollHeight;

  const logEntries = outputDiv.querySelectorAll('.log-entry');
  for (let i = 0; i < logEntries.length - MAX_LOG_ENTRIES; i++) {
    logEntries[i].remove();
  }

  // Show toggle button if there are log entries (more than the initial "Ready" message)
  if (logEntries.length > 1) {
    outputToggle.style.display = 'block';
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Theme management ───────────────────────────────────────────────────────

const THEME_STORAGE_KEY = 'ventriloquist-theme';

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getThemeIcon(currentTheme) {
  return currentTheme === 'dark' ? '☀️' : '🌙';
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
}

function updateThemeButton(theme) {
  const toggleBtn = document.getElementById('themeToggleBtn');
  if (toggleBtn) {
    toggleBtn.textContent = getThemeIcon(theme);
    toggleBtn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  }
}

function saveTheme(theme) {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

function loadSavedTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') {
    return saved;
  }
  // Default to system preference, fallback to light
  return getSystemTheme();
}

// Initialize theme on load
const savedTheme = loadSavedTheme();
applyTheme(savedTheme);
updateThemeButton(savedTheme);

// Theme toggle button event listener
const themeToggleBtn = document.getElementById('themeToggleBtn');
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    const currentTheme = loadSavedTheme();
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    saveTheme(newTheme);
    updateThemeButton(newTheme);
  });
}

// Listen for system theme changes (only when user hasn't explicitly chosen)
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (!saved) {
    applyTheme(getSystemTheme());
  }
});

// ── Recording controls ───────────────────────────────────────────────────────

recordBtn.addEventListener('click', async () => {
  recordBtn.disabled = true;
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
    if (status && status.recording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  } catch (err) {
    addLog(`Error: ${err.message}`);
  } finally {
    recordBtn.disabled = false;
  }
});

// ── Output toggle ─────────────────────────────────────────────────────────────

outputToggle.addEventListener('click', () => {
  const isHidden = outputDiv.classList.contains('hidden');
  if (isHidden) {
    outputDiv.classList.remove('hidden');
    outputToggle.textContent = 'Hide Recording Log';
  } else {
    outputDiv.classList.add('hidden');
    outputToggle.textContent = 'Show Recording Log';
  }
});

async function getInspectedTabId() {
  // In a DevTools panel, chrome.devtools is always available and authoritative.
  if (typeof chrome.devtools !== 'undefined' && chrome.devtools.inspectedWindow) {
    return chrome.devtools.inspectedWindow.tabId;
  }
  // Side-panel context: ask the service worker, which queries with
  // lastFocusedWindow:true — more reliable than currentWindow from an extension page.
  try {
    const { tabId } = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' });
    if (tabId) return tabId;
  } catch (_) {}
  // Final fallback for edge cases.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}

async function startRecording() {
  const name = recordingNameInput.value.trim() || `Recording ${new Date().toLocaleTimeString()}`;
  const tabId = await getInspectedTabId();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'START_RECORDING', name, tabId });
    if (response && response.success) {
      applyStatus(true, { name });
      addLog(`Started recording "${name}" on tab ${tabId || '?'}`);
    } else {
      addLog(`Failed to start: ${response && response.error || 'unknown error'}`);
    }
  } catch (err) {
    addLog(`Error starting recording: ${err.message}`);
  }
}

async function stopRecording() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    if (response && response.success) {
      applyStatus(false);
      addLog('Recording stopped — generating trace…');
    } else {
      addLog(`Failed to stop: ${response && response.error || 'unknown error'}`);
    }
  } catch (err) {
    addLog(`Error stopping recording: ${err.message}`);
  }
}

// ── Traces list ───────────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', loadTraces);

async function loadTraces() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_LOCAL_TRACES' });
    if (response && response.traces) {
      renderTraces(response.traces);
    } else if (response && response.error) {
      addLog(`Could not load traces: ${response.error}`);
    }
  } catch (err) {
    addLog(`Could not load traces: ${err.message}`);
  }
}

function renderTraces(traces) {
  const list = document.getElementById('traces-list');
  list.innerHTML = '';

  if (!traces || traces.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No traces recorded yet.';
    li.style.color = '#9ca3af';
    list.appendChild(li);
    return;
  }

  traces.forEach(trace => {
    const li = document.createElement('li');
    const eventCount = trace.eventCount || '?';
    const ts = trace.timestamp ? new Date(trace.timestamp).toLocaleString() : '';
    const sizeKb = trace.size ? ` · ${(trace.size / 1024).toFixed(1)} KB` : '';
    li.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <strong>${escapeHtml(trace.name || 'Untitled Trace')}</strong>
          <div class="trace-meta">${eventCount} events${ts ? ' &bull; ' + ts : ''}${escapeHtml(sizeKb)}</div>
        </div>
      </div>
      <div class="trace-actions">
        <button class="btn-download" data-id="${escapeHtml(trace.id || '')}">Download</button>
        <button class="btn-delete"   data-id="${escapeHtml(trace.id || '')}">Delete</button>
      </div>
    `;

    li.querySelector('.btn-download').addEventListener('click', async () => {
      await downloadTrace(trace);
    });

    li.querySelector('.btn-delete').addEventListener('click', async () => {
      await deleteTrace(trace.id, li);
    });

    list.appendChild(li);
  });
}

async function downloadTrace(trace) {
  addLog(`Downloading trace "${trace.name}"…`);
  try {
    const blob = await resolveTraceBlob(trace.id);
    if (!blob) {
      addLog('Download failed: trace data not found');
      return;
    }

    // The Blob is backed by the browser's blob store, so the archive is never
    // held in this page's heap.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${trace.name || 'trace'}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoking immediately can cancel the download before it starts.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    addLog(`Downloaded: ${trace.name}.zip`);
  } catch (err) {
    addLog(`Download error: ${err.message}`);
  }
}

/**
 * Read the archive directly out of IndexedDB. Older traces predate that and are
 * still base64 in chrome.storage.local, so fall back to asking the worker.
 */
async function resolveTraceBlob(id) {
  try {
    const record = await getTrace(id);
    // Archives are stored as inline bytes (durable across service-worker
    // restarts); wrap them into a Blob for the download object URL.
    if (record && record.data) {
      return new Blob([record.data], { type: 'application/zip' });
    }
  } catch (err) {
    console.warn('Could not read trace from IndexedDB:', err);
  }

  const response = await chrome.runtime.sendMessage({ type: 'GET_LEGACY_TRACE_ZIP', id });
  if (!response || !response.zipBase64) return null;
  const binary = atob(response.zipBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'application/zip' });
}

async function deleteTrace(id, li) {
  try {
    await chrome.runtime.sendMessage({ type: 'DELETE_TRACE', id });
    li.remove();
    addLog('Trace deleted');
  } catch (err) {
    addLog(`Delete error: ${err.message}`);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Load version from manifest
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_MANIFEST_VERSION' });
    if (response && response.version) {
      const versionBadge = document.getElementById('versionBadge');
      if (versionBadge) {
        versionBadge.textContent = `v${response.version}`;
      }
    }
  } catch (err) {
    console.warn('Could not load version from manifest:', err);
  }

  connectToServiceWorker();

  // Initialize toggle button state based on current log content
  const logEntries = outputDiv.querySelectorAll('.log-entry');
  if (logEntries.length <= 1) {
    outputToggle.style.display = 'none';
  } else {
    outputToggle.textContent = 'Show Recording Log';
  }

  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
    if (status) applyStatus(status.recording, status.currentRecording);
  } catch (err) {
    addLog(`Could not get recording status: ${err.message}`);
  }

  await loadTraces();
});
