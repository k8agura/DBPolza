/**
 * Задача 3: загрузка review.csv — «якобы свежая выгрузка для той же базы».
 *
 *   npm run load:csv
 *
 * Файл заметно грязнее JSON-выгрузки, поэтому загрузчик построен так:
 *   - всё, что можно однозначно починить (кодировка, регистр города,
 *     десятичная запятая, опечатка в схеме URL), чинится и записывается
 *     в load_fixes — правку видно, она не «растворяется» в коде;
 *   - всё, что починить нельзя без домысливания (рейтинг 7.2, отзывы «много»,
 *     пустые строки), уходит в staging_rejects с причиной;
 *   - строки, которые дублируют уже загруженные компании, тоже не пишутся
 *     поверх — они попадают в карантин как DUPLICATE_COMPANY.
 *
 * Ключевое решение: НЕ обновляем существующие записи данными из CSV вслепую.
 * Разбор в ANOMALIES.md показывает, что файл содержит записи с новыми id,
 * дублирующие компании из основной базы, — если бы мы делали UPSERT по id,
 * они бы просто добавились и тихо задвоили базу.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'csv-parse/sync'
import { pool } from '../src/lib/db'
import {
  normalizeText,
  normalizeCity,
  parseRating,
  parseReviewsCount,
  parseSite,
  parsePhone,
  buildDedupKey,
  isKnownCity,
  type Fix,
} from '../src/lib/normalize'
import {
  loadEnv,
  waitForDb,
  dataDir,
  section,
  LookupCache,
  recordReject,
  recordFixes,
  resetJournals,
  startRun,
  finishRun,
  type RunStats,
} from './lib'

const SOURCE = 'review_csv'
const FILE = 'review.csv'

type CsvRow = Record<string, string>

const EXPECTED_COLUMNS = [
  'id',
  'name',
  'category',
  'city',
  'address',
  'rating',
  'reviews_count',
  'site',
  'phone',
]

async function main(): Promise<void> {
  loadEnv()
  await waitForDb()

  const path = join(dataDir(), FILE)
  section(`Задача 3: загрузка ${path}`)

  const raw = readFileSync(path, 'utf8')

  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: false, // пустые строки — тоже находка, их надо увидеть
    relax_column_count: true,
    bom: true,
    trim: false,
  }) as CsvRow[]

  console.log(`Строк в файле (без заголовка): ${rows.length}`)

  const header = Object.keys(rows[0] ?? {})
  const headerMatches =
    header.length === EXPECTED_COLUMNS.length &&
    header.every((h, i) => h === EXPECTED_COLUMNS[i])
  console.log(
    `Набор колонок ${headerMatches ? 'совпадает с JSON-выгрузкой' : 'ОТЛИЧАЕТСЯ: ' + header.join(', ')}`
  )

  const client = await pool.connect()
  const stats: RunStats = { read: rows.length, inserted: 0, updated: 0, rejected: 0 }

  // Счётчики для отчёта.
  const warnings: string[] = []
  let matchedExisting = 0

  try {
    await client.query('BEGIN')

    const runId = await startRun(client, SOURCE)

    // Стираем журналы прошлого прогона по этому файлу — иначе находки
    // накапливаются и отчёт врёт при повторном запуске.
    await resetJournals(client, [FILE])

    // Записи, ранее загруженные из этого же CSV, удаляем перед повторным
    // проходом. Без этого при втором запуске загрузчик сравнивал бы строки
    // файла с их собственными копиями и отправлял всё в карантин как
    // ALREADY_IN_DB. Данные из JSON-выгрузки при этом не трогаем.
    const wiped = await client.query(
      `DELETE FROM companies WHERE source = $1`,
      [SOURCE]
    )
    if ((wiped.rowCount ?? 0) > 0) {
      console.log(
        `Повторный запуск: удалено ${wiped.rowCount} записей предыдущей загрузки CSV.`
      )
    }

    const lookups = new LookupCache(client)

    // Существующие компании: id и ключи дедупликации из уже залитой базы.
    const existingIds = new Set<string>(
      (
        await client.query<{ id: string }>('SELECT id FROM companies')
      ).rows.map((r) => r.id)
    )

    const existingDedup = new Map<string, string>(
      (
        await client.query<{ dedup_key: string; id: string }>(
          'SELECT dedup_key, id FROM companies WHERE dedup_key IS NOT NULL'
        )
      ).rows.map((r) => [r.dedup_key, r.id])
    )

    // Телефоны и сайты уже загруженных компаний — для поиска «скрытых» дублей.
    const existingPhones = new Map<string, string>(
      (
        await client.query<{ phone_norm: string; id: string }>(
          'SELECT phone_norm, id FROM companies WHERE phone_norm IS NOT NULL'
        )
      ).rows.map((r) => [r.phone_norm, r.id])
    )

    const existingSites = new Map<string, string>(
      (
        await client.query<{ site: string; id: string }>(
          'SELECT lower(site) AS site, id FROM companies WHERE site IS NOT NULL'
        )
      ).rows.map((r) => [r.site, r.id])
    )

    const seenInFile = new Set<string>()

    for (const [index, row] of rows.entries()) {
      const rowNo = index + 2 // +1 за заголовок, +1 за нумерацию с единицы
      const fixes: Fix[] = []

      const reject = (code: string, reason: string, id: string | null = null) =>
        recordReject(client, {
          sourceFile: FILE,
          rowNumber: rowNo,
          externalId: id,
          reasonCode: code,
          reason,
          raw: row,
        })

      // --- полностью пустая строка ---
      const hasAnyValue = Object.values(row).some((v) => (v ?? '').trim() !== '')
      if (!hasAnyValue) {
        await reject('EMPTY_ROW', 'строка полностью пустая')
        stats.rejected++
        continue
      }

      // --- id ---
      const idRes = normalizeText(row.id, 'id')
      fixes.push(...idRes.fixes)
      const id = idRes.value

      if (!id) {
        await reject('MISSING_ID', 'нет id')
        stats.rejected++
        continue
      }

      if (!/^c_\d{6}$/.test(id)) {
        await reject('BAD_ID', `id не соответствует формату c_NNNNNN: "${id}"`, id)
        stats.rejected++
        continue
      }

      // --- дубль id внутри самого CSV ---
      if (seenInFile.has(id)) {
        await reject('DUPLICATE_ID_IN_FILE', `id ${id} повторяется внутри review.csv`, id)
        stats.rejected++
        continue
      }
      seenInFile.add(id)

      // --- имя ---
      const nameRes = normalizeText(row.name, 'name')
      fixes.push(...nameRes.fixes)

      if (!nameRes.value) {
        await reject('MISSING_NAME', 'пустое название компании', id)
        stats.rejected++
        continue
      }

      // --- город / категория / адрес ---
      const cityRes = normalizeCity(row.city)
      const catRes = normalizeText(row.category, 'category')
      const addrRes = normalizeText(row.address, 'address')

      fixes.push(...cityRes.fixes, ...catRes.fixes, ...addrRes.fixes)

      // Признак сдвига колонок: в категории лежит название города,
      // а город при этом не распознан.
      const categoryLooksLikeCity =
        catRes.value !== null && isKnownCity(catRes.value)

      if (categoryLooksLikeCity && cityRes.value === null) {
        await reject(
          'COLUMN_SHIFT',
          `похоже на сдвиг колонок: category="${catRes.value}" (это город), ` +
            `city="${row.city}" (это адрес), address пуст`,
          id
        )
        stats.rejected++
        continue
      }

      // --- числа ---
      const ratingRes = parseRating(row.rating)
      const reviewsRes = parseReviewsCount(row.reviews_count)
      fixes.push(...ratingRes.fixes, ...reviewsRes.fixes)

      if (ratingRes.error) {
        await reject('BAD_RATING', ratingRes.error, id)
        stats.rejected++
        continue
      }

      if (reviewsRes.error) {
        await reject('BAD_REVIEWS_COUNT', reviewsRes.error, id)
        stats.rejected++
        continue
      }

      // --- сайт / телефон ---
      const siteRes = parseSite(row.site)
      const phoneRes = parsePhone(row.phone)
      fixes.push(...siteRes.fixes, ...phoneRes.fixes)

      if (siteRes.warning) warnings.push(`${id}: ${siteRes.warning}`)
      if (phoneRes.warning) warnings.push(`${id}: ${phoneRes.warning}`)

      // --- дубли относительно уже загруженной базы ---

      // 1. Тот же id — запись уже есть.
      if (existingIds.has(id)) {
        await reject(
          'ALREADY_IN_DB',
          `компания с id ${id} уже загружена из основной выгрузки`,
          id
        )
        stats.rejected++
        matchedExisting++
        continue
      }

      // 2. Другой id, но та же компания по названию+городу+адресу.
      const dedupKey = buildDedupKey(nameRes.value, cityRes.value, addrRes.value)

      if (dedupKey && existingDedup.has(dedupKey)) {
        await reject(
          'DUPLICATE_COMPANY',
          `дубль компании ${existingDedup.get(dedupKey)} под новым id ` +
            `(совпадают название, город и адрес)`,
          id
        )
        stats.rejected++
        continue
      }

      // 3. Совпадение по контактам при разных названиях — сигнал,
      //    но не повод отбрасывать: телефоны колл-центров бывают общими.
      const phoneNorm = (phoneRes.value ?? '').replace(/\D/g, '')
      if (phoneNorm && existingPhones.has(phoneNorm)) {
        warnings.push(
          `${id}: телефон совпадает с компанией ${existingPhones.get(phoneNorm)}`
        )
      }

      const siteLower = (siteRes.value ?? '').toLowerCase()
      if (siteLower && existingSites.has(siteLower)) {
        warnings.push(
          `${id}: сайт ${siteLower} уже принадлежит компании ${existingSites.get(siteLower)}`
        )
      }

      // --- запись ---
      const cityId = await lookups.cityId(cityRes.value)
      const categoryId = await lookups.categoryId(catRes.value)

      await client.query(
        `INSERT INTO companies
           (id, name, category_id, city_id, address, rating, reviews_count,
            site, phone, dedup_key, source, source_file)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          nameRes.value,
          categoryId,
          cityId,
          addrRes.value,
          ratingRes.value,
          reviewsRes.value ?? 0,
          siteRes.value,
          phoneRes.value,
          dedupKey,
          SOURCE,
          FILE,
        ]
      )

      stats.inserted++
      existingIds.add(id)
      if (dedupKey) existingDedup.set(dedupKey, id)
      if (phoneNorm) existingPhones.set(phoneNorm, id)
      if (siteLower) existingSites.set(siteLower, id)

      if (fixes.length > 0) await recordFixes(client, FILE, id, fixes)
    }

    await finishRun(
      client,
      runId,
      stats,
      `совпало с существующими id: ${matchedExisting}`
    )

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  // --- Итоги ----------------------------------------------------------------

  section('Итог загрузки review.csv')
  console.log(`Прочитано:   ${stats.read}`)
  console.log(`Вставлено:   ${stats.inserted}`)
  console.log(`В карантине: ${stats.rejected}`)

  const { rows: byReason } = await pool.query<{
    reason_code: string
    n: string
  }>(
    `SELECT reason_code, count(*)::text AS n
       FROM staging_rejects
      WHERE source_file = $1
      GROUP BY reason_code ORDER BY 2 DESC`,
    [FILE]
  )

  if (byReason.length > 0) {
    console.log('\nПричины отбраковки:')
    for (const r of byReason) console.log(`  ${r.reason_code}: ${r.n}`)
  }

  const { rows: byFix } = await pool.query<{ fix_code: string; n: string }>(
    `SELECT fix_code, count(*)::text AS n
       FROM load_fixes
      WHERE source_file = $1
      GROUP BY fix_code ORDER BY 2 DESC`,
    [FILE]
  )

  if (byFix.length > 0) {
    console.log('\nПрименённые правки:')
    for (const r of byFix) console.log(`  ${r.fix_code}: ${r.n}`)
  }

  if (warnings.length > 0) {
    console.log(`\nПредупреждения (${warnings.length}):`)
    for (const w of warnings.slice(0, 20)) console.log(`  ${w}`)
    if (warnings.length > 20) console.log(`  … ещё ${warnings.length - 20}`)
  }

  const { rows: total } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM companies'
  )
  console.log(`\nВсего компаний в базе: ${total[0].n}`)
  console.log('\nПодробный разбор находок — в ANOMALIES.md (npm run report).')
}

main()
  .catch((err) => {
    console.error('Ошибка загрузки CSV:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
