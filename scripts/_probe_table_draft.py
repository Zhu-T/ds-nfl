"""Dump search-match + table row action buttons. Does not click DRAFT."""
import json
import os
from playwright.sync_api import sync_playwright

url = (
    "https://fantasy.espn.com/football/draft"
    "?leagueId=588802581&seasonId=2026&teamId=4"
    "&memberId=%7BEF154CC5-08BA-4561-9832-587314B91558%7D"
)
profile = os.path.join(os.environ.get("TEMP", "C:/tmp"), "espn_openclaw_profile")
out_path = os.path.join(os.path.dirname(__file__), "..", "data", "_probe_table_draft.json")

ROW_JS = """() => {
  const cls = (el) => (el && el.className && String(el.className).slice(0, 220)) || "";
  const info = (b) => {
    const r = b.getBoundingClientRect();
    return {
      tag: b.tagName,
      text: (b.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 50),
      aria: b.getAttribute("aria-label") || b.getAttribute("title") || "",
      cls: cls(b),
      disabled: !!b.disabled,
      vis: r.width > 0 && r.height > 0,
      y: Math.round(r.top),
      x: Math.round(r.left),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  const matches = [...document.querySelectorAll("button.player--search--match")].map((b) => ({
    name: ((b.querySelector(".playerinfo__playername") || {}).innerText || "").trim(),
    pos: ((b.querySelector(".playerinfo__playerpos") || {}).innerText || "").trim(),
    cls: cls(b),
    text: (b.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 80),
  }));
  const searchVal = (document.querySelector('input[placeholder="Player Name"]') || {}).value || "";
  const table = document.querySelector(".draft-players") || document.body;
  const firstName = table.querySelector(".fixedDataTableRowLayout_main .playerinfo__playername, .public_fixedDataTable_bodyRow .playerinfo__playername");
  let rowBtns = [];
  let rowCls = "";
  if (firstName) {
    const row = firstName.closest(".fixedDataTableRowLayout_main, .public_fixedDataTable_bodyRow, .fixedDataTableRowLayout_rowWrapper");
    rowCls = cls(row);
    rowBtns = row ? [...row.querySelectorAll("button, a, [role='button']")].map(info) : [];
  }
  const tableBtns = [...table.querySelectorAll("button")].slice(0, 25).map(info);
  const allAction = [...document.querySelectorAll("button")].filter((b) => {
    const t = (b.innerText || "") + " " + cls(b) + " " + (b.getAttribute("aria-label") || "");
    return /queue|draft|add/i.test(t) && !/pause-resume/i.test(t);
  }).slice(0, 20).map(info);
  return { searchVal, matches, firstName: firstName && firstName.innerText, rowCls, rowBtns, tableBtns, allAction };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(
        user_data_dir=profile,
        headless=False,
        args=["--disable-blink-features=AutomationControlled"],
    )
    page = browser.pages[0] if browser.pages else browser.new_page()
    for extra in browser.pages[1:]:
        try:
            extra.close()
        except Exception:
            pass
    page.goto(url, wait_until="domcontentloaded", timeout=90000)
    page.wait_for_timeout(5000)

    box = page.locator('input[placeholder="Player Name"]').first
    box.click(timeout=3000)
    box.fill("")
    box.press_sequentially("Ja'Marr Chase", delay=60)
    page.wait_for_timeout(1200)
    after_type = page.evaluate(ROW_JS)

    clicked = False
    match = page.locator("button.player--search--match").filter(has_text="Ja'Marr Chase")
    if match.count():
        match.first.click(timeout=3000)
        clicked = True
        page.wait_for_timeout(1200)
    after_click = page.evaluate(ROW_JS) if clicked else None

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(
            {"after_type": after_type, "clicked_match": clicked, "after_click": after_click},
            f,
            indent=2,
        )
    print("wrote", out_path)
    print("matches", [m.get("name") for m in (after_type or {}).get("matches") or []])
    print("clicked", clicked)
    if after_click:
        print("firstName", after_click.get("firstName"))
        print("rowBtns", after_click.get("rowBtns"))
        print("allAction", after_click.get("allAction"))
    browser.close()
