const path = require('node:path');
const fs = require('node:fs');
const ExcelJS = require('exceljs');

async function writeReport(filePath, results) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('RPA Results');
  worksheet.columns = [
    { header: 'Excel Row', key: 'rowNumber', width: 12 },
    { header: 'Security Group', key: 'securityGroup', width: 32 },
    { header: 'Domain Security Policy', key: 'domainPolicy', width: 42 },
    { header: 'Access', key: 'access', width: 18 },
    { header: 'Action', key: 'action', width: 12 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Message', key: 'message', width: 60 },
    { header: 'Attempts', key: 'attempts', width: 12 },
    { header: 'Screenshot', key: 'screenshotPath', width: 60 }
  ];

  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9EAF7' }
  };

  for (const result of results) {
    worksheet.addRow({
      rowNumber: result.request.rowNumber,
      securityGroup: result.request.securityGroup,
      domainPolicy: result.request.domainPolicy,
      access: result.request.access || '',
      action: result.request.action,
      status: result.status,
      message: result.message,
      attempts: result.attempts,
      screenshotPath: result.screenshotPath || ''
    });
  }

  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

function resultOk(result) {
  return ['added', 'already_present', 'verified', 'dry_run_ok'].includes(result.status);
}

module.exports = {
  writeReport,
  resultOk
};
