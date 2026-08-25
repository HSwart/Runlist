const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const extension = readShippedHostSource(root);
const router = fs.readFileSync(path.join(root, 'src', 'webview', 'webview-message-router.js'), 'utf8');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

function renderRepairComparison(comparison) {
  const app = {
    innerHTML: '',
    addEventListener() {}
  };
  const document = {
    activeElement: undefined,
    addEventListener() {},
    getElementById(id) {
      return id === 'app' ? app : undefined;
    },
    querySelector() {
      return undefined;
    },
    querySelectorAll() {
      return [];
    }
  };
  const window = {
    RunlistMessageRouter: {
      createWebviewMessageRouter() {
        return () => false;
      }
    },
    RunlistProjectActions: {
      projectPrimaryAction() {
        return { action: 'start', disabled: false, label: 'Start', mode: 'start' };
      }
    },
    addEventListener() {},
    getSelection() {
      return undefined;
    },
    runlistState: {
      diagnosis: {
        agentReady: true,
        approved: false,
        name: 'Example',
        outputAvailable: false,
        repair: {
          comparison,
          proposalId: 'proposal-1',
          stale: false
        }
      },
      focusTarget: undefined,
      messageToken: 'token',
      mode: 'diagnosis',
      projects: [],
      runGroups: [],
      tags: []
    }
  };
  const context = {
    CSS: { escape: String },
    Map,
    Set,
    URL,
    acquireVsCodeApi() {
      return {
        getState() {
          return {};
        },
        postMessage() {},
        setState() {}
      };
    },
    cancelAnimationFrame() {},
    clearInterval() {},
    clearTimeout() {},
    document,
    requestAnimationFrame() {
      return 1;
    },
    setInterval() {
      return 1;
    },
    setTimeout() {
      return 1;
    },
    window
  };
  vm.runInNewContext(webview, context, { filename: 'media/main.js' });
  return app.innerHTML;
}

function parseRenderedTags(html) {
  const root = { children: [], tag: '#root', text: '' };
  const stack = [root];
  const tokenPattern = /<\/?([a-z][\w-]*)([^>]*)>/gi;
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  let cursor = 0;
  for (const match of html.matchAll(tokenPattern)) {
    const text = html.slice(cursor, match.index).replace(/\s+/g, ' ').trim();
    if (text) {
      stack.at(-1).text += `${stack.at(-1).text ? ' ' : ''}${text}`;
    }
    cursor = match.index + match[0].length;
    if (match[0][1] === '/') {
      stack.pop();
      continue;
    }
    const attrs = Object.fromEntries(
      [...match[2].matchAll(/([:\w-]+)="([^"]*)"/g)].map((attribute) => [attribute[1], attribute[2]])
    );
    const node = { attrs, children: [], tag: match[1], text: '' };
    stack.at(-1).children.push(node);
    if (!match[2].trim().endsWith('/') && !voidTags.has(match[1].toLowerCase())) {
      stack.push(node);
    }
  }
  return root;
}

function descendants(node, predicate) {
  return node.children.flatMap((child) => [
    ...(predicate(child) ? [child] : []),
    ...descendants(child, predicate)
  ]);
}

function textContent(node) {
  return [node.text, ...node.children.map(textContent)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

test('renders a complete accessible repair comparison and approval boundary', () => {
  const tree = parseRenderedTags(renderRepairComparison([
    { field: 'Start command', current: 'npm run dev', proposed: 'pnpm dev', change: 'changed' }
  ]));
  const tables = descendants(tree, (node) => node.attrs.role === 'table');
  assert.equal(tables.length, 1);
  assert.equal(tables[0].attrs['aria-label'], 'Current and proposed project setup');
  assert.match(webview, /data-action="approve-repair"[^>]*>Approve complete proposal/);
  assert.match(webview, /data-action="reject-repair"[^>]*>Reject proposal/);
  assert.match(webview, /data-action="refresh-repair"/);
  assert.match(webview, /aria-live="polite"/);
});

test('renders every repair change as a labelled cell without duplicate announcements', () => {
  const comparison = [
    { field: 'Start command', current: 'npm run dev', proposed: 'pnpm dev', change: 'changed' },
    { field: 'Stop command', current: '', proposed: 'pnpm stop', change: 'added' },
    { field: 'Services', current: '3000', proposed: '', change: 'removed' }
  ];
  const tree = parseRenderedTags(renderRepairComparison(comparison));
  const tables = descendants(tree, (node) => node.attrs.role === 'table');
  assert.equal(tables.length, 1);

  const rows = tables[0].children.filter((node) => node.attrs.role === 'row');
  assert.equal(rows.length, comparison.length + 1);
  const dataRows = rows.slice(1);
  assert.equal(
    descendants(tables[0], (node) => node.attrs.role === 'cell').length,
    comparison.length * 3
  );

  for (const [index, item] of comparison.entries()) {
    const row = dataRows[index];
    const rowHeader = row.children.find((node) => node.attrs.role === 'rowheader');
    assert.ok(rowHeader, `row ${index + 1} has a field header`);
    assert.equal(textContent(rowHeader), item.field);

    const cells = row.children.filter((node) => node.attrs.role === 'cell');
    assert.equal(cells.length, 3);
    assert.equal(textContent(cells[0]), item.current);
    assert.equal(textContent(cells[1]), item.proposed);

    const markerCell = cells.find((node) => node.attrs.class === 'repair-change-cell');
    assert.ok(markerCell, `${item.field} change is nested in a comparison cell`);
    assert.equal(markerCell.attrs['aria-label'], `${item.field}: ${item.change}`);

    const markers = descendants(markerCell, (node) =>
      node.attrs.class?.split(/\s+/).includes('repair-change')
    );
    assert.equal(markers.length, 1);
    assert.equal(markers[0].attrs['aria-hidden'], 'true');
    assert.equal(textContent(markers[0]), item.change);
  }
});

test('keeps retry separate and routes it through the normal start gate', () => {
  assert.match(webview, /data-action="retry-repair"[^>]*>Retry start/);
  assert.match(router, /retryProjectRepair: \(\) => host\.retryProjectRepair\(\)/);
  assert.match(extension, /retryProjectRepair\(\)[\s\S]*this\.startProject\(projectId\)/);
  assert.doesNotMatch(extension, /approveProjectRepairProposal\([^)]*\)[\s\S]{0,300}startProject\(/);
});

test('reserves ownership before applying an approved proposal and ships the repair boundary to MCP', () => {
  assert.match(extension, /approveProjectRepair\(proposalId\)[\s\S]*processOwnership\.reserve\(project\.id\)/);
  assert.match(extension, /approveProjectRepairProposal\(this\.projectsFile, project\.id, proposalId\)/);
  assert.match(extension, /installMcpBridge[\s\S]*project-repair\.js/);
});

test('binds repair approval to the exact proposal ID through render, router, and host', () => {
  assert.match(extension, /proposalId: repairProposal\.proposalId/);
  assert.match(webview, /data-proposal-id="\$\{escapeHtml\(diagnosis\.repair\.proposalId\)\}"/);
  assert.match(webview, /['"]approve-repair['"]:[\s\S]*proposalId: button\.dataset\.proposalId/);
  assert.match(router, /approveProjectRepair: \(message\) => host\.approveProjectRepair\(message\.proposalId\)/);
  assert.match(extension, /approveProjectRepair\(proposalId\)/);
  assert.match(extension, /approveProjectRepairProposal\(this\.projectsFile, project\.id, proposalId\)/);
});
