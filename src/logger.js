const fs = require('node:fs');
const path = require('node:path');

class JsonLogger {
  constructor(filePath) {
    this.filePath = filePath;
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
  }

  info(action, data = {}) {
    this.write('info', action, data);
  }

  warn(action, data = {}) {
    this.write('warn', action, data);
  }

  error(action, data = {}) {
    this.write('error', action, data);
  }

  write(level, action, data) {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      action,
      ...data
    };
    const line = `${JSON.stringify(record)}\n`;
    if (this.filePath) fs.appendFileSync(this.filePath, line);
    if (level === 'error') console.error(line.trim());
  }
}

module.exports = {
  JsonLogger
};
