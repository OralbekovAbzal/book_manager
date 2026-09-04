/**
 * Словарь конструктора отчётов: всё, из чего он собирает определение, с
 * человеческими подписями. Отдаётся клиенту одним запросом (`GET /reports/meta`),
 * чтобы формы конструктора строились из данных, а не дублировали списки в коде.
 *
 * Ключи здесь = ключи `OPS` / `AGGS` в engine.js: добавил операцию в движок —
 * добавь подпись сюда, иначе конструктор её не покажет.
 */

const OPS = [
  { value: 'eq',       label: 'равно',            needsValue: true },
  { value: 'neq',      label: 'не равно',         needsValue: true },
  { value: 'in',       label: 'одно из',          needsValue: true, list: true },
  { value: 'notIn',    label: 'ни одно из',       needsValue: true, list: true },
  { value: 'contains', label: 'содержит',         needsValue: true },
  { value: 'gt',       label: 'больше',           needsValue: true },
  { value: 'gte',      label: 'не меньше',        needsValue: true },
  { value: 'lt',       label: 'меньше',           needsValue: true },
  { value: 'lte',      label: 'не больше',        needsValue: true },
  { value: 'isTrue',   label: 'да (истина)',      needsValue: false },
  { value: 'isFalse',  label: 'нет (ложь)',       needsValue: false },
  { value: 'notEmpty', label: 'заполнено',        needsValue: false },
  { value: 'hasAny',   label: 'содержит любое из', needsValue: true, list: true },
]

const AGGS = [
  { value: 'sum',           label: 'Сумма',                needsField: true },
  { value: 'count',         label: 'Количество строк',     needsField: false },
  { value: 'countDistinct', label: 'Уникальных значений',  needsField: true },
  { value: 'avg',           label: 'Среднее',              needsField: true },
  { value: 'min',           label: 'Минимум',              needsField: true },
  { value: 'max',           label: 'Максимум',             needsField: true },
  { value: 'first',         label: 'Первое значение',      needsField: true },
  { value: 'ratio',         label: 'Доля (a / b)',         needsField: true, needsOf: true },
]

const PARAM_TYPES = [
  { value: 'dateRange',   label: 'Период' },
  { value: 'select',      label: 'Выбор одного' },
  { value: 'multiselect', label: 'Выбор нескольких' },
  { value: 'text',        label: 'Текст' },
  { value: 'number',      label: 'Число' },
  { value: 'boolean',     label: 'Да / нет' },
]

const COLUMN_TYPES = [
  { value: 'text',     label: 'Текст' },
  { value: 'int',      label: 'Целое число' },
  { value: 'number',   label: 'Число' },
  { value: 'money',    label: 'Деньги' },
  { value: 'percent',  label: 'Процент' },
  { value: 'date',     label: 'Дата' },
  { value: 'datetime', label: 'Дата и время' },
  { value: 'month',    label: 'Месяц' },
  { value: 'bool',     label: 'Да / нет' },
  { value: 'list',     label: 'Список' },
]

const OPTION_SOURCES = [
  { value: 'buildings',  label: 'Корпуса' },
  { value: 'floors',     label: 'Этажи' },
  { value: 'categories', label: 'Категории номеров' },
  { value: 'partners',   label: 'Партнёры' },
  { value: 'sources',    label: 'Источники броней' },
  { value: 'admins',     label: 'Сотрудники' },
]

const PRESETS = [
  { value: 'today',        label: 'Сегодня' },
  { value: 'last7',        label: '7 дней' },
  { value: 'last30',       label: '30 дней' },
  { value: 'currentMonth', label: 'Этот месяц' },
  { value: 'prevMonth',    label: 'Прошлый месяц' },
  { value: 'currentYear',  label: 'Этот год' },
  { value: 'prevYear',     label: 'Прошлый год' },
]

const ICONS = [
  { value: 'chart', label: 'График' },
  { value: 'list',  label: 'Список' },
  { value: 'doc',   label: 'Документ' },
]

const { FUNCTIONS } = require('./expr')

module.exports = { OPS, AGGS, PARAM_TYPES, COLUMN_TYPES, OPTION_SOURCES, PRESETS, ICONS, FUNCTIONS }
