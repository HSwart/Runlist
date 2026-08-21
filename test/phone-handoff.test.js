const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  choosePrivateLanIpv4,
  createPhoneHandoff,
  createPhoneQrSvg,
  derivePhoneHandoffUrl,
  privateIpv4Priority
} = require('../src/webview/phone-handoff');

const interfaces = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [
    { address: '2001:db8::1', family: 'IPv6', internal: false },
    { address: '192.168.68.42', family: 'IPv4', internal: false }
  ],
  Ethernet: [{ address: '169.254.2.3', family: 4, internal: false }],
  bridge100: [{ address: '192.168.64.1', family: 'IPv4', internal: false }],
  public: [{ address: '203.0.113.5', family: 'IPv4', internal: false }]
};

test('selects one unambiguous safe physical private IPv4 address', () => {
  assert.equal(choosePrivateLanIpv4(interfaces), '192.168.68.42');
  assert.equal(privateIpv4Priority('192.168.1.2'), 3);
  assert.equal(privateIpv4Priority('10.1.2.3'), 2);
  assert.equal(privateIpv4Priority('172.31.255.254'), 1);
  assert.equal(privateIpv4Priority('172.32.0.1'), 0);
  assert.equal(privateIpv4Priority('169.254.2.3'), 0);
  assert.equal(privateIpv4Priority('8.8.8.8'), 0);
  assert.equal(privateIpv4Priority('0.0.0.0'), 0);
});

test('does not guess between multiple physical private networks', () => {
  assert.equal(choosePrivateLanIpv4({
    WiFi: [{ address: '192.168.68.42', family: 'IPv4', internal: false }],
    Ethernet: [{ address: '10.20.30.40', family: 4, internal: false }]
  }), undefined);
});

test('preserves the local URL while replacing only its loopback hostname', () => {
  assert.equal(
    derivePhoneHandoffUrl('http://localhost:4310/deep/path?mode=demo#ready', interfaces),
    'http://192.168.68.42:4310/deep/path?mode=demo#ready'
  );
  assert.equal(
    derivePhoneHandoffUrl('https://127.0.0.8:8443/app', interfaces),
    'https://192.168.68.42:8443/app'
  );
  assert.equal(
    derivePhoneHandoffUrl('http://[::1]:3000/', interfaces),
    'http://192.168.68.42:3000/'
  );
});

test('rejects unsafe, public, link-local, virtual-only, and non-loopback handoffs', () => {
  assert.equal(derivePhoneHandoffUrl('https://example.com:4310/', interfaces), undefined);
  assert.equal(derivePhoneHandoffUrl('file:///tmp/app', interfaces), undefined);
  assert.equal(derivePhoneHandoffUrl('http://localhost:4310/', {
    Ethernet: [
      { address: '169.254.2.3', family: 'IPv4', internal: false },
      { address: '8.8.8.8', family: 'IPv4', internal: false }
    ]
  }), undefined);
  assert.equal(derivePhoneHandoffUrl('http://localhost:4310/', {
    'vEthernet (WSL)': [{ address: '172.21.0.1', family: 'IPv4', internal: false }]
  }), undefined);
});

test('encodes the exact displayed LAN URL locally', () => {
  const calls = [];
  const qrFactory = (type, correction) => ({
    addData(value, mode) {
      calls.push({ type, correction, value, mode });
    },
    make() {},
    createSvgTag() {
      return '<svg viewBox="0 0 1 1"></svg>';
    }
  });
  const url = 'http://192.168.68.42:4310/deep/path?mode=demo#ready';
  const svg = createPhoneQrSvg(url, qrFactory);

  assert.deepEqual(calls, [{ type: 0, correction: 'M', value: url, mode: 'Byte' }]);
  assert.match(svg, /aria-hidden="true" focusable="false"/);
  const handoff = createPhoneHandoff('http://localhost:4310/deep/path?mode=demo#ready', interfaces);
  assert.equal(handoff.url, url);
  assert.match(handoff.qrSvg, /^<svg/);
});

test('shows the handoff only for an eligible preview and copies its exact URL', () => {
  const root = path.join(__dirname, '..');
  const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

  assert.match(extension, /const phoneHandoff = previewExpanded\s*\? createPhoneHandoff\(previewService\.url\)/);
  assert.match(webview, /project\.phoneHandoff \? `[\s\S]*Open on phone[\s\S]*project\.phoneHandoff\.qrSvg/);
  assert.match(webview, /<code>\$\{escapeHtml\(project\.phoneHandoff\.url\)\}<\/code>/);
  assert.match(webview, /data-url="\$\{escapeHtml\(project\.phoneHandoff\.url\)\}"/);
  assert.match(extension, /phoneHandoff\.url !== requestedUrl[\s\S]*clipboard\.writeText\(phoneHandoff\.url\)/);
  assert.match(webview, /aria-expanded="\$\{phoneHandoffOpen\}"[\s\S]*aria-controls="phone-handoff-/);
});

test('ships the pinned local QR runtime with its complete license notice', () => {
  const root = path.join(__dirname, '..');
  const runtime = fs.readFileSync(path.join(root, 'vendor', 'qrcode-generator.js'), 'utf8');
  const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');

  assert.match(runtime, /QR Code Generator for JavaScript/);
  assert.match(runtime, /Copyright \(c\) 2009 Kazuhiko Arase/);
  assert.match(notices, /QR Code Generator[\s\S]*version 2\.0\.4/);
  assert.match(notices, /Copyright \(c\) 2009 Kazuhiko Arase[\s\S]*Permission is hereby granted/);
});
