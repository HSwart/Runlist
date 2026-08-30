const os = require('node:os');
const qrcode = require('../../vendor/qrcode-generator');
const { safeServiceUrl } = require('../services/external-url');

function ipv4Parts(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return undefined;
  }
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : undefined;
}

function privateIpv4Priority(value) {
  const parts = ipv4Parts(value);
  if (!parts) {
    return 0;
  }
  if (parts[0] === 192 && parts[1] === 168) {
    return 3;
  }
  if (parts[0] === 10) {
    return 2;
  }
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return 1;
  }
  return 0;
}

function isLikelyVirtualInterface(name) {
  return /(?:bridge|docker|hyper-v|loopback|tailscale|utun|vbox|veth|vethernet|virtual|vmnet|wsl|zerotier)/i
    .test(String(name || ''));
}

function listPrivateLanIpv4Candidates(interfaces = {}) {
  const seen = new Set();
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    if (isLikelyVirtualInterface(name)) {
      continue;
    }
    for (const address of addresses || []) {
      const isIpv4 = address?.family === 'IPv4' || address?.family === 4;
      const priority = isIpv4 && !address.internal
        ? privateIpv4Priority(address.address)
        : 0;
      if (!priority || seen.has(address.address)) {
        continue;
      }
      seen.add(address.address);
      candidates.push({
        interfaceName: name,
        address: address.address,
        label: `${name} — ${address.address}`
      });
    }
  }
  return candidates;
}

function choosePrivateLanIpv4(interfaces = {}) {
  const candidates = listPrivateLanIpv4Candidates(interfaces);
  return candidates.length === 1 ? candidates[0].address : undefined;
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  const parts = ipv4Parts(value);
  return value === 'localhost'
    || value.endsWith('.localhost')
    || value === '[::1]'
    || value === '::1'
    || parts?.[0] === 127;
}

function derivePhoneHandoffUrl(
  serviceUrl,
  interfaces = os.networkInterfaces(),
  chosenAddress
) {
  const safeUrl = safeServiceUrl(serviceUrl);
  if (!safeUrl) {
    return undefined;
  }
  const url = new URL(safeUrl);
  if (!isLoopbackHostname(url.hostname)) {
    return undefined;
  }
  const address = typeof chosenAddress === 'string' && chosenAddress.trim()
    ? chosenAddress.trim()
    : choosePrivateLanIpv4(interfaces);
  if (!address) {
    return undefined;
  }
  url.hostname = address;
  return url.toString();
}

function createPhoneQrSvg(url, qrFactory = qrcode) {
  const qr = qrFactory(0, 'M');
  qr.addData(url, 'Byte');
  qr.make();
  return qr.createSvgTag({ scalable: true, margin: 3 })
    .replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
}

function createPhoneHandoff(
  serviceUrl,
  interfaces = os.networkInterfaces(),
  chosenAddress
) {
  const url = derivePhoneHandoffUrl(serviceUrl, interfaces, chosenAddress);
  if (!url) {
    return undefined;
  }
  try {
    return {
      url,
      qrSvg: createPhoneQrSvg(url)
    };
  } catch {
    return undefined;
  }
}

module.exports = {
  choosePrivateLanIpv4,
  createPhoneHandoff,
  createPhoneQrSvg,
  derivePhoneHandoffUrl,
  listPrivateLanIpv4Candidates,
  privateIpv4Priority
};
