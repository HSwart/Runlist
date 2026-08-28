const fs = require('node:fs');

function imageSizeFromPng(filePath) {
  const header = fs.readFileSync(filePath).subarray(0, 24);
  return {
    width: header.readUInt32BE(16),
    height: header.readUInt32BE(20)
  };
}

module.exports = { imageSizeFromPng };
