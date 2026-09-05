# Fonts

`python setup_engine.py` downloads and validates these open fonts from the
official `google/fonts` repository, together with each SIL Open Font License:

- `Caveat.ttf`: handwritten English headings.
- `NotoSans.ttf`: clean English captions.
- `NotoSansDevanagari.ttf`: Hindi headings and captions.

They are only downloaded during explicit setup, never during a render.
You can instead copy the TTF files here manually or use `--font /path/font.ttf`.
Hindi also requires Pillow's RAQM support so conjuncts are shaped correctly.
The renderer refuses Hindi output without shaping support rather than rendering
unreadable, disconnected glyphs.