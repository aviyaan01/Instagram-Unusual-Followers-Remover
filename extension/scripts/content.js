/**
 * Instagram Follower Cleaner - Content Script
 * Executes in the context of instagram.com pages to scan, analyze, and remove followers.
 */

// State variables
let isRunning = false;
let isPaused = false;
let shouldStop = false;

// Default configuration (synced with chrome.storage.local)
let config = {
  minDiff: 300,
  checkDiff: true,
  checkInactive: true,
  inactiveDaysThreshold: 60,
  keepUsersWithPostsOver: 10,
  maxFollowersToScan: 150,
  scanUnlimited: false,
  maxRemovalsPerRun: 180, // Default 180 removals quota
  removalsUnlimited: false,
  removalMode: 'DIFF_OR_INACTIVE', // DIFF_OR_INACTIVE, DIFF_ONLY, INACTIVE_ONLY, DIFF_AND_INACTIVE
  liveRemoveInLoop: true,
  dryRun: false,
  skipPreviouslyScanned: true,
  visitDelayMin: 4000,
  visitDelayMax: 9000,
  removalDelayMin: 7000,
  removalDelayMax: 14000
};

// System paths to exclude
const SYSTEM_PATHS = new Set([
  'explore', 'reels', 'direct', 'stories', 'accounts', 'p', 'reel',
  'tv', 'tags', 'legal', 'about', 'help', 'privacy', 'terms',
  'directory', 'developer', 'creator', 'support', 'settings',
  'popular', 'locations', 'emailsignup', 'login'
]);

// Helper: sleep utilities
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

// Helper: Check rate limiting or action blocks
function checkRateLimit() {
  const text = (document.body?.innerText || '').toLowerCase();
  const patterns = [
    'try again later',
    'action blocked',
    'we restrict certain activity',
    'we limit how often',
    'temporarily blocked',
    'please wait a few minutes'
  ];
  return patterns.some((p) => text.includes(p));
}

// Log message to storage and broadcast to popup
async function logMessage(type, message, details = null) {
  const logEntry = {
    timestamp: new Date().toLocaleTimeString(),
    type, // 'info', 'success', 'warning', 'error', 'remove', 'candidate', 'keep'
    message,
    details
  };

  try {
    chrome.runtime.sendMessage({ action: 'LOG_ENTRY', entry: logEntry }).catch(() => {});

    // Save recent logs in storage (keep last 200 entries)
    const data = await chrome.storage.local.get(['recentLogs']);
    const logs = data.recentLogs || [];
    logs.push(logEntry);
    if (logs.length > 200) logs.shift();
    await chrome.storage.local.set({ recentLogs: logs });
  } catch (e) {}
}

// Broadcast status update
async function broadcastState(updates = {}) {
  try {
    chrome.runtime.sendMessage({
      action: 'UPDATE_STATE',
      data: updates
    }).catch(() => {});
  } catch (e) {}
}

// Helper: Parse follower/following/posts counts
function parseCount(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  const match = str.match(/([\d,]+(?:\.\d+)?)\s*([kmbKMB])?/i);
  if (!match) return null;

  let numStr = match[1].replace(/,/g, '');
  let val = parseFloat(numStr);
  if (isNaN(val)) return null;

  const unit = (match[2] || '').toUpperCase();
  if (unit === 'K') val *= 1000;
  else if (unit === 'M') val *= 1000000;
  else if (unit === 'B') val *= 1000000000;

  return Math.round(val);
}

// Helper: Detect active logged-in username
async function getMyUsername() {
  // Strategy 0: Check saved username in storage
  try {
    const { savedUsername, config: storedCfg, settings: storedSettings } = await chrome.storage.local.get(['savedUsername', 'config', 'settings']);
    const preconfigured = savedUsername || storedCfg?.myUsername || storedSettings?.myUsername;
    if (preconfigured && !SYSTEM_PATHS.has(preconfigured.toLowerCase())) {
      return preconfigured.trim().replace(/^@/, '');
    }
  } catch (e) {}

  // Strategy 1: Check current URL if already on own profile (e.g. instagram.com/my_name/)
  const currentPathMatch = window.location.pathname.match(/^\/([a-zA-Z0-9._]+)\/?$/);
  if (currentPathMatch && !SYSTEM_PATHS.has(currentPathMatch[1].toLowerCase())) {
    const user = currentPathMatch[1];
    chrome.storage.local.set({ savedUsername: user }).catch(() => {});
    return user;
  }

  // Strategy 2: Look at navigation links (handles both expanded and collapsed icon-only sidebar)
  const navLinks = Array.from(document.querySelectorAll('a[role="link"][href^="/"], nav a[href^="/"], div[role="navigation"] a[href^="/"], a[href^="/"]'));
  for (const link of navLinks) {
    const href = link.getAttribute('href') || '';
    const parts = href.replace(/^\/|\/$/g, '').split('/');
    const user = parts[0];
    if (user && !SYSTEM_PATHS.has(user.toLowerCase()) && /^[a-zA-Z0-9._]+$/.test(user)) {
      // Check if this link contains an avatar img, profile icon, or text
      const hasImg = !!link.querySelector('img');
      const hasProfileSvg = !!link.querySelector('svg[aria-label="Profile"]');
      const text = link.innerText.trim().toLowerCase();
      if (hasImg || hasProfileSvg || text === 'profile' || text.includes('profile')) {
        chrome.storage.local.set({ savedUsername: user }).catch(() => {});
        return user;
      }
    }
  }

  // Strategy 3: Check any avatar images with profile picture alt in the page
  const avatarImgs = Array.from(document.querySelectorAll('img[alt*="profile picture" i], img[alt*="profile" i], img[draggable="false"]'));
  for (const img of avatarImgs) {
    const parentLink = img.closest('a[href^="/"]');
    if (parentLink) {
      const href = parentLink.getAttribute('href') || '';
      const user = href.replace(/^\/|\/$/g, '').split('/')[0];
      if (user && !SYSTEM_PATHS.has(user.toLowerCase()) && /^[a-zA-Z0-9._]+$/.test(user)) {
        chrome.storage.local.set({ savedUsername: user }).catch(() => {});
        return user;
      }
    }
  }

  // Strategy 4: Search embedded JSON script tags for viewer / current user
  try {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent || '';
      const match = text.match(/"viewer"\s*:\s*\{[^}]*"username"\s*:\s*"([a-zA-Z0-9._]+)"/i) ||
                    text.match(/"raw_username"\s*:\s*"([a-zA-Z0-9._]+)"/i) ||
                    text.match(/"current_user"\s*:\s*\{[^}]*"username"\s*:\s*"([a-zA-Z0-9._]+)"/i);
      if (match && match[1] && !SYSTEM_PATHS.has(match[1].toLowerCase())) {
        const user = match[1];
        chrome.storage.local.set({ savedUsername: user }).catch(() => {});
        return user;
      }
    }
  } catch (e) {}

  return null;
}

// Helper: Close a single dialog element cleanly
function closeDialogElement(d) {
  if (!d) return;
  const closeBtn = d.querySelector(
    'svg[aria-label*="Close" i], button[aria-label*="Close" i], div[role="button"][aria-label*="Close" i], ' +
    'svg[aria-label*="বন্ধ" i], [aria-label*="বন্ধ" i], ' +
    'header button, header div[role="button"], button:has(svg), div[role="button"]:has(svg)'
  );
  if (closeBtn) {
    const clickable = closeBtn.closest('button, div[role="button"]') || closeBtn;
    try { clickable.click(); return; } catch (e) {}
  }
}

// Helper: Close Instagram dialogs cleanly
function closeInstagramDialog() {
  const dialogs = document.querySelectorAll('div[role="dialog"]');
  for (const d of dialogs) {
    closeDialogElement(d);
  }
  const escEvent = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
  document.dispatchEvent(escEvent);
  window.dispatchEvent(escEvent);
}

// Helper: Fetch and parse user profile data
async function fetchUserProfileData(username) {
  // Strategy 1: Call Instagram's internal web_profile_info endpoint (returns exact JSON counts & post dates)
  try {
    const apiRes = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
      method: 'GET',
      headers: {
        'x-ig-app-id': '936619743392459',
        'Accept': 'application/json'
      },
      credentials: 'include'
    });

    if (apiRes.ok) {
      const json = await apiRes.json();
      const user = json?.data?.user;
      if (user) {
        const followers = user.edge_followed_by?.count ?? null;
        const following = user.edge_follow?.count ?? null;
        const posts = user.edge_owner_to_timeline_media?.count ?? null;
        const isPrivate = !!user.is_private;

        let isInactive = false;
        let inactiveReason = '';
        let lastPostDays = null;

        if (config.checkInactive) {
          if (posts === 0) {
            isInactive = true;
            inactiveReason = '0 posts';
          } else if (isPrivate) {
            inactiveReason = 'private account';
          } else {
            const edges = user.edge_owner_to_timeline_media?.edges || [];
            if (edges.length > 0 && edges[0]?.node?.taken_at_timestamp) {
              const postTimestamp = edges[0].node.taken_at_timestamp * 1000;
              const postDate = new Date(postTimestamp);
              const now = new Date();
              lastPostDays = Math.floor((now - postDate) / (1000 * 60 * 60 * 24));
              if (lastPostDays >= config.inactiveDaysThreshold) {
                isInactive = true;
                inactiveReason = `inactive (${lastPostDays}d ago)`;
              } else {
                isInactive = false;
                inactiveReason = `active (${lastPostDays}d ago)`;
              }
            }
          }
        }

        if (followers !== null && following !== null) {
          return {
            userId: user.id || user.pk || null,
            followers,
            following,
            posts,
            isPrivate,
            isInactive,
            inactiveReason,
            lastPostDays
          };
        }
      }
    }
  } catch (apiErr) {
    // Continue to HTML fallback
  }

  // Strategy 2: HTML Scraping (Fallback if API endpoint is unavailable)
  try {
    const response = await fetch(`https://www.instagram.com/${username}/`, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      credentials: 'include'
    });

    if (!response.ok) return null;
    const htmlText = await response.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');

    let followers = null;
    let following = null;
    let posts = null;

    // 1. Meta tag strategy
    const meta = doc.querySelector('meta[name="description"], meta[property="og:description"]');
    if (meta && meta.content) {
      const content = meta.content;
      const mF = content.match(/([\d,.]+[kmbKMB]?)\s+Followers/i);
      const mFg = content.match(/([\d,.]+[kmbKMB]?)\s+Following/i);
      const mP = content.match(/([\d,.]+[kmbKMB]?)\s+Posts/i);

      if (mF) followers = parseCount(mF[1]);
      if (mFg) following = parseCount(mFg[1]);
      if (mP) posts = parseCount(mP[1]);
    }

    // 2. Title tag fallback
    if (followers === null || following === null) {
      const title = doc.querySelector('title')?.innerText || '';
      const mF = title.match(/([\d,.]+[kmbKMB]?)\s+Followers/i);
      const mFg = title.match(/([\d,.]+[kmbKMB]?)\s+Following/i);
      if (mF) followers = parseCount(mF[1]);
      if (mFg) following = parseCount(mFg[1]);
    }

    if (followers === null || following === null) {
      return null;
    }

    const isPrivate = htmlText.toLowerCase().includes('this account is private');
    let isInactive = false;
    let inactiveReason = '';
    let lastPostDays = null;

    if (config.checkInactive) {
      if (posts === 0) {
        isInactive = true;
        inactiveReason = '0 posts';
      } else if (isPrivate) {
        inactiveReason = 'private account';
      } else {
        const timeMatch = htmlText.match(/datetime="([^"]+)"/i) || htmlText.match(/"taken_at_timestamp":\s*(\d+)/i);
        if (timeMatch) {
          let postDate = null;
          if (timeMatch[1].includes('-')) {
            postDate = new Date(timeMatch[1]);
          } else {
            postDate = new Date(parseInt(timeMatch[1], 10) * 1000);
          }

          if (!isNaN(postDate.getTime())) {
            const now = new Date();
            lastPostDays = Math.floor((now - postDate) / (1000 * 60 * 60 * 24));
            if (lastPostDays >= config.inactiveDaysThreshold) {
              isInactive = true;
              inactiveReason = `inactive (${lastPostDays}d ago)`;
            } else {
              isInactive = false;
              inactiveReason = `active (${lastPostDays}d ago)`;
            }
          }
        }
      }
    }

    const idMatch = htmlText.match(/"user_id":"(\d+)"/) || htmlText.match(/"id":"(\d+)"/) || htmlText.match(/profilePage_([0-9]+)/);
    const userId = idMatch ? idMatch[1] : null;

    return {
      userId,
      followers,
      following,
      posts,
      isPrivate,
      isInactive,
      inactiveReason,
      lastPostDays
    };
  } catch (e) {
    return null;
  }
}

// Dismiss modals/banners
function dismissPopups() {
  for (const btn of document.querySelectorAll('button, div[role="button"]')) {
    const txt = btn.innerText?.trim();
    if (txt === 'Not now' || txt === 'Not Now' || txt === 'Cancel' || txt === 'Allow all cookies') {
      try { btn.click(); } catch (e) {}
    }
  }
}

// Open Followers modal on current profile
async function openFollowersDialog(myUsername) {
  // If dialog is ALREADY open and visible on screen, return it directly
  const existingDialogs = document.querySelectorAll('div[role="dialog"]');
  for (const d of existingDialogs) {
    if (d.offsetParent !== null && d.querySelector('input, a[href*="/followers"], ul, div[role="listitem"]')) {
      return d;
    }
  }

  // Ensure we are on user profile page
  const currentPath = window.location.pathname.replace(/^\/|\/$/g, '').toLowerCase();
  const targetLower = myUsername.toLowerCase();
  if (currentPath !== targetLower && !currentPath.startsWith(`${targetLower}/`)) {
    // Try SPA navigation via sidebar profile link first
    const profileLink = document.querySelector(`a[href="/${myUsername}/"], a[href="/${myUsername}"]`);
    if (profileLink) {
      profileLink.click();
      await sleep(2500);
    } else {
      // Set autoResume flag so script continues after full page navigation
      await chrome.storage.local.set({ autoResume: true });
      window.location.href = `https://www.instagram.com/${myUsername}/`;
      return null;
    }
  }

  dismissPopups();

  // Find followers button (English: "followers", Bengali: "অনুসারী")
  let followersBtn = document.querySelector('a[href$="/followers/"], a[href*="/followers"]');
  if (!followersBtn) {
    const allLinks = Array.from(document.querySelectorAll('a, span, div[role="button"]'));
    followersBtn = allLinks.find((el) => {
      const txt = (el.innerText || el.textContent || '').toLowerCase();
      return txt.includes('follower') || txt.includes('অনুসারী');
    });
  }

  if (!followersBtn) {
    throw new Error('Could not find Followers button on profile page.');
  }

  followersBtn.click();
  await sleep(2500);

  const dialogs = document.querySelectorAll('div[role="dialog"]');
  if (dialogs.length > 0) {
    return dialogs[0];
  }

  throw new Error('Followers dialog did not open.');
}

// Collect unscanned followers from Followers dialog
async function collectFollowers(myUsername, scannedSet) {
  const dialog = await openFollowersDialog(myUsername);
  if (!dialog) return [];

  const unscannedFollowers = new Set();
  const allSeenUsernames = new Set();
  let unchangedCount = 0;
  const maxUnchanged = 6;

  if (config.scanUnlimited) {
    logMessage('info', 'Unlimited Scan enabled: Scrolling Followers dialog to collect all unscanned accounts...');
  } else {
    logMessage('info', `Scrolling Followers dialog to collect up to ${config.maxFollowersToScan || 150} unscanned accounts...`);
  }

  while (!shouldStop) {
    while (isPaused && !shouldStop) {
      await sleep(1000);
    }
    if (shouldStop) break;

    if (checkRateLimit()) {
      logMessage('warning', 'Action limit or rate block detected. Halting collection.');
      break;
    }

    const prevSeenTotal = allSeenUsernames.size;

    // Collect visible links in dialog
    const userLinks = dialog.querySelectorAll('a[role="link"][href^="/"], a[href^="/"]');
    for (const link of userLinks) {
      const href = link.getAttribute('href') || '';
      const user = href.replace(/^\/|\/$/g, '').split('/')[0];

      if (user && !SYSTEM_PATHS.has(user) && user.toLowerCase() !== myUsername.toLowerCase() && /^[a-zA-Z0-9._]+$/.test(user)) {
        allSeenUsernames.add(user.toLowerCase());
        if (config.skipPreviouslyScanned && scannedSet.has(user.toLowerCase())) {
          continue;
        }
        unscannedFollowers.add(user);
      }
    }

    const currentUnscanned = unscannedFollowers.size;
    const currentSeen = allSeenUsernames.size;
    const targetDisplay = config.scanUnlimited ? '∞' : (config.maxFollowersToScan || '∞');

    broadcastState({
      statusText: `Collecting: ${currentSeen} seen, ${currentUnscanned}/${targetDisplay} new`,
      scannedCount: currentUnscanned
    });

    if (!config.scanUnlimited && config.maxFollowersToScan && currentUnscanned >= config.maxFollowersToScan) {
      logMessage('info', `Reached target limit of ${config.maxFollowersToScan} unscanned followers.`);
      break;
    }

    // Scroll container
    const links = dialog.querySelectorAll('a[role="link"][href^="/"], a[href^="/"]');
    if (links.length > 0) {
      links[links.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
    }

    const scrollContainers = dialog.querySelectorAll('div');
    for (const div of scrollContainers) {
      if (div.scrollHeight > div.clientHeight && div.clientHeight > 150) {
        div.scrollTop = div.scrollHeight;
        break;
      }
    }

    await randomDelay(1200, 2200);

    const newSeenTotal = allSeenUsernames.size;
    if (newSeenTotal === prevSeenTotal) {
      unchangedCount++;
      if (unchangedCount >= maxUnchanged) {
        await sleep(2000);
        if (allSeenUsernames.size === prevSeenTotal) {
          logMessage('info', 'Reached the bottom of Followers list.');
          break;
        }
      }
    } else {
      unchangedCount = 0;
    }
  }

  // Close dialog cleanly
  closeInstagramDialog();
  await sleep(1000);

  let result = Array.from(unscannedFollowers);
  if (!config.scanUnlimited && config.maxFollowersToScan) {
    result = result.slice(0, config.maxFollowersToScan);
  }

  return result;
}

// Helper: Detect if an element is a Remove button across multiple languages
function isRemoveButton(btn) {
  if (!btn) return false;
  // Ignore close buttons or search clear buttons
  if (btn.querySelector('svg[aria-label*="Close" i], svg[aria-label*="Clear" i], svg[aria-label*="বন্ধ" i]')) return false;
  const label = (btn.getAttribute('aria-label') || '').toLowerCase();
  if (label.includes('close') || label.includes('clear') || label.includes('বন্ধ') || label.includes('cancel') || label.includes('বাতিল')) return false;

  const rawText = (btn.innerText || btn.textContent || '').trim().toLowerCase();
  if (rawText.includes('cancel') || rawText.includes('বাতিল') || rawText === 'not now') return false;

  const patterns = [
    'remove',
    'মুছে',
    'রিমুভ',
    'সরান',
    'eliminar',
    'supprimer',
    'entfernen',
    'हटाएं',
    'remover'
  ];

  return patterns.some((p) => rawText.includes(p) || label.includes(p));
}

// Extract CSRF token from Instagram cookies or DOM
function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  try {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      const m = txt.match(/"csrf_token":"([^"]+)"/);
      if (m) return m[1];
    }
  } catch (e) {}
  return '';
}

// Helper: Query user ID by username if not available
async function getUserIdByUsername(username) {
  try {
    const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
      headers: {
        'x-ig-app-id': '936619743392459',
        'Accept': 'application/json'
      },
      credentials: 'include'
    });
    if (res.ok) {
      const json = await res.json();
      return json?.data?.user?.id || json?.data?.user?.pk || null;
    }
  } catch (e) {}
  return null;
}

// Live remove follower via Instagram internal Web API (Prong 1: Fastest & 100% Reliable)
async function removeFollowerApi(userId, targetUsername) {
  if (!userId) {
    userId = await getUserIdByUsername(targetUsername);
  }
  if (!userId) return false;

  const csrfToken = getCsrfToken();
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-IG-App-ID': '936619743392459',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Instagram-AJAX': '1',
    'Accept': '*/*'
  };
  if (csrfToken) {
    headers['X-CSRFToken'] = csrfToken;
  }

  const endpoints = [
    `https://www.instagram.com/api/v1/friendships/remove_follower/${userId}/`,
    `https://www.instagram.com/web/friendships/${userId}/remove_follower/`
  ];

  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: `user_id=${encodeURIComponent(userId)}`,
        credentials: 'include'
      });

      if (response.ok) {
        const json = await response.json().catch(() => null);
        if (json && (json.status === 'ok' || json.did_remove === true)) {
          logMessage('remove', `Removed @${targetUsername} live from followers.`);
          return true;
        }
      }
    } catch (e) {}
  }

  return false;
}

// Helper: Real synthetic text typing into search input
async function typeIntoSearch(input, text) {
  input.focus();
  try {
    input.scrollIntoView({ block: 'nearest' });
  } catch (e) {}

  // 1. Click clear button inside the search field if present (ONLY clear button, not svg search icon!)
  const parentWrap = input.closest('div') || input.parentElement;
  if (parentWrap) {
    const clearBtn = parentWrap.querySelector('button[aria-label*="Clear" i], div[aria-label*="Clear" i], [role="button"][aria-label*="Clear" i]');
    if (clearBtn && clearBtn !== input) {
      try { clearBtn.click(); } catch (e) {}
      await sleep(100);
    }
  }

  // 2. Clear input using selectAll + delete & native prototype
  try {
    input.select();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  } catch (e) {}

  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(input, '');
  } else {
    input.value = '';
  }
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

  await sleep(100);

  if (!text) return; // Cleared successfully

  // 3. Set text using execCommand & native setter for React/Relay synthetic events
  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, text);
  } catch (e) {}

  if (!inserted || input.value !== text) {
    if (nativeSetter) {
      nativeSetter.call(input, text);
    } else {
      input.value = text;
    }
  }

  // 4. Fire full event chain so React and search queries trigger
  input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
}

// Live remove follower on Instagram UI (Prong 2: Resilient UI Fallback)
async function removeFollowerLive(myUsername, targetUsername) {
  try {
    const dialog = await openFollowersDialog(myUsername);
    if (!dialog) return false;

    // Scroll followers container to top
    const scrollable = dialog.querySelector('div[style*="overflow"], div[class*="x1dm5hii"]')?.parentElement || dialog;
    try { scrollable.scrollTop = 0; } catch (e) {}

    // Find search input (with polling up to 3.5 seconds)
    let searchInput = null;
    const findSearchStart = Date.now();
    while (Date.now() - findSearchStart < 3500) {
      searchInput = dialog.querySelector('input[placeholder*="Search" i], input[type="text"], input[aria-label*="Search" i], input[placeholder*="অনুসন্ধান" i]');
      if (searchInput) break;
      await sleep(250);
    }

    if (!searchInput) {
      logMessage('error', 'Search input not found in Followers dialog.');
      return false;
    }

    // Type the target username into search
    await typeIntoSearch(searchInput, targetUsername);
    await sleep(1500); // Allow Instagram search debounce & rendering

    // Wait and poll for the user's row and Remove button (up to 7s)
    const lowerTarget = targetUsername.toLowerCase();
    let removeBtn = null;
    const searchWaitStart = Date.now();

    while (Date.now() - searchWaitStart < 7000) {
      if (shouldStop) break;

      const allButtons = Array.from(dialog.querySelectorAll('button, div[role="button"]'));

      // Strategy 1: Find Remove button inside row that explicitly matches targetUsername
      for (const btn of allButtons) {
        if (!isRemoveButton(btn)) continue;

        let parent = btn.parentElement;
        for (let i = 0; i < 9 && parent && parent !== dialog; i++) {
          const rowText = (parent.innerText || '').toLowerCase();
          const hasUserLink = !!parent.querySelector(`a[href*="/${targetUsername}/" i], a[href*="/${targetUsername}" i]`);
          if (hasUserLink || rowText.includes(lowerTarget)) {
            removeBtn = btn;
            break;
          }
          parent = parent.parentElement;
        }
        if (removeBtn) break;
      }

      // Strategy 2: If only 1 action button exists in dialog outside header, that's our target in filtered search results
      if (!removeBtn) {
        const resultButtons = allButtons.filter((b) => {
          if (!isRemoveButton(b)) return false;
          return !b.closest('header, [role="banner"]');
        });

        if (resultButtons.length === 1) {
          removeBtn = resultButtons[0];
          break;
        } else if (resultButtons.length > 1) {
          for (const btn of resultButtons) {
            const container = btn.closest('div[role="listitem"], li') || btn.parentElement?.parentElement;
            if (container && (container.innerText || '').toLowerCase().includes(lowerTarget)) {
              removeBtn = btn;
              break;
            }
          }
          if (removeBtn) break;
        }
      }

      // Strategy 3: Find user's link directly and search for button in that row
      if (!removeBtn) {
        const userLinks = Array.from(dialog.querySelectorAll(`a[href*="/${targetUsername}/" i], a[href*="/${targetUsername}" i]`));
        for (const link of userLinks) {
          const hrefUser = (link.getAttribute('href') || '').replace(/^\/|\/$/g, '').split('/')[0].toLowerCase();
          if (hrefUser === lowerTarget) {
            let parent = link.parentElement;
            for (let i = 0; i < 9 && parent && parent !== dialog; i++) {
              const rowBtn = Array.from(parent.querySelectorAll('button, div[role="button"]')).find(
                (b) => isRemoveButton(b) || (!b.querySelector('svg[aria-label*="Close" i]') && (b.innerText || '').trim().length > 0)
              );
              if (rowBtn) {
                removeBtn = rowBtn;
                break;
              }
              parent = parent.parentElement;
            }
            if (removeBtn) break;
          }
        }
      }

      if (removeBtn) break;
      await sleep(350);
    }

    if (!removeBtn) {
      const visibleText = (dialog.innerText || '').toLowerCase();
      if (visibleText.includes('no results found') || visibleText.includes('কোনো ফলাফল পাওয়া যায়নি') || visibleText.includes('no followers found')) {
        logMessage('warning', `@${targetUsername} is no longer in followers list (already removed or not found).`);
      } else {
        logMessage('warning', `Remove button not found for @${targetUsername}.`);
      }
      await typeIntoSearch(searchInput, '');
      return false;
    }

    // Click the Remove button on the user's row
    removeBtn.click();
    await sleep(1000);

    // Wait & poll for Confirmation modal (up to 4.5s)
    let confirmed = false;
    const confirmStart = Date.now();

    while (Date.now() - confirmStart < 4500) {
      if (shouldStop) break;

      const dialogs = document.querySelectorAll('div[role="dialog"]');
      if (dialogs.length > 1) {
        // Confirmation modal is always the topmost/newest dialog
        const d = dialogs[dialogs.length - 1];
        const confirmBtns = Array.from(d.querySelectorAll('button, div[role="button"]'));
        const confirmBtn = confirmBtns.find((el) => {
          const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
          if (txt.includes('cancel') || txt.includes('বাতিল') || txt === 'not now') return false;
          return isRemoveButton(el) || confirmBtns.length === 2;
        });

        if (confirmBtn) {
          confirmBtn.click();
          confirmed = true;
          await sleep(2200); // Wait for Instagram backend deletion request
          logMessage('remove', `Removed @${targetUsername} live from followers.`);
          break;
        }
      }

      if (confirmed) break;
      await sleep(300);
    }

    if (!confirmed) {
      logMessage('warning', `Confirmation modal button not found for @${targetUsername}.`);
    }

    // Clear search input so next candidate search is completely clean
    try {
      await typeIntoSearch(searchInput, '');
    } catch (e) {}

    // Close any leftover confirmation modal
    const dialogsAfter = document.querySelectorAll('div[role="dialog"]');
    if (dialogsAfter.length > 1) {
      closeDialogElement(dialogsAfter[dialogsAfter.length - 1]);
    }

    return confirmed;
  } catch (err) {
    logMessage('error', `Error removing @${targetUsername}: ${err.message}`);
    return false;
  }
}

// Main execution process
async function startCleaningProcess() {
  if (isRunning) return;
  isRunning = true;
  isPaused = false;
  shouldStop = false;

  await broadcastState({ isRunning: true, isPaused: false, statusText: 'Initializing...' });
  logMessage('info', 'Starting Follower Cleaner process...');

  try {
    // 1. Load config and history (supports both 'config' and legacy 'settings' keys)
    const storageData = await chrome.storage.local.get(['config', 'settings', 'scannedUsers', 'allScannedRecords', 'removalCandidates']);
    const savedConfig = storageData.config || storageData.settings;
    if (savedConfig) config = { ...config, ...savedConfig };

    // Ensure numeric properties are strictly typed
    config.minDiff = Number(config.minDiff) || 300;
    config.inactiveDaysThreshold = Number(config.inactiveDaysThreshold) || 60;
    if (config.keepUsersWithPostsOver !== null && config.keepUsersWithPostsOver !== undefined && config.keepUsersWithPostsOver !== 'none') {
      config.keepUsersWithPostsOver = Number(config.keepUsersWithPostsOver);
    }
    if (config.maxRemovalsPerRun) {
      config.maxRemovalsPerRun = Number(config.maxRemovalsPerRun);
    }
    if (config.maxFollowersToScan) {
      config.maxFollowersToScan = Number(config.maxFollowersToScan);
    }

    const scannedSet = new Set(storageData.scannedUsers || []);
    const allRecords = storageData.allScannedRecords || [];
    const candidates = storageData.removalCandidates || [];

    // Ensure any candidates that were not successfully removed in prior runs are re-scanned and processed
    for (const c of candidates) {
      if (c && c.status !== 'removed' && c.username) {
        scannedSet.delete(c.username.toLowerCase());
      }
    }
    await chrome.storage.local.set({ scannedUsers: Array.from(scannedSet) });

    logMessage('info', `Loaded ${scannedSet.size} previously scanned user(s) from local history.`);

    // 2. Identify current user
    let myUsername = await getMyUsername();
    if (!myUsername) {
      // Prompt user as a fallback so they are never stuck
      const manual = window.prompt('IG Cleaner: Please enter your Instagram username (e.g. your_handle):');
      if (manual && manual.trim()) {
        myUsername = manual.trim().replace(/^@/, '');
        await chrome.storage.local.set({ savedUsername: myUsername });
      }
    }

    if (!myUsername) {
      logMessage('error', 'Could not detect your username. Please click your profile avatar at the bottom-left of Instagram, then click Start Cleaner.');
      isRunning = false;
      await broadcastState({ isRunning: false, statusText: 'Username needed' });
      return;
    }

    logMessage('info', `Detected active Instagram account: @${myUsername}`);

    // 3. Collect followers
    await broadcastState({ statusText: 'Collecting followers list...' });
    const followers = await collectFollowers(myUsername, scannedSet);
    if (!followers) return; // redirected or stopped

    const totalToScan = followers.length;
    const removalQuota = config.removalsUnlimited ? null : (config.maxRemovalsPerRun || 180);
    const removalQuotaText = removalQuota ? `${removalQuota} accounts` : 'Unlimited (No cap)';
    logMessage('info', `Collected ${totalToScan} new unscanned follower(s) to inspect. [Removal Limit: ${removalQuotaText}]`);

    if (totalToScan === 0) {
      logMessage('success', 'No new unscanned followers found. Your followers list is clean!');
      isRunning = false;
      await broadcastState({ isRunning: false, statusText: 'Completed (List clean)' });
      return;
    }

    // 4. Inspect profiles and live remove
    let removedCount = 0;
    let candidateCount = 0;
    let protectedCount = 0;
    let reachedRemovalLimit = false;

    for (let idx = 0; idx < followers.length; idx++) {
      if (shouldStop) {
        logMessage('warning', 'Process stopped by user.');
        break;
      }

      while (isPaused && !shouldStop) {
        await broadcastState({ isPaused: true, statusText: 'Paused' });
        await sleep(1000);
      }
      if (shouldStop) break;

      if (checkRateLimit()) {
        logMessage('warning', 'Instagram action limit detected. Pausing process.');
        isPaused = true;
        await broadcastState({ isPaused: true, statusText: 'Action limit detected' });
        break;
      }

      const username = followers[idx];
      const progressText = `[${idx + 1}/${totalToScan}] Inspecting @${username}`;
      await broadcastState({ statusText: progressText, scannedCount: idx + 1 });

      const data = await fetchUserProfileData(username);

      if (!data || data.followers === null || data.following === null) {
        logMessage('warning', `@${username} -> could not read counts -> skipped`);
        allRecords.push({
          username,
          status: 'skipped',
          followers: '',
          following: '',
          diff: '',
          posts: '',
          is_inactive: '',
          last_post_days: '',
          reason: 'could not read counts'
        });
        continue;
      }

      const diff = data.following - data.followers;
      const diffMatch = config.checkDiff && diff >= config.minDiff;
      const inactiveMatch = config.checkInactive && data.isInactive;

      let isCandidate = false;
      if (config.removalMode === 'DIFF_OR_INACTIVE') isCandidate = diffMatch || inactiveMatch;
      else if (config.removalMode === 'INACTIVE_ONLY') isCandidate = inactiveMatch;
      else if (config.removalMode === 'DIFF_ONLY') isCandidate = diffMatch;
      else if (config.removalMode === 'DIFF_AND_INACTIVE') isCandidate = diffMatch && inactiveMatch;
      else isCandidate = diffMatch || inactiveMatch;

      // Post count protection: if posts > 10, never remove!
      let protectedByPosts = false;
      if (config.keepUsersWithPostsOver !== null && data.posts !== null && data.posts > config.keepUsersWithPostsOver) {
        isCandidate = false;
        protectedByPosts = true;
        protectedCount++;
        await broadcastState({ protectedCount });
      }

      const reasons = [];
      if (protectedByPosts) {
        reasons.push(`protected (> ${config.keepUsersWithPostsOver} posts)`);
      } else {
        if (diffMatch) reasons.push(`diff ${diff} >= ${config.minDiff}`);
        if (inactiveMatch) reasons.push(data.inactiveReason);
      }

      const reasonDesc = reasons.join(', ') || (isCandidate ? 'candidate' : 'active / within ratio');

      const record = {
        username,
        status: isCandidate ? 'candidate' : 'keep',
        followers: data.followers,
        following: data.following,
        diff,
        posts: data.posts !== null ? data.posts : '',
        is_inactive: data.isInactive,
        last_post_days: data.lastPostDays || '',
        reason: reasonDesc
      };

      allRecords.push(record);

      if (isCandidate) {
        candidateCount++;
        candidates.push(record);
        logMessage('candidate', `@${username} -> candidate (${reasonDesc})`, record);
        await broadcastState({ candidatesCount: candidateCount });

        // LIVE REMOVAL IN LOOP
        if (!config.dryRun && config.liveRemoveInLoop) {
          // Check removal quota before executing removal
          if (removalQuota && removedCount >= removalQuota) {
            logMessage('success', `🎯 Target removal limit reached (${removalQuota} removed). Halting further removals to protect your Instagram account.`);
            reachedRemovalLimit = true;
            break;
          }

          logMessage('info', `[Removal ${removedCount + 1}/${removalQuota || '∞'}] Removing @${username} live...`);

          // Attempt removal via internal API first (Fastest & 100% reliable), fallback to UI
          let success = false;
          if (data.userId) {
            success = await removeFollowerApi(data.userId, username);
          }
          if (!success) {
            success = await removeFollowerLive(myUsername, username);
          }

          if (success) {
            removedCount++;
            record.status = 'removed';
            if (config.skipPreviouslyScanned) {
              scannedSet.add(username.toLowerCase());
              await chrome.storage.local.set({ scannedUsers: Array.from(scannedSet) });
            }
            await broadcastState({ removedCount, candidatesCount: candidateCount, protectedCount });

            // Check removal quota immediately after removal
            if (removalQuota && removedCount >= removalQuota) {
              logMessage('success', `🎯 Reached target removal limit of ${removalQuota} followers! Run safely finished.`);
              reachedRemovalLimit = true;
              break;
            }
          } else {
            record.status = 'failed';
            logMessage('warning', `Could not remove @${username}. Kept in queue for retry.`);
          }

          // Delay between removals
          await randomDelay(config.removalDelayMin, config.removalDelayMax);
        } else {
          if (config.skipPreviouslyScanned) {
            scannedSet.add(username.toLowerCase());
            await chrome.storage.local.set({ scannedUsers: Array.from(scannedSet) });
          }
          await randomDelay(config.visitDelayMin, config.visitDelayMax);
        }
      } else {
        logMessage('keep', `@${username} -> keep (${reasonDesc})`, record);
        if (config.skipPreviouslyScanned) {
          scannedSet.add(username.toLowerCase());
          await chrome.storage.local.set({ scannedUsers: Array.from(scannedSet) });
        }
        await randomDelay(config.visitDelayMin, config.visitDelayMax);
      }

      // Update storage records & counts
      await chrome.storage.local.set({
        allScannedRecords: allRecords,
        removalCandidates: candidates
      });

      await broadcastState({
        scannedCount: idx + 1,
        candidatesCount: candidateCount,
        removedCount,
        protectedCount
      });
    }

    let finalCompletionStatus = 'Completed';
    if (reachedRemovalLimit) {
      finalCompletionStatus = `Completed (${removedCount}/${removalQuota} removed)`;
      logMessage('success', `Session complete! Hit removal quota of ${removedCount} accounts. Scanned: ${followers.length}, Candidates: ${candidateCount}, Protected: ${protectedCount}`);
    } else {
      logMessage('success', `Completed scan of ${totalToScan} followers! Removed: ${removedCount}, Candidates: ${candidateCount}, Protected: ${protectedCount}`);
    }
  } catch (err) {
    logMessage('error', `Process error: ${err.message}`);
  } finally {
    isRunning = false;
    isPaused = false;
    await broadcastState({ isRunning: false, isPaused: false, statusText: finalCompletionStatus || 'Completed' });
  }
}

// Listen for commands from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'START') {
    if (!isRunning) {
      startCleaningProcess();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, message: 'Already running' });
    }
  } else if (request.action === 'PAUSE') {
    isPaused = true;
    broadcastState({ isPaused: true, statusText: 'Paused' });
    sendResponse({ success: true });
  } else if (request.action === 'RESUME') {
    isPaused = false;
    broadcastState({ isPaused: false, statusText: 'Resumed' });
    sendResponse({ success: true });
  } else if (request.action === 'STOP') {
    shouldStop = true;
    isRunning = false;
    isPaused = false;
    broadcastState({ isRunning: false, isPaused: false, statusText: 'Stopped' });
    sendResponse({ success: true });
  }
  return true;
});

// Auto-resume if redirected from another page to user profile
(async () => {
  try {
    const data = await chrome.storage.local.get(['autoResume']);
    if (data.autoResume) {
      await chrome.storage.local.set({ autoResume: false });
      setTimeout(() => {
        if (!isRunning) startCleaningProcess();
      }, 2500);
    }
  } catch (e) {}
})();
