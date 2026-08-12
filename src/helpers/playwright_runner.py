"""
Run sync Playwright safely even when the caller thread already has an asyncio
event loop (Playwright Sync API refuses to start in that case).
"""

from __future__ import annotations

import asyncio
import functools
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, TypeVar

T = TypeVar("T")


def run_sync(fn: Callable[..., T], *args, **kwargs) -> T:
    """
    Invoke `fn` inline when no asyncio loop is running; otherwise run it in a
    fresh thread so sync_playwright() can own that thread's event loop.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return fn(*args, **kwargs)

    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(fn, *args, **kwargs).result()


def playwright_sync(fn: Callable[..., T]) -> Callable[..., T]:
    """Decorator: ensure the wrapped function never starts sync Playwright on a loop thread."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return run_sync(fn, *args, **kwargs)
    return wrapper
