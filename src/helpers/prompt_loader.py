"""
Loads markdown prompt-guidance files from prompts/ so they can be fed to
DeepSeek ahead of each workflow's specific request. Kept as plain markdown
(not Python constants) so the guidance can be tuned without touching code —
files are read fresh on every call, so edits apply on the next run with no
server restart needed.
"""

import os
import logging

PROMPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "prompts"))


def load_guidance(*filenames: str) -> str:
    """Read one or more markdown guidance files and join them for use in a prompt."""
    sections = []
    for filename in filenames:
        path = os.path.join(PROMPTS_DIR, filename)
        try:
            with open(path, "r", encoding="utf-8") as f:
                sections.append(f.read().strip())
        except FileNotFoundError:
            logging.warning(f"Prompt guidance file not found: {path}")
    return "\n\n".join(sections)
