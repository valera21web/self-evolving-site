#!/usr/bin/env python3
"""Fetch all RSS feeds, filter out already-published articles, print candidates as JSON."""
import json
import urllib.request
import xml.etree.ElementTree as ET
import ssl
import sys

FEEDS_FILE = "/app/src/config/feeds.json"
NEWS_FILE = "/app/src/data/news.json"

# Allow unverified SSL for some feeds
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

with open(FEEDS_FILE) as f:
    feeds = json.load(f)

with open(NEWS_FILE) as f:
    news = json.load(f)

existing_urls = {item["sourceUrl"] for item in news}

candidates = []
errors = []

for feed in feeds:
    url = feed["url"]
    name = feed["name"]
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "TechPulse/1.0"})
        data = urllib.request.urlopen(req, timeout=15, context=ctx).read()
        root = ET.fromstring(data)

        # RSS 2.0 items
        for item in root.findall(".//item")[:5]:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub = (item.findtext("pubDate") or "")
            if link and link not in existing_urls:
                candidates.append({
                    "title": title,
                    "link": link,
                    "pubDate": pub,
                    "sourceName": name,
                })

        # Atom entries
        ns = "{http://www.w3.org/2005/Atom}"
        for entry in root.findall(f".//{ns}entry")[:5]:
            title = (entry.findtext(f"{ns}title") or "").strip()
            link = ""
            for l in entry.findall(f"{ns}link"):
                href = l.attrib.get("href", "")
                if href:
                    link = href.strip()
                    break
            pub = entry.findtext(f"{ns}updated") or entry.findtext(f"{ns}published") or ""
            if link and link not in existing_urls:
                candidates.append({
                    "title": title,
                    "link": link,
                    "pubDate": pub,
                    "sourceName": name,
                })
    except Exception as e:
        errors.append(f"{name}: {e}")

# Print summary
print(f"Found {len(candidates)} new candidates from {len(feeds)} feeds ({len(errors)} errors)")
if errors:
    print(f"Errors: {', '.join(errors[:5])}")
print()
print(json.dumps(candidates[:30], indent=2, ensure_ascii=False))
