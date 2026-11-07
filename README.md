# Smart Tab Saver

A Chrome extension that keeps only the tabs you need awake, using a policy learned from Belady's optimal algorithm, plus task focus, predictive wake, away and handoff, green mode and call mode.

Manifest V3 · Chrome 116 or later · plain JavaScript ES modules, no build step and no dependencies.

## Demo

[![Smart Tab Saver demo: lowering the limit puts tabs to sleep, predictive wake, call mode](docs/demo/preview.gif)](docs/demo/smart-tab-saver-demo.mp4?raw=true)

**[Watch the full demo (4:21, MP4)](docs/demo/smart-tab-saver-demo.mp4?raw=true)** · [also on Google Drive](https://drive.google.com/file/d/1zC7HcSF-0APsv2wK4xu38vv_f1qBksJv/view?usp=sharing)

The video walks through the awake-tab limit, reloads compared with LRU, task focus, predictive wake, call mode, green mode and "Learn from my browsing". It was recorded in Chromium with the extension loaded unpacked. The websites are local stand-in pages, the grace period and task timer were shortened so effects show within seconds, and the battery event was sent by the demo script (the recording machine has no battery).

## The idea: tabs are pages

Every open tab holds memory, but you only work with a few at a time. Smart Tab Saver manages tabs the way an operating system manages pages:

| Operating system | Smart Tab Saver |
|---|---|
| Page | Tab |
| Memory size C | "Keep awake at most" (default 8 websites) |
| Page reference | Opening or switching to a tab |
| Eviction | Putting a tab to sleep with `chrome.tabs.discard` (it stays in the tab strip) |
| Page fault | Going back to a sleeping tab, which has to reload |
| Belady's OPT | The teacher the model is trained to imitate |
| LRU | The fallback, and the baseline every decision is measured against |

## How it picks the tab to sleep

1. **Score.** Each tab that may sleep gets a probability that it won't be needed soon, from a logistic regression over eight features of its history: age, use count, the last three gaps between uses, mean gap, how overdue it is (age ÷ mean gap) and whether it was used more than once. The model was trained offline to imitate OPT: a tab is labelled "not needed soon" if its next use is more than 2 × C switches away.
2. **Fall back.** If even the best score is below the confidence threshold (default 50%), the least recently used tab sleeps instead.
3. **Regret guard.** Going back soon to a tab that slept counts against whichever of the model or LRU chose it, and trust shifts between the two (multiplicative weights). The popup shows the current split as a trust bar.
4. **Keep score.** A shadow LRU runs on the same switches with the same limit and protections, so the popup can show your reloads next to the ones plain LRU would have caused.

Tabs from the task you're working on are the last to go.

### What never sleeps

- The tab you're looking at, and any tab opened or switched to in the last 60 seconds
- Chrome's own pages, pinned tabs (unless you turn that off) and tabs playing sound
- Sites you exclude in Settings
- Tabs where you typed into a form and haven't submitted (optional, needs permission)
- The tab you're in a call on

## Smart features

Each one can be switched on or off in the popup, with a "Why?" that explains it.

| Feature | What it does | Default |
|---|---|---|
| **Task focus** | Groups your tabs into tasks from their titles, site names and addresses (TF-IDF and average-linkage clustering, on this computer). When you've left a task for 2 minutes and 3 tab switches, its tabs sleep together. Tasks can also be shown as Chrome tab groups. | On |
| **Predictive wake** | Moving the mouse quickly up toward the tab bar wakes the sleeping tab you'll most likely open next: the one you usually go to from this tab, or the latest tab of the same task. Pointing at a sleeping tab in the popup wakes it too. | Off (needs site permission) |
| **Away & handoff** | A video you paused and left for 10 minutes sleeps, and half as many tabs stay awake while you're away (5 minutes without input, or a locked screen). Optional handoff: when the same video starts on your other Chrome device, the paused one here sleeps. | On (handoff off) |
| **Green mode** | On battery, with the CPU at 75% or more, or with a high-carbon power grid (optional, free [Electricity Maps](https://www.electricitymaps.com/) key), the limit drops to three quarters and the model may act on lower confidence. | On |
| **Call mode** | During a video call in the browser (Meet, Zoom, Teams, Webex, Slack, Discord, Whereby), half as many tabs stay awake. It only notices that the call site turned your microphone or camera on or off. | Off (needs permission for the call sites) |

When several modes apply, the strictest limit wins, and the limit never drops below 2.

### Learn from my browsing

The button in the popup retrains the model on your own tab switches (the last 5,000). Your history is replayed under OPT, every moment a tab had to sleep becomes a labelled example, and a new logistic regression is fitted by Newton's method. The new model is kept only if, replayed on that same history, it causes no more reloads than the current one. It needs more distinct tabs than your limit and at least 100 training examples, and it all stays on your computer. Settings has a button to go back to the pretrained model.

## The popup

From top to bottom: how many websites are awake out of the limit and how much RAM is free; the tasks found in your tabs; the "Keep awake at most" slider; reloads with Smart Tab Saver next to plain LRU; the trust bar between the model and LRU; the tabs next in line to sleep, with the model's score; the sleeping tabs, each with the reason it slept; the five smart features; and "Learn from my browsing". The switch in the header pauses the extension.

Settings (the link at the bottom of the popup) holds the protections, the confidence threshold, excluded sites, the task timer, tab groups, the away and paused-video timers, handoff, the Electricity Maps key and zone, and buttons to reset the model or the reload counts.

## Results

From our Review 3 report: a trace-driven simulation over 30 synthetic task-structured browsing strings of 1,200 switches each, with the limit at C = 8.

| Policy | Reloads per 1,200 switches |
|---|---|
| Belady OPT (lower bound) | 54.9 |
| LRU | 124.1 |
| Smart Tab Saver (model + fallback + regret guard) | 134.7 |
| Learned model alone | 247.1 |

- On task-structured browsing LRU is hard to beat. The shipped hybrid stays within 12% of LRU at every limit tested, while the model alone would double the reloads.
- Where LRU breaks down, on a loop over 10 tabs, the model causes 410 reloads against 1,190 for LRU (OPT: 264).
- Retraining on a user's own first 600 switches cut the model's reloads on the next 600 by 25% (109.3 → 81.5).
- Task clustering grouped 27 realistic tabs into 8 tasks with an adjusted Rand index of 0.87 and no wrong merges.

## Privacy and permissions

Everything is worked out on your computer and kept in `chrome.storage.local`. Two things leave it, and only if you turn them on: handoff shares a scrambled code of the playing video's address (never the address) through Chrome sync, and green mode asks Electricity Maps for your zone's grid carbon if you add a key. The page scripts never read or send what you type or what's on the page.

| Permission | Used for |
|---|---|
| `tabs` | Seeing tab switches, putting tabs to sleep and waking them |
| `storage` | Settings, tab history and reload counts (local); the handoff code (sync) |
| `alarms` | Checking the limit once a minute |
| `scripting` | Registering the optional page scripts |
| `system.memory`, `system.cpu` | Free RAM in the popup; CPU load for green mode |
| `idle` | Noticing when you're away |
| `offscreen` | Reading the battery status for green mode |
| `tabGroups` | Showing tasks as tab groups (optional) |
| Site access (optional, asked for when needed) | Typing protection and predictive wake (all sites); call mode (the call sites); grid carbon (api.electricitymap.org) |

## Install

1. Download or clone this repository:
   ```bash
   git clone https://github.com/rajveer-lab/oschromium.git
   ```
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `oschromium` folder.
4. Click the Smart Tab Saver icon in the toolbar (pin it from the puzzle-piece menu) to open the popup.

## Tests

The end-to-end suite loads the extension into real Chromium under Xvfb (Linux) and checks every feature: the limit, task detection, task focus, predictive wake, call mode, green mode, handoff, paused video and away, tab groups, and the popup and settings pages.

```bash
tests/build.sh && tests/run.sh
```

`tests/build.sh` builds a test copy in `tests/ext` with local stand-ins for the call sites and the carbon API. Set `CHROME` to a Chromium or Chrome for Testing binary if it isn't found; branded Google Chrome no longer loads unpacked extensions from the command line.

## Project structure

| File | What it does |
|---|---|
| `manifest.json` | Manifest V3: permissions, service worker, popup, icons |
| `background.js` | Service worker: tab switches, regret guard, enforcing the limit, smart features, learning |
| `policy.js` | Features, pretrained model, OPT labelling, logistic regression, replay |
| `rules.js` | Which tabs count and may sleep, default settings, the current limit |
| `tasks.js` | Task clustering: TF-IDF and average-linkage clustering of tabs |
| `popup.html`, `popup.css`, `popup.js` | The toolbar popup |
| `options.html`, `options.js` | The settings page |
| `content-typing.js` | Notices unsaved form input |
| `content-intent.js` | Notices the mouse heading for the tab bar |
| `content-call.js`, `content-call-relay.js` | Notice a call's microphone and camera turning on or off |
| `offscreen.html`, `offscreen.js` | Battery status for green mode |
| `tests/` | `build.sh`, `run.sh`, the test runner (`harness/`) and local test pages (`site/`) |
| `docs/demo/` | The demo video and its preview |

## Related

The feature set and the OPT labelling come from the companion Python project, [Learned Page Replacement](https://github.com/rajveer-lab/autonomous-file-decay/tree/HEAD/ml-page-replacement), which compares learned and classical page-replacement policies on memory and file traces.

## Authors

Saharsh Indurkar, Aryan Upadhyay and Rajveer Singh Chopra. Course project for BCSE303P Operating Systems, School of Computer Science and Engineering (SCOPE), Vellore Institute of Technology, under the guidance of Dr. Ezhil Arasi V.
