const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initializeRunState,
  recordResult,
  remainingRequestsForResume,
  requestKey
} = require('../src/run-state');

test('run state records completed request and resume skips it', () => {
  const requests = [
    {
      requestIndex: 0,
      rowNumber: 2,
      securityGroup: 'HR',
      domainPolicy: 'Worker Data',
      access: 'View Only',
      action: 'add'
    },
    {
      requestIndex: 1,
      rowNumber: 3,
      securityGroup: 'HR',
      domainPolicy: 'Integration Event',
      access: 'Get Only',
      action: 'add'
    }
  ];
  const state = initializeRunState('artifacts/test-state.json', requests);

  recordResult(state, requests[0], { status: 'added', message: 'ok' }, 0);
  const remaining = remainingRequestsForResume(requests, state);

  assert.equal(state.last_completed_row, 2);
  assert.deepEqual(state.completed_keys, [requestKey(requests[0])]);
  assert.deepEqual(remaining, [requests[1]]);
});
