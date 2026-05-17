const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function requestKey(request) {
  return [
    request.rowNumber,
    request.securityGroup,
    request.domainPolicy,
    request.access,
    request.action
  ].join('|');
}

function requestFingerprint(requests) {
  const stable = requests.map((request) => ({
    rowNumber: request.rowNumber,
    securityGroup: request.securityGroup,
    domainPolicy: request.domainPolicy,
    access: request.access,
    action: request.action
  }));
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function loadRunState(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function initializeRunState(filePath, requests, { resume = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fingerprint = requestFingerprint(requests);
  const existing = resume ? loadRunState(filePath) : undefined;
  if (existing?.request_fingerprint === fingerprint) {
    return existing;
  }

  return {
    request_fingerprint: fingerprint,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_completed_index: -1,
    last_completed_row: null,
    security_group: null,
    completed_keys: [],
    results: []
  };
}

function remainingRequestsForResume(requests, state) {
  const completed = new Set(state.completed_keys || []);
  return requests.filter((request) => !completed.has(requestKey(request)));
}

function recordResult(state, request, result, requestIndex) {
  const key = requestKey(request);
  const completed = new Set(state.completed_keys || []);
  completed.add(key);

  state.updated_at = new Date().toISOString();
  state.last_completed_index = requestIndex;
  state.last_completed_row = request.rowNumber;
  state.security_group = request.securityGroup;
  state.completed_keys = [...completed];
  state.results = [
    ...(state.results || []).filter((item) => item.key !== key),
    {
      key,
      row_number: request.rowNumber,
      security_group: request.securityGroup,
      domain_policy: request.domainPolicy,
      access: request.access,
      status: result.status,
      message: result.message,
      completed_at: new Date().toISOString()
    }
  ];
}

function saveRunState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

module.exports = {
  initializeRunState,
  loadRunState,
  recordResult,
  remainingRequestsForResume,
  requestFingerprint,
  requestKey,
  saveRunState
};
