const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WorkdaySecurityAutomator } = require('../src/rpa');

test('automator adds a policy through a replica-like page', { timeout: 30000 }, async () => {
  const server = await startMockReplica();
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workday-rpa-artifacts-'));

  try {
    const automator = new WorkdaySecurityAutomator(
      {
        baseUrl: server.url,
        timeoutMs: 5000,
        login: { enabled: false },
        workflow: {
          task_name: 'Maintain Domain Security Policies for Security Group',
          global_search_input: 'testid=global-search',
          global_search_result: 'testid=task-result',
          security_group_input: 'testid=security-group-input',
          security_group_result: 'testid=security-group-result',
          ok_button: 'testid=ok-button',
          permissions_grid: "[data-testid='domain-permissions-grid'], [data-testid='view-security-group-grid']",
          add_policy_button: 'testid=add-domain-policy',
          access_field: 'testid=access-token',
          access_lookup_input: 'testid=access-lookup-input',
          access_result: "css=[data-access='{access}']",
          domain_policy_input: 'testid=domain-policy-input',
          domain_policy_result: 'testid=domain-policy-result',
          save_button: 'testid=save-button'
        }
      },
      { headless: true, artifactsDir, maxAttempts: 2, safeMode: true }
    );

    const results = await automator.run([
      {
        rowNumber: 2,
        securityGroup: 'HR Admins',
        domainPolicy: 'Worker Data Public Reports',
        access: 'View and Modify',
        action: 'add'
      }
    ]);

    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'added');
    assert.equal(results[0].attempts, 1);
  } finally {
    await server.close();
  }
});

test('automator batches multiple policies for the same group into one save', { timeout: 45000 }, async () => {
  const server = await startMockReplica();
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workday-rpa-batch-artifacts-'));

  try {
    const automator = new WorkdaySecurityAutomator(
      {
        baseUrl: server.url,
        timeoutMs: 5000,
        login: { enabled: false },
        automation: { action_delay_ms: 0, settle_ms: 0, view_confirmation_ms: 0 },
        workflow: {
          task_name: 'Maintain Domain Security Policies for Security Group',
          global_search_input: 'testid=global-search',
          global_search_result: 'testid=task-result',
          security_group_input: 'testid=security-group-input',
          security_group_result: 'testid=security-group-result',
          ok_button: 'testid=ok-button',
          permissions_grid: "[data-testid='domain-permissions-grid'], [data-testid='view-security-group-grid']",
          add_policy_button: 'testid=add-domain-policy',
          access_field: 'testid=access-token',
          access_lookup_input: 'testid=access-lookup-input',
          access_result: "css=[data-access='{access}']",
          domain_policy_input: 'testid=domain-policy-input',
          domain_policy_result: 'testid=domain-policy-result',
          save_button: 'testid=save-button'
        }
      },
      { headless: true, artifactsDir, maxAttempts: 2 }
    );

    const results = await automator.run([
      {
        requestIndex: 0,
        rowNumber: 2,
        securityGroup: 'HR Admins',
        domainPolicy: 'Worker Data Public Reports',
        access: 'View and Modify',
        action: 'add'
      },
      {
        requestIndex: 1,
        rowNumber: 3,
        securityGroup: 'HR Admins',
        domainPolicy: 'Integration Event',
        access: 'View and Modify',
        action: 'add'
      }
    ]);

    assert.deepEqual(results.map((result) => result.status), ['added', 'added']);
    assert.equal(server.saveCount(), 1);
    assert.equal(server.openCount(), 1);
  } finally {
    await server.close();
  }
});

test('automator does not reopen a saved batch after post-save validation fails', { timeout: 45000 }, async () => {
  const server = await startMockReplica();
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workday-rpa-batch-validation-artifacts-'));

  try {
    const automator = new WorkdaySecurityAutomator(
      {
        baseUrl: server.url,
        timeoutMs: 5000,
        login: { enabled: false },
        automation: { action_delay_ms: 0, settle_ms: 0, view_confirmation_ms: 0 },
        workflow: {
          task_name: 'Maintain Domain Security Policies for Security Group',
          global_search_input: 'testid=global-search',
          global_search_result: 'testid=task-result',
          security_group_input: 'testid=security-group-input',
          security_group_result: 'testid=security-group-result',
          ok_button: 'testid=ok-button',
          permissions_grid: "[data-testid='domain-permissions-grid'], [data-testid='view-security-group-grid']",
          add_policy_button: 'testid=add-domain-policy',
          access_field: 'testid=access-token',
          access_lookup_input: 'testid=access-lookup-input',
          access_result: "css=[data-access='{access}']",
          domain_policy_input: 'testid=domain-policy-input',
          domain_policy_result: 'testid=domain-policy-result',
          save_button: 'testid=save-button',
          replica_storage_key: 'missing-storage-key'
        }
      },
      { headless: true, artifactsDir, maxAttempts: 3 }
    );

    const results = await automator.run([
      {
        requestIndex: 0,
        rowNumber: 2,
        securityGroup: 'HR Admins',
        domainPolicy: 'Worker Data Public Reports',
        access: 'View and Modify',
        action: 'add'
      },
      {
        requestIndex: 1,
        rowNumber: 3,
        securityGroup: 'HR Admins',
        domainPolicy: 'Integration Event',
        access: 'View and Modify',
        action: 'add'
      }
    ]);

    assert.deepEqual(results.map((result) => result.status), ['failed', 'failed']);
    assert.match(results[0].message, /post-save validation failed/);
    assert.equal(server.saveCount(), 1);
    assert.equal(server.openCount(), 1);
  } finally {
    await server.close();
  }
});

async function startMockReplica() {
  let saveCount = 0;
  let openCount = 0;
  const html = `<!doctype html>
    <html>
      <body>
        <input data-testid="global-search" placeholder="Search" />
        <button data-testid="task-result" hidden>Maintain Domain Security Policies for Security Group</button>
        <section id="form" hidden>
          <input data-testid="security-group-input" />
          <button data-testid="security-group-result" hidden>HR Admins</button>
          <button data-testid="ok-button">OK</button>
          <button data-testid="add-domain-policy">Add</button>
          <button data-testid="access-token" hidden></button>
          <input data-testid="access-lookup-input" hidden />
          <button data-access="View and Modify" hidden>View and Modify</button>
          <input data-testid="domain-policy-input" />
          <button data-testid="domain-policy-result" hidden>Worker Data Public Reports</button>
          <button data-testid="save-button">Save</button>
          <table data-testid="domain-permissions-grid"><tbody id="policies"></tbody></table>
        </section>
        <script>
          const search = document.querySelector('[data-testid="global-search"]');
          const task = document.querySelector('[data-testid="task-result"]');
          const form = document.querySelector('#form');
          const groupInput = document.querySelector('[data-testid="security-group-input"]');
          const groupResult = document.querySelector('[data-testid="security-group-result"]');
          const policyInput = document.querySelector('[data-testid="domain-policy-input"]');
          const policyResult = document.querySelector('[data-testid="domain-policy-result"]');
          const policies = document.querySelector('#policies');
          const accessToken = document.querySelector('[data-testid="access-token"]');
          const accessInput = document.querySelector('[data-testid="access-lookup-input"]');
          const accessResult = document.querySelector('[data-access="View and Modify"]');
          let selectedAccess = 'View and Modify';

          search.addEventListener('input', () => { task.hidden = false; });
          task.addEventListener('click', () => {
            form.hidden = false;
            fetch('/open-task', { method: 'POST' });
          });
          groupInput.addEventListener('input', () => { groupResult.hidden = false; });
          document.querySelector('[data-testid="add-domain-policy"]').addEventListener('click', () => { accessToken.hidden = false; });
          accessToken.addEventListener('click', () => {
            accessInput.hidden = false;
            accessResult.hidden = false;
          });
          accessResult.addEventListener('click', () => { selectedAccess = 'View and Modify'; });
          policyInput.addEventListener('input', () => { policyResult.hidden = false; });
          policyResult.addEventListener('click', () => {
            const policy = policyInput.value;
            const row = document.createElement('tr');
            row.innerHTML = '<td>' + selectedAccess + '</td><td>' + policy + '</td>';
            policies.appendChild(row);
          });
          document.querySelector('[data-testid="save-button"]').addEventListener('click', () => {
            fetch('/save', { method: 'POST' });
          });
        </script>
      </body>
    </html>`;

  const server = http.createServer((request, response) => {
    if (request.url === '/save') {
      saveCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === '/open-task') {
      openCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    saveCount: () => saveCount,
    openCount: () => openCount,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
