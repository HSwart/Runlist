const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OUTPUT_WIDTH = 1600;
const OUTPUT_HEIGHT = 1000;

function composeGalleryHero(sourcePath, outputPath, crop) {
  assert.ok(fs.existsSync(sourcePath), `Hero source missing: ${sourcePath}`);
  assert.ok(crop && Number.isFinite(crop.x) && Number.isFinite(crop.y)
    && Number.isFinite(crop.width) && Number.isFinite(crop.height),
  'Hero compose requires a workbench crop rectangle.');
  const scale = crop.deviceScaleFactor || 2;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const scriptPath = path.join(os.tmpdir(), `runlist-compose-hero-${process.pid}.py`);
  fs.writeFileSync(scriptPath, `
from PIL import Image, ImageDraw, ImageFilter

OUTPUT_WIDTH = ${OUTPUT_WIDTH}
OUTPUT_HEIGHT = ${OUTPUT_HEIGHT}
CARD_RADIUS = 18
PADDING_X = 48
PADDING_Y = 40
SCALE = ${scale}

source = Image.open(${JSON.stringify(sourcePath)}).convert('RGBA')
crop_box = (
    int(round(${crop.x} * SCALE)),
    int(round(${crop.y} * SCALE)),
    int(round((${crop.x} + ${crop.width}) * SCALE)),
    int(round((${crop.y} + ${crop.height}) * SCALE)),
)
frame = source.crop(crop_box)

max_card_width = OUTPUT_WIDTH - (PADDING_X * 2)
max_card_height = OUTPUT_HEIGHT - (PADDING_Y * 2)
fit_scale = min(max_card_width / frame.width, max_card_height / frame.height)
if fit_scale <= 0:
    raise SystemExit('Hero frame has invalid dimensions.')
if abs(fit_scale - 1) > 0.001:
    frame = frame.resize(
        (max(1, int(frame.width * fit_scale)), max(1, int(frame.height * fit_scale))),
        Image.Resampling.LANCZOS,
    )

card = Image.new('RGBA', frame.size, (0, 0, 0, 0))
mask = Image.new('L', frame.size, 0)
draw = ImageDraw.Draw(mask)
draw.rounded_rectangle((0, 0, frame.width, frame.height), CARD_RADIUS, fill=255)
card.paste(frame, (0, 0), mask)

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
cy = (OUTPUT_HEIGHT - card.height) // 2
canvas.alpha_composite(shadow, (cx - 20, cy - 8))
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
  const sourcePath = process.argv[2];
  const outputPath = process.argv[3] || path.join(__dirname, '..', 'media', 'gallery-01-hero.png');
  const crop = JSON.parse(process.argv[4] || '{}');
  composeGalleryHero(sourcePath, outputPath, crop);
  process.stdout.write(`Wrote ${outputPath}\n`);
}

module.exports = { composeGalleryHero };
