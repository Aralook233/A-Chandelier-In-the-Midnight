"""Regenerate the three unicode-range faces of the LXGW WenKai webfont.

  core   -> every glyph the pages paint; downloaded on first visit
  music  -> only the glyphs a track title / artist / shelf can paint; a browser
            fetches this face the first time the 节目单 actually renders a row
  fill   -> the remaining GB2312 glyphs; only fetched once a page renders a
            character neither face above can draw

Writes hashed woff2 files into public/fonts and rewrites
src/styles/story-font.css, which is what the pages import.

    py -3 tools/font_faces.py D:\\path\\to\\LXGWWenKai-Regular.ttf

File names embed a content hash so /fonts/* can be cached immutably. The core
face must cover what the browser actually paints, and Markdown turns straight
quotes into typographic ones, so the character set is read from dist/**.html
when a build is present: run `npm run build`, then this tool, then build again.
Re-run it after adding chapters. The track list is deliberately NOT part of core:
700 B 站 titles add over a thousand glyphs, and folding them in would double what
every reader downloads just to read prose. Licence: OFL 1.1, at /fonts/OFL.txt.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "fonts"
CSS = ROOT / "src" / "styles" / "story-font.css"
SUFFIXES = {".md", ".astro", ".ts", ".mjs", ".json"}
MUSIC = ROOT / "src" / "data" / "music.mjs"
MUSIC_FIELDS = ("title", "artist", "album", "side")
# Typographic characters the Markdown renderer can substitute at build time.
TYPOGRAPHY = "“”‘’«»–—…′″"


def source_ttf():
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    env = os.environ.get("LXGW_TTF")
    if env:
        return Path(env)
    raise SystemExit("give the LXGWWenKai-Regular.ttf path as an argument or in LXGW_TTF")


def visible_html_text(html):
    html = re.sub(r"<(script|style)[^>]*>[\s\S]*?</\1>", "", html, flags=re.I)
    html = re.sub(r"<[^>]+>", " ", html)
    html = re.sub(r"&#x([0-9a-f]+);", lambda m: chr(int(m.group(1), 16)), html)
    html = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), html)
    return html


def corpus_chars():
    chars = {chr(c) for c in range(0x20, 0x7F)} | set(TYPOGRAPHY)
    for path in list((ROOT / "src").rglob("*")):
        if path.is_file() and path.suffix in SUFFIXES and path.resolve() != MUSIC:
            chars.update(path.read_text(encoding="utf-8", errors="ignore"))
    # The rendered build is the ground truth for what a reader's browser paints.
    for path in list((ROOT / "dist").rglob("*.html")) if (ROOT / "dist").is_dir() else []:
        chars.update(visible_html_text(path.read_text(encoding="utf-8", errors="ignore")))
    return {c for c in chars if not ("\ud800" <= c <= "\udfff")}


def music_chars():
    """What a crate row can paint: the four text fields, nothing else from the manifest."""
    if not MUSIC.is_file():
        return set()
    chars = set()
    for line in MUSIC.read_text(encoding="utf-8", errors="ignore").splitlines():
        text = line.strip().rstrip(",")
        if not text.startswith("{"):
            continue
        try:
            track = json.loads(text)
        except ValueError:
            continue
        for field in MUSIC_FIELDS:
            chars.update(str(track.get(field) or ""))
    return {c for c in chars if not ("\ud800" <= c <= "\udfff")}


def gb2312_rows(hi_lo, hi_hi):
    out = set()
    for hi in range(hi_lo, hi_hi + 1):
        for lo in range(0xA1, 0xFF):
            try:
                out.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return out


def codepoints(chars):
    # Control characters, surrogates and non-characters are never painted glyphs,
    # and astral codepoints do not exist in GB2312, so the BMP subset is enough.
    out = set()
    for c in chars:
        cp = ord(c)
        if cp < 0x20 or cp == 0x7F or cp == 0x9F:
            continue
        if 0xD800 <= cp <= 0xDFFF or cp > 0xFFFE:
            continue
        out.add(cp)
    return sorted(out)


def merged_parts(cps, gap):
    parts, start, prev = [], cps[0], cps[0]
    for cp in cps[1:]:
        if cp - prev <= gap + 1:
            prev = cp
            continue
        parts.append((start, prev))
        start = prev = cp
    parts.append((start, prev))
    return parts


def carve(parts, holes):
    """Cut the core face's codepoints out of the fill face's ranges.

    Overlapping unicode-ranges make browsers fetch both faces, which is exactly
    the 1.4 MB this split is supposed to avoid; the cascade order does not save
    us, so the two faces must be disjoint.
    """
    holes = sorted(set(holes))
    result = []
    for lo, hi in parts:
        low = lo
        for cp in holes:
            if cp < low:
                continue
            if cp > hi:
                break
            if low <= cp - 1:
                result.append((low, cp - 1))
            low = cp + 1
        if low <= hi:
            result.append((low, hi))
    return result


def range_text(chars, gap=0, exclude=None):
    parts = merged_parts(codepoints(chars), gap)
    if exclude:
        parts = carve(parts, codepoints(exclude))
    # A range's upper bound carries no `U+` prefix: `U+20-7e`, never `U+20-U+7e`,
    # and an invalid descriptor makes the browser ignore the face's range entirely.
    return ",\n  ".join(f"U+{lo:x}" if lo == hi else f"U+{lo:x}-{hi:x}" for lo, hi in parts)


def subset(chars, tag, src):
    work = Path(os.environ.get("TEMP", "."))
    text_file = work / f"lxgw_face_{tag}.txt"
    text_file.write_text("".join(sorted(chars)), encoding="utf-8")
    out = work / f"lxgw_face_{tag}.woff2"
    cmd = [
        sys.executable, "-m", "fontTools.subset", str(src),
        f"--text-file={text_file}", f"--output-file={out}",
        "--flavor=woff2", "--drop-tables+=DSIG",
        "--ignore-missing-glyphs", "--ignore-missing-unicodes",
        "--name-IDs=1,2,3,4,6", "--no-recalc-timestamp",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    text_file.unlink(missing_ok=True)
    if res.returncode != 0:
        raise SystemExit(f"subset failed for {tag}: {res.stderr[-800:]}")
    data = out.read_bytes()
    out.unlink(missing_ok=True)
    name = f"lxgw-{tag}.{hashlib.md5(data).hexdigest()[:8]}.woff2"
    (OUT_DIR / name).write_bytes(data)
    print(f"{tag}: {len(chars)} chars, {len(data):,} bytes -> {name}")
    return name, len(data)


def main():
    src = source_ttf()
    if not src.is_file():
        raise SystemExit(f"no such font: {src}")

    core = corpus_chars()
    music = music_chars() - core
    fill = (core | music
            | gb2312_rows(0xA1, 0xA9) | gb2312_rows(0xB0, 0xD7) | gb2312_rows(0xD8, 0xF7)
            ) - core - music
    if not core or not fill:
        raise SystemExit("unexpectedly empty character set")

    for stale in OUT_DIR.glob("lxgw-*.woff2"):
        stale.unlink()

    core_name, core_size = subset(core, "core", src)
    music_name, music_size = subset(music, "music", src) if music else ("", 0)
    fill_name = subset(fill, "fill", src)[0]

    music_face = ""
    if music_name:
        music_face = f"""@font-face {{
  font-family: 'LXGW Story';
  src: url('/fonts/{music_name}') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
  unicode-range: {range_text(music, exclude=core)};
}}

"""

    CSS.write_text(
        f"""/*
 * 霞鹜文楷 / LXGW WenKai, three unicode-range faces of one family.
 *   lxgw-core   every glyph the prose paints ({core_size / 1048576:.2f} MB)
 *   lxgw-music  only the glyphs a 节目单 row can paint ({music_size / 1048576:.2f} MB, {len(music):,} chars):
 *               readers who never open the crate never download it, and readers who
 *               do get it instead of the 1.4 MB fill face
 *   lxgw-fill   the rest of GB2312, fetched only when a page renders a character
 *               neither face above carries ({len(fill):,} chars)
 * The ranges are disjoint on purpose: with overlapping unicode-ranges browsers
 * download both faces and the split saves nothing. public/_headers pins
 * `font-src 'self'`, hence self-hosted, and every name embeds a content hash so
 * /fonts/* caches immutably. Licence: OFL 1.1, at /fonts/OFL.txt.
 */
@font-face {{
  font-family: 'LXGW Story';
  src: url('/fonts/{fill_name}') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
  unicode-range: {range_text(fill, 24, exclude=core | music)};
}}

{music_face}@font-face {{
  font-family: 'LXGW Story';
  src: url('/fonts/{core_name}') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
  unicode-range: {range_text(core)};
}}

:root {{
  --font-story: 'LXGW Story', 'LXGW WenKai', '霞鹜文楷', 'Kaiti SC', 'STKaiti', 'KaiTi', '楷体', 'Noto Serif SC', '宋体', serif;
  font-family: var(--font-story);
}}

/* Forced display: the root keeps the story face and everything inherits it.
   Elements that must use another face need a class-level (more specific) rule. */
*, *::before, *::after {{
  font-family: inherit;
}}
""",
        encoding="utf-8",
    )
    print(f"css: {CSS.stat().st_size:,} bytes -> {CSS}")


if __name__ == "__main__":
    main()
