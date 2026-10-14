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
  maxRemovalsPerRun: 150,
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

// Helper: Close Instagram dialogs cleanly
function closeInstagramDialog() {
  const dialogs = document.querySelectorAll('div[role="dialog"]');
  for (const d of dialogs) {
    const closeBtn = d.querySelector('svg[aria-label="Close"], button:has(svg[aria-label="Close"]), div[role="button"]:has(svg[aria-label="Close"])');
    if (closeBtn) {
      const clickable = closeBtn.closest('button, div[role="button"]') || closeBtn;
      try { clickable.click(); } catch (e) {}
    }
  }
  const escEvent = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true });
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

    return {
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
  const existingDialog = document.querySelector('div[role="dialog"]');
  if (existingDialog && existingDialog.offsetParent !== null) {
    return existingDialog;
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

  // Find followers button
  let followersBtn = document.querySelector('a[href$="/followers/"], a[href*="/followers"]');
  if (!followersBtn) {
    const allLinks = Array.from(document.querySelectorAll('a, span'));
    followersBtn = allLinks.find((el) => el.innerText && el.innerText.toLowerCase().includes('followers'));
  }

  if (!followersBtn) {
    throw new Error('Could not find Followers button on profile page.');
  }

  followersBtn.click();
  await sleep(2500);

  const dialog = document.querySelector('div[role="dialog"]');
  if (!dialog) {
    throw new Error('Followers dialog did not open.');
  }

  return dialog;
}

// Collect unscanned followers from Followers dialog
async function collectFollowers(myUsername, scannedSet) {
  const dialog = await openFollowersDialog(myUsername);
  if (!dialog) return [];

  const unscannedFollowers = new Set();
  const allSeenUsernames = new Set();
  let unchangedCount = 0;
  const maxUnchanged = 6;

  logMessage('info', 'Scrolling Followers dialog to collect unscanned accounts...');

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

    broadcastState({
      statusText: `Collecting: ${currentSeen} seen, ${currentUnscanned} new`,
      scannedCount: currentUnscanned
    });

    if (config.maxFollowersToScan && currentUnscanned >= config.maxFollowersToScan) {
      logMessage('info', `Reached limit of ${config.maxFollowersToScan} unscanned followers.`);
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
  if (config.maxFollowersToScan) {
    result = result.slice(0, config.maxFollowersToScan);
  }

  return result;
}

// Live remove follower on Instagram
async function removeFollowerLive(myUsername, targetUsername) {
  try {
    const dialog = await openFollowersDialog(myUsername);
    if (!dialog) return false;

    // Find search input
    const searchInput = dialog.querySelector('input[placeholder*="Search" i], input[type="text"]');
    if (!searchInput) {
      logMessage('error', 'Search input not found in Followers dialog.');
      return false;
    }

    // Focus & type username with input event
    searchInput.focus();
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);

    // Set value and trigger synthetic React input
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(searchInput, targetUsername);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));

    await sleep(2500);

    // Safe targeting: locate the SPECIFIC row matching targetUsername
    const lowerTarget = targetUsername.toLowerCase();
    let removeBtn = null;

    // 1. Try finding row with link matching targetUsername
    const userLinks = Array.from(dialog.querySelectorAll(`a[href*="/${targetUsername}/" i], a[href*="/${targetUsername}" i]`));
    for (const link of userLinks) {
      const hrefUser = (link.getAttribute('href') || '').replace(/^\/|\/$/g, '').split('/')[0].toLowerCase();
      if (hrefUser === lowerTarget) {
        let parent = link.parentElement;
        for (let i = 0; i < 8 && parent && parent !== dialog; i++) {
          const btn = Array.from(parent.querySelectorAll('div[role="button"], button')).find(
            (b) => b.innerText && b.innerText.trim() === 'Remove'
          );
          if (btn) {
            removeBtn = btn;
            break;
          }
          parent = parent.parentElement;
        }
        if (removeBtn) break;
      }
    }

    // 2. Fallback: row container containing the exact username text
    if (!removeBtn) {
      const allDivs = Array.from(dialog.querySelectorAll('div[role="listitem"], ul > li, div > div'));
      for (const el of allDivs) {
        const text = el.innerText || '';
        if (text.toLowerCase().includes(lowerTarget)) {
          const btn = Array.from(el.querySelectorAll('div[role="button"], button')).find(
            (b) => b.innerText && b.innerText.trim() === 'Remove'
          );
          if (btn) {
            removeBtn = btn;
            break;
          }
        }
      }
    }

    if (!removeBtn) {
      logMessage('warning', `Remove button not found for @${targetUsername}.`);
      closeInstagramDialog();
      return false;
    }

    removeBtn.click();
    await sleep(1500);

    // Find confirmation modal (last dialog)
    const dialogs = document.querySelectorAll('div[role="dialog"]');
    const confirmDialog = dialogs[dialogs.length - 1];

    const confirmBtns = Array.from(confirmDialog.querySelectorAll('button, div[role="button"]'));
    const confirmBtn = confirmBtns.find((el) => el.innerText && el.innerText.trim() === 'Remove');

    if (confirmBtn) {
      confirmBtn.click();
      await sleep(2500);
      logMessage('remove', `Removed @${targetUsername} live from followers.`);
    } else {
      logMessage('warning', `Confirmation modal button not found for @${targetUsername}.`);
      closeInstagramDialog();
      return false;
    }

    // Close any dialogs
    closeInstagramDialog();
    await sleep(500);

    return true;
  } catch (err) {
    logMessage('error', `Error removing @${targetUsername}: ${err.message}`);
    closeInstagramDialog();
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

    const scannedSet = new Set(storageData.scannedUsers || []);
    const allRecords = storageData.allScannedRecords || [];
    const candidates = storageData.removalCandidates || [];

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
    logMessage('info', `Collected ${totalToScan} new unscanned follower(s) to inspect.`);

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

      // Save user to history set immediately
      if (config.skipPreviouslyScanned) {
        scannedSet.add(username.toLowerCase());
        await chrome.storage.local.set({ scannedUsers: Array.from(scannedSet) });
      }

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

        // LIVE REMOVAL IN LOOP
        if (!config.dryRun && config.liveRemoveInLoop) {
          logMessage('info', `Removing @${username} live...`);
          const success = await removeFollowerLive(myUsername, username);
          if (success) {
            removedCount++;
            record.status = 'removed';
            await broadcastState({ removedCount, candidatesCount: candidateCount, protectedCount });
          }

          // Delay between removals
          await randomDelay(config.removalDelayMin, config.removalDelayMax);
        } else {
          await randomDelay(config.visitDelayMin, config.visitDelayMax);
        }
      } else {
        logMessage('keep', `@${username} -> keep (${reasonDesc})`, record);
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

    logMessage('success', `Completed scan of ${totalToScan} followers! Removed: ${removedCount}, Candidates: ${candidateCount}, Protected: ${protectedCount}`);
  } catch (err) {
    logMessage('error', `Process error: ${err.message}`);
  } finally {
    isRunning = false;
    isPaused = false;
    await broadcastState({ isRunning: false, isPaused: false, statusText: 'Completed' });
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
