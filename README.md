# Blackboard TaskBar

A Tampermonkey userscript that adds a simple assignment to-do sidebar to Blackboard Learn (Ultra course view). Think "Tasks for Canvas", but for Blackboard.

**License:** [PolyForm Noncommercial 1.0.0](LICENSE) — free for personal/noncommercial use, no reselling.

> **Status:** v0.3 beta. Reads your gradebook in each current course, so items you have already submitted or that have been graded drop off automatically. Tested on one Ultra site so far.

## What it does

- Shows a collapsible panel (top-right) on Blackboard pages listing every unsubmitted assignment, quiz, or graded discussion that has a due date, across all your current courses.
- Each item shows the assignment name, course, due date/time, points possible, and a link to open it.
- Groups items by due date: **Overdue / Today / Tomorrow / This Week / Later**, sorted by due date within each group.
- Filter by course with a dropdown.
- Check items off manually. This is stored only in your browser and does **not** touch Blackboard's actual submission state.
- Toggle to show or hide completed items.
- Refreshes on page load and every 10 minutes.
- All settings and check-offs persist across page loads via Tampermonkey storage.

## What it does NOT do

- No backend, no account, no telemetry, no third-party servers. It runs 100% in your browser.
- It only reads the same assignment data Blackboard already shows you, using the session you are already logged in with. It never asks for your password.
- It does not submit, edit, or delete anything on Blackboard.

## Install (non-technical)

1. Install the Tampermonkey extension for your browser:
   - [Chrome / Edge / Brave](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)
   - [Safari](https://apps.apple.com/app/tampermonkey/id1482490089)
2. **Chrome / Edge / Brave only:** open `chrome://extensions` (or `edge://extensions`), and turn on the **Developer mode** toggle in the top-right corner. Chrome requires this for any userscript to run. Skip this on Firefox and Safari.
3. Click this link: **[Install Blackboard TaskBar](https://github.com/Rafer374/Blackboard-TaskBar/raw/main/blackboard-taskbar.user.js)**
4. Tampermonkey opens a page showing the script. Click **Install**.
5. Go to your school's Blackboard site and log in as usual. The panel appears in the top-right corner.

**If clicking the link just downloads a `.js` file** instead of opening Tampermonkey, step 2 was skipped or Tampermonkey isn't turned on. Fix that, then either click the link again or open the Tampermonkey icon → **Dashboard** → **Utilities** → paste the link into **Import from URL**. Do not double-click the downloaded file; Windows will try to run it as a desktop script and show an error. Just delete it.

## Updating

Tampermonkey checks for updates automatically. You can also open the Tampermonkey dashboard and click **Check for userscript updates**.

## Configuration

Open the script in the Tampermonkey editor and adjust the constants near the top:

| Constant | Default | Meaning |
|---|---|---|
| `REFRESH_INTERVAL_MS` | `600000` (10 min) | How often the panel refetches assignments |
| `THIS_WEEK_DAYS` | `7` | How many days ahead count as "This Week" |

## Disclaimer

This is an unofficial, student-made tool. It is not affiliated with or endorsed by Blackboard / Anthology or any university. It only reads your own session data in your own browser. Blackboard may change its internal API at any time, which would break the panel until the script is updated. Always confirm due dates in Blackboard itself.

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, modify, and share this for personal, educational, and other noncommercial purposes. Commercial use and resale are not permitted.

Copyright (c) 2026 Rafer374
