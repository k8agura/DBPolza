/**
 * Самопроверка логики нормализации — самое хрупкое место всей загрузки.
 *
 *   npx tsx scripts/test-normalize.ts
 *
 * Без фреймворков: обычные assert'ы, ненулевой код выхода при провале.
 * Проверяется то, что ломалось на практике: починка кодировки (первая версия
 * молча не работала из-за таблицы CP1251 на 127 символов) и отсутствие ложных
 * срабатываний на чистых русских названиях.
 */

import assert from 'node:assert/strict'
import {
  fixMojibake,
  normalizeCity,
  normalizeText,
  parseRating,
  parseReviewsCount,
  parseSite,
  parsePhone,
  buildDedupKey,
} from '../src/lib/normalize'

let passed = 0
let failed = 0

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
  } catch (err) {
    failed++
    console.error(`✗ ${label}`)
    console.error(`  ${(err as Error).message.split('\n')[0]}`)
  }
}

// --- Кодировка -------------------------------------------------------------

check('mojibake: город восстанавливается', () => {
  assert.equal(fixMojibake('РњРѕСЃРєРІР°'), 'Москва')
  assert.equal(fixMojibake('РЎР°РЅРєС‚-РџРµС‚РµСЂР±СѓСЂРі'), 'Санкт-Петербург')
})

check('mojibake: название с кавычками восстанавливается', () => {
  // Именно этот случай не работал, пока таблица CP1251 была на 127 символов.
  assert.equal(fixMojibake('РћРћРћ В«Р—Р°СЂСЏ РўРµС…В»'), 'ООО «Заря Тех»')
  assert.equal(fixMojibake('РћРћРћ В«РўРµРјРї РњРµРґРёР°В»'), 'ООО «Темп Медиа»')
})

check('mojibake: чистые русские строки не портятся', () => {
  const clean = [
    'Москва',
    'Ростов-на-Дону',
    'Санкт-Петербург',
    'ООО «Заря Тех»',
    'АО «Сокол Трейд»',
    'ИП Орлов С. П.',
    'Пермь',
    'Сочи',
    'ул. Молодёжная, д. 83, офис 179',
    'Строительная компания',
    'Нижний Новгород',
    'Ярославль',
  ]
  for (const s of clean) {
    assert.equal(fixMojibake(s), s, `строка испорчена: ${s}`)
  }
})

check('mojibake: латиница и пустая строка не ломают функцию', () => {
  assert.equal(fixMojibake(''), '')
  assert.equal(fixMojibake('Moscow'), 'Moscow')
  assert.equal(fixMojibake('https://example.ru'), 'https://example.ru')
})

// --- Города ----------------------------------------------------------------

check('город: варианты написания сводятся к одному', () => {
  for (const v of ['Москва', 'москва', 'Москва ', ' МОСКВА', 'Moscow', 'РњРѕСЃРєРІР°']) {
    assert.equal(normalizeCity(v).value, 'Москва', `не сошлось: "${v}"`)
  }
})

check('город: опечатка из выгрузки исправляется', () => {
  assert.equal(normalizeCity('Санкат-Петербург').value, 'Санкт-Петербург')
  assert.equal(normalizeCity('санкт-петербург').value, 'Санкт-Петербург')
})

check('город: адрес в поле города отбраковывается', () => {
  // Признак сдвига колонок — сюда попал адрес.
  assert.equal(normalizeCity('ул. Советская, д. 89, офис 43').value, null)
})

check('город: неизвестный город сохраняется как есть', () => {
  // Справочник не должен молча терять города, которых в нём пока нет.
  assert.equal(normalizeCity('Норильск').value, 'Норильск')
})

// --- Рейтинг ---------------------------------------------------------------

check('рейтинг: корректные значения проходят', () => {
  assert.equal(parseRating('4.5').value, 4.5)
  assert.equal(parseRating(4.5).value, 4.5)
  assert.equal(parseRating('5').value, 5)
  assert.equal(parseRating('0').value, 0)
})

check('рейтинг: десятичная запятая чинится', () => {
  const r = parseRating('4,5')
  assert.equal(r.value, 4.5)
  assert.equal(r.error, undefined)
  assert.ok(r.fixes.some((f) => f.code === 'DECIMAL_COMMA_FIXED'))
})

check('рейтинг: заглушки становятся NULL без ошибки', () => {
  for (const v of ['N/A', '', 'нет данных', '-']) {
    const r = parseRating(v)
    assert.equal(r.value, null, `не NULL: "${v}"`)
    assert.equal(r.error, undefined, `неожиданная ошибка на "${v}"`)
  }
})

check('рейтинг: вне шкалы 0..5 отбраковывается', () => {
  assert.ok(parseRating('7.2').error, '7.2 должен быть отбракован')
  assert.ok(parseRating('-3').error, '-3 должен быть отбракован')
  assert.ok(parseRating(7.2).error, 'число 7.2 должно быть отбраковано')
})

check('рейтинг: мусор отбраковывается', () => {
  assert.ok(parseRating('отлично').error)
})

// --- Число отзывов ---------------------------------------------------------

check('отзывы: целые проходят, пустое = 0', () => {
  assert.equal(parseReviewsCount('42').value, 42)
  assert.equal(parseReviewsCount(0).value, 0)
  assert.equal(parseReviewsCount('').value, 0)
  assert.equal(parseReviewsCount(null).value, 0)
})

check('отзывы: дробное, отрицательное и текст отбраковываются', () => {
  assert.ok(parseReviewsCount('45.5').error, '45.5 должно быть отбраковано')
  assert.ok(parseReviewsCount('-10').error, '-10 должно быть отбраковано')
  assert.ok(parseReviewsCount('много').error, '«много» должно быть отбраковано')
})

// --- Сайт ------------------------------------------------------------------

check('сайт: опечатка в схеме чинится', () => {
  const r = parseSite('htp://sintez-service-453.ru')
  assert.equal(r.value, 'http://sintez-service-453.ru')
  assert.ok(r.fixes.some((f) => f.code === 'SITE_SCHEME_FIXED'))
})

check('сайт: мусор приводится к NULL', () => {
  // Иначе «доля компаний с сайтом» окажется завышенной.
  assert.equal(parseSite('https://').value, null)
  assert.equal(parseSite('нет сайта').value, null)
  assert.equal(parseSite('').value, null)
})

check('сайт: нормальный URL не трогается', () => {
  assert.equal(parseSite('https://example.ru').value, 'https://example.ru')
  assert.equal(parseSite('http://a-b-1.com').value, 'http://a-b-1.com')
})

// --- Телефон ---------------------------------------------------------------

check('телефон: корректный проходит без предупреждений', () => {
  const r = parsePhone('+7 (495) 248-44-40')
  assert.equal(r.value, '+7 (495) 248-44-40')
  assert.equal(r.warning, undefined)
})

check('телефон: мусор сохраняется, но помечается', () => {
  // Терять контакт хуже, чем хранить его неаккуратным.
  const withLetters = parsePhone('8 (925) abc-12-34')
  assert.ok(withLetters.warning, 'ожидалось предупреждение')
  assert.equal(withLetters.value, '8 (925) abc-12-34')

  const tooShort = parsePhone('+7')
  assert.ok(tooShort.warning)
})

// --- Ключ дедупликации -----------------------------------------------------

check('дедуп: кавычки и орг-форма не мешают найти дубль', () => {
  // Ровно этот случай — записи c_9000xx в review.csv.
  const a = buildDedupKey('АО «Флагман Лаб»', 'Пермь', 'ул. Южная, д. 113')
  const b = buildDedupKey('АО Флагман Лаб', 'Пермь', 'ул. Южная, д. 113')
  assert.equal(a, b)
})

check('дедуп: разные компании не склеиваются', () => {
  const a = buildDedupKey('ООО «Сфера»', 'Москва', 'ул. Ленина, д. 1')
  const b = buildDedupKey('ООО «Сфера»', 'Казань', 'ул. Ленина, д. 1')
  const c = buildDedupKey('ООО «Сфера»', 'Москва', 'ул. Ленина, д. 2')
  assert.notEqual(a, b, 'разные города склеились')
  assert.notEqual(a, c, 'разные адреса склеились')
})

check('дедуп: пустое имя даёт null', () => {
  assert.equal(buildDedupKey(null, 'Москва', 'ул. Ленина'), null)
  assert.equal(buildDedupKey('', 'Москва', 'ул. Ленина'), null)
})

// --- Текст -----------------------------------------------------------------

check('текст: пробелы схлопываются, пустое становится NULL', () => {
  assert.equal(normalizeText('  ООО   Ромашка  ', 'name').value, 'ООО Ромашка')
  assert.equal(normalizeText('   ', 'name').value, null)
  assert.equal(normalizeText(null, 'name').value, null)
})

// --- Итог ------------------------------------------------------------------

console.log(`\nПройдено: ${passed}, провалено: ${failed}`)

if (failed > 0) {
  console.error('Проверки не прошли.')
  process.exit(1)
}

console.log('Все проверки нормализации прошли.')
