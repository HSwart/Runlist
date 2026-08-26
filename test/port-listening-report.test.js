const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildPortListeningReport,
  formatPortListeningClipboard,
  plainLanguageForIdentity
} = require('../src/ports/port-listening-report');

const projects = [
  {
    id: 'acme',
    name: 'Acme Storefront',
    services: [{ name: 'web', port: 4310 }]
  },
  {
    id: 'api',
    name: 'Billing API',
    services: [{ name: 'api', port: 7071 }]
  }
];

test('builds owned, external, unknown, and gone rows for configured ports only', () => {
  const report = buildPortListeningReport({
    projects,
    listeners: [
      { port: 4310, pid: 120, identity: '120:linux:1000', name: 'node' },
      { port: 7071, pid: 88, identity: '88:linux:9', name: 'python' }
    ],
    processRuntime: new Map([
      ['acme', {
        childPid: 120,
        childIdentity: '120:linux:1000',
        processActive: true
      }]
    ]),
    platform: 'linux',
    scannedAt: 1000
  });

  assert.equal(report.empty, false);
  assert.equal(report.rows.length, 2);
  assert.equal(report.rows[0].kind, 'owned');
  assert.equal(report.rows[0].canReveal, true);
  assert.equal(report.rows[0].canClose, true);
  assert.equal(report.rows[0].closeProjectId, 'acme');
  assert.equal(report.rows[1].kind, 'external');
  assert.equal(report.rows[1].canReveal, false);
  assert.equal(report.rows[1].canClose, true);
  assert.equal(report.rows[1].closeProjectId, 'api');
  assert.match(report.rows[1].plainReason, /not confirmed/i);
});

test('marks missing identity and idle ports in plain language', () => {
  const report = buildPortListeningReport({
    projects: [projects[0]],
    listeners: [{ port: 4310, pid: 55, name: 'node' }],
    processRuntime: new Map(),
    platform: 'linux'
  });
  assert.equal(report.rows[0].kind, 'unknown');
  assert.equal(report.rows[0].canClose, false);
  assert.match(report.rows[0].plainReason, /could not confirm which process/i);

  assert.match(plainLanguageForIdentity({ kind: 'gone', port: 1 }), /Nothing is listening/i);
  assert.match(
    plainLanguageForIdentity({ kind: 'unknown', reason: 'pid-reuse', pid: 9 }),
    /no longer matches/i
  );
});

test('clipboard export stays read-only and lists each configured port', () => {
  const report = buildPortListeningReport({
    projects,
    listeners: [],
    processRuntime: new Map(),
    scannedAt: 1
  });
  const text = formatPortListeningClipboard(report);
  assert.match(text, /What's listening/i);
  assert.match(text, /:4310/);
  assert.match(text, /:7071/);
  assert.doesNotMatch(text, /kill|terminate/i);
});
