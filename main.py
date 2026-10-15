"""
Instagram Follower Cleaner (Playwright Sync API)
Automates cleaning your own Instagram followers list based on following/followers difference.

Never stores or asks for passwords. Uses a persistent browser profile.
"""

import os
import re
import sys
import io
import time
import random
import csv
from datetime import datetime, timezone
from typing import Optional, Tuple, List, Dict, Any
from playwright.sync_api import sync_playwright, Page, BrowserContext, TimeoutError as PlaywrightTimeoutError

# Ensure Windows terminal doesn't crash on emoji characters in Instagram names
if sys.platform == "win32":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass

# ==============================================================================
# ENVIRONMENT & CONFIGURATION LOADER
# ==============================================================================
def load_dotenv(filepath: str = ".env") -> None:
    """Load key-value settings from .env file into os.environ if file exists."""
    if not os.path.exists(filepath):
        return
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass

# Automatically load .env if present
load_dotenv()

# Optional: Set your username here directly (e.g. "my_username"), or leave empty "" to auto-detect
TARGET_USERNAME = os.getenv("TARGET_USERNAME", "")

# Browser Configuration
USE_REAL_CHROME = os.getenv("USE_REAL_CHROME", "True").lower() in ("true", "1", "yes")
HEADLESS = os.getenv("HEADLESS", "False").lower() in ("true", "1", "yes")

DRY_RUN = os.getenv("DRY_RUN", "False").lower() in ("true", "1", "yes")
LIVE_REMOVE_IN_LOOP = os.getenv("LIVE_REMOVE_IN_LOOP", "True").lower() in ("true", "1", "yes")
AUTO_CONFIRM_REMOVAL = os.getenv("AUTO_CONFIRM_REMOVAL", "True").lower() in ("true", "1", "yes")
MAX_REMOVALS_PER_RUN = int(os.getenv("MAX_REMOVALS_PER_RUN", "180"))

# Limit how many followers to scan from the top of the list (e.g. 50, 100, 150, or None / 'none' for unlimited)
_max_scan_env = os.getenv("MAX_FOLLOWERS_TO_SCAN", "150")
MAX_FOLLOWERS_TO_SCAN = int(_max_scan_env) if _max_scan_env and _max_scan_env.lower() not in ("none", "unlimited", "0") else None

# CSV Export Configuration
EXPORT_CSV = True  # Automatically save scan results to CSV files
CSV_ALL_REPORT = "followers_report.csv"       # Full report of all scanned followers
CSV_CANDIDATES = "removal_candidates.csv"     # List of removal candidates

# ------------------------------------------------------------------------------
# REMOVAL CRITERIA & RULES
# ------------------------------------------------------------------------------
# Rule 1: Follower / Following Difference
CHECK_DIFF = True
MIN_DIFF = int(os.getenv("MIN_DIFF", "300"))

# Rule 2: Inactive Account Detection (no posts for 2+ months, or 0 posts)
CHECK_INACTIVE = True
INACTIVE_DAYS_THRESHOLD = int(os.getenv("INACTIVE_DAYS_THRESHOLD", "60"))
TREAT_ZERO_POSTS_AS_INACTIVE = True

# Rule 3: Post Count Protection (do not remove users with more than 10 posts)
_keep_posts_env = os.getenv("KEEP_USERS_WITH_POSTS_OVER", "10")
KEEP_USERS_WITH_POSTS_OVER = int(_keep_posts_env) if _keep_posts_env and _keep_posts_env.lower() != "none" else None

# Rule 4: Skip Previously Scanned Users (never scan the same user twice)
SKIP_PREVIOUSLY_SCANNED = os.getenv("SKIP_PREVIOUSLY_SCANNED", "True").lower() in ("true", "1", "yes")
SCANNED_USERS_FILE = "scanned_users.txt"

# Removal Mode Options:
REMOVAL_MODE = os.getenv("REMOVAL_MODE", "DIFF_OR_INACTIVE")

# Delay ranges (in seconds) for rate-limiting and human-like behavior
PROFILE_VISIT_DELAY_MIN = 5.0
PROFILE_VISIT_DELAY_MAX = 15.0
REMOVAL_DELAY_MIN = 8.0
REMOVAL_DELAY_MAX = 20.0
SCROLL_DELAY_MIN = 1.0
SCROLL_DELAY_MAX = 2.5

# Persistent browser profile directory to keep login session
USER_DATA_DIR = "./ig_session"

# System paths to exclude when detecting usernames from URLs/links
SYSTEM_PATHS = {
    "explore", "reels", "direct", "stories", "accounts", "p", "reel",
    "tv", "tags", "legal", "about", "help", "privacy", "terms",
    "directory", "developer", "creator", "support", "settings",
    "popular", "locations", "emailsignup", "login"
}

# ==============================================================================
# SELECTORS (Centralized for easy updates if Instagram HTML changes)
# ==============================================================================
SELECTORS = {
    # Login & session detection
    "password_input": 'input[name="password"]',
    "username_input": 'input[name="username"]',
    "nav_home_icon": 'svg[aria-label="Home"], a[href="/"]',
    "nav_profile_link": 'a[role="link"]:has-text("Profile"), a:has-text("Profile")',
    "dismiss_buttons": [
        'button:has-text("Not now")',
        'button:has-text("Not Now")',
        'button:has-text("Cancel")',
        'div[role="button"]:has-text("Not now")',
        'div[role="button"]:has-text("Not Now")',
        'button:has-text("Allow all cookies")',
        'button:has-text("Decline optional cookies")',
    ],

    # Followers dialog
    "followers_link": 'a:has-text("followers"), span:has-text("followers"), a[href$="/followers/"], a[href*="/followers"]',
    "following_link": 'a:has-text("following"), span:has-text("following"), a[href$="/following/"], a[href*="/following"]',
    "dialog": 'div[role="dialog"]',
    "dialog_close_button": 'div[role="dialog"] svg[aria-label="Close"], button:has(svg[aria-label="Close"])',
    "dialog_search_input": 'div[role="dialog"] input[placeholder*="Search" i], div[role="dialog"] input[type="text"]',
    "dialog_user_links": 'div[role="dialog"] a[role="link"][href^="/"], div[role="dialog"] a[href^="/"]',

    # Removal actions (Instagram web uses div[role="button"] for row button and button for confirmation modal)
    "row_remove_button": 'div[role="button"]:has-text("Remove"), button:has-text("Remove")',
    "confirm_remove_button": 'button:has-text("Remove"), div[role="button"]:has-text("Remove")',

    # Rate limiting / Action blocks
    "rate_limit_patterns": [
        r"try again later",
        r"action blocked",
        r"we restrict certain activity",
        r"we limit how often",
        r"temporarily blocked",
        r"please wait a few minutes",
        r"something went wrong",
    ]
}


# ==============================================================================
# HELPER FUNCTIONS
# ==============================================================================
def load_scanned_users() -> set:
    """
    Load set of previously scanned usernames from SCANNED_USERS_FILE and followers_report.csv.
    """
    scanned = set()
    if os.path.exists(SCANNED_USERS_FILE):
        try:
            with open(SCANNED_USERS_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    u = line.strip().lower().lstrip("@")
                    if u:
                        scanned.add(u)
        except Exception:
            pass

    if os.path.exists(CSV_ALL_REPORT):
        try:
            with open(CSV_ALL_REPORT, "r", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    u = row.get("username", "").strip().lower().lstrip("@")
                    if u:
                        scanned.add(u)
        except Exception:
            pass

    return scanned


def save_scanned_user(username: str) -> None:
    """
    Append a scanned username to SCANNED_USERS_FILE immediately.
    """
    try:
        with open(SCANNED_USERS_FILE, "a", encoding="utf-8") as f:
            f.write(f"{username.strip().lower()}\n")
    except Exception:
        pass


def parse_count(raw: Any) -> Optional[int]:
    """
    Parse Instagram count strings into integers.
    Supports formats like '1,234', '12.5K', '3M', '1.2B', '500', '1,420 followers'.
    Returns None if parsing fails.
    """
    if not raw or not isinstance(raw, str):
        return None
    raw = raw.strip()
    match = re.search(r"([\d,]+(?:\.\d+)?)\s*([kmbKMB])?", raw)
    if not match:
        return None
    num_str, unit = match.groups()
    num_str = num_str.replace(",", "")
    try:
        val = float(num_str)
    except ValueError:
        return None

    if unit:
        unit = unit.upper()
        if unit == "K":
            val *= 1_000
        elif unit == "M":
            val *= 1_000_000
        elif unit == "B":
            val *= 1_000_000_000

    return int(val)


def is_authenticated(context: BrowserContext) -> bool:
    """
    Verify authentication by checking for Instagram's session cookies.
    When logged in, Instagram always sets 'sessionid' and 'ds_user_id'.
    """
    try:
        cookies = context.cookies()
        return any(c.get("name") in ("sessionid", "ds_user_id") for c in cookies)
    except Exception:
        return False


def check_rate_limit(page: Page) -> bool:
    """
    Check if Instagram has displayed an action block, rate limit, or 'Try again later' popup.
    """
    try:
        content = page.content()
        for pattern in SELECTORS["rate_limit_patterns"]:
            if re.search(pattern, content, re.IGNORECASE):
                print("\n" + "=" * 65)
                print("[WARNING] INSTAGRAM ACTION LIMIT OR BLOCK DETECTED!")
                print(f"[WARNING] Detected signal: '{pattern}'")
                print("[WARNING] Stopping immediately to protect your Instagram account.")
                print("=" * 65 + "\n")
                return True
    except Exception:
        pass
    return False


def dismiss_popups(page: Page) -> None:
    """
    Dismiss common modal prompts such as 'Save Your Login Info', 'Turn on Notifications', or Cookie banners.
    """
    for selector in SELECTORS["dismiss_buttons"]:
        try:
            btn = page.locator(selector).first
            if btn.is_visible(timeout=500):
                btn.click()
                time.sleep(0.5)
        except Exception:
            pass


def wait_for_login(page: Page, context: BrowserContext) -> None:
    """
    Ensure the user is logged into Instagram.
    If not logged in, waits indefinitely for manual login in the browser.
    Never asks for or stores credentials.
    """
    print("[INFO] Checking Instagram login status...")
    page.goto("https://www.instagram.com/", wait_until="domcontentloaded")
    time.sleep(2)
    dismiss_popups(page)

    if not is_authenticated(context):
        print("\n" + "=" * 65)
        print("[ACTION REQUIRED] You are not logged in yet!")
        print("Please log in to your Instagram account in the opened browser window.")
        print("Once you complete the login (including 2FA if enabled),")
        print("the script will detect your session automatically and continue.")
        print("=" * 65 + "\n")

        # Poll until authentication cookies are detected
        while not is_authenticated(context):
            time.sleep(2)
            dismiss_popups(page)

        print("\n[SUCCESS] Login detected successfully!")
        time.sleep(3)
        dismiss_popups(page)
    else:
        print("[INFO] Logged-in session verified from saved session.")
        time.sleep(1)
        dismiss_popups(page)


def get_my_username(page: Page) -> str:
    """
    Detect the logged-in user's own username from the active session or configuration.
    """
    global TARGET_USERNAME
    if TARGET_USERNAME and TARGET_USERNAME.strip():
        username = TARGET_USERNAME.strip().lstrip("@")
        print(f"[INFO] Using configured target username: @{username}")
        return username

    print("[INFO] Auto-detecting your Instagram username from session...")
    page.goto("https://www.instagram.com/", wait_until="domcontentloaded")
    time.sleep(2)
    dismiss_popups(page)

    # 1. Try clicking the Profile link in the left sidebar to navigate directly
    profile_links = page.locator(SELECTORS["nav_profile_link"])
    if profile_links.count() > 0:
        try:
            profile_links.first.click()
            time.sleep(3)
            # URL will be https://www.instagram.com/<username>/
            match = re.search(r"instagram\.com/([^/?#]+)", page.url)
            if match and match.group(1) not in SYSTEM_PATHS:
                detected = match.group(1)
                print(f"[INFO] Detected username from profile page: @{detected}")
                return detected
        except Exception:
            pass

    # 2. Check sidebar profile link href attribute directly
    if profile_links.count() > 0:
        for i in range(profile_links.count()):
            href = profile_links.nth(i).get_attribute("href")
            if href:
                user = href.strip("/").split("/")[0]
                if user and user not in SYSTEM_PATHS:
                    print(f"[INFO] Detected username from sidebar: @{user}")
                    return user

    # 3. Fallback: prompt user in console
    print("[WARNING] Could not auto-detect username automatically.")
    manual = input("[PROMPT] Please enter your Instagram username (e.g. johndoe): ").strip()
    return manual.lstrip("@")


def get_follower_usernames(page: Page, my_username: str, scanned_set: Optional[set] = None) -> List[str]:
    """
    Open the user's profile, open the Followers dialog, scroll until all followers are loaded,
    and return a list of all follower usernames (skipping already scanned users if enabled).
    """
    profile_url = f"https://www.instagram.com/{my_username}/"
    print(f"\n[INFO] Navigating to profile: {profile_url}")
    page.goto(profile_url, wait_until="domcontentloaded")
    time.sleep(2.5)
    dismiss_popups(page)

    if check_rate_limit(page):
        return []

    # Verify that this is indeed a valid profile page
    if "Page Not Found" in page.title() or "isn't available" in page.content().lower():
        print(f"[ERROR] Profile for @{my_username} could not be loaded. Please check the username.")
        return []

    # Click the Followers link/button
    followers_btn = page.locator(SELECTORS["followers_link"]).first
    if followers_btn.count() == 0 or not followers_btn.is_visible():
        followers_btn = page.locator('a:has-text("followers")').first

    if followers_btn.count() == 0:
        print("[ERROR] Could not locate the 'Followers' button on your profile.")
        return []

    print("[INFO] Opening Followers dialog...")
    followers_btn.click()

    # Wait for dialog to open
    try:
        page.wait_for_selector(SELECTORS["dialog"], timeout=12000)
    except PlaywrightTimeoutError:
        print("[ERROR] Followers dialog did not open.")
        return []

    time.sleep(2)
    unscanned_followers: Dict[str, bool] = {}
    all_seen_usernames: Dict[str, bool] = {}
    unchanged_count = 0
    max_unchanged = 5

    print("[INFO] Scrolling Followers dialog to collect unscanned followers...")

    while True:
        if check_rate_limit(page):
            break

        prev_seen_total = len(all_seen_usernames)

        # Collect visible real follower usernames inside the dialog and detect 'Suggested for you'
        scan_res = page.evaluate("""
            ([myUser, sysPaths]) => {
                const dialog = document.querySelector('div[role="dialog"]');
                if (!dialog) return { followers: [], reachedSuggested: false };

                // 1. Detect if "Suggested for you" / "Suggestions" section header exists in dialog
                let suggestedEl = null;
                const candidates = dialog.querySelectorAll('h1, h2, h3, h4, h5, h6, span, div');
                for (const el of candidates) {
                    if (el.children.length > 2) continue;
                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                    if (
                        txt === 'suggested for you' ||
                        txt === 'suggestions for you' ||
                        txt === 'suggested' ||
                        txt === 'suggestions' ||
                        txt === 'আপনার জন্য প্রস্তাবিত' ||
                        txt.startsWith('suggested for you') ||
                        txt.startsWith('suggestions for you')
                    ) {
                        if (el.offsetParent !== null || el.clientHeight > 0) {
                            suggestedEl = el;
                            break;
                        }
                    }
                }

                const reachedSuggested = !!suggestedEl;

                // 2. Extract genuine followers
                // Every genuine follower row has a "Remove" button ('remove', 'মুছুন', 'মুছে ফেলুন', 'সরান')
                const removeKeywords = ['remove', 'মুছুন', 'মুছে ফেলুন', 'সরান'];
                const allButtons = Array.from(dialog.querySelectorAll('button, div[role="button"]'));
                const followersFromRemove = [];

                for (const btn of allButtons) {
                    if (suggestedEl && (suggestedEl.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                        continue;
                    }
                    const btnText = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                    const isRemove = removeKeywords.some(kw => btnText === kw || btnText.startsWith(kw));

                    if (isRemove) {
                        let row = btn.parentElement;
                        let foundUser = null;
                        let depth = 0;
                        while (row && row !== dialog && depth < 8) {
                            const links = Array.from(row.querySelectorAll('a[role="link"][href^="/"], a[href^="/"]'));
                            for (const l of links) {
                                const href = l.getAttribute('href') || '';
                                const u = href.replace(/^\\/+|\\/+$/g, '').split('/')[0];
                                if (u && !sysPaths.includes(u.toLowerCase()) && u.toLowerCase() !== myUser.toLowerCase() && /^[a-zA-Z0-9._]+$/.test(u)) {
                                    foundUser = u;
                                    break;
                                }
                            }
                            if (foundUser) break;
                            row = row.parentElement;
                            depth++;
                        }
                        if (foundUser && !followersFromRemove.includes(foundUser)) {
                            followersFromRemove.push(foundUser);
                        }
                    }
                }

                // Fallback: If no remove buttons matched (e.g. customized UI), collect links strictly before suggestedEl
                let finalFollowers = followersFromRemove;
                if (finalFollowers.length === 0) {
                    const allLinks = Array.from(dialog.querySelectorAll('a[role="link"][href^="/"], a[href^="/"]'));
                    for (const l of allLinks) {
                        if (suggestedEl && (suggestedEl.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                            continue;
                        }
                        const href = l.getAttribute('href') || '';
                        const u = href.replace(/^\\/+|\\/+$/g, '').split('/')[0];
                        if (u && !sysPaths.includes(u.toLowerCase()) && u.toLowerCase() !== myUser.toLowerCase() && /^[a-zA-Z0-9._]+$/.test(u)) {
                            if (!finalFollowers.includes(u)) {
                                finalFollowers.push(u);
                            }
                        }
                    }
                }

                return {
                    followers: finalFollowers,
                    reachedSuggested: reachedSuggested
                };
            }
        """, [my_username, list(SYSTEM_PATHS)])

        new_followers = scan_res.get("followers", [])
        reached_suggested = scan_res.get("reachedSuggested", False)

        for user in new_followers:
            all_seen_usernames[user.lower()] = True
            if SKIP_PREVIOUSLY_SCANNED and scanned_set and user.lower() in scanned_set:
                continue
            unscanned_followers[user] = True

        unscanned_count = len(unscanned_followers)
        seen_count = len(all_seen_usernames)
        print(f"\r[INFO] Followers seen in list: {seen_count} | New unscanned to process: {unscanned_count}", end="", flush=True)

        if reached_suggested:
            print(f"\n[INFO] Detected Instagram's 'Suggested for you' section. All real followers have been loaded!")
            break

        # Early exit if we reached the requested limit of new unscanned followers
        if MAX_FOLLOWERS_TO_SCAN and unscanned_count >= MAX_FOLLOWERS_TO_SCAN:
            print(f"\n[INFO] Reached target limit of {MAX_FOLLOWERS_TO_SCAN} new unscanned followers. Stopping scroll.")
            break

        # Scroll the scrollable container inside the dialog (works seamlessly in background/minimized)
        scrolled = page.evaluate("""
            () => {
                const dialog = document.querySelector('div[role="dialog"]');
                if (!dialog) return false;

                // Trigger virtual scroll by scrolling last follower link into view
                const links = dialog.querySelectorAll('a[role="link"][href^="/"], a[href^="/"]');
                if (links.length > 0) {
                    links[links.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
                }

                const allDivs = Array.from(dialog.querySelectorAll('div'));
                for (const div of allDivs) {
                    const style = window.getComputedStyle(div);
                    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && div.scrollHeight > div.clientHeight) {
                        div.scrollTop = div.scrollHeight;
                        return true;
                    }
                }
                for (const div of allDivs) {
                    if (div.scrollHeight > div.clientHeight && div.clientHeight > 150) {
                        div.scrollTop = div.scrollHeight;
                        return true;
                    }
                }
                dialog.scrollTop = dialog.scrollHeight;
                return true;
            }
        """)

        # Also dispatch PageDown key if possible (ignore if window is minimized/unfocused)
        try:
            page.keyboard.press("PageDown")
        except Exception:
            pass

        # Small random pause between scrolls
        time.sleep(random.uniform(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX))

        new_seen_total = len(all_seen_usernames)
        if new_seen_total == prev_seen_total:
            unchanged_count += 1
            if unchanged_count >= max_unchanged:
                print("\n[INFO] Reached bottom of Followers list.")
                break
        else:
            unchanged_count = 0

    collected = list(unscanned_followers.keys())
    if MAX_FOLLOWERS_TO_SCAN:
        collected = collected[:MAX_FOLLOWERS_TO_SCAN]

    print(f"\n[INFO] Finished collecting followers. Total new unscanned to evaluate: {len(collected)}")

    # Close dialog cleanly
    try:
        page.keyboard.press("Escape")
        time.sleep(1)
    except Exception:
        pass

    return collected


def get_profile_data(page: Page, username: str) -> Optional[Dict[str, Any]]:
    """
    Visit a user's profile and extract followers, following, posts, and inactivity status.
    Returns a dict of profile metrics or None if counts cannot be read.
    """
    try:
        page.goto(f"https://www.instagram.com/{username}/", wait_until="domcontentloaded", timeout=20000)
    except Exception:
        return None

    time.sleep(1.5)

    if check_rate_limit(page):
        return None

    followers_val: Optional[int] = None
    following_val: Optional[int] = None
    posts_val: Optional[int] = None

    # Strategy 1: Read meta description tag (fastest and most reliable)
    try:
        meta = page.locator('meta[name="description"], meta[property="og:description"]').first
        if meta.count() > 0:
            content = meta.get_attribute("content")
            if content:
                m_f = re.search(r"([\d,.]+[kmbKMB]?)\s+Followers", content, re.IGNORECASE)
                m_fg = re.search(r"([\d,.]+[kmbKMB]?)\s+Following", content, re.IGNORECASE)
                m_p = re.search(r"([\d,.]+[kmbKMB]?)\s+Posts", content, re.IGNORECASE)
                if m_f:
                    followers_val = parse_count(m_f.group(1))
                if m_fg:
                    following_val = parse_count(m_fg.group(1))
                if m_p:
                    posts_val = parse_count(m_p.group(1))
    except Exception:
        pass

    # Strategy 2: Locate followers and following links/spans on profile header
    if followers_val is None:
        try:
            followers_el = page.locator(SELECTORS["followers_link"]).first
            if followers_el.count() > 0:
                title_el = followers_el.locator("span[title]").first
                if title_el.count() > 0 and title_el.get_attribute("title"):
                    followers_val = parse_count(title_el.get_attribute("title"))
                else:
                    followers_val = parse_count(followers_el.inner_text())
        except Exception:
            pass

    if following_val is None:
        try:
            following_el = page.locator(SELECTORS["following_link"]).first
            if following_el.count() > 0:
                title_el = following_el.locator("span[title]").first
                if title_el.count() > 0 and title_el.get_attribute("title"):
                    following_val = parse_count(title_el.get_attribute("title"))
                else:
                    following_val = parse_count(following_el.inner_text())
        except Exception:
            pass

    # Strategy 3: Text match on header items
    if followers_val is None or following_val is None or posts_val is None:
        try:
            header_text = page.locator("header").inner_text()
            if followers_val is None:
                f_match = re.search(r"([\d,.]+[kmbKMB]?)\s+followers", header_text, re.IGNORECASE)
                if f_match:
                    followers_val = parse_count(f_match.group(1))
            if following_val is None:
                fg_match = re.search(r"([\d,.]+[kmbKMB]?)\s+following", header_text, re.IGNORECASE)
                if fg_match:
                    following_val = parse_count(fg_match.group(1))
            if posts_val is None:
                p_match = re.search(r"([\d,.]+[kmbKMB]?)\s+posts", header_text, re.IGNORECASE)
                if p_match:
                    posts_val = parse_count(p_match.group(1))
        except Exception:
            pass

    if followers_val is None or following_val is None:
        return None

    # Check if account is private
    is_private = False
    try:
        content_lower = page.content().lower()
        if "this account is private" in content_lower:
            is_private = True
    except Exception:
        pass

    # Check inactivity if enabled
    is_inactive = False
    inactive_reason = ""
    last_post_days = None

    if CHECK_INACTIVE:
        if posts_val == 0:
            if TREAT_ZERO_POSTS_AS_INACTIVE:
                is_inactive = True
                inactive_reason = "0 posts"
            else:
                inactive_reason = "0 posts"
        elif is_private:
            inactive_reason = "private account"
        else:
            # Check the date of the latest post in the profile grid
            try:
                first_post = page.locator('article a[href*="/p/"], a[href*="/p/"], article a[href*="/reel/"], a[href*="/reel/"]').first
                if first_post.count() > 0 and first_post.is_visible():
                    first_post.click()
                    time.sleep(1.2)
                    time_el = page.locator("time[datetime]").first
                    if time_el.count() > 0:
                        dt_str = time_el.get_attribute("datetime")
                        if dt_str:
                            dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
                            now = datetime.now(timezone.utc)
                            days_ago = (now - dt).days
                            last_post_days = days_ago
                            if days_ago >= INACTIVE_DAYS_THRESHOLD:
                                is_inactive = True
                                inactive_reason = f"inactive ({days_ago}d ago)"
                            else:
                                is_inactive = False
                                inactive_reason = f"active ({days_ago}d ago)"
                    # Close post modal
                    page.keyboard.press("Escape")
                    time.sleep(0.5)
            except Exception:
                try:
                    page.keyboard.press("Escape")
                except Exception:
                    pass

    # Check if visited account is actually following the user (protects against suggested accounts)
    is_follower = True
    try:
        header_text_lower = page.locator("header").inner_text().lower()
        buttons = page.locator('header button, header div[role="button"]').all()
        btn_texts = [b.inner_text().strip().lower() for b in buttons if b.is_visible()]
        has_plain_follow = any(t in ("follow", "অনুসরণ করুন") for t in btn_texts)
        has_follow_back = any("follow back" in t or "অনুসরণ ফিরিয়ে দিন" in t for t in btn_texts)
        has_follows_you = "follows you" in header_text_lower or "আপনাকে অনুসরণ করে" in header_text_lower

        if has_plain_follow and not has_follow_back and not has_follows_you:
            is_follower = False
    except Exception:
        pass

    return {
        "followers": followers_val,
        "following": following_val,
        "posts": posts_val,
        "is_private": is_private,
        "is_inactive": is_inactive,
        "inactive_reason": inactive_reason,
        "last_post_days": last_post_days,
        "is_follower": is_follower,
    }


def get_profile_counts(page: Page, username: str) -> Tuple[Optional[int], Optional[int]]:
    """Legacy helper for backwards compatibility."""
    data = get_profile_data(page, username)
    if not data:
        return None, None
    return data["followers"], data["following"]


def remove_follower_live(page: Page, my_username: str, target_username: str) -> bool:
    """
    Live removal helper:
    Navigates to my profile, opens the Followers dialog, searches target_username,
    clicks 'Remove' (div[role="button"]), confirms in the modal popup, and returns True on success.
    """
    try:
        page.goto(f"https://www.instagram.com/{my_username}/", wait_until="domcontentloaded", timeout=25000)
        time.sleep(2.0)
        dismiss_popups(page)

        # Locate Followers link/button (handles href='#' and text like '21.2K followers')
        followers_btn = page.locator('a:has-text("followers"), span:has-text("followers"), a[href*="/followers"]').first
        if followers_btn.count() == 0 or not followers_btn.is_visible():
            print(f"   [ERROR] Could not find Followers button on profile: https://www.instagram.com/{my_username}/")
            return False

        followers_btn.click()
        time.sleep(2.0)

        # Wait for dialog
        try:
            page.wait_for_selector(SELECTORS["dialog"], timeout=10000)
        except Exception:
            print("   [ERROR] Followers dialog did not open.")
            return False

        dialog = page.locator(SELECTORS["dialog"]).first

        # Locate search input inside the dialog
        search_input = dialog.locator('input[placeholder*="Search" i], input[type="text"]').first
        if search_input.count() == 0:
            print("   [ERROR] Search input not found in Followers dialog.")
            page.keyboard.press("Escape")
            return False

        # Type target username with keystroke delays for React reactivity
        search_input.click()
        search_input.fill("")
        search_input.press_sequentially(target_username, delay=35)
        time.sleep(2.5)  # Wait for search results to filter

        if check_rate_limit(page):
            return False

        # Find Remove button for the user (specifically matching target row if possible)
        row = dialog.locator(f'div:has(a[href*="/{target_username}/"]):has(*:has-text("Remove")), div:has(a[href*="/{target_username}"]):has(*:has-text("Remove")), div:has-text("{target_username}"):has(*:has-text("Remove"))').last
        if row.count() > 0 and row.locator('div[role="button"]:has-text("Remove"), button:has-text("Remove")').first.is_visible():
            remove_btn = row.locator('div[role="button"]:has-text("Remove"), button:has-text("Remove")').first
        else:
            remove_btn = dialog.locator('div[role="button"]:has-text("Remove"), button:has-text("Remove")').first

        if remove_btn.count() == 0 or not remove_btn.is_visible():
            print(f"   [SKIP] Could not find 'Remove' button for @{target_username} in search results.")
            page.keyboard.press("Escape")
            return False

        # Click the row's Remove button
        remove_btn.click()
        time.sleep(1.5)

        # Confirm the removal in the confirmation modal popup (second dialog)
        dialogs = page.locator('div[role="dialog"]')
        confirm_dialog = dialogs.last
        confirm_btn = confirm_dialog.locator('button:has-text("Remove"), div[role="button"]:has-text("Remove")').first

        if confirm_btn.count() > 0 and confirm_btn.is_visible():
            confirm_btn.click()
            time.sleep(2.5)  # Wait for removal request to complete on Instagram
        else:
            print(f"   [WARNING] Confirmation popup button not visible for @{target_username}.")
            page.keyboard.press("Escape")
            return False

        # Close any open dialogs cleanly
        try:
            page.keyboard.press("Escape")
            time.sleep(0.5)
        except Exception:
            pass

        return True

    except Exception as e:
        print(f"   [ERROR] Exception removing @{target_username}: {e}")
        try:
            page.keyboard.press("Escape")
        except Exception:
            pass
        return False


def remove_follower(page: Page, username: str) -> bool:
    """Helper for batch removal if dialog is already open."""
    dialog = page.locator(SELECTORS["dialog"]).first
    search_input = dialog.locator('input[placeholder*="Search" i], input[type="text"]').first
    if search_input.count() == 0:
        return False
    try:
        search_input.click()
        search_input.fill("")
        search_input.press_sequentially(username, delay=35)
        time.sleep(2.5)
        remove_btn = dialog.locator('div[role="button"]:has-text("Remove"), button:has-text("Remove")').first
        if remove_btn.count() == 0 or not remove_btn.is_visible():
            search_input.fill("")
            return False
        remove_btn.click()
        time.sleep(1.5)
        dialogs = page.locator('div[role="dialog"]')
        confirm_dialog = dialogs.last
        confirm_btn = confirm_dialog.locator('button:has-text("Remove"), div[role="button"]:has-text("Remove")').first
        if confirm_btn.count() > 0 and confirm_btn.is_visible():
            confirm_btn.click()
            time.sleep(2.5)
            search_input.fill("")
            return True
        search_input.fill("")
        return False
    except Exception:
        return False


def export_records_to_csv(filename: str, records: List[Dict[str, Any]]) -> None:
    """
    Save list of dict records to a UTF-8 with BOM CSV file for Excel compatibility.
    Merges with existing file if present so scan history is preserved across runs.
    """
    if not records:
        return
    try:
        fieldnames = [
            "username",
            "status",
            "followers",
            "following",
            "diff",
            "posts",
            "is_inactive",
            "last_post_days",
            "reason",
        ]
        existing_records_dict: Dict[str, Dict[str, Any]] = {}
        if os.path.exists(filename):
            try:
                with open(filename, mode="r", newline="", encoding="utf-8-sig") as f:
                    reader = csv.DictReader(f)
                    for row in reader:
                        u = row.get("username")
                        if u:
                            existing_records_dict[u.lower()] = dict(row)
            except Exception:
                pass

        for r in records:
            u = r.get("username")
            if u:
                existing_records_dict[u.lower()] = r

        combined_records = list(existing_records_dict.values())
        with open(filename, mode="w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            for r in combined_records:
                writer.writerow(r)
        print(f"[CSV] Successfully saved {len(combined_records)} total record(s) in '{filename}' (history preserved).")
    except Exception as e:
        print(f"[WARNING] Could not save CSV file '{filename}': {e}")


# ==============================================================================
# MAIN WORKFLOW
# ==============================================================================
def main() -> None:
    print("=" * 65)
    print("        INSTAGRAM FOLLOWER CLEANER (PLAYWRIGHT SYNC)        ")
    print("=" * 65)
    print(f"Mode: {'DRY RUN (Simulate only, no accounts removed)' if DRY_RUN else 'LIVE (Removals enabled)'}")
    print(f"Removal Criteria: {REMOVAL_MODE}")
    if CHECK_DIFF:
        print(f"  - Ratio threshold: following - followers >= {MIN_DIFF}")
    if CHECK_INACTIVE:
        print(f"  - Inactivity threshold: no posts for >= {INACTIVE_DAYS_THRESHOLD} days (or 0 posts)")
    if KEEP_USERS_WITH_POSTS_OVER is not None:
        print(f"  - Post Protection: KEEP users with > {KEEP_USERS_WITH_POSTS_OVER} posts (never remove)")
    if SKIP_PREVIOUSLY_SCANNED:
        print("  - Repeat Protection: SKIP previously scanned users (never scanned twice)")
    if MAX_FOLLOWERS_TO_SCAN:
        print(f"Scan Scope: Top {MAX_FOLLOWERS_TO_SCAN} followers from top (stops early without scrolling to bottom)")
    else:
        print("Scan Scope: All followers (scrolls to bottom)")
    print(f"Max removals per run: {MAX_REMOVALS_PER_RUN}")
    print("=" * 65)

    context: Optional[BrowserContext] = None
    playwright_instance = None
    candidates: List[Dict[str, Any]] = []
    all_scanned_records: List[Dict[str, Any]] = []

    try:
        playwright_instance = sync_playwright().start()

        # Step 0: Load previously scanned users from persistent history
        scanned_history = load_scanned_users() if SKIP_PREVIOUSLY_SCANNED else set()
        if SKIP_PREVIOUSLY_SCANNED and scanned_history:
            print(f"[HISTORY] Loaded {len(scanned_history)} previously scanned user(s) from history.")

        # Launch browser with persistent context to retain login session
        channel_to_use = "chrome" if USE_REAL_CHROME else None
        browser_name = "Google Chrome (Real)" if channel_to_use else "Chromium"
        mode_str = "Headless (Hidden Background)" if HEADLESS else "Headed (Can minimize to taskbar)"
        print(f"[INFO] Launching {browser_name} in {mode_str} mode...")

        browser_args = [
            "--disable-blink-features=AutomationControlled",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
        ]

        try:
            context = playwright_instance.chromium.launch_persistent_context(
                user_data_dir=USER_DATA_DIR,
                channel=channel_to_use,
                headless=HEADLESS,
                viewport={"width": 1280, "height": 800},
                args=browser_args,
                ignore_default_args=["--enable-automation"]
            )
        except Exception as launch_err:
            if channel_to_use:
                print(f"[WARNING] Could not launch real Chrome ({launch_err}). Falling back to Chromium...")
                context = playwright_instance.chromium.launch_persistent_context(
                    user_data_dir=USER_DATA_DIR,
                    headless=HEADLESS,
                    viewport={"width": 1280, "height": 800},
                    args=browser_args,
                    ignore_default_args=["--enable-automation"]
                )
            else:
                raise launch_err

        page = context.pages[0] if context.pages else context.new_page()

        # Step 1: Login check (waits for manual login if not logged in)
        wait_for_login(page, context)

        # Step 2: Detect username
        my_username = get_my_username(page)

        # Step 2 (cont): Open followers dialog and collect new follower usernames
        followers = get_follower_usernames(page, my_username, scanned_set=scanned_history)
        total_followers = len(followers)

        if total_followers == 0:
            print("[INFO] No new unscanned followers found. Followers list is up to date!")
            return

        print(f"\n[INFO] Starting profile inspection for {total_followers} new followers...")
        print(f"[INFO] Visiting profiles with {PROFILE_VISIT_DELAY_MIN:.0f}-{PROFILE_VISIT_DELAY_MAX:.0f}s random delay.\n")

        # Step 3 & 4: Visit each profile, check rules, and LIVE REMOVE candidates
        candidates: List[Dict[str, Any]] = []
        all_scanned_records: List[Dict[str, Any]] = []
        removed_live_count = 0

        for idx, username in enumerate(followers, start=1):
            if check_rate_limit(page):
                print("[WARNING] Halting profile scans due to rate limit detection.")
                break

            if SKIP_PREVIOUSLY_SCANNED and username.lower() in scanned_history:
                print(f"[{idx}/{total_followers}] {username} -> already scanned in previous run -> skipped")
                continue

            data = get_profile_data(page, username)

            # Record in history immediately so progress is preserved even if stopped
            if SKIP_PREVIOUSLY_SCANNED:
                save_scanned_user(username)
                scanned_history.add(username.lower())

            if data is None or data.get("followers") is None or data.get("following") is None:
                # Rule 5: If counts can't be read, skip and keep that user
                print(f"[{idx}/{total_followers}] {username} -> could not read counts -> skipped")
                all_scanned_records.append({
                    "username": username,
                    "status": "skipped",
                    "followers": "",
                    "following": "",
                    "diff": "",
                    "posts": "",
                    "is_inactive": "",
                    "last_post_days": "",
                    "reason": "could not read counts",
                })
            elif not data.get("is_follower", True):
                # Account is an Instagram suggested account and does not follow the user
                print(f"[{idx}/{total_followers}] {username} -> does not follow you (Instagram suggested account) -> skipped")
                all_scanned_records.append({
                    "username": username,
                    "status": "skipped",
                    "followers": data.get("followers", ""),
                    "following": data.get("following", ""),
                    "diff": "",
                    "posts": data.get("posts", ""),
                    "is_inactive": "",
                    "last_post_days": "",
                    "reason": "does not follow you (suggested account)",
                })
            else:
                followers_cnt = data["followers"]
                following_cnt = data["following"]
                posts_cnt = data.get("posts")
                diff = following_cnt - followers_cnt
                is_inactive = data.get("is_inactive", False)
                inactive_reason = data.get("inactive_reason", "")

                diff_match = (diff >= MIN_DIFF) if CHECK_DIFF else False
                inactive_match = is_inactive if CHECK_INACTIVE else False

                if REMOVAL_MODE == "DIFF_OR_INACTIVE":
                    is_candidate = diff_match or inactive_match
                elif REMOVAL_MODE == "INACTIVE_ONLY":
                    is_candidate = inactive_match
                elif REMOVAL_MODE == "DIFF_ONLY":
                    is_candidate = diff_match
                elif REMOVAL_MODE == "DIFF_AND_INACTIVE":
                    is_candidate = diff_match and inactive_match
                else:
                    is_candidate = diff_match or inactive_match

                # Exemption / Protection: If user has > 10 posts, NEVER remove them!
                protected_by_posts = False
                if KEEP_USERS_WITH_POSTS_OVER is not None and posts_cnt is not None and posts_cnt > KEEP_USERS_WITH_POSTS_OVER:
                    is_candidate = False
                    protected_by_posts = True

                reasons = []
                if protected_by_posts:
                    reasons.append(f"protected (> {KEEP_USERS_WITH_POSTS_OVER} posts)")
                else:
                    if diff_match:
                        reasons.append(f"diff {diff} >= {MIN_DIFF}")
                    if inactive_match:
                        reasons.append(inactive_reason)

                activity_str = f" | {inactive_reason}" if inactive_reason else ""
                posts_str = f" | posts: {posts_cnt}" if posts_cnt is not None else ""
                reason_desc = ", ".join(reasons) if reasons else ("candidate" if is_candidate else "active / within ratio")

                record = {
                    "username": username,
                    "status": "candidate" if is_candidate else "keep",
                    "followers": followers_cnt,
                    "following": following_cnt,
                    "diff": diff,
                    "posts": posts_cnt if posts_cnt is not None else "",
                    "is_inactive": is_inactive,
                    "last_post_days": data.get("last_post_days", ""),
                    "reason": reason_desc,
                }
                all_scanned_records.append(record)

                if is_candidate:
                    print(f"[{idx}/{total_followers}] {username} -> followers {followers_cnt}, following {following_cnt}, diff {diff}{activity_str}{posts_str} -> candidate ({reason_desc})")
                    candidates.append(record)

                    # LIVE REMOVAL DIRECTLY INSIDE THE LOOP!
                    if not DRY_RUN and LIVE_REMOVE_IN_LOOP:
                        print(f"   -> [LIVE REMOVE] Removing @{username} right now...")
                        success = remove_follower_live(page, my_username, username)
                        if success:
                            removed_live_count += 1
                            record["status"] = "removed"
                            print(f"   -> [SUCCESS] @{username} has been removed from your followers!")
                        else:
                            print(f"   -> [FAILED] Could not remove @{username}. Will remain in candidate report.")

                        if check_rate_limit(page):
                            print("[WARNING] Halting due to rate limit detection.")
                            break

                        # Safe pause between removals
                        rem_delay = random.uniform(REMOVAL_DELAY_MIN, REMOVAL_DELAY_MAX)
                        print(f"   -> [WAIT] Waiting {rem_delay:.1f}s before checking next profile...")
                        time.sleep(rem_delay)
                    else:
                        # Delay between profile visits
                        if idx < total_followers:
                            delay = random.uniform(PROFILE_VISIT_DELAY_MIN, PROFILE_VISIT_DELAY_MAX)
                            time.sleep(delay)
                else:
                    print(f"[{idx}/{total_followers}] {username} -> followers {followers_cnt}, following {following_cnt}, diff {diff}{activity_str}{posts_str} -> keep ({reason_desc})")
                    if idx < total_followers:
                        delay = random.uniform(PROFILE_VISIT_DELAY_MIN, PROFILE_VISIT_DELAY_MAX)
                        time.sleep(delay)

            # Periodic checkpoint export every 5 profiles or whenever a follower is removed live
            if EXPORT_CSV and (idx % 5 == 0 or (record.get("status") == "removed")):
                export_records_to_csv(CSV_ALL_REPORT, all_scanned_records)
                export_records_to_csv(CSV_CANDIDATES, candidates)

        # Export CSV reports
        if EXPORT_CSV:
            print("\n" + "-" * 65)
            print("[INFO] Generating CSV reports...")
            export_records_to_csv(CSV_ALL_REPORT, all_scanned_records)
            export_records_to_csv(CSV_CANDIDATES, candidates)
            print("-" * 65)

        # Summary of candidates
        print("\n" + "=" * 65)
        print(f"SCAN SUMMARY: Found {len(candidates)} removal candidate(s) out of {total_followers} followers.")
        if LIVE_REMOVE_IN_LOOP and not DRY_RUN:
            print(f"[LIVE MODE RESULT] Successfully removed {removed_live_count} follower(s) live during the scan!")
            print("=" * 65)
            return
        print("=" * 65)

        if not candidates:
            print("[INFO] No removal candidates met the criteria. Followers list is clean!")
            return

        for i, c in enumerate(candidates, start=1):
            print(f"  {i}. {c['username']} -> followers {c['followers']}, following {c['following']}, diff {c['diff']} ({c.get('reason', '')})")

        # Step 6: Removal Confirmation
        candidates_to_process = candidates[:MAX_REMOVALS_PER_RUN]
        n_count = len(candidates_to_process)

        if DRY_RUN:
            print("\n[DRY RUN MODE] DRY_RUN is True. No accounts will be removed.")
            print("Set DRY_RUN = False at the top of main.py to enable removal.")
            confirm = input(f"Remove these {n_count} users? (y/n): ").strip().lower()
            if confirm in ("y", "yes"):
                print("[DRY RUN] Simulation complete. No changes were made to your account.")
            else:
                print("[INFO] Exiting.")
            return

        # LIVE MODE REMOVAL
        print(f"\n[LIVE MODE] {n_count} candidate(s) ready for removal (capped at MAX_REMOVALS_PER_RUN = {MAX_REMOVALS_PER_RUN}).")
        if AUTO_CONFIRM_REMOVAL:
            print(f"[INFO] AUTO_CONFIRM_REMOVAL is enabled. Automatically proceeding with removal of {n_count} user(s)...")
        else:
            confirm = input(f"Remove these {n_count} users? (y/n): ").strip().lower()
            if confirm not in ("y", "yes"):
                print("[INFO] Removal cancelled by user. Exiting.")
                return

        print("\n[INFO] Starting follower removals...")
        print(f"[INFO] Navigating to profile: https://www.instagram.com/{my_username}/")
        page.goto(f"https://www.instagram.com/{my_username}/", wait_until="domcontentloaded")
        time.sleep(2)
        dismiss_popups(page)

        # Open Followers dialog
        followers_btn = page.locator(SELECTORS["followers_link"]).first
        if followers_btn.count() == 0 or not followers_btn.is_visible():
            followers_btn = page.locator('a:has-text("followers")').first
        followers_btn.click()

        try:
            page.wait_for_selector(SELECTORS["dialog"], timeout=10000)
        except PlaywrightTimeoutError:
            print("[ERROR] Could not open Followers dialog for removal.")
            return

        time.sleep(2)
        removed_count = 0

        for r_idx, candidate in enumerate(candidates_to_process, start=1):
            if check_rate_limit(page):
                print("[WARNING] Halting removals due to rate limit detection.")
                break

            target_user = candidate["username"]
            print(f"[{r_idx}/{n_count}] Removing @{target_user}...")

            success = remove_follower(page, target_user)
            if success:
                removed_count += 1
                print(f"[{r_idx}/{n_count}] Successfully removed @{target_user}")
            else:
                print(f"[{r_idx}/{n_count}] Could not remove @{target_user}")

            if check_rate_limit(page):
                print("[WARNING] Halting removals due to rate limit detection.")
                break

            # Delay between removals
            if r_idx < n_count:
                rem_delay = random.uniform(REMOVAL_DELAY_MIN, REMOVAL_DELAY_MAX)
                time.sleep(rem_delay)

        print("\n" + "=" * 65)
        print(f"[COMPLETE] Removed {removed_count} out of {n_count} candidates.")
        print("=" * 65)

    except KeyboardInterrupt:
        print("\n\n[INFO] Operation interrupted by user (Ctrl+C). Exiting cleanly...")

    except Exception as e:
        err_msg = str(e)
        if "ProcessSingleton" in err_msg or "profile corruption" in err_msg:
            print("\n" + "=" * 65)
            print("[ERROR] Another browser window or script is already using './ig_session'!")
            print("Please close any open Chrome/Chromium windows, then run again.")
            print("=" * 65)
        else:
            print(f"\n[UNEXPECTED ERROR] {e}")

    finally:
        if EXPORT_CSV and all_scanned_records:
            try:
                export_records_to_csv(CSV_ALL_REPORT, all_scanned_records)
                export_records_to_csv(CSV_CANDIDATES, candidates)
            except Exception:
                pass
        print("[INFO] Closing browser session cleanly...")
        if context:
            try:
                context.close()
            except Exception:
                pass
        if playwright_instance:
            try:
                playwright_instance.stop()
            except Exception:
                pass
        print("[INFO] Session closed safely. Goodbye!")


if __name__ == "__main__":
    main()
