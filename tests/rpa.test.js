const test = require('node:test');
const assert = require('node:assert/strict');
const { RpaError, formatSelector, groupRequestsBySecurityGroup, retry } = require('../src/rpa');

test('formatSelector replaces placeholders', () => {
  assert.equal(
    formatSelector('text={domain_policy}', { domain_policy: 'Worker Data' }),
    'text=Worker Data'
  );
});

test('retry eventually succeeds', async () => {
  let calls = 0;
  const { value, attempts } = await retry(
    async () => {
      calls += 1;
      if (calls < 2) throw new RpaError('not yet');
      return 'ok';
    },
    { attempts: 3, delayMs: 0 }
  );

  assert.equal(value, 'ok');
  assert.equal(attempts, 2);
});

test('retry raises last error', async () => {
  await assert.rejects(
    () => retry(async () => {
      throw new RpaError('still broken');
    }, { attempts: 2, delayMs: 0 }),
    /still broken/
  );
});

test('groups requests by security group while preserving group order', () => {
  const requests = [
    { securityGroup: 'A', domainPolicy: 'P1' },
    { securityGroup: 'B', domainPolicy: 'P2' },
    { securityGroup: 'A', domainPolicy: 'P3' }
  ];

  const batches = groupRequestsBySecurityGroup(requests);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].securityGroup, 'A');
  assert.deepEqual(batches[0].requests.map((request) => request.domainPolicy), ['P1', 'P3']);
  assert.equal(batches[1].securityGroup, 'B');
});
