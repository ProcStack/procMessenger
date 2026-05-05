"""
procMessenger – Tavily Web Search

Provides async keyword search via the Tavily REST API.
Only text-based search results are returned; no file downloads are performed.
All returned text is sanitised before being passed upstream.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Dict, List

import aiohttp

logger = logging.getLogger("procMessenger.llm.tavily")

TAVILY_SEARCH_URL = "https://api.tavily.com/search"

# Safety cap: max characters kept per result snippet
_MAX_SNIPPET_LEN = 2_000
# Safety cap: max characters kept for the synthesised AI answer
_MAX_ANSWER_LEN  = 1_000


def _sanitize_text(text: Any) -> str:
    """
    Strip null bytes and most non-printable control characters from text.
    Keeps newlines (\\n), carriage returns (\\r), and horizontal tabs (\\t).
    """
    if not isinstance(text, str):
        return ""
    # Remove C0/C1 control characters except \\t \\n \\r
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]", "", text)
    return text.strip()


async def tavily_search(
    query: str,
    api_key: str,
    max_results: int = 10,
    search_depth: str = "basic",
    include_answer: bool = False,
) -> Dict[str, Any]:
    """
    Perform a Tavily web search and return sanitised results.

    Parameters
    ----------
    query        : Search query string.
    api_key      : Tavily API key.
    max_results  : Maximum results to return (capped 1–20).
    search_depth : ``"basic"`` (≈1 credit) or ``"advanced"`` (≈2 credits).
    include_answer : If True, request Tavily's synthesised AI answer.

    Returns
    -------
    dict with keys:
        ``query``    – the sanitised query string
        ``answer``   – AI-synthesised answer (empty string unless ``include_answer`` is True)
        ``results``  – list of {url, title, snippet, score}
        ``error``    – present only on failure; value is a human-readable message
    """
    query = _sanitize_text(query)
    if not query:
        return {"query": query, "results": [], "error": "Empty query."}

    max_results = min(max(1, int(max_results)), 20)

    request_body = {
        "api_key":            api_key,
        "query":              query,
        "max_results":        max_results,
        "search_depth":       search_depth,
        "include_answer":     include_answer,
        # Security: never request raw page content or images through this API
        "include_raw_content": False,
        "include_images":     False,
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                TAVILY_SEARCH_URL,
                json=request_body,
                headers={"Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=30),
                # Never follow redirects to unexpected hosts
                allow_redirects=False,
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    logger.error(
                        "Tavily API HTTP %s: %s",
                        resp.status,
                        body[:300],
                    )
                    return {
                        "query":   query,
                        "results": [],
                        "error":   f"Tavily API returned HTTP {resp.status}.",
                    }
                data = await resp.json(content_type=None)

    except aiohttp.ClientResponseError as exc:
        logger.error("Tavily HTTP error: %s", exc)
        return {"query": query, "results": [], "error": f"HTTP error: {exc}"}
    except aiohttp.ClientError as exc:
        logger.error("Tavily network error: %s", exc)
        return {"query": query, "results": [], "error": f"Network error: {exc}"}
    except asyncio.TimeoutError:
        logger.error("Tavily request timed out.")
        return {"query": query, "results": [], "error": "Request timed out."}

    # --- Parse and sanitise results ---
    raw_results: List[Dict] = data.get("results", [])
    results: List[Dict] = []

    for item in raw_results:
        url = _sanitize_text(item.get("url", ""))
        # Block any non-http/https URLs as a safety measure
        if not re.match(r"^https?://", url):
            logger.warning("Skipping non-HTTP URL from Tavily result: %s", url[:80])
            continue

        title   = _sanitize_text(item.get("title",   ""))[:300]
        snippet = _sanitize_text(item.get("content", ""))[:_MAX_SNIPPET_LEN]
        score   = float(item.get("score", 0.0))

        results.append({
            "url":     url,
            "title":   title,
            "snippet": snippet,
            "score":   round(score, 4),
        })

    answer = ""
    if include_answer:
        answer = _sanitize_text(data.get("answer", ""))[:_MAX_ANSWER_LEN]

    return {
        "query":   query,
        "answer":  answer,
        "results": results,
    }
