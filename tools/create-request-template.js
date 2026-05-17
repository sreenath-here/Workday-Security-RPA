const path = require('node:path');
const ExcelJS = require('exceljs');

async function main(argv = process.argv.slice(2)) {
  const output = argv[0] || path.join('samples', 'request_list.xlsx');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Requests');
  worksheet.columns = [
    { header: 'Security Group', key: 'securityGroup', width: 32 },
    { header: 'Domain Security Policy', key: 'domainPolicy', width: 42 },
    { header: 'View', key: 'view', width: 10 },
    { header: 'Modify', key: 'modify', width: 10 },
    { header: 'Get', key: 'get', width: 10 },
    { header: 'Put', key: 'put', width: 10 }
  ];
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9EAF7' }
  };
  worksheet.addRow({
    securityGroup: 'SREE_Job_Profile',
    domainPolicy: 'Worker Data: Compensation',
    view: 'Y',
    modify: 'Y',
    get: 'N',
    put: 'N'
  });

  await workbook.xlsx.writeFile(output);
  console.log(`Created ${output}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
