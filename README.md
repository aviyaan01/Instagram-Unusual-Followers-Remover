# Instagram Follower Cleaner

An automated, intelligent follower cleaning suite available in two modes:
1. **🌐 Chrome Extension (Manifest V3)**: Zero setup, runs directly in your existing Google Chrome browser without Python or terminal commands. (See [extension/README.md](file:///c:/Users/ASUS/Desktop/IG/extension/README.md))
2. **🐍 Python & Playwright Script**: Powerful automated background script with real Chrome browser support.

---

## 🌟 Key Features & Safety Mechanisms

- **Zero Credential Storage**: Uses a persistent Chrome profile (`./ig_session`). You log in manually once in your browser; the tool never asks for or stores your password or session keys.
- **Real Google Chrome Support**: Automatically detects and uses your installed Google Chrome browser (`USE_REAL_CHROME = True`) with fallback to Playwright Chromium.
- **Background & Minimized Execution**: Configured with background throttling prevention flags (`--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`) so you can minimize the browser window to your taskbar and use other apps while it runs.
- **⚡ Live In-Loop Removal (`LIVE_REMOVE_IN_LOOP = True`)**: Removes removal candidates **live on the spot** inside the scan loop as soon as they are identified, without having to wait for the entire scan to finish.
- **🛡️ Post Count Protection (`KEEP_USERS_WITH_POSTS_OVER = 10`)**: Accounts with **more than 10 posts** are automatically protected and kept safe, ensuring active content creators are never removed.
- **🔄 Repeat Protection (`SKIP_PREVIOUSLY_SCANNED = True`)**: Keeps a persistent history of previously evaluated accounts in `scanned_users.txt`. Future runs automatically skip already scanned followers and scroll further down to find brand new ones.
- **Rule-Based Decision Logic**:
  - **Ratio Imbalance**: Following - Followers $\ge 300$ (`MIN_DIFF = 300`).
  - **Inactivity Detection**: 0 posts or no posts in the last 60+ days (`INACTIVE_DAYS_THRESHOLD = 60`).
- **Missing / Private Account Safety**: If counts cannot be read or verified, the user is kept safe and skipped.
- **Rate-Limit & Block Protection**: Detects Instagram's "Try again later", "Action Blocked", or restriction warnings and halts immediately to protect your account.
- **Human-like Delays**: Randomized pauses between profile visits (5–15s) and removals (8–20s) to keep activity within safe Instagram limits.
- **📊 Comprehensive CSV Reports**: Automatically creates and merges `followers_report.csv` (all scanned users) and `removal_candidates.csv` (all removal candidates and their removal status) with UTF-8 BOM encoding for Microsoft Excel compatibility.

---

## 🚀 Setup & Installation

### 1. Install Dependencies
Make sure you have Python 3.8+ installed, then open your terminal in the project folder and run:

```bash
pip install -r requirements.txt
```

### 2. Install Playwright Chromium (Fallback)
If Google Chrome is not installed, install Playwright's Chromium browser:

```bash
playwright install chromium
```

---

## 📖 How to Run

### Live Mode (Default)
In `main.py`, `DRY_RUN = False` and `LIVE_REMOVE_IN_LOOP = True` are already configured for live removal.

Simply run:

```bash
python main.py
```

1. Google Chrome opens with your persistent session profile (`./ig_session`).
2. If this is your first run, log into Instagram manually in the browser. The script will detect your login cookies and continue automatically.
3. The script auto-detects your username, opens your **Followers** dialog, and scrolls down to gather new (unscanned) followers.
4. It inspects each profile one by one.
5. If a profile matches the removal rules (and has $\le 10$ posts), the script **immediately opens the followers dialog, searches the user, removes them live, and confirms the action**.
6. At the end (or if interrupted with `Ctrl+C`), full reports are saved in `followers_report.csv` and `removal_candidates.csv`.

### Simulation Mode (Dry Run)
If you want to simulate without actually removing anyone:
1. Open [main.py](file:///c:/Users/ASUS/Desktop/IG/main.py) and set:
   ```python
   DRY_RUN = True
   ```
2. Run `python main.py`. Candidates will be flagged and reported in CSV files, but no accounts will be removed.

---

## ⚙️ Configuration Reference

All settings are centralized at the top of [main.py](file:///c:/Users/ASUS/Desktop/IG/main.py):

| Setting | Current Default | Description |
| :--- | :--- | :--- |
| `TARGET_USERNAME` | `""` | Optional: Your Instagram handle (leave empty `""` to auto-detect). |
| `USE_REAL_CHROME` | `True` | `True` = use your installed Google Chrome; `False` = Playwright Chromium. |
| `HEADLESS` | `False` | `False` = headed browser (can minimize to taskbar). `True` = completely invisible background run. |
| `DRY_RUN` | `False` | `False` = LIVE removals enabled; `True` = simulation only. |
| `LIVE_REMOVE_IN_LOOP` | `True` | `True` = removes candidates immediately on the spot inside the loop. |
| `AUTO_CONFIRM_REMOVAL` | `True` | `True` = automatically confirms removal without manual `y/n` prompts. |
| `MAX_FOLLOWERS_TO_SCAN` | `150` | Number of **new (unscanned)** followers to evaluate from the top. |
| `MAX_REMOVALS_PER_RUN` | `150` | Maximum number of removals allowed in a single session. |
| `CHECK_DIFF` | `True` | Enable following vs follower difference check. |
| `MIN_DIFF` | `300` | Difference threshold: `(following - followers >= MIN_DIFF)`. |
| `CHECK_INACTIVE` | `True` | Enable inactive account detection. |
| `INACTIVE_DAYS_THRESHOLD` | `60` | Days without posting to consider inactive (60 days = 2 months). |
| `TREAT_ZERO_POSTS_AS_INACTIVE` | `True` | Treat accounts with 0 posts as inactive candidates. |
| `KEEP_USERS_WITH_POSTS_OVER` | `10` | **Protection Rule**: Accounts with > 10 posts are **never removed**. |
| `SKIP_PREVIOUSLY_SCANNED` | `True` | **Repeat Protection**: Skips accounts already scanned in previous runs. |
| `SCANNED_USERS_FILE` | `"scanned_users.txt"` | File tracking all evaluated accounts to avoid duplicate scans. |
| `REMOVAL_MODE` | `"DIFF_OR_INACTIVE"` | Modes: `"DIFF_OR_INACTIVE"`, `"INACTIVE_ONLY"`, `"DIFF_ONLY"`, or `"DIFF_AND_INACTIVE"`. |
| `EXPORT_CSV` | `True` | Automatically save/merge scan reports to CSV. |
| `CSV_ALL_REPORT` | `"followers_report.csv"` | Report file containing all scanned followers. |
| `CSV_CANDIDATES` | `"removal_candidates.csv"` | Report file containing removal candidates and their status (`removed`/`candidate`). |
| `PROFILE_VISIT_DELAY_MIN` | `5.0` | Minimum delay (seconds) between visiting profiles. |
| `PROFILE_VISIT_DELAY_MAX` | `15.0` | Maximum delay (seconds) between visiting profiles. |
| `REMOVAL_DELAY_MIN` | `8.0` | Minimum safety delay (seconds) after removing a follower. |
| `REMOVAL_DELAY_MAX` | `20.0` | Maximum safety delay (seconds) after removing a follower. |

---

## 📁 Output Files

- **`scanned_users.txt`**: Persistent list of all scanned usernames. To reset and scan everyone again from scratch, simply delete this file.
- **`followers_report.csv`**: Complete audit report of every follower checked (includes followers count, following count, difference, posts count, activity status, and decision reason).
- **`removal_candidates.csv`**: Filtered report of accounts flagged for removal, with status marked as `removed` or `candidate`.

---

## 🛠️ Selectors & Instagram Updates

Instagram occasionally modifies its web layout. All DOM selectors and regex patterns are centralized in the `SELECTORS` dictionary in [main.py](file:///c:/Users/ASUS/Desktop/IG/main.py). They prioritize resilient role-based selectors (`div[role="button"]:has-text("Remove")`, `div[role="dialog"]`) to maintain long-term stability against Instagram frontend updates.
