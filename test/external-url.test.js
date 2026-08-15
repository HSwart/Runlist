const assert = require('node:assert/strict');
const test = require('node:test');
const { safeHttpUrl } = require('../external-url');

test('allows only valid HTTP and HTTPS output links', () => {
  assert.equal(safeHttpUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  assert.equal(safeHttpUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(safeHttpUrl('file:///tmp/project'), undefined);
  assert.equal(safeHttpUrl('javascript:alert(1)'), undefined);
  assert.equal(safeHttpUrl('not a url'), undefined);
});
