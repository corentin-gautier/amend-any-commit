# Draws the extension icon: a branch whose middle commit points to its message, which a pencil rewrites.
# White shapes on a warm gradient, drawn at 4x then scaled down for smooth edges.
# Usage: python3 tools/draw-icon.py icon.png  (needs Pillow)
import math
import sys
from PIL import Image, ImageDraw

S = 1024
OUT = 256

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

# Everything white is drawn into one mask, so holes and gaps show the gradient through.
mask = Image.new('L', (S, S), 0)
d = ImageDraw.Draw(mask)
ON, OFF = 255, 0

def line(a, b, width, fill=ON):
	d.line((a, b), fill=fill, width=width)
	for x, y in (a, b):
		d.ellipse((x - width / 2, y - width / 2, x + width / 2, y + width / 2), fill=fill)

def circle(x, y, r, fill=ON):
	d.ellipse((x - r, y - r, x + r, y + r), fill=fill)

# Branch with two hollow commits and the solid one being amended.
bx = 214
line((bx, 256), (bx, 768), 48)
for y in (256, 768):
	circle(bx, y, 74)
	circle(bx, y, 34, OFF)
circle(bx, 512, 96)

# Its message: a link to a solid card, its lines of text cut out.
line((bx, 512), (380, 512), 44)
d.rounded_rectangle((352, 336, 852, 688), radius=84, fill=ON)
line((476, 450), (772, 450), 56, OFF)
line((476, 572), (634, 572), 56, OFF)

# Pencil writing the end of the second line, cut out from what lies under it.
tip = (676, 590)
angle = math.radians(-45)
ux, uy = math.cos(angle), math.sin(angle)  # from the tip towards the eraser
nx, ny = -uy, ux  # across the pencil
half = 48
length = 270

def at(along, across):
	return (tip[0] + ux * along + nx * across, tip[1] + uy * along + ny * across)

def pencil(grow, fill):
	cone = 96
	d.polygon([at(-grow * 1.4, 0), at(cone, half + grow), at(cone, -half - grow)], fill=fill)
	d.polygon([at(cone, half + grow), at(length, half + grow), at(length, -half - grow), at(cone, -half - grow)], fill=fill)
	ex, ey = at(length, 0)
	r = half + grow
	d.ellipse((ex - r, ey - r, ex + r, ey + r), fill=fill)

pencil(26, OFF)
pencil(0, ON)
# Gaps mark the wood cone and the eraser band.
for along in (96, 214):
	d.line((at(along, half + 4), at(along, -half - 4)), fill=OFF, width=18)

white = Image.new('RGBA', (S, S), (255, 255, 255, 255))
img.paste(white, (0, 0), Image.composite(mask, Image.new('L', (S, S), 0), shape))
img.resize((OUT, OUT), Image.LANCZOS).save(sys.argv[1])
