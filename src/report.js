import PDFDocument from 'pdfkit';

// PDF con el desglose de suscripciones/cobros recurrentes detectados
export function generateRecurringReportPdf(recurringGroups, { generatedAt = new Date() } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Reporte de gastos recurrentes');
    doc.fontSize(10).fillColor('gray').text(`Generado el ${generatedAt.toLocaleString('es-PE')}`);
    doc.moveDown();

    doc.fillColor('black').fontSize(12).text('Suscripciones y cobros recurrentes detectados:');
    doc.moveDown(0.5);

    if (recurringGroups.length === 0) {
      doc.fontSize(11).text('No se detectaron patrones recurrentes en el período analizado.');
    }

    for (const group of recurringGroups) {
      doc
        .fontSize(11)
        .text(
          `${group.vendor} — ${group.montoActual} ${group.moneda} (${group.frecuencia}) — ` +
            `último cobro: ${group.ultimoCobro}, próximo estimado: ${group.proximoEstimado}`
        );
    }

    doc.moveDown();

    const totals = new Map();
    for (const group of recurringGroups) {
      const monthlyEquivalent = group.frecuencia === 'anual' ? group.montoActual / 12 : group.montoActual;
      totals.set(group.moneda, (totals.get(group.moneda) ?? 0) + monthlyEquivalent);
    }

    doc.fontSize(12).text('Total mensual estimado (prorrateando los anuales):');
    for (const [moneda, total] of totals) {
      doc.text(`  ${total.toFixed(2)} ${moneda}/mes`);
    }
    if (totals.size === 0) {
      doc.text('  —');
    }

    doc.moveDown();
    doc
      .fontSize(9)
      .fillColor('gray')
      .text(
        'Nota: esto es lo que el correo permite detectar. El total real probablemente es mayor, porque hay ' +
          'cobros que no mandan correo (algunos cargos van directo a la tarjeta sin aviso detallado).'
      );

    doc.end();
  });
}
