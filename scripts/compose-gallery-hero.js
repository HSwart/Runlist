const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OUTPUT_WIDTH = 1600;
const OUTPUT_HEIGHT = 1000;

function resolveChromeBinary() {
  for (const candidate of [
    process.env.CHROME_BIN,
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not find Chrome for gallery hero compose.');
}

function composeGalleryHero(sidebarPath, outputPath) {
  assert.ok(fs.existsSync(sidebarPath), `Sidebar source missing: ${sidebarPath}`);
  const sidebarBase64 = fs.readFileSync(sidebarPath).toString('base64');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-hero-compose-'));
  const htmlPath = path.join(workDir, 'hero.html');
  const screenshotPath = path.join(workDir, 'hero-raw.png');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    html, body {
      margin: 0;
      width: ${OUTPUT_WIDTH}px;
      height: ${OUTPUT_HEIGHT}px;
      overflow: hidden;
      background:
        radial-gradient(1200px 700px at 50% 38%, rgba(56, 88, 140, 0.34), transparent 68%),
        radial-gradient(900px 520px at 18% 82%, rgba(34, 52, 86, 0.28), transparent 72%),
        linear-gradient(180deg, #0b1220 0%, #0a1018 48%, #070b12 100%);
    }
    .stage {
      width: ${OUTPUT_WIDTH}px;
      height: ${OUTPUT_HEIGHT}px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      padding: 56px 72px 64px;
    }
    .card {
      max-width: 100%;
      max-height: 100%;
      border-radius: 18px;
      overflow: hidden;
      box-shadow:
        0 28px 80px rgba(0, 0, 0, 0.55),
        0 8px 24px rgba(0, 0, 0, 0.35),
        0 0 0 1px rgba(255, 255, 255, 0.06);
    }
    .card img {
      display: block;
      max-width: min(100%, 1180px);
      max-height: 820px;
      width: auto;
      height: auto;
    }
  </style>
</head>
<body>
  <div class="stage">
    <div class="card">
      <img src="data:image/png;base64,${sidebarBase64}" alt="">
    </div>
  </div>
</body>
</html>`;
  fs.writeFileSync(htmlPath, html);

  const chrome = resolveChromeBinary();
  const result = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--window-size=${OUTPUT_WIDTH},${OUTPUT_HEIGHT}`,
    `--screenshot=${screenshotPath}`,
    `file://${htmlPath}`
  ], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`Chrome hero compose failed: ${result.stderr || result.stdout || result.status}`);
  }
  assert.ok(fs.existsSync(screenshotPath), 'Chrome did not write the composed hero screenshot.');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  resizeToMarketplaceDimensions(screenshotPath, outputPath);
  fs.rmSync(workDir, { recursive: true, force: true });
}

function resizeToMarketplaceDimensions(sourcePath, outputPath) {
  const resize = spawnSync('python3', ['-c', `
from PIL import Image
source = Image.open(${JSON.stringify(sourcePath)})
if source.size != (${OUTPUT_WIDTH}, ${OUTPUT_HEIGHT}):
    source = source.resize((${OUTPUT_WIDTH}, ${OUTPUT_HEIGHT}), Image.Resampling.LANCZOS)
source.save(${JSON.stringify(outputPath)}, optimize=True)
print(source.size)
`], { encoding: 'utf8' });
  if (resize.status !== 0) {
    throw new Error(`Hero resize failed: ${resize.stderr || resize.stdout}`);
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
