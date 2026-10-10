# Instagram Follower Cleaner

An automated tool built with **Python** and **Playwright (Sync API)** to clean your own Instagram followers list based on the difference between their following count and followers count.

---

## Features & Safety

- **Zero Credential Storage**: Launches Chromium in headed mode with a persistent session profile (`./ig_session`). You log in manually once in the browser; the tool never asks for or stores your password.
- **Dry-Run by Default**: `DRY_RUN = True` by default so you can safely inspect which followers qualify as candidates before doing any removals.
- **Rule-Based Filtering**: Users are flagged for removal if:
  $$\text{following\_count} - \text{followers\_count} \ge 300$$
  *(configurable via `MIN_DIFF`)*
- **Missing / Private Profile Safety**: If profile counts cannot be read for any reason, the user is kept and skipped.
- **Rate-Limit & Block Protection**: Detects Instagram's "Try again later", "Action Blocked", and restriction messages, immediately halting operations to protect your account.
- **Human-like Delays**: Uses randomized pauses between profile visits (5–15s) and removals (8–20s).
- **Graceful Termination**: Safely handles `Ctrl+C` interrupts and closes the browser context cleanly.

---

## Setup & Installation

### 1. Install Dependencies
Make sure you have Python 3.8+ installed, then run:

```bash
pip install -r requirements.txt
```

### 2. Install Playwright Chromium Browser
Download the Chromium binary used by Playwright:

```bash
playwright install chromium
```

---

## Usage

### Step 1: Run in Dry-Run Mode (Default)
Run the script:

```bash
python main.py
```

1. Chromium will open.
2. If this is your first run, log in manually to your Instagram account in the browser window. The script detects when login finishes and continues automatically.
3. The script detects your username, opens your profile's **Followers** dialog, and scrolls until all followers are loaded.
4. It visits each follower's profile with random pauses, displaying live progress:
   ```text
   [12/480] username -> followers 300, following 800, diff 500 -> candidate
   [13/480] another_user -> followers 600, following 700, diff 100 -> keep
   ```
5. At the end of the scan, it prints the candidates list and confirms that no accounts were removed because `DRY_RUN` is active.

### Step 2: Perform Removals (Live Mode)
To perform actual removals:

1. Open [main.py](file:///c:/Users/ASUS/Desktop/IG/main.py) and change:
   ```python
   DRY_RUN = False
   ```
2. Run the script:
   ```bash
   python main.py
   ```
3. After the scan finishes, the script will prompt:
   ```text
   Remove these N users? (y/n): 
   ```
4. Enter `y` to confirm. The script opens your Followers dialog, searches each candidate, clicks **Remove**, confirms the popup, and waits 8–20 seconds between removals.

---

## Configuration

All configuration constants are located at the top of [main.py](file:///c:/Users/ASUS/Desktop/IG/main.py):

| Constant | Default | Description |
| :--- | :--- | :--- |
| `USE_REAL_CHROME` | `True` | Set to `True` to use your real installed Google Chrome; `False` for Chromium. |
| `HEADLESS` | `False` | `False` = browser window can be minimized to taskbar. `True` = completely invisible background run. |
| `TARGET_USERNAME` | `""` | Optional: Your Instagram username (leave empty to auto-detect). |
| `DRY_RUN` | `True` | Set to `False` to execute real removals. |
| `MAX_FOLLOWERS_TO_SCAN` | `50` | Limit followers to scan from top (e.g. `50`, `100`, or `None` for all). Avoids scrolling to bottom. |
| `CHECK_DIFF` | `True` | Enable checking ratio difference `(following - followers >= MIN_DIFF)`. |
| `MIN_DIFF` | `300` | Difference threshold `(following - followers >= MIN_DIFF)`. |
| `CHECK_INACTIVE` | `True` | Enable detecting inactive accounts (no posts for X days, or 0 posts). |
| `INACTIVE_DAYS_THRESHOLD` | `60` | Days without posting to consider inactive (default `60` = 2 months). |
| `TREAT_ZERO_POSTS_AS_INACTIVE` | `True` | Treat accounts with 0 posts as inactive candidates. |
| `KEEP_USERS_WITH_POSTS_OVER` | `10` | Exemption: Users with > 10 posts are never removed (kept safe). |
| `SKIP_PREVIOUSLY_SCANNED` | `True` | Never scans the same user twice across runs (saved in `scanned_users.txt`). |
| `REMOVAL_MODE` | `"DIFF_OR_INACTIVE"` | Criteria mode: `"DIFF_OR_INACTIVE"`, `"INACTIVE_ONLY"`, `"DIFF_ONLY"`, or `"DIFF_AND_INACTIVE"`. |
| `MAX_REMOVALS_PER_RUN` | `150` | Maximum number of accounts to remove per session. |
| `PROFILE_VISIT_DELAY_MIN` | `5.0` | Minimum delay (seconds) between visiting profiles. |
| `PROFILE_VISIT_DELAY_MAX` | `15.0` | Maximum delay (seconds) between visiting profiles. |
| `REMOVAL_DELAY_MIN` | `8.0` | Minimum delay (seconds) between follower removals. |
| `REMOVAL_DELAY_MAX` | `20.0` | Maximum delay (seconds) between follower removals. |
| `SCROLL_DELAY_MIN` | `1.0` | Minimum pause (seconds) while scrolling followers list. |
| `SCROLL_DELAY_MAX` | `2.5` | Maximum pause (seconds) while scrolling followers list. |
| `USER_DATA_DIR` | `"./ig_session"` | Folder storing browser cookies/session. |

---

## Updating Selectors

Instagram regularly updates its web markup. All CSS selectors and text patterns are centralized in the `SELECTORS` dictionary at the top of [main.py](file:///c:/Users/ASUS/Desktop/IG/main.py). They prioritize text and role-based selectors over minified CSS class names.
