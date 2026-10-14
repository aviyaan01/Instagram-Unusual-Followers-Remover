/**
 * Background Service Worker (Manifest V3)
 * Manages communication between popup and Instagram content script.
 */

// Track extension state
let appState = {
  isRunning: false,
  isPaused: false,
  statusText: 'Ready',
  scannedCount: 0,
  candidatesCount: 0,
  removedCount: 0,
  protectedCount: 0
};

// Update extension icon badge
function updateBadge() {
  if (appState.isRunning) {
    if (appState.isPaused) {
      chrome.action.setBadgeText({ text: 'PAUSE' });
      chrome.action.setBadgeBackgroundColor({ color: '#F59E0B' }); // Amber
    } else {
      const txt = String(appState.removedCount || 'RUN');
      chrome.action.setBadgeText({ text: txt });
      chrome.action.setBadgeBackgroundColor({ color: '#E1306C' }); // Instagram pink
    }
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Listen for messages from popup or content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_STATE') {
    sendResponse({ state: appState });
    return true;
  }

  if (message.action === 'UPDATE_STATE') {
    appState = { ...appState, ...message.data };
    updateBadge();
    // Broadcast state update to popup if open
    chrome.runtime.sendMessage({ action: 'STATE_CHANGED', state: appState }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'RELAY_TO_CONTENT') {
    // Send command to active Instagram tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab && activeTab.url && activeTab.url.includes('instagram.com')) {
        chrome.tabs.sendMessage(activeTab.id, message.payload, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse(response || { success: true });
          }
        });
      } else {
        // Query any tab with instagram.com
        chrome.tabs.query({ url: '*://*.instagram.com/*' }, (igTabs) => {
          if (igTabs.length > 0) {
            chrome.tabs.sendMessage(igTabs[0].id, message.payload, (response) => {
              if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
              } else {
                sendResponse(response || { success: true });
              }
            });
          } else {
            sendResponse({ success: false, error: 'No Instagram tab found.' });
          }
        });
      }
    });
    return true; // Keep channel open for async response
  }
});
