const fs = require('node:fs');
const ExcelJS = require('exceljs');

class ExcelInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExcelInputError';
  }
}

const SECURITY_GROUP_ALIASES = new Set(['security group', 'sec group', 'group', 'securitygroup']);
const DOMAIN_POLICY_ALIASES = new Set(['domain security policy', 'domain policy', 'policy', 'domain']);
const ACTION_ALIASES = new Set(['action', 'operation']);
const VIEW_ALIASES = new Set(['view']);
const MODIFY_ALIASES = new Set(['modify']);
const GET_ALIASES = new Set(['get']);
const PUT_ALIASES = new Set(['put']);

async function readPolicyRequests(filePath, sheetName) {
  if (!fs.existsSync(filePath)) {
    throw new ExcelInputError(`Excel file not found: ${filePath}`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!worksheet) {
    throw new ExcelInputError(sheetName ? `Worksheet not found: ${sheetName}` : 'Excel workbook is empty.');
  }

  const headerRow = worksheet.getRow(1);
  const headerMap = buildHeaderMap(headerRow);
  const securityGroupColumn = findRequired(headerMap, SECURITY_GROUP_ALIASES, 'Security Group');
  const domainPolicyColumn = findRequired(headerMap, DOMAIN_POLICY_ALIASES, 'Domain Security Policy');
  const actionColumn = findOptional(headerMap, ACTION_ALIASES);
  const viewColumn = findOptional(headerMap, VIEW_ALIASES);
  const modifyColumn = findOptional(headerMap, MODIFY_ALIASES);
  const getColumn = findOptional(headerMap, GET_ALIASES);
  const putColumn = findOptional(headerMap, PUT_ALIASES);

  const requests = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const securityGroup = cellText(row.getCell(securityGroupColumn));
    const domainPolicy = cellText(row.getCell(domainPolicyColumn));
    const action = actionColumn ? cellText(row.getCell(actionColumn)) || 'add' : 'add';

    if (!securityGroup && !domainPolicy) return;
    if (!securityGroup || !domainPolicy) {
      throw new ExcelInputError(`Row ${rowNumber} must include both Security Group and Domain Security Policy.`);
    }

    const normalizedAction = action.trim().toLowerCase();
    if (!['add', 'verify'].includes(normalizedAction)) {
      throw new ExcelInputError(`Row ${rowNumber} has unsupported Action '${action}'. Supported actions: add, verify.`);
    }

    const accessValues = deriveAccessValues({
      rowNumber,
      view: viewColumn ? cellText(row.getCell(viewColumn)) : '',
      modify: modifyColumn ? cellText(row.getCell(modifyColumn)) : '',
      get: getColumn ? cellText(row.getCell(getColumn)) : '',
      put: putColumn ? cellText(row.getCell(putColumn)) : ''
    });

    for (const access of accessValues) {
      requests.push({
        rowNumber,
        securityGroup: securityGroup.trim(),
        domainPolicy: domainPolicy.trim(),
        access,
        action: normalizedAction
      });
    }
  });

  if (requests.length === 0) {
    throw new ExcelInputError('No request rows found in the workbook.');
  }
  return requests;
}

function deriveAccessValues({ rowNumber, view, modify, get, put }) {
  const wantsView = isYes(view);
  const wantsModify = isYes(modify);
  const wantsGet = isYes(get);
  const wantsPut = isYes(put);

  if (wantsModify && !wantsView) {
    throw new ExcelInputError(`Row ${rowNumber} has Modify=Y but View is not Y.`);
  }
  if (wantsPut && !wantsGet) {
    throw new ExcelInputError(`Row ${rowNumber} has Put=Y but Get is not Y.`);
  }

  const accessValues = [];
  if (wantsView) accessValues.push(wantsModify ? 'View and Modify' : 'View Only');
  if (wantsGet) accessValues.push(wantsPut ? 'Get and Put' : 'Get Only');

  if (accessValues.length === 0) {
    throw new ExcelInputError(`Row ${rowNumber} must have at least one permission column marked Y.`);
  }
  return accessValues;
}

function isYes(value) {
  return ['y', 'yes', 'true', '1'].includes(normalize(value));
}

function buildHeaderMap(row) {
  const mapping = new Map();
  row.eachCell((cell, columnNumber) => {
    const normalized = normalize(cellText(cell));
    if (normalized) mapping.set(normalized, columnNumber);
  });
  return mapping;
}

function findRequired(headerMap, aliases, displayName) {
  const match = findOptional(headerMap, aliases);
  if (!match) {
    throw new ExcelInputError(`Missing required column '${displayName}'. Accepted names: ${[...aliases].sort().join(', ')}.`);
  }
  return match;
}

function findOptional(headerMap, aliases) {
  for (const alias of aliases) {
    if (headerMap.has(alias)) return headerMap.get(alias);
  }
  return undefined;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function cellText(cell) {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('').trim();
    if (value.text) return String(value.text).trim();
    if (value.result !== undefined) return String(value.result).trim();
    if (value.hyperlink && value.text) return String(value.text).trim();
  }
  return String(value).trim();
}

module.exports = {
  ExcelInputError,
  readPolicyRequests,
  cellText,
  deriveAccessValues
};
