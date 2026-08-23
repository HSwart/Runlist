const assert = require('node:assert/strict');
const test = require('node:test');
const { safeHttpUrl, safeServiceUrl } = require('../src/services/external-url');

test('allows only valid HTTP and HTTPS output links', () => {
  assert.equal(safeHttpUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  assert.equal(safeHttpUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(safeHttpUrl('file:///tmp/project'), undefined);
  assert.equal(safeHttpUrl('javascript:alert(1)'), undefined);
  assert.equal(safeHttpUrl('not a url'), undefined);
});

test('rejects credential-bearing output links', () => {
  assert.equal(safeHttpUrl('https://user:secret@example.com'), undefined);
  assert.equal(safeHttpUrl('https://user%40name:secret%40word@example.com'), undefined);
});

test('rejects control characters in output links', () => {
  assert.equal(safeHttpUrl(`https://example.com/path${String.fromCharCode(10)}next`), undefined);
  assert.equal(safeHttpUrl(`https://example.com/path${String.fromCharCode(0)}next`), undefined);
  assert.equal(safeHttpUrl(`https://example.com/path${String.fromCharCode(127)}next`), undefined);
});

test('allows only safe HTTP and HTTPS service URL overrides', () => {
  assert.equal(safeServiceUrl(' https://app.local/dashboard?view=all '), 'https://app.local/dashboard?view=all');
  assert.equal(safeServiceUrl('http://localhost:3000/docs'), 'http://localhost:3000/docs');
  assert.equal(safeServiceUrl('file:///tmp/project'), undefined);
  assert.equal(safeServiceUrl('javascript:alert(1)'), undefined);
  assert.equal(safeServiceUrl('https://user:secret@example.com'), undefined);
  assert.equal(safeServiceUrl('https://exam\nple.com'), undefined);
});
