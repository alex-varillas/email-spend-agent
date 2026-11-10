export function buildUsageExamplesText() {
  return (
    'Podés preguntarme en texto libre, por ejemplo:\n' +
    '• "dame mis gastos de los últimos 15 días"\n' +
    '• "cuánto gasté en agosto"\n' +
    '• "muéstrame mis suscripciones"\n\n' +
    'O usar los comandos directos:\n' +
    '/gastos [rango] — todos tus movimientos, con el detalle en Excel\n' +
    '/suscripciones [rango] — solo lo que detecté como recurrente'
  );
}
