/**
 * Нормализация значений из выгрузок.
 *
 * Отдельный модуль, потому что одни и те же правила нужны обоим загрузчикам
 * (JSON и CSV), а расхождение между ними — источник тихих багов: в базе
 * появились бы «Москва» из JSON и «москва» из CSV как два разных города.
 *
 * Каждая функция возвращает не только значение, но и пометку о том, что именно
 * было изменено, — эти пометки складываются в таблицу load_fixes.
 */

import iconv from 'iconv-lite'

export type FixCode =
  | 'MOJIBAKE_FIXED'
  | 'CITY_CANONICALIZED'
  | 'WHITESPACE_TRIMMED'
  | 'DECIMAL_COMMA_FIXED'
  | 'SITE_SCHEME_FIXED'
  | 'PLACEHOLDER_TO_NULL'

export interface Fix {
  field: string
  code: FixCode
  oldValue: string | null
  newValue: string | null
}

/** Результат нормализации поля: значение + список применённых правок. */
export interface Normalized<T> {
  value: T
  fixes: Fix[]
}

// ---------------------------------------------------------------------------
//  Кодировка
// ---------------------------------------------------------------------------

/**
 * Чинит «мохибейк» — UTF-8-байты, прочитанные как CP1251 и снова записанные в
 * UTF-8. Выглядит как «РњРѕСЃРєРІР°» вместо «Москва».
 *
 * Восстановление: кодируем строку обратно в байты CP1251 и читаем их как UTF-8.
 * Результат принимаем только если доля кириллицы выросла, — иначе возвращаем
 * исходную строку нетронутой. Так чистые русские названия не портятся.
 */
export function fixMojibake(input: string): string {
  if (input === '') return input

  // Быстрый отсев: в мохибейке почти всегда есть «Р»/«С» в связке со
  // служебными символами. Но одного этого признака мало — «Ростов-на-Дону»
  // тоже содержит «Р», поэтому решение принимает метрика ниже.
  if (!/[РСВЂ‚ѓ„…†‡‰‹Ќўµ»є°]/.test(input)) return input

  try {
    // Кодек cp1251 берём из iconv-lite, а не из собственной таблицы: первая
    // версия была набрана руками и содержала 127 символов вместо 128, из-за
    // чего все байты выше 0x80 съезжали на единицу и починка молча не работала
    // (города чинились, а названия с кавычками — нет).
    const cp1251 = iconv.encode(input, 'win1251')

    // iconv-lite подставляет «?» вместо непредставимых символов. Если таких
    // подстановок больше, чем реальных «?» в исходной строке, — значит, она не
    // была cp1251-мохибейком, и трогать её нельзя.
    const originalQuestions = (input.match(/\?/g) ?? []).length
    if (countByte(cp1251, 0x3f) > originalQuestions) return input

    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(cp1251)

    // Признак удачной починки: доля кириллицы выросла.
    //
    // Сравнивать абсолютное число кириллических символов нельзя: в строке
    // «РњРѕСЃРєРІР°» шесть «Р» — это тоже кириллица, и счётчики сходятся
    // с «Москва» ровно в ничью. Доля же растёт с 0.5 до 1.0, потому что
    // мохибейк вдвое длиннее и разбавлен служебными символами.
    return cyrillicRatio(decoded) > cyrillicRatio(input) ? decoded : input
  } catch {
    // fatal: true бросает исключение на некорректном UTF-8 — значит, строка
    // не была мохибейком, возвращаем как есть.
    return input
  }
}

function countByte(buf: Buffer, byte: number): number {
  let n = 0
  for (const b of buf) if (b === byte) n++
  return n
}

/** Доля букв основного кириллического диапазона среди непробельных символов. */
function cyrillicRatio(s: string): number {
  const meaningful = s.replace(/\s/g, '')
  if (meaningful.length === 0) return 0

  const cyrillic = (meaningful.match(/[а-яА-ЯёЁ]/g) ?? []).length
  return cyrillic / meaningful.length
}

// ---------------------------------------------------------------------------
//  Текстовые поля
// ---------------------------------------------------------------------------

/** Схлопывает пробелы, чинит кодировку, пустую строку превращает в null. */
export function normalizeText(
  raw: unknown,
  field: string
): Normalized<string | null> {
  const fixes: Fix[] = []

  if (raw === null || raw === undefined) return { value: null, fixes }

  const original = String(raw)
  let value = original

  const demojibaked = fixMojibake(value)
  if (demojibaked !== value) {
    fixes.push({
      field,
      code: 'MOJIBAKE_FIXED',
      oldValue: value,
      newValue: demojibaked,
    })
    value = demojibaked
  }

  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (collapsed !== value) {
    fixes.push({
      field,
      code: 'WHITESPACE_TRIMMED',
      oldValue: value,
      newValue: collapsed,
    })
    value = collapsed
  }

  return { value: value === '' ? null : value, fixes }
}

// ---------------------------------------------------------------------------
//  Города
// ---------------------------------------------------------------------------

/**
 * Канонические написания городов. Ключ — «сжатая» форма (нижний регистр, без
 * пробелов и дефисов), значение — как город должен выглядеть в базе.
 *
 * Сюда же добавлены латиница (Moscow) и опечатка из выгрузки
 * (Санкат-Петербург) — их видно в review.csv.
 */
const CITY_CANON: Record<string, string> = {
  москва: 'Москва',
  moscow: 'Москва',
  мск: 'Москва',
  санктпетербург: 'Санкт-Петербург',
  санкатпетербург: 'Санкт-Петербург', // опечатка в исходных данных
  spb: 'Санкт-Петербург',
  saintpetersburg: 'Санкт-Петербург',
  питер: 'Санкт-Петербург',
  новосибирск: 'Новосибирск',
  екатеринбург: 'Екатеринбург',
  краснодар: 'Краснодар',
  нижнийновгород: 'Нижний Новгород',
  казань: 'Казань',
  ростовнадону: 'Ростов-на-Дону',
  уфа: 'Уфа',
  воронеж: 'Воронеж',
  челябинск: 'Челябинск',
  пермь: 'Пермь',
  самара: 'Самара',
  волгоград: 'Волгоград',
  тюмень: 'Тюмень',
  сочи: 'Сочи',
  омск: 'Омск',
  тула: 'Тула',
  калуга: 'Калуга',
  ярославль: 'Ярославль',
  красноярск: 'Красноярск',
  саратов: 'Саратов',
}

function cityKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\s\-‑–—]/g, '')
}

/**
 * Приводит город к каноническому виду.
 *
 * Возвращает value=null, если строка вообще не похожа на город (например, в
 * поле city приехал адрес — так бывает при сдвиге колонок).
 */
export function normalizeCity(raw: unknown): Normalized<string | null> {
  const base = normalizeText(raw, 'city')
  const fixes = [...base.fixes]

  if (base.value === null) return { value: null, fixes }

  // Признак сдвига колонок: в городе лежит адрес.
  if (/^ул\.|^пр\.|^пер\.|д\.\s*\d|офис\s*\d/i.test(base.value)) {
    return { value: null, fixes }
  }

  const canon = CITY_CANON[cityKey(base.value)]

  if (canon && canon !== base.value) {
    fixes.push({
      field: 'city',
      code: 'CITY_CANONICALIZED',
      oldValue: base.value,
      newValue: canon,
    })
    return { value: canon, fixes }
  }

  return { value: canon ?? base.value, fixes }
}

/** Известен ли город справочнику — используется для проверки «город ли это». */
export function isKnownCity(name: string): boolean {
  return CITY_CANON[cityKey(name)] !== undefined
}

// ---------------------------------------------------------------------------
//  Числа
// ---------------------------------------------------------------------------

/** Строки-заглушки, означающие «значения нет». */
const NULL_PLACEHOLDERS = new Set([
  'n/a',
  'na',
  'нет',
  'нет данных',
  'нет сайта',
  'none',
  'null',
  'undefined',
  '-',
  '—',
  '',
])

export function isPlaceholder(s: string): boolean {
  return NULL_PLACEHOLDERS.has(s.trim().toLowerCase())
}

export interface ParsedNumber {
  value: number | null
  fixes: Fix[]
  /** Заполнено, если значение невалидно и строку нужно отправить в карантин. */
  error?: string
}

/**
 * Разбирает рейтинг: допускает десятичную запятую («4,5»), отбраковывает
 * значения вне 0..5 и нечисловой мусор.
 */
export function parseRating(raw: unknown): ParsedNumber {
  const fixes: Fix[] = []

  if (raw === null || raw === undefined) return { value: null, fixes }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0 || raw > 5) {
      return { value: null, fixes, error: `рейтинг вне диапазона 0..5: ${raw}` }
    }
    return { value: raw, fixes }
  }

  const s = String(raw).trim()
  if (isPlaceholder(s)) {
    if (s !== '') {
      fixes.push({
        field: 'rating',
        code: 'PLACEHOLDER_TO_NULL',
        oldValue: s,
        newValue: null,
      })
    }
    return { value: null, fixes }
  }

  let normalized = s
  if (s.includes(',')) {
    normalized = s.replace(',', '.')
    fixes.push({
      field: 'rating',
      code: 'DECIMAL_COMMA_FIXED',
      oldValue: s,
      newValue: normalized,
    })
  }

  const num = Number(normalized)
  if (!Number.isFinite(num)) {
    return { value: null, fixes, error: `рейтинг не число: "${s}"` }
  }
  if (num < 0 || num > 5) {
    return { value: null, fixes, error: `рейтинг вне диапазона 0..5: ${s}` }
  }

  return { value: num, fixes }
}

/** Разбирает число отзывов: только целое >= 0. */
export function parseReviewsCount(raw: unknown): ParsedNumber {
  const fixes: Fix[] = []

  if (raw === null || raw === undefined) return { value: 0, fixes }
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0) {
      return { value: null, fixes, error: `число отзывов некорректно: ${raw}` }
    }
    return { value: raw, fixes }
  }

  const s = String(raw).trim()
  if (s === '') return { value: 0, fixes }

  if (!/^-?\d+$/.test(s)) {
    return { value: null, fixes, error: `число отзывов не целое: "${s}"` }
  }

  const num = Number(s)
  if (num < 0) {
    return { value: null, fixes, error: `число отзывов отрицательное: ${s}` }
  }

  return { value: num, fixes }
}

// ---------------------------------------------------------------------------
//  Сайт и телефон
// ---------------------------------------------------------------------------

export interface ParsedField {
  value: string | null
  fixes: Fix[]
  /** Значение сохраняем, но помечаем как подозрительное (не повод отбрасывать строку). */
  warning?: string
}

/**
 * Нормализует URL. Опечатку в схеме («htp://») чиним, а вот «https://» без
 * домена или «нет сайта» — это отсутствие сайта, пишем null.
 */
export function parseSite(raw: unknown): ParsedField {
  const base = normalizeText(raw, 'site')
  const fixes = [...base.fixes]

  if (base.value === null) return { value: null, fixes }

  let s = base.value

  if (isPlaceholder(s)) {
    fixes.push({
      field: 'site',
      code: 'PLACEHOLDER_TO_NULL',
      oldValue: s,
      newValue: null,
    })
    return { value: null, fixes }
  }

  const schemeFixed = s.replace(/^htp:\/\//i, 'http://').replace(/^htps:\/\//i, 'https://')
  if (schemeFixed !== s) {
    fixes.push({
      field: 'site',
      code: 'SITE_SCHEME_FIXED',
      oldValue: s,
      newValue: schemeFixed,
    })
    s = schemeFixed
  }

  // «https://» без хоста — мусор, а не адрес.
  if (!/^https?:\/\/[^\s/]+\.[a-z]{2,}/i.test(s)) {
    fixes.push({
      field: 'site',
      code: 'PLACEHOLDER_TO_NULL',
      oldValue: s,
      newValue: null,
    })
    return { value: null, fixes, warning: `сайт не похож на URL: "${s}"` }
  }

  return { value: s, fixes }
}

/**
 * Телефон. Приводим «8 (xxx)» к «+7», но не пытаемся спасать явный мусор:
 * если цифр не 11, оставляем значение как есть и помечаем предупреждением —
 * терять контакт хуже, чем хранить его неаккуратным.
 */
export function parsePhone(raw: unknown): ParsedField {
  const base = normalizeText(raw, 'phone')
  const fixes = [...base.fixes]

  if (base.value === null) return { value: null, fixes }

  const s = base.value
  if (isPlaceholder(s)) {
    fixes.push({
      field: 'phone',
      code: 'PLACEHOLDER_TO_NULL',
      oldValue: s,
      newValue: null,
    })
    return { value: null, fixes }
  }

  const digits = s.replace(/\D/g, '')

  if (digits.length !== 11) {
    return { value: s, fixes, warning: `телефон некорректен: "${s}"` }
  }

  if (/[a-zA-Zа-яА-Я]/.test(s)) {
    return { value: s, fixes, warning: `в телефоне есть буквы: "${s}"` }
  }

  return { value: s, fixes }
}

// ---------------------------------------------------------------------------
//  Ключ дедупликации
// ---------------------------------------------------------------------------

/**
 * Ключ «это та же самая компания»: имя без организационно-правовой формы и
 * кавычек + город + адрес.
 *
 * Почему без формы: в review.csv те же компании приходят как «АО Флагман Лаб»
 * вместо «АО «Флагман Лаб»» из основной выгрузки — отличаются только кавычки.
 * Сравнение «в лоб» такие пары не поймает.
 */
export function buildDedupKey(
  name: string | null,
  city: string | null,
  address: string | null
): string | null {
  if (!name) return null

  const cleanName = name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/^\s*(ооо|оао|зао|пао|ао|ип|чп)\s+/i, '')
    .replace(/[^a-zа-я0-9]/g, '')

  if (!cleanName) return null

  const cleanCity = (city ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '')
  const cleanAddr = (address ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '')

  return `${cleanName}|${cleanCity}|${cleanAddr}`
}
