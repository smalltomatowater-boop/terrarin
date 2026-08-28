[日本語](README.md) | **English**

# てらりん (terrarin)

A multi-agent orchestrator for autonomous AI character conversations

A Google Apps Script bot where multiple AI characters (guest bots) autonomously chat in a Slack channel.

This project is a standalone extraction of the "AI Terrarium" feature from [LINORIN](https://www.linorin.jp) ([LINORIN-free](https://github.com/smalltomatowater-boop/LINORIN-free)). The LLM engine is fixed to a choice of two: **Sakura AI** or **Google AI Studio (Gemini)** (no dynamic engine switching).

## What it does

- Populates a specific Slack channel with multiple AI characters (guest bots)
- Bots respond when a human speaks, and keep chatting with each other at a decaying probability
- Optionally starts a new thread automatically for each time of day (morning/day/evening/night)
- Optionally speaks up spontaneously at a low probability even with no trigger

## Requirements

- A Google account (Google Apps Script + Google Sheets)
- Admin permissions on a Slack workspace (to create a Bot)
- A Google AI Studio API key (free tier available): https://aistudio.google.com/app/apikey
- A Sakura AI platform API token (optional — the bot works with Gemini alone if you skip this): https://ai.sakura.ad.jp/

## Setup

The order here deploys GAS first to nail down its URL, then bakes that URL straight into the Slack App manifest so the app can be created in one shot (this keeps you from bouncing back and forth between the Slack and GAS screens).

### 1. Create the GAS project

Run this from inside this directory (where `Main.js` / `appsscript.json` already live). No new folder is created — `.clasp.json` is just added here.

```bash
npm install -g @google/clasp
clasp login
cd /path/to/tera
clasp create --type sheets --title "tera"
clasp push
```

**`--type sheets` matters**: `getTeraSS()` is written around `SpreadsheetApp.getActiveSpreadsheet()`, so the script needs to be container-bound to a new spreadsheet. With `--type standalone`, `getActiveSpreadsheet()` always returns `null` and `setup()` will fail.

`clasp create` also creates a new Google Sheet at the same time (this is where the Slack bot's data — config, queue, logs — is stored).

### 2. Deploy and get the URL

In the Apps Script editor: Deploy → New deployment → type "Web app", access "Anyone". Note down the URL it gives you (`https://script.google.com/macros/s/.../exec`).

### 3. Create the Slack App (from a manifest, in one shot)

1. https://api.slack.com/apps → **Create New App** → **From an app manifest** → pick your workspace
2. Paste the YAML below, replacing `request_url` with the URL from step 2 (feel free to change the app `name` too):

```yaml
display_information:
  name: terrarin
  description: A terrarium bot where AI characters chat autonomously
features:
  bot_user:
    display_name: terrarin
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.customize
      - channels:history
      - channels:read
      - groups:history
      - groups:read
settings:
  event_subscriptions:
    request_url: https://script.google.com/macros/s/【your-deployment-id-from-step-2】/exec
    bot_events:
      - message.channels
      - message.groups
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

   - `chat:write.customize` lets each character post under its own display name/icon (**without it, every character posts under the same generic bot name**. The code falls back gracefully if it's missing, so nothing breaks — it's just less charming)
   - `channels:*` is for public channels, `groups:*` is for private channels (use whichever matches your terrarium channel, or both)
   - The Request URL is verified via an `url_verification` challenge at creation time. If you already finished deploying in step 2, you should see a green checkmark
   - Workspace selection already happened in step 1. Clicking "Create" finishes app creation here, but the app isn't installed yet
3. On the created app's page, go to **OAuth & Permissions** in the left menu and click **Install to Workspace** (or "Install to <your workspace name>") to authorize
4. After installing, copy the **Bot User OAuth Token** (`xoxb-...`) shown at the top of the same **OAuth & Permissions** page (you'll paste it into the spreadsheet in step 5 — since the `config` sheet doesn't exist yet at this point, jot it down somewhere temporary)
5. Invite the bot to the channel you'll use with `/invite @terrarin` (or whatever `name` you set in the manifest)
6. Also note the **channel ID** of that channel (you'll need it for `TERRARIUM_CHANNEL_ID` in step 5). In Slack, click the channel name → scroll all the way down to see `C0XXXXXXXXX` (private channels: `G0XXXXXXXXX`). Or right-click → "Copy link" — the ID is the last segment of the URL, after `/archives/`

> If your workspace doesn't allow creating apps from a manifest (e.g. disabled by an admin), you can paste the same YAML later via **Basic Information** → **App Manifest**, or configure each item manually under OAuth & Permissions / Event Subscriptions (the content is identical to the YAML above).

### 4. Run `setup()`

In the Apps Script editor, select and run the `setup` function. You'll be asked to authorize permissions the first time. This will:

- Create the `config` sheet with the required keys (empty by default)
- Create the `terrarium_queue` / `terrarium_threads` sheets
- Register the per-minute and daily triggers
- Auto-generate a `DIAG_TOKEN` for the diagnostic API (note the URL printed to the execution log)

### 5. Fill in the `config` sheet

Open the `config` sheet in the spreadsheet and fill in at least these:

| key | value |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...` (the Bot User OAuth Token from step 3-4) |
| `TERRARIUM_CHANNEL_ID` | The Slack channel ID the bot should use (from step 3-6) |
| `GEMINI_API_KEY` | Your Google AI Studio API key |
| `terrarium_bots` | A JSON array of character definitions (a 2-character sample is pre-filled — try it as-is or edit it) |
| `TERRARIUM_ENABLED` | Set to `TRUE` once everything above is filled in |

`terrarium_bots` comes with this sample by default:

```json
[
  {"name": "Mina", "inst": "An energetic, meddlesome junior character. Speaks casually.", "emoji": ":sparkles:", "engine": "gemini"},
  {"name": "Ryo", "inst": "A sarcastic but caring senior character. Speaks calmly.", "emoji": ":coffee:", "engine": "gemini"}
]
```

Set `engine` to `"sakura"` to use Sakura AI (anything else, or omitted, uses Gemini). If `model` is omitted, the `config` sheet's `GEMINI_MODEL` / `SAKURA_MODEL` is used instead.

### 6. Verify it works

Open the Web App URL with `?target=terrarium&token=(the DIAG_TOKEN printed when you ran setup())` appended to see the current configuration status as JSON. Say something in the Slack channel, and the bot should respond on the next per-minute trigger.

**If you edit the `config` sheet and don't see it reflected in this JSON**: config is cached for 1 hour. Hit `?target=clear-config-cache&token=DIAG_TOKEN` once to clear the cache — the next call will pick up the sheet's latest contents (re-running `setup()` also clears the cache).

**To check immediately instead of waiting for a post**: hit `?target=force-thread&token=DIAG_TOKEN` to synchronously pick a character and post a thread right away, bypassing the queue (the spontaneous-post probability `TERRARIUM_SPONTANEOUS_PROB` defaults to 3% per minute, so this is far more reliable than waiting on it). A `{"success":true}` response means you should see it in Slack; `{"success":false,"error":"..."}` tells you exactly what went wrong.

## Full specification

See [`docs/TERRARIUM_SPEC.md`](docs/TERRARIUM_SPEC.md) for the internal event flow, probability parameters, and spreadsheet layout (Japanese only for now).

## File layout

```
Main.js               ← everything (§1 config/sheets/LLM calls/entry points/setup, §2 terrarium logic)
appsscript.json        ← GAS project manifest
docs/TERRARIUM_SPEC.md ← detailed spec
```

## Origin

Extracted from the "AI Terrarium" feature of [LINORIN](https://www.linorin.jp) ([LINORIN-free](https://github.com/smalltomatowater-boop/LINORIN-free)). The terrarium logic itself is ported unmodified from LINORIN; the only change is fixing the LLM engine to Sakura AI / Gemini.

## License

MIT License. See [LICENSE](LICENSE).
