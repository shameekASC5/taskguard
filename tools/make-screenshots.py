#!/usr/bin/env python3
"""
Generate the synthetic screenshots used in the README.

Both images are entirely invented. They exist so the README can show what the
hook looks like without publishing a real session — a real screenshot leaks
commit hashes, test counts, deploy state, and whatever the agent happened to be
working on.

Run from the repo root:

    python3 tools/make-screenshots.py

Requires Pillow. Output is deterministic, so re-running produces identical
bytes and does not churn the diff.
"""

import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "images")

# VS Code dark theme colours.
BG = (30, 30, 30)
PANEL = (37, 37, 38)
BORDER = (60, 60, 60)
TEXT = (212, 212, 212)
DIM = (150, 150, 150)
ACCENT = (86, 156, 214)
WARN = (220, 180, 90)
ERR = (240, 100, 100)
CODE_BG = (45, 45, 48)

FONT_CANDIDATES = [
    "/System/Library/Fonts/SFNSMono.ttf",
    "/System/Library/Fonts/Menlo.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def wrap(draw, text, font, max_width):
    """Greedy word wrap. Returns a list of lines."""
    words = text.split()
    lines, current = [], ""
    for word in words:
        trial = f"{current} {word}".strip()
        if draw.textlength(trial, font=font) <= max_width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def draw_paragraph(draw, x, y, text, font, max_width, fill=TEXT, line_gap=10):
    for line in wrap(draw, text, font, max_width):
        draw.text((x, y), line, font=font, fill=fill)
        y += font.size + line_gap
    return y


def draw_code(draw, x, y, text, font, max_width):
    """Inline code chip: rounded rect behind monospace text."""
    w = draw.textlength(text, font=font)
    draw.rounded_rectangle(
        [x, y - 2, x + w + 12, y + font.size + 6], radius=4, fill=CODE_BG
    )
    draw.text((x + 6, y), text, font=font, fill=(206, 145, 120))
    return x + w + 18


def draw_rich_line(draw, x, y, segments, font, max_width, fill=TEXT):
    """
    Draw one line made of (text, kind) segments, wrapping at word boundaries.

    kind is "text" or "code". Needed because a sentence containing an inline
    code chip cannot be wrapped by the plain paragraph helper — the chip has to
    stay on the same baseline as the words around it.
    """
    # Flatten to words, remembering which are code.
    words = []
    for text, kind in segments:
        for w in text.split():
            words.append((w, kind))

    line, line_w = [], 0.0
    space = draw.textlength(" ", font=font)

    def flush(line, y):
        cx = x
        for word, kind in line:
            if kind == "code":
                cx = draw_code(draw, cx, y, word, font, max_width)
            else:
                draw.text((cx, y), word, font=font, fill=fill)
                cx += draw.textlength(word, font=font) + space
        return y + font.size + 10

    for word, kind in words:
        w = draw.textlength(word, font=font) + (12 if kind == "code" else 0)
        if line and line_w + space + w > max_width:
            y = flush(line, y)
            line, line_w = [], 0.0
        line.append((word, kind))
        line_w += w + (space if line_w else 0)

    if line:
        y = flush(line, y)
    return y


def make_blocked():
    """The 'turn blocked' screenshot: a reply, then the Stop hook firing."""
    W, H = 1170, 1165
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    body = load_font(26)
    small = load_font(22)
    mono = load_font(22)
    head = load_font(24)

    margin = 60
    inner = W - margin * 2

    # --- user bubble -------------------------------------------------------
    d.rounded_rectangle([margin, 20, W - margin, 130], radius=10, fill=PANEL)
    y = 45
    y = draw_paragraph(
        d, margin + 28, y,
        "Okay, you're right. There is no dark mode, but look at the home page. "
        "It's the home page. You can clearly see this ugly overlay.",
        body, inner - 56,
    )

    # --- assistant reply ---------------------------------------------------
    y = 175
    y = draw_paragraph(
        d, margin, y,
        "Fair point. The overlay is a separate feature, not a bug.",
        body, inner,
    )
    y += 12
    d.text((margin, y), "\u2022", font=body, fill=TEXT)
    y = draw_paragraph(
        d, margin + 26, y,
        "Haiku \u2014 written in my previous message.",
        body, inner - 26,
    )

    y += 20
    # A sentence with an inline code chip, like the original.
    y = draw_rich_line(
        d, margin, y,
        [
            ("9 regression tests pin the layout. 73 tests pass. Deployed as ", "text"),
            ("a1b2c3d", "code"),
            (".", "text"),
        ],
        body, inner,
    )

    y += 20
    y = draw_paragraph(
        d, margin, y,
        "One thing worth flagging: the same pattern could exist elsewhere. "
        "Want me to sweep the other components for it?",
        body, inner,
    )

    # --- warning panel -----------------------------------------------------
    y += 40
    d.rounded_rectangle([margin, y, W - margin, y + 52], radius=8, outline=ACCENT, width=2)
    d.text((margin + 20, y + 14), "Warning from Stop hook", font=head, fill=ACCENT)
    y += 70

    panel_h = 190
    d.rounded_rectangle([margin, y, W - margin, y + panel_h], radius=8, outline=BORDER, width=1)
    py = y + 22
    d.text((margin + 24, py), "LEDGER NUDGE #2: turn blocked \u2014 2 item(s) still open",
           font=small, fill=TEXT)
    py += 40
    d.text((margin + 24, py), "- [t1] Write a haiku about the ocean", font=small, fill=TEXT)
    py += 34
    d.text((margin + 24, py), "- [t2] Show proof that the fix works on mobile, including pictures.",
           font=small, fill=TEXT)
    py += 34
    d.text((margin + 24, py), "(2 resolved this turn)", font=small, fill=DIM)

    # --- blocked panel -----------------------------------------------------
    y += panel_h + 40
    d.text((margin, y), "\u2297  Blocked by Stop hook", font=head, fill=WARN)
    y += 46

    blocked_h = 190
    d.rounded_rectangle([margin, y, W - margin, y + blocked_h], radius=8, outline=BORDER, width=1)
    py = y + 24
    py = draw_paragraph(
        d, margin + 24, py,
        "You ended your turn, but these requested items are still unresolved:",
        small, inner - 48,
    )
    py += 6
    d.text((margin + 24, py), "- [t1] (task) Write a haiku about the ocean", font=small, fill=TEXT)
    py += 34
    d.text((margin + 24, py), "- [t2] (task) Show proof that the fix works on mobile, including pictures.",
           font=small, fill=TEXT)
    py += 34
    d.text((margin + 24, py), "Address each one now, or explicitly state why it is no longer needed.",
           font=small, fill=DIM)

    path = os.path.join(OUT_DIR, "blocked.png")
    img.save(path, "PNG", optimize=True)
    return path


def make_warning():
    """The 'warning' screenshot: the pre-tool nudge, mid-turn."""
    W, H = 1170, 900
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    body = load_font(26)
    small = load_font(22)
    head = load_font(24)

    margin = 60
    inner = W - margin * 2

    y = 40
    y = draw_paragraph(
        d, margin, y,
        "I've updated the parser and the tests are green. Next I'll wire it into the handler.",
        body, inner,
    )

    y += 40
    d.rounded_rectangle([margin, y, W - margin, y + 52], radius=8, outline=ACCENT, width=2)
    d.text((margin + 20, y + 14), "\u26a0  Warning from PreToolUse hook", font=head, fill=ACCENT)
    y += 70

    panel_h = 210
    d.rounded_rectangle([margin, y, W - margin, y + panel_h], radius=8, outline=BORDER, width=1)
    py = y + 24
    d.text((margin + 24, py), "OPEN ITEMS (taskguard) \u2014 these were requested and are not yet resolved:",
           font=small, fill=TEXT)
    py += 40
    d.text((margin + 24, py), "- [t1] (task) Add a regression test for the empty-input case",
           font=small, fill=TEXT)
    py += 34
    d.text((margin + 24, py), "- [q2] (question) What is the deploy command?", font=small, fill=TEXT)
    py += 34
    d.text((margin + 24, py), "- [t3] (task) Update the README with the new flag", font=small, fill=TEXT)
    py += 44
    d.text((margin + 24, py), "Address each one, or explicitly state why it is no longer needed.",
           font=small, fill=DIM)

    path = os.path.join(OUT_DIR, "warning.png")
    img.save(path, "PNG", optimize=True)
    return path


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for fn in (make_blocked, make_warning):
        print("wrote", fn())
