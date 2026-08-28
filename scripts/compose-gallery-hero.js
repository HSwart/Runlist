const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OUTPUT_WIDTH = 1600;
const OUTPUT_HEIGHT = 1000;

function composeGalleryHero(sidebarPath, outputPath) {
  assert.ok(fs.existsSync(sidebarPath), `Sidebar source missing: ${sidebarPath}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const scriptPath = path.join(os.tmpdir(), `runlist-compose-hero-${process.pid}.py`);
  fs.writeFileSync(scriptPath, `
from PIL import Image, ImageDraw, ImageFilter

OUTPUT_WIDTH = ${OUTPUT_WIDTH}
OUTPUT_HEIGHT = ${OUTPUT_HEIGHT}
CARD_RADIUS = 18
PADDING_X = 72
PADDING_TOP = 56
PADDING_BOTTOM = 64

sidebar = Image.open(${JSON.stringify(sidebarPath)}).convert('RGBA')
max_card_width = OUTPUT_WIDTH - (PADDING_X * 2)
max_card_height = OUTPUT_HEIGHT - PADDING_TOP - PADDING_BOTTOM
scale = min(max_card_width / sidebar.width, max_card_height / sidebar.height, 1)
if scale < 1:
    new_size = (max(1, int(sidebar.width * scale)), max(1, int(sidebar.height * scale)))
    sidebar = sidebar.resize(new_size, Image.Resampling.LANCZOS)

card = Image.new('RGBA', sidebar.size, (0, 0, 0, 0))
mask = Image.new('L', sidebar.size, 0)
draw = ImageDraw.Draw(mask)
draw.rounded_rectangle((0, 0, sidebar.width, sidebar.height), CARD_RADIUS, fill=255)
card.paste(sidebar, (0, 0), mask)

shadow = Image.new('RGBA', (card.width + 80, card.height + 80), (0, 0, 0, 0))
shadow_mask = Image.new('L', shadow.size, 0)
shadow_draw = ImageDraw.Draw(shadow_mask)
shadow_draw.rounded_rectangle((40, 40, 40 + card.width, 40 + card.height), CARD_RADIUS + 4, fill=180)
shadow = Image.new('RGBA', shadow.size, (0, 0, 0, 255))
shadow.putalpha(shadow_mask)
shadow = shadow.filter(ImageFilter.GaussianBlur(18))

canvas = Image.new('RGBA', (OUTPUT_WIDTH, OUTPUT_HEIGHT), (10, 16, 26, 255))
gradient = Image.new('RGBA', (OUTPUT_WIDTH, OUTPUT_HEIGHT), (0, 0, 0, 0))
gradient_draw = ImageDraw.Draw(gradient)
for y in range(OUTPUT_HEIGHT):
    t = y / max(OUTPUT_HEIGHT - 1, 1)
    color = (
        int(11 + (7 - 11) * t),
        int(18 + (11 - 18) * t),
        int(32 + (18 - 32) * t),
        255,
    )
    gradient_draw.line([(0, y), (OUTPUT_WIDTH, y)], fill=color)
canvas = Image.alpha_composite(canvas, gradient)

cx = (OUTPUT_WIDTH - card.width) // 2
cy = PADDING_TOP + (max_card_height - card.height) // 2
shadow_x = cx - 20
shadow_y = cy - 8
canvas.alpha_composite(shadow, (shadow_x, shadow_y))
canvas.alpha_composite(card, (cx, cy))

canvas.convert('RGB').save(${JSON.stringify(outputPath)}, optimize=True)
print(canvas.size)
`);
  const result = spawnSync('python3', [scriptPath], { encoding: 'utf8' });
  fs.rmSync(scriptPath, { force: true });
  if (result.status !== 0) {
    throw new Error(`Hero compose failed: ${result.stderr || result.stdout || result.status}`);
  }
  const stats = fs.statSync(outputPath);
  assert.ok(stats.size > 10000, 'Composed gallery hero was unexpectedly small.');
}

if (require.main === module) {
  const sidebarPath = process.argv[2];
  const outputPath = process.argv[3] || path.join(__dirname, '..', 'media', 'gallery-01-hero.png');
  composeGalleryHero(sidebarPath, outputPath);
  process.stdout.write(`Wrote ${outputPath}\n`);
}

module.exports = { composeGalleryHero };
