const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../src/cli');
const {
  RpaError,
  WorkdaySecurityAutomator,
  formatSelector,
  groupRequestsBySecurityGroup,
  retry,
  selectExistingPage
} = require('../src/rpa');

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

test('replica storage validation is skipped for real Workday URLs by default', () => {
  const automator = new WorkdaySecurityAutomator({
    baseUrl: 'https://wd5.myworkday.com/example',
    workflow: { replica_storage_key: 'exactWorkdayReplica' }
  });

  assert.equal(automator.shouldVerifyReplicaStorage(), false);
});

test('replica storage validation stays enabled for localhost replica runs', () => {
  const automator = new WorkdaySecurityAutomator({
    baseUrl: 'http://127.0.0.1:4190/',
    workflow: { replica_storage_key: 'exactWorkdayReplica' }
  });

  assert.equal(automator.shouldVerifyReplicaStorage(), true);
});

test('selects existing tab matching base URL before other open tabs', () => {
  const pages = [
    fakePage('https://example.com/home'),
    fakePage('https://wd5.myworkday.com/example/d/home.htmld')
  ];

  const page = selectExistingPage(pages, { baseUrl: 'https://wd5.myworkday.com/example' });

  assert.equal(page.url(), 'https://wd5.myworkday.com/example/d/home.htmld');
});

test('selects existing tab by wildcard URL pattern', () => {
  const pages = [
    fakePage('https://wd5.myworkday.com/example/d/home.htmld'),
    fakePage('https://wd5.myworkday.com/example/security/task')
  ];

  const page = selectExistingPage(pages, {
    baseUrl: 'https://wd5.myworkday.com/example',
    urlPattern: '*security*'
  });

  assert.equal(page.url(), 'https://wd5.myworkday.com/example/security/task');
});

function fakePage(url) {
  return { url: () => url };
}

test('parses existing browser attach options', () => {
  const args = parseArgs([
    '--excel',
    'requests.xlsx',
    '--cdp-endpoint',
    'http://127.0.0.1:9222',
    '--use-existing-page',
    '--existing-page-url',
    '*myworkday*'
  ]);

  assert.equal(args.cdpEndpoint, 'http://127.0.0.1:9222');
  assert.equal(args.useExistingPage, true);
  assert.equal(args.existingPageUrl, '*myworkday*');
});
