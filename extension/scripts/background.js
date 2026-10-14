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

// Helper to inject content script if not already present in the tab
async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['scripts/content.js']
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return true;
  } catch (err) {
    return false;
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
    (async () => {
      // 1. Check active tab in current window
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let targetTab = null;

      if (activeTab && activeTab.url && activeTab.url.includes('instagram.com')) {
        targetTab = activeTab;
      } else {
        // 2. Check any open Instagram tab across all windows
        const igTabs = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
        if (igTabs && igTabs.length > 0) {
          targetTab = igTabs[0];
          try {
            await chrome.tabs.update(targetTab.id, { active: true });
          } catch (e) {}
        }
      }

      if (!targetTab) {
        sendResponse({
          success: false,
          error: 'Instagram is not open! Please open https://www.instagram.com/ in a Chrome tab, log in, and try again.'
        });
        return;
      }

      // 3. Send message, or auto-inject content script if receiving end does not exist
      chrome.tabs.sendMessage(targetTab.id, message.payload, async (response) => {
        if (chrome.runtime.lastError || !response) {
          // Content script was not loaded yet (e.g. tab was open before extension was installed/reloaded)
          const injected = await ensureContentScriptInjected(targetTab.id);
          if (injected) {
            chrome.tabs.sendMessage(targetTab.id, message.payload, (retryResponse) => {
              if (chrome.runtime.lastError || !retryResponse) {
                sendResponse({
                  success: false,
                  error: 'Please reload your Instagram tab (F5) and click Start Cleaner again.'
                });
              } else {
                sendResponse(retryResponse);
              }
            });
          } else {
            sendResponse({
              success: false,
              error: 'Please reload your Instagram tab (F5) and click Start Cleaner again.'
            });
          }
        } else {
          sendResponse(response);
        }
      });
    })();
    return true; // Keep channel open for async response
  }
});
