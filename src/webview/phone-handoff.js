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

function formatPrivateLanCandidateLabel(interfaceName, address) {
  return `${interfaceName} \u2014 ${address}`;
}

function listPrivateLanIpv4Candidates(interfaces = {}) {
  const byAddress = new Map();
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    if (isLikelyVirtualInterface(name)) {
      continue;
    }
    for (const address of addresses || []) {
      const isIpv4 = address?.family === 'IPv4' || address?.family === 4;
      const ip = address?.address;
      const priority = isIpv4 && !address.internal
        ? privateIpv4Priority(ip)
        : 0;
      if (priority && !byAddress.has(ip)) {
        byAddress.set(ip, {
          address: ip,
          interfaceName: name,
          label: formatPrivateLanCandidateLabel(name, ip)
        });
      }
    }
  }
  return [...byAddress.values()].sort((left, right) => {
    const priority = privateIpv4Priority(right.address) - privateIpv4Priority(left.address);
    if (priority) {
      return priority;
    }
    return left.label.localeCompare(right.label);
  });
}

function choosePrivateLanIpv4(interfaces = {}) {
  const candidates = listPrivateLanIpv4Candidates(interfaces);
  return candidates.length === 1 ? candidates[0].address : undefined;
}

function resolvePrivateLanIpv4(interfaces = {}, chosenAddress) {
  const candidates = listPrivateLanIpv4Candidates(interfaces);
  if (chosenAddress && candidates.some((candidate) => candidate.address === chosenAddress)) {
    return chosenAddress;
  }
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

function isPhoneHandoffPreview(serviceUrl) {
  const safeUrl = safeServiceUrl(serviceUrl);
  if (!safeUrl) {
    return false;
  }
  try {
    return isLoopbackHostname(new URL(safeUrl).hostname);
  } catch {
    return false;
  }
}

function derivePhoneHandoffUrl(serviceUrl, interfaces = os.networkInterfaces(), chosenAddress) {
  const safeUrl = safeServiceUrl(serviceUrl);
  if (!safeUrl) {
    return undefined;
  }
  const url = new URL(safeUrl);
  if (!isLoopbackHostname(url.hostname)) {
    return undefined;
  }
  const address = resolvePrivateLanIpv4(interfaces, chosenAddress);
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

function createPhoneHandoff(serviceUrl, interfaces = os.networkInterfaces(), chosenAddress) {
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
  formatPrivateLanCandidateLabel,
  isLoopbackHostname,
  isPhoneHandoffPreview,
  listPrivateLanIpv4Candidates,
  privateIpv4Priority,
  resolvePrivateLanIpv4
};
