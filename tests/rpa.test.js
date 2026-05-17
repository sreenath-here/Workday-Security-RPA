const test = require('node:test');
const assert = require('node:assert/strict');
const { RpaError, formatSelector, retry } = require('../src/rpa');

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
