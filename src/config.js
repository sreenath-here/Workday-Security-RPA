const fs = require('node:fs');

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function loadConfig(filePath, baseUrlOverride) {
  if (!fs.existsSync(filePath)) {
    throw new ConfigError(`Config file not found: ${filePath}`);
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const baseUrl = baseUrlOverride || process.env.WORKDAY_REPLICA_URL || raw.base_url;
  if (!baseUrl) {
    throw new ConfigError('base_url is required in config or WORKDAY_REPLICA_URL.');
  }

  const login = raw.login || {};
  if (login.enabled) {
    login.username = process.env.WORKDAY_USERNAME || login.username || '';
    login.password = process.env.WORKDAY_PASSWORD || login.password || '';
    if (!login.username || !login.password) {
      throw new ConfigError('Login is enabled, but username/password were not provided.');
    }
  }

  const workflow = raw.workflow || {};
  if (Object.keys(workflow).length === 0) {
    throw new ConfigError('workflow selectors are required.');
  }

  return {
    baseUrl: String(baseUrl),
    timeoutMs: Number(raw.timeout_ms || 45000),
    login,
    workflow,
    automation: raw.automation || {}
  };
}

module.exports = {
  ConfigError,
  loadConfig
};
