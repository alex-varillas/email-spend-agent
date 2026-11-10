import ExcelJS from 'exceljs';

function formatCanal(record) {
  if (record.canal === 'tarjeta' && record.banco) {
    return `${record.canal}(${record.banco})`;
  }
  return record.canal;
}

// Workbook itemizado de gastos (todo tipo de gasto, no solo recurrente),
// usado tanto por el bot conversacional como por adjuntos de reportes.
export async function generateGastosExcel(records, { sheetName = 'Gastos' } = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Hora', key: 'hora', width: 20 },
    { header: 'Vendor', key: 'vendor', width: 32 },
    { header: 'Monto', key: 'monto', width: 12 },
    { header: 'Moneda', key: 'moneda', width: 8 },
    { header: 'Canal', key: 'canal', width: 16 },
    { header: 'Categoría', key: 'categoria', width: 24 },
  ];
  sheet.getRow(1).font = { bold: true };

  const sorted = [...records].sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  for (const record of sorted) {
    sheet.addRow({
      fecha: record.fecha,
      hora: record.hora ? new Date(record.hora).toLocaleString('es-PE') : '',
      vendor: record.vendor,
      monto: record.monto,
      moneda: record.moneda,
      canal: formatCanal(record),
      categoria: record.categoria,
    });
  }

  return workbook.xlsx.writeBuffer();
}
