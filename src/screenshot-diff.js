const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function captureLocatorFingerprint(locator, filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const buffer = await locator.screenshot({ path: filePath });
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch {
    return undefined;
  }
}

module.exports = {
  captureLocatorFingerprint
};
