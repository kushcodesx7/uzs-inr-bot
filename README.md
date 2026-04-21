# UZS → INR tracker

A tiny Telegram bot that checks the UZS to INR mid-market rate every 4 hours,
logs each check to an Excel file, and alerts you on Telegram only when the
change on your tracked amount exceeds ₹500.

Runs entirely on GitHub Actions — no server, no cost.

## How it works

- Schedule: `0 */4 * * *` (every 4 hours, UTC)
- Rate source: [fawazahmed0/currency-api](https://github.com/fawazahmed0/exchange-api) via jsDelivr (free, no key, aggregates multiple sources for near-Google/Wise accuracy), with a `pages.dev` fallback
- State: `last_rate.json` + `history.xlsx`, committed back to the repo after each run
- Alert rule: Telegram message sent only when `|change| > ₹500`
- First run always sends a baseline message so you know it's wired up

## Setup

### 1. Create a Telegram bot

1. Open Telegram, message [@BotFather](https://t.me/BotFather)
2. `/newbot` → pick a name and username
3. Copy the **bot token** it gives you (looks like `123456:ABC-DEF…`)

### 2. Get your chat ID

1. Message your new bot at least once (say "hi")
2. Message [@userinfobot](https://t.me/userinfobot) — it replies with your numeric chat ID

### 3. Add the three secrets

In this repo: **Settings → Secrets and variables → Actions → New repository secret**

| Name         | Value                                             |
| ------------ | ------------------------------------------------- |
| `BOT_TOKEN`  | The token from @BotFather                         |
| `CHAT_ID`    | Your numeric chat ID from @userinfobot            |
| `AMOUNT_UZS` | The UZS amount to track (plain number, no commas) |

The UZS amount never appears in code, logs, or Telegram messages — only
the resulting INR value is shown.

### 4. Run it

- **Manually the first time**: Actions tab → "UZS to INR tracker" → Run workflow
- **Automatically**: every 4 hours after that

You should receive the baseline Telegram message within a minute.

## Files

- `bot.py` — fetches rate, logs, sends alert
- `.github/workflows/tracker.yml` — scheduler + commit-back
- `last_rate.json` — last rate + INR amount (generated)
- `history.xlsx` — full check history with Indian-formatted numbers and UP/DOWN coloring (generated)

## Tweaking

- **Change the threshold**: edit `ALERT_THRESHOLD_INR` in `bot.py`
- **Change the schedule**: edit the cron in `.github/workflows/tracker.yml`
- **Change the timezone**: edit `TZ = ZoneInfo("Asia/Tashkent")` in `bot.py`
