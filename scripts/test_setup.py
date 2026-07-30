"""
Setup Diagnostics Script
Tests Playwright browser engine and local DeepSeek (Ollama) server.
"""

import os
import sys
import requests
from playwright.sync_api import sync_playwright

OLLAMA_URL = "http://localhost:11434/api/tags"

def test_playwright():
    print("Testing Playwright Chromium browser...")
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto("https://fantasy.espn.com")
            print(f"  [SUCCESS] Playwright connected! Page title: '{page.title()}'")
            browser.close()
    except Exception as e:
        print(f"  [FAILED] Playwright error: {e}")

def test_nfl_data_py():
    print("Testing nfl_data_py (nflverse player stats source)...")
    try:
        import nfl_data_py as nfl
        import datetime
        year = datetime.datetime.now().year
        while year > 1999:
            try:
                df = nfl.import_weekly_data([year])
                print(f"  [SUCCESS] nfl_data_py reachable. Loaded {len(df)} weekly rows for {year}.")
                return
            except Exception:
                year -= 1
        print("  [WARNING] nfl_data_py is installed but no season data could be fetched.")
    except ImportError:
        print("  [FAILED] nfl_data_py is not installed. Run: python -m pip install nfl_data_py")
    except Exception as e:
        print(f"  [FAILED] nfl_data_py error: {e}")

def test_ollama():
    print("Testing connection to local DeepSeek (Ollama) server at http://localhost:11434...")
    try:
        res = requests.get(OLLAMA_URL, timeout=5)
        if res.status_code == 200:
            models = res.json().get("models", [])
            model_names = [m.get("name") for m in models]
            print(f"  [SUCCESS] Connected to Ollama! Available models: {model_names}")
        else:
            print(f"  [WARNING] Received status code {res.status_code} from Ollama.")
    except Exception:
        print("  [NOT RUNNING] Ollama is not detected at http://localhost:11434.")
        print("  To fix: Install Ollama (https://ollama.com) and run: ollama pull deepseek-r1:14b")

if __name__ == "__main__":
    print("--- Running Setup Diagnostics ---")
    test_playwright()
    print("")
    test_ollama()
    print("")
    test_nfl_data_py()
    print("---------------------------------")
