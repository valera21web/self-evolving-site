#!/usr/bin/env python3
"""Validate a news entry JSON before adding it to news.json.
Usage: echo '{"id":...}' | python3 validate_news.py
Exit 0 if valid, exit 1 with error description if invalid.
"""
import json
import sys
import re

def validate(entry):
    errors = []

    # Required fields
    required = ["id", "title", "shortDescription", "fullDescription", "tags", "sourceUrl", "sourceName", "publishedAt"]
    for field in required:
        if field not in entry:
            errors.append(f"Missing required field: {field}")

    if errors:
        return errors

    # id format: should be non-empty string
    if not isinstance(entry["id"], str) or len(entry["id"]) < 3:
        errors.append("id must be a string of at least 3 characters")

    # title: non-empty
    if not isinstance(entry["title"], str) or len(entry["title"]) < 5:
        errors.append("title must be at least 5 characters")

    # shortDescription: max 300 chars
    sd = entry["shortDescription"]
    if not isinstance(sd, str) or len(sd) < 20:
        errors.append("shortDescription must be at least 20 characters")
    elif len(sd) > 350:
        errors.append(f"shortDescription too long: {len(sd)} chars (max 300)")

    # fullDescription: 500-1300 chars
    fd = entry["fullDescription"]
    if not isinstance(fd, str) or len(fd) < 300:
        errors.append(f"fullDescription too short: {len(fd)} chars (min 500)")
    elif len(fd) > 1500:
        errors.append(f"fullDescription too long: {len(fd)} chars (max 1300)")

    # tags: array of 3-5 strings starting with #
    tags = entry["tags"]
    if not isinstance(tags, list):
        errors.append("tags must be an array")
    elif len(tags) < 2 or len(tags) > 6:
        errors.append(f"tags must have 3-5 items, got {len(tags)}")
    else:
        for t in tags:
            if not isinstance(t, str) or not t.startswith("#"):
                errors.append(f"Each tag must start with #, got: {t}")
                break

    # sourceUrl: must be a valid URL, not an RSS feed URL
    url = entry["sourceUrl"]
    if not isinstance(url, str) or not url.startswith("http"):
        errors.append("sourceUrl must be a valid HTTP URL")
    elif url.endswith("/feed") or url.endswith("/feed/") or url.endswith(".xml") or url.endswith("/rss"):
        errors.append(f"sourceUrl looks like an RSS feed URL, not an article URL: {url}")

    # sourceName: non-empty
    if not isinstance(entry["sourceName"], str) or len(entry["sourceName"]) < 2:
        errors.append("sourceName must be at least 2 characters")

    # publishedAt: ISO 8601 format check
    pat = entry["publishedAt"]
    if not isinstance(pat, str) or len(pat) < 10:
        errors.append("publishedAt must be an ISO 8601 date string")

    # Check for duplicate against existing news
    try:
        with open("/app/src/data/news.json") as f:
            existing = json.load(f)
        existing_urls = {item["sourceUrl"] for item in existing}
        if url in existing_urls:
            errors.append(f"Duplicate: sourceUrl already exists in news.json")
    except Exception:
        pass  # Skip duplicate check if file can't be read

    return errors


if __name__ == "__main__":
    try:
        raw = sys.stdin.read().strip()
        entry = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"INVALID JSON: {e}", file=sys.stderr)
        sys.exit(1)

    errors = validate(entry)
    if errors:
        print("VALIDATION FAILED:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)
    else:
        print("VALID")
        sys.exit(0)
