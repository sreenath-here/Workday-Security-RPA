const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const ExcelJS = require('exceljs');
const { ExcelInputError, readPolicyRequests } = require('../src/excel-reader');

test('reads valid requests', async () => {
  const filePath = await workbook([
    ['Security Group', 'Domain Security Policy', 'View', 'Modify', 'Get', 'Put'],
    ['HR Admins', 'Worker Data: Public Worker Reports', 'Y', 'Y', 'N', 'N']
  ]);

  const requests = await readPolicyRequests(filePath);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].rowNumber, 2);
  assert.equal(requests[0].securityGroup, 'HR Admins');
  assert.equal(requests[0].domainPolicy, 'Worker Data: Public Worker Reports');
  assert.equal(requests[0].access, 'View and Modify');
});

test('derives get only requests', async () => {
  const filePath = await workbook([
    ['Security Group', 'Domain Security Policy', 'View', 'Modify', 'Get', 'Put'],
    ['HR Admins', 'Integration Event', 'N', 'N', 'Y', 'N']
  ]);

  const requests = await readPolicyRequests(filePath);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].access, 'Get Only');
});

test('creates both access requests when both permission families are marked', async () => {
  const filePath = await workbook([
    ['Security Group', 'Domain Security Policy', 'View', 'Modify', 'Get', 'Put'],
    ['HR Admins', 'Integration Event', 'Y', 'N', 'Y', 'Y']
  ]);

  const requests = await readPolicyRequests(filePath);

  assert.deepEqual(requests.map((request) => request.access), ['View Only', 'Get and Put']);
});

test('accepts verify action', async () => {
  const filePath = await workbook([
    ['Security Group', 'Domain Security Policy', 'View', 'Modify', 'Get', 'Put', 'Action'],
    ['HR Admins', 'Integration Event', 'N', 'N', 'Y', 'N', 'verify']
  ]);

  const requests = await readPolicyRequests(filePath);

  assert.equal(requests[0].action, 'verify');
});

test('rejects missing required columns', async () => {
  const filePath = await workbook([['Security Group'], ['HR Admins']]);

  await assert.rejects(() => readPolicyRequests(filePath), ExcelInputError);
});

test('rejects incomplete rows', async () => {
  const filePath = await workbook([
    ['Security Group', 'Domain Security Policy', 'View', 'Modify', 'Get', 'Put'],
    ['HR Admins', '', 'Y', 'N', 'N', 'N']
  ]);

  await assert.rejects(() => readPolicyRequests(filePath), /Row 2/);
});

test('rejects modify without view', async () => {
  const filePath = await workbook([
    ['Security Group', 'Domain Security Policy', 'View', 'Modify', 'Get', 'Put'],
    ['HR Admins', 'Worker Data: Public Worker Reports', 'N', 'Y', 'N', 'N']
  ]);

  await assert.rejects(() => readPolicyRequests(filePath), /Modify=Y/);
});

async function workbook(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workday-rpa-'));
  const filePath = path.join(dir, 'requests.xlsx');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Requests');
  for (const row of rows) ws.addRow(row);
  await wb.xlsx.writeFile(filePath);
  return filePath;
}
