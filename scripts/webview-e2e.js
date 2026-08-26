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

const UPDATE_SCREENSHOT = process.argv.includes('--update-screenshot')
  || process.env.RUNLIST_UPDATE_SCREENSHOTS === '1';

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const temporaryParent = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  const temporaryPrefix = UPDATE_SCREENSHOT
    ? path.join(temporaryParent, 'runlist-webview-preview-')
    : path.join(temporaryParent, 'runlist-e2e-');
  const root = fs.realpathSync(fs.mkdtempSync(temporaryPrefix));
  const workspacePath = path.join(root, 'workspace');
  const userDataPath = path.join(root, 'user-data');
  const extensionsPath = path.join(root, 'extensions');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(extensionsPath, { recursive: true });
  fs.mkdirSync(path.join(userDataPath, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userDataPath, 'User', 'settings.json'), JSON.stringify({
    'files.simpleDialog.enable': true,
    'workbench.startupEditor': 'none'
  }));
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
    extensionTestsPath: path.join(extensionDevelopmentPath, 'smoke', 'webview-e2e-host.js'),
    extensionTestsEnv: {
      RUNLIST_EXTENSION_SMOKE: '1',
      RUNLIST_WEBVIEW_E2E_ROOT: root
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
    }, 30000, 'the extension host to open Runlist');
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'host-ready.json'), 'utf8'));
    await waitForDebugEndpoint(debugPort, WEBVIEW_DEBUG_ENDPOINT_TIMEOUT_MS);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    if (UPDATE_SCREENSHOT) {
      await captureIdeScreenshots(browser, ready, root, extensionDevelopmentPath);
    } else {
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
      await runWebviewJourneys(browser, webview, ready, root, extensionDevelopmentPath);
    }
    fs.writeFileSync(path.join(root, 'browser-complete'), 'ok\n');
    await hostRun;
    if (hostFailure) {
      throw hostFailure;
    }
    process.stdout.write('Runlist webview E2E passed.\n');
  } catch (error) {
    fs.writeFileSync(path.join(root, 'browser-complete'), 'failed\n');
    process.stderr.write(`${hostOutput}\n`);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await fs.promises.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
  }
}

async function captureIdeScreenshots(browser, ready, root, extensionDevelopmentPath) {
  const page = await waitForWorkbenchPage(browser);
  const artifactDir = path.join('/opt/cursor/artifacts/screenshots');
  fs.mkdirSync(artifactDir, { recursive: true });

  await hostCommand(root, 'set-theme', { theme: 'Default Dark Modern' });
  await hostCommand(root, 'prepare-screenshot');
  await widenSidebar(page, 420);
  await hideWorkbenchChrome(page);

  fs.writeFileSync(path.join(ready.workspacePath, 'package.json'), JSON.stringify({
    name: 'acme-storefront',
    scripts: {
      start: 'node server.js',
      dev: 'node server.js',
      test: 'node --test'
    }
  }, null, 2));
  await hostCommand(root, 'refresh-list');
  // Give the empty-state chips a moment to paint after re-render.
  await new Promise((resolve) => setTimeout(resolve, 800));
  await hideWorkbenchChrome(page);
  const frameAPath = path.join(artifactDir, 'ide-frame-a-empty.png');
  await page.screenshot({ path: frameAPath });
  assert.ok(fs.statSync(frameAPath).size > 10000, 'Frame A IDE screenshot was unexpectedly small.');

  const seeded = await hostCommand(root, 'seed-running-screenshot');
  await waitFor(async () => await hostCommand(root, 'project-status', { projectId: seeded.projectId }) === 'running',
    20000, 'seeded screenshot project to become running');
  await waitFor(async () => await hostCommand(root, 'start-count') >= 1,
    10000, 'seeded screenshot project to write its launch marker');
  // Let the elapsed clock tick so Frame B looks alive.
  await new Promise((resolve) => setTimeout(resolve, 1400));
  await hostCommand(root, 'prepare-screenshot');
  await widenSidebar(page, 420);
  await hideWorkbenchChrome(page);
  const frameBPath = path.join(artifactDir, 'ide-frame-b-running-row.png');
  await page.screenshot({ path: frameBPath });
  assert.ok(fs.statSync(frameBPath).size > 10000, 'Frame B IDE screenshot was unexpectedly small.');

  const previewPath = path.join(extensionDevelopmentPath, 'media', 'runlist-preview.png');
  await page.screenshot({ path: previewPath });
  assert.ok(fs.statSync(previewPath).size > 10000, 'The generated webview screenshot was unexpectedly small.');
  fs.copyFileSync(previewPath, path.join(artifactDir, 'ide-runlist-preview.png'));

  await hostCommand(root, 'stop-project', { projectId: seeded.projectId });
  await waitFor(async () => {
    const status = await hostCommand(root, 'project-status', { projectId: seeded.projectId });
    return status === 'stopped' || status === 'idle' || status === 'inactive';
  }, 15000, 'seeded screenshot project to stop');
}

async function waitForWorkbenchPage(browser) {
  let page;
  await waitFor(() => {
    page = browser.contexts().flatMap((context) => context.pages())[0];
    return Boolean(page);
  }, 15000, 'the VS Code workbench page');
  return page;
}

async function hideWorkbenchChrome(page) {
  await page.locator('.notifications-toasts').evaluate((element) => {
    element.style.display = 'none';
  }).catch(() => undefined);
  await page.locator('.monaco-workbench .notifications-center, .notification-toast-container')
    .evaluateAll((elements) => {
      for (const element of elements) {
        element.style.display = 'none';
      }
    }).catch(() => undefined);
}

async function runWebviewJourneys(browser, webview, ready, root, extensionDevelopmentPath) {
  let page = webview.page();
  await assertVisible(webview.getByRole('heading', { name: 'No projects yet' }));

  const artifactDir = path.join('/opt/cursor/artifacts/screenshots');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(ready.workspacePath, 'package.json'), JSON.stringify({
    name: 'acme-storefront',
    scripts: {
      start: 'node server.js',
      dev: 'node server.js',
      test: 'node --test'
    }
  }, null, 2));
  await hostCommand(root, 'refresh-list');
  webview = await currentRunlistFrame(browser, (frame) => (
    frame.getByRole('button', { name: 'Start start for this folder' }).isVisible()
      .catch(() => false)
    || frame.getByRole('button', { name: 'start', exact: true }).isVisible()
  ));
  await widenSidebar(page, 420);
  await page.locator('.notifications-toasts').evaluate((element) => {
    element.style.display = 'none';
  }).catch(() => undefined);
  await page.screenshot({ path: path.join(artifactDir, 'ide-frame-a-empty.png') });

  const addButton = webview.getByRole('button', { name: 'Add this folder' });
  await addButton.focus();
  assert.equal(await webview.evaluate(() => document.activeElement?.textContent?.trim()), 'Add this folder');
  await page.keyboard.press('Enter');
  webview = await currentRunlistFrame(browser, (frame) => (
    frame.getByRole('heading', { name: 'Add project' }).isVisible()
  ));
  page = webview.page();
  await assertVisible(webview.getByRole('heading', { name: 'Add project' }));
  await webview.locator('#project-name').fill('Lifecycle project');
  await webview.locator('#folder').fill(ready.lifecyclePath);
  await webview.locator('#start-command').fill('node server.js');
  await webview.getByRole('button', { name: 'Add service' }).click();
  await webview.locator('#service-name-0').fill('web');
  await webview.locator('#service-port-0').fill('4310');
  const saveButton = webview.getByRole('button', { name: 'Save project' });
  await saveButton.focus();
  await page.keyboard.press('Enter');
  webview = await currentRunlistFrame(browser, (frame) => (
    frame.getByRole('heading', { name: 'Lifecycle project' }).isVisible()
  ));
  await assertVisible(webview.getByRole('heading', { name: 'Lifecycle project' }));

  await verifyMenuKeyboardAndFocus(webview, page, 'Lifecycle project');
  webview = await editProject(browser, webview, 'Lifecycle project', 'Lifecycle project edited');
  webview = await exerciseProjectLifecycle(browser, webview, root, 'Lifecycle project edited', artifactDir);

  await openAndCancelImportThroughVsCode(page, root);
  const seeded = await hostCommand(root, 'seed-review');
  webview = await currentRunlistFrame(browser, (frame) => (
    frame.getByRole('heading', { name: 'Imported dashboard' }).isVisible()
  ));
  await assertVisible(webview.getByRole('heading', { name: 'Imported dashboard' }));
  webview = await approveImportedProject(browser, webview);
  await createRunGroupThroughVsCode(page, root, 'Development stack', 'Lifecycle project edited');
  webview = await currentRunlistFrame(browser, (frame) => (
    frame.getByRole('button', { name: 'Start group Development stack' }).isVisible()
  ));
  webview = await exerciseRunGroup(browser, webview, 'Development stack');

  webview = await assertAxeClean(browser, extensionDevelopmentPath, 'dark project list');
  webview = await verifyThemes(browser, root, extensionDevelopmentPath);
  await verifyNarrowLayout(webview, page);

  await hostCommand(root, 'set-theme', { theme: 'Default Dark Modern' });
  webview = await waitForTheme(browser, 'vscode-dark');
  if (UPDATE_SCREENSHOT) {
    await hostCommand(root, 'prepare-screenshot');
    webview = await currentRunlistFrame(browser);
    await widenSidebar(page, 420);
    await page.locator('.notifications-toasts').evaluate((element) => {
      element.style.display = 'none';
    }).catch(() => undefined);
  }
  const screenshotPath = UPDATE_SCREENSHOT
    ? path.join(extensionDevelopmentPath, 'media', 'runlist-preview.png')
    : path.join(root, 'runlist-webview.png');
  await page.screenshot({ path: screenshotPath });
  assert.ok(fs.statSync(screenshotPath).size > 10000,
    'The generated webview screenshot was unexpectedly small.');
  if (UPDATE_SCREENSHOT) {
    fs.copyFileSync(screenshotPath, path.join(artifactDir, 'ide-runlist-preview.png'));
  }

  webview = await deleteProject(browser, webview, root, 'Imported dashboard', false);
  webview = await deleteProject(browser, webview, root, 'Lifecycle project edited', true);
  webview = await deleteProject(browser, webview, root, 'Imported dashboard', true);
  await assertVisible(webview.getByRole('heading', { name: 'No projects yet' }));
  assert.equal(typeof seeded.importedId, 'string');
}

async function verifyMenuKeyboardAndFocus(webview, page, projectName) {
  const trigger = webview.getByRole('button', { name: `More actions for ${projectName}` });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = webview.getByRole('menu', { name: `Actions for ${projectName}` });
  await assertVisible(menu);
  await waitFor(async () => (await webview.evaluate(
    () => document.activeElement?.getAttribute('role')
  )) === 'menuitem', 3000, 'the first project menu item to receive focus');
  await page.keyboard.press('End');
  assert.equal(await webview.evaluate(() => document.activeElement?.textContent?.trim()), 'Delete project');
  await page.keyboard.press('Escape');
  assert.equal(await webview.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    `More actions for ${projectName}`);
}

async function editProject(browser, webview, before, after) {
  await webview.getByRole('button', { name: `More actions for ${before}` }).click();
  await webview.getByRole('menuitem', { name: 'Edit project' }).click();
  webview = await currentRunlistFrame(browser, (frame) => (
    frame.getByRole('heading', { name: 'Edit project' }).isVisible()
  ));
  await assertVisible(webview.getByRole('heading', { name: 'Edit project' }));
  await webview.locator('#project-name').fill(after);
  await webview.getByRole('button', { name: 'Save changes' }).click();
  webview = await currentRunlistFrame(browser, (frame) => (
    frame.getByRole('heading', { name: after }).isVisible()
  ));
  await assertVisible(webview.getByRole('heading', { name: after }));
  return webview;
}

async function exerciseProjectLifecycle(browser, webview, root, projectName, artifactDir = '') {
  await webview.getByRole('button', { name: `Start ${projectName}` }).click();
  await waitForProjectStatus(browser, projectName, 'Running');
  webview = await currentRunlistFrame(browser);
  await waitFor(async () => await hostCommand(root, 'start-count') >= 1,
    5000, 'the start command to write its launch marker');
  await assertVisible(webview.getByRole('button', { name: `Stop ${projectName}` }));
  await assertVisible(webview.getByRole('button', { name: `Restart ${projectName}` }));
  await assertVisible(webview.locator('.project-port-chip'));
  await assertVisible(webview.locator('[data-row-elapsed]'));
  // Let the elapsed clock tick so Frame B looks alive in IDE screenshots.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (artifactDir) {
    const page = webview.page();
    await widenSidebar(page, 420);
    await page.locator('.notifications-toasts').evaluate((element) => {
      element.style.display = 'none';
    }).catch(() => undefined);
    await page.screenshot({ path: path.join(artifactDir, 'ide-frame-b-running-row.png') });
  }

  await webview.getByRole('button', { name: `Restart ${projectName}` }).click();
  await waitFor(async () => await hostCommand(root, 'start-count') >= 2,
    15000, 'restart to launch a new process');
  await waitForProjectStatus(browser, projectName, 'Running');

  await clickCurrentWebview(browser, (frame) => (
    frame.getByRole('button', { name: `Stop ${projectName}` })
  ));
  await waitForProjectStatus(browser, projectName, 'Stopped');
  return currentRunlistFrame(browser);
}

async function approveImportedProject(browser, webview) {
  await webview.getByRole('button', { name: 'Review setup for Imported dashboard' }).click();
  webview = await currentRunlistFrame(browser, (frame) => (
    frame.getByRole('heading', { name: 'Review project setup' }).isVisible()
  ));
  await assertVisible(webview.getByRole('heading', { name: 'Review project setup' }));
  assert.equal(await webview.locator('#start-command').inputValue(),
    'node -e "setInterval(() => undefined, 1000)"');
  await webview.getByRole('button', { name: 'Approve setup' }).click();
  webview = await currentRunlistFrame(browser, (frame) => (
    frame.getByRole('button', { name: 'Start Imported dashboard' }).isVisible()
  ));
  await assertVisible(webview.getByRole('button', { name: 'Start Imported dashboard' }));
  return webview;
}

async function exerciseRunGroup(browser, webview, groupName) {
  const start = webview.getByRole('button', { name: `Start group ${groupName}` });
  await assertVisible(start);
  await start.click();
  await waitFor(async () => {
    const current = await currentRunlistFrame(browser);
    return current.getByRole('button', { name: `Stop group ${groupName}` }).isVisible();
  }, 15000, `${groupName} to start`);
  await clickCurrentWebview(browser, (frame) => (
    frame.getByRole('button', { name: `Stop group ${groupName}` })
  ));
  await waitFor(async () => {
    const current = await currentRunlistFrame(browser);
    return current.getByRole('button', { name: `Start group ${groupName}` }).isVisible();
  }, 15000, `${groupName} to stop`);
  return currentRunlistFrame(browser);
}

async function createRunGroupThroughVsCode(page, root, groupName, projectName) {
  await hostCommand(root, 'begin-vscode-command', { command: 'runlist.manageGroups' });
  await chooseQuickPick(page, 'Create run group');
  await fillQuickInput(page, groupName);
  await chooseQuickPick(page, 'Add project');
  await chooseQuickPick(page, projectName);
  await chooseQuickPick(page, 'Save group');
}

async function openAndCancelImportThroughVsCode(page, root) {
  await hostCommand(root, 'begin-vscode-command', { command: 'runlist.transferProjects' });
  await chooseQuickPick(page, 'Import project setups');
  const input = page.locator('.quick-input-widget:visible input').first();
  await assertVisible(input);
  await input.press('Escape');
  await page.locator('.quick-input-widget:visible').waitFor({ state: 'hidden' });
}

async function chooseQuickPick(page, text) {
  const choice = page.locator('.quick-input-widget:visible .monaco-list-row')
    .filter({ hasText: text }).first();
  await assertVisible(choice);
  await choice.click();
}

async function fillQuickInput(page, value) {
  const input = page.locator('.quick-input-widget:visible input').first();
  await assertVisible(input);
  await input.fill(value);
  await input.press('Enter');
}

async function deleteProject(browser, webview, root, projectName, confirm) {
  const trigger = webview.getByRole('button', { name: `More actions for ${projectName}` });
  await trigger.click();
  await hostCommand(root, 'queue-warning-response', {
    response: confirm ? 'Delete project' : undefined
  });
  await webview.getByRole('menuitem', { name: 'Delete project' }).click();
  if (!confirm) {
    await waitFor(async () => await trigger.evaluate((element) => element === document.activeElement),
      3000, 'project menu focus to be restored after canceling deletion');
    return webview;
  }
  webview = await currentRunlistFrame(browser, async (frame) => (
    await frame.getByRole('heading', { name: projectName }).count() === 0
  ));
  assert.equal(await webview.getByRole('heading', { name: projectName }).count(), 0);
  return webview;
}

async function verifyThemes(browser, root, extensionDevelopmentPath) {
  const themes = [
    ['Default Light Modern', 'vscode-light'],
    ['Default Dark Modern', 'vscode-dark'],
    ['Default High Contrast', 'vscode-high-contrast']
  ];
  let webview;
  for (const [theme, className] of themes) {
    await hostCommand(root, 'set-theme', { theme });
    webview = await waitForTheme(browser, className);
    webview = await assertAxeClean(browser, extensionDevelopmentPath, theme);
  }
  return webview;
}

async function waitForTheme(browser, className) {
  return currentRunlistFrame(browser, (frame) => frame.locator('body').evaluate(
    (body, expected) => body.classList.contains(expected), className
  ));
}

async function verifyNarrowLayout(webview, page) {
  await page.setViewportSize({ width: 300, height: 760 });
  await waitFor(async () => await webview.evaluate(() => window.innerWidth <= 300),
    3000, 'the actual webview to reach narrow-sidebar width');
  const overflow = await webview.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  assert.ok(overflow.scrollWidth <= overflow.clientWidth + 1,
    `Narrow webview overflowed horizontally (${overflow.scrollWidth} > ${overflow.clientWidth}).`);
  await page.setViewportSize({ width: 1100, height: 800 });
}

async function widenSidebar(page, targetWidth) {
  const sidebar = page.locator('.part.sidebar');
  const bounds = await sidebar.boundingBox();
  if (!bounds || bounds.width >= targetWidth) {
    return;
  }
  const sashes = page.locator('.monaco-sash.vertical');
  for (let index = 0; index < await sashes.count(); index += 1) {
    const sashBounds = await sashes.nth(index).boundingBox();
    if (!sashBounds || Math.abs(sashBounds.x - (bounds.x + bounds.width)) > 8) {
      continue;
    }
    const x = sashBounds.x + Math.max(1, sashBounds.width / 2);
    const y = bounds.y + Math.min(120, bounds.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + targetWidth - bounds.width, y, { steps: 10 });
    await page.mouse.up();
    await waitFor(async () => (await sidebar.boundingBox())?.width >= targetWidth - 10,
      3000, 'the Runlist sidebar to widen for the generated screenshot');
    return;
  }
  throw new Error('Could not find the VS Code sidebar resize handle.');
}

async function assertAxeClean(browser, extensionDevelopmentPath, label) {
  const axePath = require.resolve('axe-core/axe.min.js', { paths: [extensionDevelopmentPath] });
  const axeSource = fs.readFileSync(axePath, 'utf8');
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const webview = await currentRunlistFrame(browser);
    try {
      await webview.evaluate(axeSource);
      const violations = await webview.evaluate(async () => {
        const result = await window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }
        });
        return result.violations
          .filter((violation) => ['critical', 'serious'].includes(violation.impact))
          .map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            targets: violation.nodes.map((node) => node.target.join(' ')).slice(0, 5)
          }));
      });
      assert.deepEqual(violations, [], `${label} has serious or critical axe violations.`);
      return webview;
    } catch (error) {
      lastError = error;
      if (!webviewFrameWasReplaced(error)) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function waitForProjectStatus(browser, projectName, expected) {
  await waitFor(async () => {
    const webview = await currentRunlistFrame(browser);
    const row = webview.locator('.project-row').filter({
      has: webview.getByRole('heading', { name: projectName })
    });
    return (await row.locator('.project-status').textContent())?.trim() === expected;
  },
    15000, `${projectName} to become ${expected}`);
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

async function clickCurrentWebview(browser, locatorForFrame) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const webview = await currentRunlistFrame(browser);
    try {
      await locatorForFrame(webview).click();
      return webview;
    } catch (error) {
      lastError = error;
      if (!webviewFrameWasReplaced(error)) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function hostCommand(root, action, values = {}) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const commandPath = path.join(root, 'browser-command.json');
  const responsePath = path.join(root, 'host-response.json');
  fs.rmSync(responsePath, { force: true });
  fs.writeFileSync(commandPath, JSON.stringify({ id, action, ...values }));
  let response;
  await waitFor(() => {
    if (!fs.existsSync(responsePath)) {
      return false;
    }
    try {
      response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
    } catch {
      return false;
    }
    return response.id === id;
  }, 10000, `host command ${action}`);
  if (response.error) {
    throw new Error(response.error);
  }
  return response.result;
}

async function assertVisible(locator, timeoutMs = 5000) {
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(await locator.isVisible(), true);
}

const attachedWebviewTargetIds = new Set();

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
    // Nested iframe handles can disappear while VS Code swaps the webview document.
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
      if (await predicate()) {
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
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
