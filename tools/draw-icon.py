# Draws the extension icon: VS Code's own Source Control icon (the "source-control" codicon), so the
# extension reads as part of that view, with a context menu next to it, since the extension adds to the right-click menu of that view, in white on a warm gradient.
# The glyph comes from the codicon font that ships with VS Code. Codicons: (c) Microsoft, CC BY 4.0,
# https://github.com/microsoft/vscode-codicons
# Usage: python3 tools/draw-icon.py icon.png [path/to/codicon.ttf]  (needs Pillow)
import sys
from PIL import Image, ImageDraw, ImageFont

FONT = sys.argv[2] if len(sys.argv) > 2 else '/Applications/Visual Studio Code.app/Contents/Resources/app/out/media/codicon.ttf'
SOURCE_CONTROL = chr(0xEA68)
S = 1024
OUT = 256
GLYPH = 470  # size of the icon inside the square
SHIFT = (-215, 0)  # off center, to leave room for the menu

# Background: rounded square with a diagonal gradient.
start, end = (255, 138, 61), (226, 52, 110)
bg = Image.new('RGBA', (S, S))
px = bg.load()
for y in range(S):
	for x in range(S):
		t = (x + y) / (2 * (S - 1))
		px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(start, end)) + (255,)
shape = Image.new('L', (S, S), 0)
ImageDraw.Draw(shape).rounded_rectangle((32, 32, S - 32, S - 32), radius=210, fill=255)
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
img.paste(bg, (0, 0), shape)

# The glyph, scaled so its drawn shape (not the font's em box) is GLYPH wide or tall, then centered.
probe = ImageFont.truetype(FONT, 1000)
x0, y0, x1, y1 = probe.getbbox(SOURCE_CONTROL)
font = ImageFont.truetype(FONT, round(1000 * GLYPH / max(x1 - x0, y1 - y0)))
x0, y0, x1, y1 = font.getbbox(SOURCE_CONTROL)
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).text(((S - (x1 - x0)) / 2 - x0 + SHIFT[0], (S - (y1 - y0)) / 2 - y0 + SHIFT[1]), SOURCE_CONTROL, font=font, fill=255)

# Context menu: a card with three entries, the middle one highlighted under the mouse pointer,
# cut away from the icon around it.
d = ImageDraw.Draw(mask)
left, top, right, bottom, gap = 500, 330, 872, 694, 30
d.rounded_rectangle((left - gap, top - gap, right + gap, bottom + gap), radius=48 + gap, fill=0)
d.rounded_rectangle((left, top, right, bottom), radius=48, fill=255)
row = (bottom - top) / 3
for i in range(3):
	y = top + row * (i + 0.5)
	if i == 1:
		# Highlighted entry: a band cut out, with its label left white inside it.
		d.rounded_rectangle((left + 24, y - 44, right - 24, y + 44), radius=24, fill=0)
		d.rounded_rectangle((left + 60, y - 15, right - 150, y + 15), radius=15, fill=255)
	else:
		d.rounded_rectangle((left + 60, y - 15, right - 60 - (90 if i else 0), y + 15), radius=15, fill=0)

# Mouse pointer on the highlighted entry, with a cut-out outline.
def pointer(x, y, k):
	return [(x + px * k, y + py * k) for px, py in ((0, 0), (0, 17), (4.2, 13), (7.2, 19.5), (10.2, 18.2), (7.4, 11.8), (12.6, 11.8))]
tip = (742, 528)
d.polygon(pointer(*tip, 10.5), fill=0)
d.line(pointer(*tip, 10.5) + [tip], fill=0, width=36, joint='curve')
d.polygon(pointer(*tip, 10.5), fill=255)

white = Image.new('RGBA', (S, S), (255, 255, 255, 255))
img.paste(white, (0, 0), Image.composite(mask, Image.new('L', (S, S), 0), shape))
img.resize((OUT, OUT), Image.LANCZOS).save(sys.argv[1])
