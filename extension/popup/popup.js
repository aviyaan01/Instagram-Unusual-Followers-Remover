/**
 * Instagram Follower Cleaner - Popup Logic
 * Coordinates controls, settings, live activity streaming, and CSV export.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const statusPill = document.getElementById('statusPill');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  const valScanned = document.getElementById('valScanned');
  const valCandidates = document.getElementById('valCandidates');
  const valRemoved = document.getElementById('valRemoved');
  const valProtected = document.getElementById('valProtected');

  const btnStart = document.getElementById('btnStart');
  const btnPause = document.getElementById('btnPause');
  const pauseBtnText = document.getElementById('pauseBtnText');
  const btnStop = document.getElementById('btnStop');

  const logTerminal = document.getElementById('logTerminal');
  const btnClearLogs = document.getElementById('btnClearLogs');

  const cfgMyUsername = document.getElementById('cfgMyUsername');
  const cfgMinDiff = document.getElementById('cfgMinDiff');
  const cfgInactiveDays = document.getElementById('cfgInactiveDays');
  const cfgKeepPosts = document.getElementById('cfgKeepPosts');
  const cfgMaxScan = document.getElementById('cfgMaxScan');
  const cfgMaxScanUnit = document.getElementById('cfgMaxScanUnit');
  const cfgScanUnlimited = document.getElementById('cfgScanUnlimited');
  const cfgMaxRemove = document.getElementById('cfgMaxRemove');
  const cfgMaxRemoveUnit = document.getElementById('cfgMaxRemoveUnit');
  const cfgRemoveUnlimited = document.getElementById('cfgRemoveUnlimited');
  const quickScanInput = document.getElementById('quickScanInput');
  const quickScanUnit = document.getElementById('quickScanUnit');
  const quickRemoveInput = document.getElementById('quickRemoveInput');
  const quickRemoveUnit = document.getElementById('quickRemoveUnit');
  const cfgLiveRemove = document.getElementById('cfgLiveRemove');
  const cfgSkipScanned = document.getElementById('cfgSkipScanned');
  const cfgDryRun = document.getElementById('cfgDryRun');
  const btnSaveSettings = document.getElementById('btnSaveSettings');

  const btnExportAll = document.getElementById('btnExportAll');
  const btnExportCandidates = document.getElementById('btnExportCandidates');
  const scannedUsersCount = document.getElementById('scannedUsersCount');
  const btnClearHistory = document.getElementById('btnClearHistory');

  let currentState = {
    isRunning: false,
    isPaused: false,
    statusText: 'Ready',
    scannedCount: 0,
    candidatesCount: 0,
    removedCount: 0,
    protectedCount: 0
  };

  // ==========================================
  // Tab Switching
  // ==========================================
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');
      tabBtns.forEach((b) => b.classList.remove('active'));
      tabPanes.forEach((p) => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');
    });
  });

  // ==========================================
  // Render State
  // ==========================================
  function renderState(state) {
    currentState = { ...currentState, ...state };

    valScanned.textContent = currentState.scannedCount || 0;
    valCandidates.textContent = currentState.candidatesCount || 0;
    valRemoved.textContent = currentState.removedCount || 0;
    valProtected.textContent = currentState.protectedCount || 0;

    statusText.textContent = currentState.statusText || 'Ready';

    statusPill.classList.remove('running', 'paused', 'completed');
    if (currentState.isRunning) {
      if (currentState.isPaused) {
        statusPill.classList.add('paused');
        pauseBtnText.textContent = 'Resume';
      } else {
        statusPill.classList.add('running');
        pauseBtnText.textContent = 'Pause';
      }
      btnStart.disabled = true;
      btnPause.disabled = false;
      btnStop.disabled = false;
    } else {
      if (currentState.statusText === 'Completed') {
        statusPill.classList.add('completed');
      }
      btnStart.disabled = false;
      btnPause.disabled = true;
      btnStop.disabled = true;
      pauseBtnText.textContent = 'Pause';
    }
  }

  // ==========================================
  // Log Terminal
  // ==========================================
  function appendLog(entry) {
    if (!logTerminal) return;

    const row = document.createElement('div');
    row.className = `log-line log-${entry.type || 'info'}`;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = entry.timestamp || new Date().toLocaleTimeString();

    const badgeSpan = document.createElement('span');
    badgeSpan.className = `log-badge ${entry.type || 'info'}`;
    badgeSpan.textContent = (entry.type || 'info').toUpperCase();

    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-msg';
    msgSpan.textContent = entry.message || '';

    row.appendChild(timeSpan);
    row.appendChild(badgeSpan);
    row.appendChild(msgSpan);

    logTerminal.appendChild(row);
    logTerminal.scrollTop = logTerminal.scrollHeight;
  }

  // Load existing logs
  async function loadLogs() {
    try {
      const data = await chrome.storage.local.get(['recentLogs']);
      if (data.recentLogs && Array.isArray(data.recentLogs) && data.recentLogs.length > 0) {
        logTerminal.innerHTML = '';
        data.recentLogs.forEach(appendLog);
      }
    } catch (e) {}
  }

  btnClearLogs.addEventListener('click', async () => {
    logTerminal.innerHTML = '';
    await chrome.storage.local.set({ recentLogs: [] });
  });

  // ==========================================
  // Settings Management
  // ==========================================
  const DEFAULT_CONFIG = {
    minDiff: 300,
    checkDiff: true,
    checkInactive: true,
    inactiveDaysThreshold: 60,
    keepUsersWithPostsOver: 10,
    maxFollowersToScan: 150,
    scanUnlimited: false,
    maxRemovalsPerRun: 180, // Default 180 as requested
    removalsUnlimited: false,
    removalMode: 'DIFF_OR_INACTIVE',
    liveRemoveInLoop: true,
    dryRun: false,
    skipPreviouslyScanned: true,
    visitDelayMin: 4000,
    visitDelayMax: 9000,
    removalDelayMin: 7000,
    removalDelayMax: 14000
  };

  // Synchronize Scan Target UI across quick card & settings
  function applyScanTargetUI(val, isUnlimited) {
    const scanVal = val || 150;
    if (isUnlimited) {
      if (quickScanInput) {
        quickScanInput.value = '';
        quickScanInput.placeholder = '∞';
        quickScanInput.disabled = true;
      }
      if (quickScanUnit) quickScanUnit.textContent = 'Unlimited';
      if (cfgMaxScan) {
        cfgMaxScan.value = '';
        cfgMaxScan.placeholder = '∞';
        cfgMaxScan.disabled = true;
      }
      if (cfgMaxScanUnit) cfgMaxScanUnit.textContent = 'Unlimited';
      if (cfgScanUnlimited) cfgScanUnlimited.checked = true;
    } else {
      if (quickScanInput) {
        quickScanInput.value = scanVal;
        quickScanInput.placeholder = 'Limit';
        quickScanInput.disabled = false;
      }
      if (quickScanUnit) quickScanUnit.textContent = 'accounts';
      if (cfgMaxScan) {
        cfgMaxScan.value = scanVal;
        cfgMaxScan.placeholder = 'Limit';
        cfgMaxScan.disabled = false;
      }
      if (cfgMaxScanUnit) cfgMaxScanUnit.textContent = 'limit';
      if (cfgScanUnlimited) cfgScanUnlimited.checked = false;
    }

    // Highlight matching pill across all scan preset buttons
    document.querySelectorAll('[data-scan]').forEach((btn) => {
      const btnScan = btn.getAttribute('data-scan');
      if (isUnlimited && btnScan === 'unlimited') {
        btn.classList.add('active');
      } else if (!isUnlimited && btnScan === String(scanVal)) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  // Synchronize Removal Target UI across quick card & settings
  function applyRemoveTargetUI(val, isUnlimited) {
    const removeVal = val !== undefined && val !== null ? val : 180;
    if (isUnlimited) {
      if (quickRemoveInput) {
        quickRemoveInput.value = '';
        quickRemoveInput.placeholder = '∞';
        quickRemoveInput.disabled = true;
      }
      if (quickRemoveUnit) quickRemoveUnit.textContent = 'No Cap';
      if (cfgMaxRemove) {
        cfgMaxRemove.value = '';
        cfgMaxRemove.placeholder = '∞';
        cfgMaxRemove.disabled = true;
      }
      if (cfgMaxRemoveUnit) cfgMaxRemoveUnit.textContent = 'No Cap';
      if (cfgRemoveUnlimited) cfgRemoveUnlimited.checked = true;
    } else {
      if (quickRemoveInput) {
        quickRemoveInput.value = removeVal;
        quickRemoveInput.placeholder = 'Limit';
        quickRemoveInput.disabled = false;
      }
      if (quickRemoveUnit) quickRemoveUnit.textContent = 'removals';
      if (cfgMaxRemove) {
        cfgMaxRemove.value = removeVal;
        cfgMaxRemove.placeholder = 'Limit';
        cfgMaxRemove.disabled = false;
      }
      if (cfgMaxRemoveUnit) cfgMaxRemoveUnit.textContent = 'removals';
      if (cfgRemoveUnlimited) cfgRemoveUnlimited.checked = false;
    }

    // Highlight matching pill across all remove preset buttons
    document.querySelectorAll('[data-remove]').forEach((btn) => {
      const btnRemove = btn.getAttribute('data-remove');
      if (isUnlimited && btnRemove === 'unlimited') {
        btn.classList.add('active');
      } else if (!isUnlimited && btnRemove === String(removeVal)) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  // Persist current limits to storage
  async function persistLimits(scanVal, isScanUnlimited, removeVal, isRemoveUnlimited) {
    const data = await chrome.storage.local.get(['config', 'settings']);
    const currentCfg = data.config || data.settings || DEFAULT_CONFIG;

    const updatedConfig = {
      ...currentCfg,
      maxFollowersToScan: isScanUnlimited ? null : (parseInt(scanVal, 10) || 150),
      scanUnlimited: !!isScanUnlimited,
      maxRemovalsPerRun: isRemoveUnlimited ? null : (parseInt(removeVal, 10) || 180),
      removalsUnlimited: !!isRemoveUnlimited
    };

    await chrome.storage.local.set({ config: updatedConfig, settings: updatedConfig });
  }

  async function loadSettings() {
    try {
      const data = await chrome.storage.local.get(['config', 'settings']);
      const cfg = { ...DEFAULT_CONFIG, ...(data.config || data.settings || {}) };

      const userRes = await chrome.storage.local.get(['savedUsername', 'config', 'settings']);
      if (cfgMyUsername) {
        cfgMyUsername.value = userRes.savedUsername || userRes.config?.myUsername || userRes.settings?.myUsername || '';
      }

      cfgMinDiff.value = cfg.minDiff ?? 300;
      cfgInactiveDays.value = cfg.inactiveDaysThreshold ?? 60;
      cfgKeepPosts.value = cfg.keepUsersWithPostsOver ?? 10;
      cfgLiveRemove.checked = !!cfg.liveRemoveInLoop;
      cfgSkipScanned.checked = !!cfg.skipPreviouslyScanned;
      cfgDryRun.checked = !!cfg.dryRun;

      // Apply initial limits
      applyScanTargetUI(cfg.maxFollowersToScan, !!cfg.scanUnlimited);
      applyRemoveTargetUI(cfg.maxRemovalsPerRun, !!cfg.removalsUnlimited);
    } catch (e) {}
  }

  // Click handlers for Scan Preset Buttons (Quick card & settings)
  document.querySelectorAll('[data-scan]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const val = btn.getAttribute('data-scan');
      const isUnlimited = val === 'unlimited';
      const numVal = isUnlimited ? null : parseInt(val, 10);
      applyScanTargetUI(numVal, isUnlimited);

      const isRemoveUnl = cfgRemoveUnlimited?.checked || false;
      const removeVal = isRemoveUnl ? null : (parseInt(quickRemoveInput?.value, 10) || 180);
      await persistLimits(numVal, isUnlimited, removeVal, isRemoveUnl);

      appendLog({
        timestamp: new Date().toLocaleTimeString(),
        type: 'info',
        message: isUnlimited ? 'Scan target set to Unlimited (entire followers list).' : `Scan target set to ${numVal} accounts.`
      });
    });
  });

  // Click handlers for Removal Preset Buttons (Quick card & settings)
  document.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const val = btn.getAttribute('data-remove');
      const isUnlimited = val === 'unlimited';
      const numVal = isUnlimited ? null : parseInt(val, 10);
      applyRemoveTargetUI(numVal, isUnlimited);

      const isScanUnl = cfgScanUnlimited?.checked || false;
      const scanVal = isScanUnl ? null : (parseInt(quickScanInput?.value, 10) || 150);
      await persistLimits(scanVal, isScanUnl, numVal, isUnlimited);

      appendLog({
        timestamp: new Date().toLocaleTimeString(),
        type: 'info',
        message: isUnlimited ? 'Removal limit set to Unlimited (no cap).' : `Removal safety limit set to ${numVal} accounts.`
      });
    });
  });

  // Input change handlers for Scan Targets
  function handleScanInputChange(e) {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && val > 0) {
      applyScanTargetUI(val, false);
      const isRemoveUnl = cfgRemoveUnlimited?.checked || false;
      const removeVal = isRemoveUnl ? null : (parseInt(quickRemoveInput?.value, 10) || 180);
      persistLimits(val, false, removeVal, isRemoveUnl);
    }
  }
  quickScanInput?.addEventListener('input', handleScanInputChange);
  cfgMaxScan?.addEventListener('input', handleScanInputChange);

  // Input change handlers for Removal Targets
  function handleRemoveInputChange(e) {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && val > 0) {
      applyRemoveTargetUI(val, false);
      const isScanUnl = cfgScanUnlimited?.checked || false;
      const scanVal = isScanUnl ? null : (parseInt(quickScanInput?.value, 10) || 150);
      persistLimits(scanVal, isScanUnl, val, false);
    }
  }
  quickRemoveInput?.addEventListener('input', handleRemoveInputChange);
  cfgMaxRemove?.addEventListener('input', handleRemoveInputChange);

  // Unlimited Toggles
  cfgScanUnlimited?.addEventListener('change', () => {
    const isUnlimited = cfgScanUnlimited.checked;
    const val = parseInt(quickScanInput?.value || cfgMaxScan?.value, 10) || 150;
    applyScanTargetUI(val, isUnlimited);
    const isRemoveUnl = cfgRemoveUnlimited?.checked || false;
    const removeVal = isRemoveUnl ? null : (parseInt(quickRemoveInput?.value, 10) || 180);
    persistLimits(val, isUnlimited, removeVal, isRemoveUnl);
  });

  cfgRemoveUnlimited?.addEventListener('change', () => {
    const isUnlimited = cfgRemoveUnlimited.checked;
    const val = parseInt(quickRemoveInput?.value || cfgMaxRemove?.value, 10) || 180;
    applyRemoveTargetUI(val, isUnlimited);
    const isScanUnl = cfgScanUnlimited?.checked || false;
    const scanVal = isScanUnl ? null : (parseInt(quickScanInput?.value, 10) || 150);
    persistLimits(scanVal, isScanUnl, val, isUnlimited);
  });

  btnSaveSettings.addEventListener('click', async () => {
    const minDiffVal = parseInt(cfgMinDiff.value, 10) || 300;
    const inactiveDaysVal = parseInt(cfgInactiveDays.value, 10) || 60;
    const keepPostsVal = parseInt(cfgKeepPosts.value, 10) >= 0 ? parseInt(cfgKeepPosts.value, 10) : 10;

    const isScanUnlimited = !!cfgScanUnlimited?.checked;
    const maxScanVal = isScanUnlimited ? null : (parseInt(cfgMaxScan.value, 10) || 150);

    const isRemoveUnlimited = !!cfgRemoveUnlimited?.checked;
    const maxRemoveVal = isRemoveUnlimited ? null : (parseInt(cfgMaxRemove.value, 10) || 180);

    const data = await chrome.storage.local.get(['config', 'settings']);
    const currentCfg = data.config || data.settings || DEFAULT_CONFIG;

    const usernameVal = (cfgMyUsername?.value || '').trim().replace(/^@/, '');
    if (usernameVal) {
      await chrome.storage.local.set({ savedUsername: usernameVal });
    }

    const updatedConfig = {
      ...currentCfg,
      myUsername: usernameVal || currentCfg.myUsername || '',
      minDiff: minDiffVal,
      inactiveDaysThreshold: inactiveDaysVal,
      keepUsersWithPostsOver: keepPostsVal,
      maxFollowersToScan: maxScanVal,
      scanUnlimited: isScanUnlimited,
      maxRemovalsPerRun: maxRemoveVal,
      removalsUnlimited: isRemoveUnlimited,
      liveRemoveInLoop: cfgLiveRemove.checked,
      skipPreviouslyScanned: cfgSkipScanned.checked,
      dryRun: cfgDryRun.checked
    };

    await chrome.storage.local.set({ config: updatedConfig, settings: updatedConfig });

    // Sync quick inputs on main screen
    applyScanTargetUI(maxScanVal, isScanUnlimited);
    applyRemoveTargetUI(maxRemoveVal, isRemoveUnlimited);

    btnSaveSettings.textContent = 'Settings Saved ✓';
    btnSaveSettings.style.borderColor = '#10B981';
    btnSaveSettings.style.color = '#34D399';
    setTimeout(() => {
      btnSaveSettings.textContent = 'Save Settings';
      btnSaveSettings.style.borderColor = '';
      btnSaveSettings.style.color = '';
    }, 2000);

    appendLog({
      timestamp: new Date().toLocaleTimeString(),
      type: 'info',
      message: `Config saved: Scan=${isScanUnlimited ? 'Unlimited' : maxScanVal}, RemoveLimit=${isRemoveUnlimited ? 'Unlimited' : maxRemoveVal}, minDiff=${minDiffVal}`
    });
  });

  // ==========================================
  // Scanned History Memory
  // ==========================================
  async function loadScannedCount() {
    try {
      const data = await chrome.storage.local.get(['scannedUsers']);
      const count = (data.scannedUsers && Array.isArray(data.scannedUsers)) ? data.scannedUsers.length : 0;
      scannedUsersCount.textContent = `${count} accounts`;
    } catch (e) {}
  }

  btnClearHistory.addEventListener('click', async () => {
    if (confirm('Clear scanned memory? All previously scanned accounts will be eligible for scanning again.')) {
      await chrome.storage.local.set({ scannedUsers: [] });
      scannedUsersCount.textContent = '0 accounts';
      appendLog({
        timestamp: new Date().toLocaleTimeString(),
        type: 'warning',
        message: 'Scanned accounts memory cleared.'
      });
    }
  });

  // ==========================================
  // Controls Handlers (Start / Pause / Stop)
  // ==========================================
  async function sendToContent(actionName) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: 'RELAY_TO_CONTENT', payload: { action: actionName } },
        (response) => {
          if (chrome.runtime.lastError || !response || !response.success) {
            resolve({
              success: false,
              error: response?.error || chrome.runtime.lastError?.message || 'Instagram tab not active.'
            });
          } else {
            resolve({ success: true, response });
          }
        }
      );
    });
  }

  btnStart.addEventListener('click', async () => {
    btnStart.disabled = true;
    renderState({ isRunning: true, isPaused: false, statusText: 'Starting...' });

    const res = await sendToContent('START');
    if (!res.success) {
      renderState({ isRunning: false, isPaused: false, statusText: 'Failed to start' });
      const errorMsg = res.error || 'Please open https://www.instagram.com/ in an active Chrome tab first.';
      appendLog({
        timestamp: new Date().toLocaleTimeString(),
        type: 'error',
        message: errorMsg
      });
      alert(errorMsg);
    } else {
      appendLog({
        timestamp: new Date().toLocaleTimeString(),
        type: 'info',
        message: 'Starting follower cleaner on active Instagram tab...'
      });
    }
  });

  btnPause.addEventListener('click', async () => {
    if (currentState.isPaused) {
      await sendToContent('RESUME');
      renderState({ isPaused: false, statusText: 'Resuming...' });
    } else {
      await sendToContent('PAUSE');
      renderState({ isPaused: true, statusText: 'Paused' });
    }
  });

  btnStop.addEventListener('click', async () => {
    await sendToContent('STOP');
    renderState({ isRunning: false, isPaused: false, statusText: 'Stopped' });
    appendLog({
      timestamp: new Date().toLocaleTimeString(),
      type: 'warning',
      message: 'Stopping follower cleaner process...'
    });
  });

  // ==========================================
  // CSV Export Utility
  // ==========================================
  function convertToCSV(dataRows, headers) {
    if (!dataRows || !dataRows.length) return null;

    const escapeField = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const lines = [];
    lines.push(headers.map(escapeField).join(','));

    dataRows.forEach((row) => {
      const line = headers.map((h) => escapeField(row[h] !== undefined ? row[h] : ''));
      lines.push(line.join(','));
    });

    return lines.join('\r\n');
  }

  function downloadCSV(csvContent, filename) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  btnExportAll.addEventListener('click', async () => {
    const data = await chrome.storage.local.get(['allScannedRecords']);
    const records = data.allScannedRecords || [];

    if (!records.length) {
      alert('No scanned records available to export yet. Run a scan first.');
      return;
    }

    const headers = [
      'username', 'status', 'followers', 'following', 'diff',
      'posts', 'is_inactive', 'last_post_days', 'reason'
    ];
    const csv = convertToCSV(records, headers);
    if (csv) {
      downloadCSV(csv, 'followers_report.csv');
    }
  });

  btnExportCandidates.addEventListener('click', async () => {
    const data = await chrome.storage.local.get(['removalCandidates']);
    const candidates = data.removalCandidates || [];

    if (!candidates.length) {
      alert('No candidates found yet. Run a scan first.');
      return;
    }

    const headers = [
      'username', 'status', 'followers', 'following', 'diff',
      'posts', 'is_inactive', 'last_post_days', 'reason'
    ];
    const csv = convertToCSV(candidates, headers);
    if (csv) {
      downloadCSV(csv, 'removal_candidates.csv');
    }
  });

  // ==========================================
  // Listen for Background / Content Script Updates
  // ==========================================
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'STATE_CHANGED' && message.state) {
      renderState(message.state);
      loadScannedCount();
    } else if (message.action === 'LOG_ENTRY' && message.entry) {
      appendLog(message.entry);
    }
  });

  // Initial queries on popup open
  chrome.runtime.sendMessage({ action: 'GET_STATE' }, (response) => {
    if (response && response.state) {
      renderState(response.state);
    }
  });

  await loadSettings();
  await loadLogs();
  await loadScannedCount();
});
