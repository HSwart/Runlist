const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canObserveHttp,
  createHttpInspectorStore,
  redactHeaders,
  truncateBody
} = require('../src/services/http-inspector');

test('redacts secret headers and truncates bodies', () => {
  assert.deepEqual(redactHeaders({
    Authorization: 'Bearer secret',
    Cookie: 'a=1',
    'Set-Cookie': 'b=2',
    'Content-Type': 'text/plain'
  }), {
    Authorization: '[redacted]',
    Cookie: '[redacted]',
    'Set-Cookie': '[redacted]',
    'Content-Type': 'text/plain'
  });
  const body = truncateBody(Buffer.alloc(9000, 65));
  assert.equal(body.truncated, true);
  assert.equal(body.text.length, 8 * 1024);
});

test('hides inspector unless observing a managed single web port', () => {
  assert.equal(canObserveHttp({}, {
    managed: true,
    status: 'running',
    webPorts: [3000],
    observing: true
  }), true);
  assert.equal(canObserveHttp({}, {
    managed: true,
    status: 'running',
    webPorts: [3000, 3001],
    observing: true
  }), false);
  assert.equal(canObserveHttp({}, {
    managed: true,
    status: 'running',
    webPorts: [3000],
    observing: false
  }), false);
});

test('clears in-memory request list on clear', () => {
  const store = createHttpInspectorStore();
  store.clear('p1');
  assert.deepEqual(store.list('p1'), []);
  assert.equal(store.isObserving('p1'), false);
});
