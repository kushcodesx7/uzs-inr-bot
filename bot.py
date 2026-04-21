import json
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill

STATE_FILE = Path("last_rate.json")
HISTORY_FILE = Path("history.xlsx")
TZ = ZoneInfo("Asia/Tashkent")
ALERT_THRESHOLD_INR = 500.0
API_URL = "https://open.er-api.com/v6/latest/UZS"
TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"

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


def format_indian(n):
    sign = "-" if n < 0 else ""
    n = abs(float(n))
    int_part, dec_part = f"{n:.2f}".split(".")
    if len(int_part) <= 3:
        return f"{sign}{int_part}.{dec_part}"
    last3 = int_part[-3:]
    rest = int_part[:-3]
    groups = []
    while len(rest) > 2:
        groups.insert(0, rest[-2:])
        rest = rest[:-2]
    if rest:
        groups.insert(0, rest)
    return f"{sign}{','.join(groups)},{last3}.{dec_part}"


def fetch_rate():
    resp = requests.get(API_URL, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if data.get("result") != "success":
        raise RuntimeError(f"API returned non-success result: {data.get('result')}")
    return float(data["rates"]["INR"])


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


def build_update_message(rate, inr_amount, change, pct_change, direction, prev):
    emoji = "📈" if direction == "UP" else "📉"
    sign = "+" if change >= 0 else "-"
    prev_time = prev.get("timestamp_display", "—")
    return "\n".join([
        f"{emoji} <b>UZS → INR update</b>",
        "",
        f"Rate: <code>1 UZS = ₹{rate:.8f}</code>",
        f"Current: <b>₹{format_indian(inr_amount)}</b>",
        f"Change: <b>{sign}₹{format_indian(abs(change))}</b> ({sign}{abs(pct_change):.2f}%)",
        f"Previous: ₹{format_indian(prev['inr_amount'])} at {prev_time}",
    ])


def build_baseline_message(rate, inr_amount):
    return "\n".join([
        "🟢 <b>UZS → INR tracker started</b>",
        "",
        f"Rate: <code>1 UZS = ₹{rate:.8f}</code>",
        f"Current: <b>₹{format_indian(inr_amount)}</b>",
        "",
        f"Alerts will fire when change exceeds ₹{format_indian(ALERT_THRESHOLD_INR)}.",
    ])


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
    display_ts = now.strftime("%Y-%m-%d %H:%M %Z")

    prev = load_state()

    if prev is None:
        direction = "START"
        change = 0.0
        pct_change = 0.0
        send_telegram(token, chat_id, build_baseline_message(rate, inr_amount))
        print(f"[{display_ts}] Baseline: rate={rate:.8f}, INR={inr_amount:.2f}")
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
        if abs(change) > ALERT_THRESHOLD_INR:
            msg = build_update_message(rate, inr_amount, change, pct_change, direction, prev)
            send_telegram(token, chat_id, msg)
            print(f"[{display_ts}] Alert sent: change={change:+.2f} ({pct_change:+.2f}%)")
        else:
            print(f"[{display_ts}] No alert: change={change:+.2f} under threshold ₹{ALERT_THRESHOLD_INR:.0f}")

    wb = open_workbook()
    log_row(wb, date_str, time_str, rate, inr_amount, change, pct_change, direction)

    save_state({
        "rate": rate,
        "inr_amount": inr_amount,
        "timestamp": now.isoformat(),
        "timestamp_display": display_ts,
    })


if __name__ == "__main__":
    main()
