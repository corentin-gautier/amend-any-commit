# Draws the extension icon: a commit graph whose middle commit is being rewritten by a pencil.
# Drawn at 4x then scaled down for smooth edges.
import math
import sys
from PIL import Image, ImageDraw

S = 1024
OUT = 256
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Background: rounded square, vertical gradient.
bg = Image.new('RGBA', (S, S))
top, bottom = (52, 58, 96), (28, 31, 54)
for y in range(S):
	t = y / (S - 1)
	bg.paste(tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,), (0, y, S, y + 1))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((32, 32, S - 32, S - 32), radius=200, fill=255)
img.paste(bg, (0, 0), mask)

# Commit graph: a vertical line with three commits, the middle one highlighted in git orange.
x = 330
grey = (186, 192, 222)
orange = (240, 81, 51)
d.line((x, 150, x, 874), fill=grey, width=44)
for y in (230, 794):
	d.ellipse((x - 70, y - 70, x + 70, y + 70), fill=grey)
	d.ellipse((x - 30, y - 30, x + 30, y + 30), fill=bottom)
y = 512
d.ellipse((x - 112, y - 112, x + 112, y + 112), fill=orange)
d.ellipse((x - 52, y - 52, x + 52, y + 52), fill=(255, 236, 214))

# Message lines beside the highlighted commit, the pencil writing the last one.
cream = (255, 236, 214)
d.rounded_rectangle((500, 452, 760, 492), radius=20, fill=cream)
d.rounded_rectangle((500, 532, 640, 572), radius=20, fill=cream)

# Pencil, pointing down-left so its tip ends at the second message line.
tip = (668, 552)
angle = math.radians(-45)
ux, uy = math.cos(angle), math.sin(angle)  # along the pencil, from tip to eraser
px, py = -uy, ux  # across the pencil
half = 62

def quad(a, b, color):
	pts = [
		(tip[0] + ux * a + px * half, tip[1] + uy * a + py * half),
		(tip[0] + ux * b + px * half, tip[1] + uy * b + py * half),
		(tip[0] + ux * b - px * half, tip[1] + uy * b - py * half),
		(tip[0] + ux * a - px * half, tip[1] + uy * a - py * half),
	]
	d.polygon(pts, fill=color)

# Wooden cone, then graphite point.
cone = 130
d.polygon([
	tip,
	(tip[0] + ux * cone + px * half, tip[1] + uy * cone + py * half),
	(tip[0] + ux * cone - px * half, tip[1] + uy * cone - py * half),
], fill=(245, 205, 160))
lead = 48
d.polygon([
	tip,
	(tip[0] + ux * lead + px * half * lead / cone, tip[1] + uy * lead + py * half * lead / cone),
	(tip[0] + ux * lead - px * half * lead / cone, tip[1] + uy * lead - py * half * lead / cone),
], fill=(44, 44, 56))
quad(cone, 310, (255, 196, 61))
# A darker stripe gives the body some depth.
d.polygon([
	(tip[0] + ux * cone + px * half, tip[1] + uy * cone + py * half),
	(tip[0] + ux * 310 + px * half, tip[1] + uy * 310 + py * half),
	(tip[0] + ux * 310 + px * half * 0.33, tip[1] + uy * 310 + py * half * 0.33),
	(tip[0] + ux * cone + px * half * 0.33, tip[1] + uy * cone + py * half * 0.33),
], fill=(230, 160, 30))
quad(310, 345, (200, 205, 220))
quad(345, 410, (244, 128, 150))

img.resize((OUT, OUT), Image.LANCZOS).save(sys.argv[1])
