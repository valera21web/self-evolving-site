#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="$PROJECT_ROOT/src"
DIST="$PROJECT_ROOT/dist"
TEMPLATES="$SRC/frontend/templates"
STATIC="$SRC/frontend/static"
NEWS_FILE="$SRC/data/news.json"

echo "[build] Starting build..."

rm -rf "$DIST"
mkdir -p "$DIST/static" "$DIST/article"

cp "$STATIC"/* "$DIST/static/"
cp "$TEMPLATES/admin.html" "$DIST/admin.html"

# Use Python for all HTML generation — handles special characters safely
export SRC DIST TEMPLATES STATIC NEWS_FILE
python3 << 'BUILDSCRIPT'
import json, os, html, re

src = os.environ["SRC"]
dist = os.environ["DIST"]
templates = os.environ["TEMPLATES"]
news_file = os.environ["NEWS_FILE"]

with open(news_file) as f:
    news = json.load(f)

news_count = len(news)

def esc(s):
    return html.escape(str(s)) if s else ""

def tags_html(tags):
    if not tags:
        return ""
    return "".join(f'<span class="tag">{esc(t)}</span>' for t in tags)

def md_to_html(md_text):
    """Simple, safe Markdown to HTML converter. Only allows safe formatting."""
    if not md_text:
        return ""
    # Escape HTML first to prevent injection
    text = html.escape(md_text)
    # Convert markdown bold **text** -> <strong>text</strong>
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    # Convert markdown italic *text* -> <em>text</em>
    text = re.sub(r'\*(.+?)\*', r'<em>\1</em>', text)
    # Convert inline code `code` -> <code>code</code>
    text = re.sub(r'`(.+?)`', r'<code>\1</code>', text)
    # Convert bullet lists (lines starting with - )
    lines = text.split('\n')
    result = []
    in_list = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('- '):
            if not in_list:
                result.append('<ul>')
                in_list = True
            result.append(f'<li>{stripped[2:]}</li>')
        else:
            if in_list:
                result.append('</ul>')
                in_list = False
            if stripped == '':
                result.append('</p><p>')
            else:
                result.append(stripped)
    if in_list:
        result.append('</ul>')
    return '<p>' + '\n'.join(result) + '</p>'

# Generate index news items (newest first)
items_html = ""
for item in reversed(news):
    short = item.get("shortDescription") or item.get("summary", "")
    tags = tags_html(item.get("tags", []))
    items_html += f'''<div class="news-item">
<h2><a href="/article/{esc(item["id"])}.html">{esc(item["title"])}</a></h2>
<p class="short-description">{esc(short)}</p>
{"<div class='tags'>" + tags + "</div>" if tags else ""}
<div class="meta"><span class="source">{esc(item["sourceName"])}</span>
<span class="date">{esc(item["publishedAt"])}</span></div>
</div>'''

# Generate index.html
with open(os.path.join(templates, "index.html")) as f:
    index_tpl = f.read()
index_out = index_tpl.replace("<!-- NEWS_ITEMS_PLACEHOLDER -->", items_html)
with open(os.path.join(dist, "index.html"), "w") as f:
    f.write(index_out)

# Generate article pages
with open(os.path.join(templates, "article.html")) as f:
    article_tpl = f.read()

for item in news:
    full = item.get("fullDescription") or item.get("summary", "")
    tags = tags_html(item.get("tags", []))
    article_out = article_tpl
    article_out = article_out.replace("{{TITLE}}", esc(item["title"]))
    article_out = article_out.replace("{{FULL_DESCRIPTION}}", md_to_html(full))
    article_out = article_out.replace("{{SOURCE_NAME}}", esc(item["sourceName"]))
    article_out = article_out.replace("{{SOURCE_URL}}", esc(item["sourceUrl"]))
    article_out = article_out.replace("{{PUBLISHED_AT}}", esc(item["publishedAt"]))
    article_out = article_out.replace("{{TAGS_HTML}}", tags)
    with open(os.path.join(dist, "article", f"{item['id']}.html"), "w") as f:
        f.write(article_out)

print(f"[build] Done. Generated {news_count} article(s) in {dist}/")
BUILDSCRIPT
