#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { runTests } = require('@vscode/test-electron');
const { webviewFrameWasReplaced } = require('./webview-frame-errors');
const {
  WEBVIEW_DEBUG_ENDPOINT_TIMEOUT_MS,
  WEBVIEW_FRAME_TIMEOUT_MS
} = require('./webview-e2e-timeouts');

const ARTIFACT_DIR = '/opt/cursor/artifacts/screenshots';
const attachedWebviewTargetIds = new Set();
let commandSequence = 0;

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-recovery-walkthrough-')));
  const workspacePath = path.join(root, 'workspace');
  const userDataPath = path.join(root, 'user-data');
  const extensionsPath = path.join(root, 'extensions');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(extensionsPath, { recursive: true });
  fs.mkdirSync(path.join(userDataPath, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userDataPath, 'User', 'settings.json'), JSON.stringify({
    'files.simpleDialog.enable': true,
    'workbench.startupEditor': 'none',
    'terminal.integrated.tabs.enabled': true
  }, null, 2));

  const debugPort = await availablePort();
  let hostOutput = '';
  const output = {
    write(chunk) {
      hostOutput += String(chunk);
      return true;
    }
  };
  let hostFailure;
  const hostRun = runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.join(extensionDevelopmentPath, 'smoke', 'recovery-walkthrough-host.js'),
    extensionTestsEnv: {
      RUNLIST_EXTENSION_SMOKE: '1',
      RUNLIST_RECOVERY_WALKTHROUGH_ROOT: root
    },
    launchArgs: [
      workspacePath,
      `--remote-debugging-port=${debugPort}`,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-release-notes',
      '--skip-welcome',
      `--user-data-dir=${userDataPath}`,
      `--extensions-dir=${extensionsPath}`
    ],
    stdout: output,
    stderr: output
  }).catch((error) => {
    hostFailure = error;
  });

  let browser;
  try {
    await waitFor(() => {
      if (hostFailure) {
        throw hostFailure;
      }
      return fs.existsSync(path.join(root, 'host-ready.json'));
    }, 45000, 'the extension host to open Runlist');
    await waitForDebugEndpoint(debugPort, WEBVIEW_DEBUG_ENDPOINT_TIMEOUT_MS);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const page = await waitForWorkbenchPage(browser);
    await widenSidebar(page, 420);
    let webview;
    try {
      await waitFor(async () => {
        await attachVsCodeWebviewTargets(browser);
        const frames = browser.contexts()
          .flatMap((context) => context.pages())
          .flatMap((page) => page.frames());
        webview = await findRunlistFrame(frames);
        return Boolean(webview);
      }, WEBVIEW_FRAME_TIMEOUT_MS, 'the Runlist webview frame');
    } catch (error) {
      throw new Error(`${error.message} ${await browserFrameEvidence(browser)}`, { cause: error });
    }
    const seeded = await hostCommand(root, 'seed-recovery-demo');
    webview = await currentRunlistFrame(browser, (frame) => (
      frame.getByRole('heading', { name: 'Broken App' }).isVisible()
    ));

    await captureStep(page, webview, '01_review_filter_chip', async (frame) => {
      await assertVisible(frame.getByRole('button', { name: /Review setup \(1\)/ }));
    });
    await webview.getByRole('button', { name: /Review setup \(1\)/ }).click();
    webview = await currentRunlistFrame(browser, (frame) => (
      frame.getByRole('heading', { name: 'Legacy Import' }).isVisible()
    ));
    await captureStep(page, webview, '02_review_filter_active', async (frame) => {
      await assertVisible(frame.getByRole('heading', { name: 'Legacy Import' }));
      await assertHidden(frame.getByRole('heading', { name: 'Broken App' }));
    });

    await webview.getByRole('button', { name: /Review setup \(1\)/ }).click();
    webview = await currentRunlistFrame(browser);

    await captureStep(page, webview, '03_show_terminal_primary', async (frame) => {
      await assertVisible(frame.getByRole('button', { name: 'Show terminal for Broken App' }));
    });

    const brokenMenu = webview.getByRole('button', { name: 'More actions for Broken App' });
    await brokenMenu.click();
    await captureStep(page, webview, '04_copy_error_menu', async (frame) => {
      await assertVisible(frame.getByRole('menuitem', { name: /Copy start error for Broken App/ }));
    });
    await page.keyboard.press('Escape');

    const groupsToggle = webview.getByRole('button', { name: 'Groups' });
    if (await groupsToggle.getAttribute('aria-expanded') !== 'true') {
      await groupsToggle.click();
    }
    await webview.getByRole('button', { name: `Stop group ${seeded.groupName}` }).click();
    await waitFor(async () => page.locator('.monaco-dialog-box').isVisible(), 5000, 'Stop group confirmation modal');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, '05_stop_group_confirm_modal.png') });
    await page.keyboard.press('Escape');
    webview = await currentRunlistFrame(browser);

    await hostCommand(root, 'show-terminal', { projectId: seeded.runningProjectIds[0] });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, '06_show_terminal_focus.png') });

    await hostCommand(root, 'install-copilot-skill');
    await hostCommand(root, 'show-agent-setup');
    webview = await currentRunlistFrame(browser, (frame) => (
      frame.getByRole('heading', { name: 'Agent connections' }).isVisible()
    ));
    await captureStep(page, webview, '07_copilot_handoff_ready', async (frame) => {
      await assertVisible(frame.getByText('Ready for handoff'));
    });

    fs.writeFileSync(path.join(ARTIFACT_DIR, 'recovery-walkthrough-summary.json'), JSON.stringify({
      capturedAt: new Date().toISOString(),
      groupName: seeded.groupName,
      artifacts: [
        '01_review_filter_chip.png',
        '02_review_filter_active.png',
        '03_show_terminal_primary.png',
        '04_copy_error_menu.png',
        '05_stop_group_confirm_modal.png',
        '06_show_terminal_focus.png',
        '07_copilot_handoff_ready.png'
      ]
    }, null, 2));

    fs.writeFileSync(path.join(root, 'browser-complete'), 'ok\n');
    await hostRun;
    if (hostFailure) {
      throw hostFailure;
    }
    console.log(`Recovery walkthrough captured ${ARTIFACT_DIR}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    if (!fs.existsSync(path.join(root, 'browser-complete'))) {
      fs.writeFileSync(path.join(root, 'browser-complete'), 'abort\n');
      await hostRun.catch(() => undefined);
      if (hostFailure) {
        console.error(hostOutput);
        throw hostFailure;
      }
    }
  }
}

async function captureStep(page, webview, name, assertions) {
  await assertions(webview);
  await hideNotifications(page);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, `${name}.png`) });
}

async function hideNotifications(page) {
  await page.locator('.notifications-toasts').evaluate((element) => {
    element.style.display = 'none';
  }).catch(() => undefined);
}

async function hostCommand(root, action, payload = {}) {
  const id = ++commandSequence;
  const commandPath = path.join(root, 'browser-command.json');
  const responsePath = path.join(root, 'host-response.json');
  fs.writeFileSync(commandPath, JSON.stringify({ id, action, ...payload }));
  await waitFor(() => fs.existsSync(responsePath), 30000, `host response for ${action}`);
  const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
  fs.unlinkSync(responsePath);
  assert.equal(response.id, id);
  if (response.error) {
    throw new Error(response.error);
  }
  return response.result;
}

async function waitForWorkbenchPage(browser) {
  let page;
  await waitFor(() => {
    page = browser.contexts().flatMap((context) => context.pages())[0];
    return Boolean(page);
  }, 15000, 'the VS Code workbench page');
  return page;
}

async function widenSidebar(page, targetWidth) {
  const sidebar = page.locator('.monaco-workbench .part.sidebar').first();
  await assertVisible(sidebar);
  const bounds = await sidebar.boundingBox();
  if (!bounds || bounds.width >= targetWidth - 8) {
    return;
  }
  const handle = page.locator('.monaco-sash.vertical').first();
  await assertVisible(handle);
  const handleBounds = await handle.boundingBox();
  if (!handleBounds) {
    return;
  }
  const x = handleBounds.x + handleBounds.width / 2;
  const y = handleBounds.y + handleBounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (targetWidth - bounds.width), y, { steps: 12 });
  await page.mouse.up();
}

async function currentRunlistFrame(browser, predicate = () => true) {
  let webview;
  await waitFor(async () => {
    await attachVsCodeWebviewTargets(browser);
    const frames = browser.contexts()
      .flatMap((context) => context.pages())
      .flatMap((page) => page.frames());
    webview = await findRunlistFrame(frames, predicate);
    return Boolean(webview);
  }, 5000, 'the current Runlist webview frame');
  return webview;
}

async function attachVsCodeWebviewTargets(browser) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  for (const page of pages) {
    try {
      const session = await page.context().newCDPSession(page);
      const { targetInfos } = await session.send('Target.getTargets');
      for (const info of targetInfos) {
        if (info.type !== 'iframe' || !/vscode-webview:/i.test(info.url || '')) {
          continue;
        }
        if (attachedWebviewTargetIds.has(info.targetId)) {
          continue;
        }
        try {
          await session.send('Target.attachToTarget', {
            targetId: info.targetId,
            flatten: true
          });
          attachedWebviewTargetIds.add(info.targetId);
        } catch {
          // Target may already be attached from a previous poll.
        }
      }
    } catch {
      // The workbench page can reload while the extension host finishes booting.
    }
  }
}

async function frameLooksLikeRunlist(frame, predicate = () => true) {
  return Boolean(await frame.locator('#app').count()
    && await frame.evaluate(() => Boolean(window.runlistState))
    && await predicate(frame));
}

async function browserFrameEvidence(browser) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const frames = pages.flatMap((page) => page.frames()).slice(0, 20);
  const evidence = [];
  for (const frame of frames) {
    try {
      evidence.push({
        url: frame.url().slice(0, 200),
        app: await frame.locator('#app').count(),
        state: await frame.evaluate(() => Boolean(window.runlistState))
      });
    } catch (error) {
      evidence.push({
        url: frame.url().slice(0, 200),
        error: String(error?.message || error).slice(0, 200)
      });
    }
  }
  return `Observed ${pages.length} pages and ${frames.length} frames: ${JSON.stringify(evidence)}`;
}

async function nestedContentFrames(frame) {
  const nested = [...frame.childFrames()];
  try {
    const handles = await frame.locator('iframe').elementHandles();
    for (const handle of handles) {
      const content = await handle.contentFrame();
      if (content && !nested.includes(content)) {
        nested.push(content);
      }
    }
  } catch {
    // Frame may disappear while VS Code swaps the webview document.
  }
  return nested;
}

async function findRunlistFrame(frames, predicate = () => true) {
  const queue = [...frames];
  const seen = new Set();
  while (queue.length) {
    const frame = queue.shift();
    if (!frame || seen.has(frame)) {
      continue;
    }
    seen.add(frame);
    try {
      if (await frameLooksLikeRunlist(frame, predicate)) {
        return frame;
      }
      queue.push(...await nestedContentFrames(frame));
    } catch {
      // Cross-target frames can disappear while VS Code finishes opening the view.
    }
  }
  return undefined;
}

async function assertVisible(locator) {
  await locator.waitFor({ state: 'visible', timeout: 10000 });
}

async function assertHidden(locator) {
  await locator.waitFor({ state: 'hidden', timeout: 10000 });
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForDebugEndpoint(port, timeoutMs) {
  await waitFor(() => new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('error', () => resolve(false));
    request.setTimeout(250, () => {
      request.destroy();
      resolve(false);
    });
  }), timeoutMs, 'the VS Code debugging endpoint');
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` ${lastError.message}` : ''}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
