import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill

STATE_FILE = Path("last_rate.json")
HISTORY_FILE = Path("history.xlsx")
TZ = ZoneInfo("Asia/Tashkent")
ALERT_THRESHOLD_INR = 500.0
RATE_API_URLS = [
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/uzs.json",
    "https://latest.currency-api.pages.dev/v1/currencies/uzs.json",
]
TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"
CRON_HOURS_UTC = [0, 4, 8, 12, 16, 20]
DIVIDER = "━━━━━━━━━━━━━━━━"

HEADERS = [
    "Date",
    "Time",
    "Rate (1 UZS = INR)",
    "INR amount",
    "Change (INR)",
    "% Change",
    "Direction",
]

GREEN_FILL = PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid")
RED_FILL = PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")


def format_indian(n, decimals=2):
    sign = "-" if n < 0 else ""
    n = abs(float(n))
    if decimals == 0:
        int_part = f"{round(n):d}"
        dec_part = ""
    else:
        int_part, dec_part = f"{n:.{decimals}f}".split(".")
    if len(int_part) <= 3:
        out = f"{sign}{int_part}"
    else:
        last3 = int_part[-3:]
        rest = int_part[:-3]
        groups = []
        while len(rest) > 2:
            groups.insert(0, rest[-2:])
            rest = rest[:-2]
        if rest:
            groups.insert(0, rest)
        out = f"{sign}{','.join(groups)},{last3}"
    return f"{out}.{dec_part}" if dec_part else out


def fetch_rate():
    last_err = None
    for url in RATE_API_URLS:
        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            inr = data.get("uzs", {}).get("inr")
            if inr is None:
                raise RuntimeError(f"INR rate missing in response from {url}")
            return float(inr)
        except Exception as e:
            last_err = e
            print(f"Rate fetch failed from {url}: {e}", file=sys.stderr)
    raise RuntimeError(f"All rate endpoints failed: {last_err}")


def load_state():
    if not STATE_FILE.exists():
        return None
    return json.loads(STATE_FILE.read_text())


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def open_workbook():
    if HISTORY_FILE.exists():
        return load_workbook(HISTORY_FILE)
    wb = Workbook()
    ws = wb.active
    ws.title = "History"
    ws.append(HEADERS)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    widths = [12, 10, 20, 16, 14, 10, 12]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = w
    return wb


def log_row(wb, date_str, time_str, rate, inr_amount, change, pct_change, direction):
    ws = wb.active
    ws.append([date_str, time_str, rate, inr_amount, change, pct_change, direction])
    row = ws.max_row
    ws.cell(row=row, column=3).number_format = "0.00000000"
    ws.cell(row=row, column=4).number_format = "#,##0.00"
    ws.cell(row=row, column=5).number_format = "#,##0.00"
    ws.cell(row=row, column=6).number_format = "0.00"
    direction_cell = ws.cell(row=row, column=7)
    if direction == "UP":
        direction_cell.fill = GREEN_FILL
    elif direction == "DOWN":
        direction_cell.fill = RED_FILL
    wb.save(HISTORY_FILE)


def todays_range(current_inr, today_str):
    high = low = current_inr
    if not HISTORY_FILE.exists():
        return high, low
    wb = load_workbook(HISTORY_FILE, read_only=True)
    ws = wb.active
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or len(row) < 4:
            continue
        date_val, inr_val = row[0], row[3]
        if date_val == today_str and isinstance(inr_val, (int, float)):
            high = max(high, inr_val)
            low = min(low, inr_val)
    wb.close()
    return high, low


def next_check_display(now, tz):
    now_utc = now.astimezone(timezone.utc)
    for h in CRON_HOURS_UTC:
        candidate = now_utc.replace(hour=h, minute=0, second=0, microsecond=0)
        if candidate > now_utc:
            return candidate.astimezone(tz).strftime("%-I:%M %p")
    tomorrow = now_utc.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    return tomorrow.astimezone(tz).strftime("%-I:%M %p")


def send_telegram(token, chat_id, text):
    url = TELEGRAM_API.format(token=token)
    resp = requests.post(
        url,
        json={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def build_message(now, inr_amount, change, pct_change, direction, prev, today_high, today_low, next_check):
    date_display = now.strftime("%d %b %Y, %-I:%M %p")
    lines = [
        "💱 <b>UZS → INR Tracker</b>",
        DIVIDER,
        f"📅 {date_display}",
        "",
        f"You'd get: <b>₹{format_indian(inr_amount, 0)}</b>",
        "",
    ]
    if direction == "START":
        lines.append("🟢 <b>Baseline set</b>")
        lines.append(
            f"Alerts fire when change exceeds ₹{format_indian(ALERT_THRESHOLD_INR, 0)}."
        )
    else:
        emoji = {"UP": "📈", "DOWN": "📉", "FLAT": "➖"}.get(direction, "")
        sign = "+" if change >= 0 else "-"
        label = "UP" if direction == "UP" else ("DOWN" if direction == "DOWN" else "FLAT")
        lines.append(f"{emoji} <b>{label}</b> from last check")
        lines.append(
            f"Change: {sign}₹{format_indian(abs(change), 0)} ({sign}{abs(pct_change):.2f}%)"
        )
        lines.append("")
        prev_time = prev.get("timestamp_time", "—")
        lines.append(
            f"Last check: ₹{format_indian(prev['inr_amount'], 0)} ({prev_time})"
        )
    lines += [
        "",
        "📊 <b>Today's range:</b>",
        f"High: ₹{format_indian(today_high, 0)}",
        f"Low:  ₹{format_indian(today_low, 0)}",
        "",
        DIVIDER,
        f"Next check: {next_check}",
    ]
    return "\n".join(lines)


def main():
    try:
        token = os.environ["BOT_TOKEN"]
        chat_id = os.environ["CHAT_ID"]
        amount_uzs = float(os.environ["AMOUNT_UZS"])
    except KeyError as e:
        print(f"Missing required env var: {e}", file=sys.stderr)
        sys.exit(1)

    rate = fetch_rate()
    inr_amount = amount_uzs * rate

    now = datetime.now(TZ)
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M:%S")
    time_display = now.strftime("%-I:%M %p")
    full_display = now.strftime("%Y-%m-%d %H:%M %Z")

    prev = load_state()

    if prev is None:
        direction = "START"
        change = 0.0
        pct_change = 0.0
    else:
        change = inr_amount - prev["inr_amount"]
        base = prev["inr_amount"] or 1.0
        pct_change = (change / base) * 100
        if change > 0:
            direction = "UP"
        elif change < 0:
            direction = "DOWN"
        else:
            direction = "FLAT"

    wb = open_workbook()
    log_row(wb, date_str, time_str, rate, inr_amount, change, pct_change, direction)

    high, low = todays_range(inr_amount, date_str)
    next_check = next_check_display(now, TZ)

    should_send = direction == "START" or abs(change) > ALERT_THRESHOLD_INR
    if should_send:
        msg = build_message(now, inr_amount, change, pct_change, direction, prev or {}, high, low, next_check)
        send_telegram(token, chat_id, msg)
        print(f"[{full_display}] Sent ({direction}): change={change:+.2f}")
    else:
        print(f"[{full_display}] No alert: change={change:+.2f} under ₹{ALERT_THRESHOLD_INR:.0f}")

    save_state({
        "rate": rate,
        "inr_amount": inr_amount,
        "timestamp": now.isoformat(),
        "timestamp_display": full_display,
        "timestamp_time": time_display,
    })


if __name__ == "__main__":
    main()
