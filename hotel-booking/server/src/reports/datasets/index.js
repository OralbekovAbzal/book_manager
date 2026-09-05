const bookings = require('./bookings')
const roomNights = require('./roomNights')
const charges = require('./charges')
const payments = require('./payments')

const DATASETS = {
  [bookings.id]: bookings,
  [roomNights.id]: roomNights,
  [charges.id]: charges,
  [payments.id]: payments,
}

function getDataset(id) {
  return DATASETS[id] || null
}

/** Описание датасетов для конструктора отчётов (без функций загрузки). */
function describeDatasets() {
  return Object.values(DATASETS).map((ds) => ({
    id: ds.id,
    label: ds.label,
    description: ds.description,
    requiresPeriod: !!ds.requiresPeriod,
    fields: Object.entries(ds.fields).map(([key, f]) => ({ key, ...f })),
    metrics: Object.entries(ds.metrics || {}).map(([key, m]) => ({ key, ...m })),
  }))
}

module.exports = { DATASETS, getDataset, describeDatasets }
