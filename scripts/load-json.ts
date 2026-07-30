/**
 * Задача 1: загрузка выгрузки page_001.json … page_020.json в Postgres.
 *
 *   npm run load:json
 *
 * Что делает:
 *   1. читает все страницы, сверяет число записей с полем total из ответа API;
 *   2. нормализует поля (см. src/lib/normalize.ts);
 *   3. схлопывает дубли внутри выгрузки — по id и по ключу имя+город+адрес;
 *   4. пишет в companies через UPSERT, чтобы повторный запуск не плодил строк.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pool } from '../src/lib/db'
import {
  normalizeText,
  normalizeCity,
  parseRating,
  parseReviewsCount,
  parseSite,
  parsePhone,
  buildDedupKey,
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

interface RawCompany {
  id?: unknown
  name?: unknown
  category?: unknown
  city?: unknown
  address?: unknown
  rating?: unknown
  reviews_count?: unknown
  site?: unknown
  phone?: unknown
}

interface Page {
  page?: number
  per_page?: number
  total?: number
  items?: RawCompany[]
}

const SOURCE = 'json_pages'

async function main(): Promise<void> {
  loadEnv()
  await waitForDb()

  const dir = dataDir()
  const files = readdirSync(dir)
    .filter((f) => /^page_\d+\.json$/.test(f))
    .sort()

  if (files.length === 0) {
    throw new Error(`В ${dir} не найдено ни одного page_*.json`)
  }

  section(`Задача 1: загрузка ${files.length} страниц из ${dir}`)

  // --- Чтение страниц -------------------------------------------------------

  const rows: { raw: RawCompany; file: string; index: number }[] = []
  let declaredTotal: number | null = null

  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Page
    const items = parsed.items ?? []

    if (declaredTotal === null && typeof parsed.total === 'number') {
      declaredTotal = parsed.total
    }

    items.forEach((raw, i) => rows.push({ raw, file, index: i }))
  }

  console.log(`Прочитано записей: ${rows.length}`)
  if (declaredTotal !== null) {
    const verdict = declaredTotal === rows.length ? 'сходится' : 'РАСХОЖДЕНИЕ'
    console.log(`Поле total в ответе API: ${declaredTotal} — ${verdict}`)
  }

  // --- Загрузка -------------------------------------------------------------

  const client = await pool.connect()
  const stats: RunStats = { read: rows.length, inserted: 0, updated: 0, rejected: 0 }

  try {
    await client.query('BEGIN')

    const runId = await startRun(client, SOURCE)

    // Журналы прошлого прогона по этим же файлам стираем — иначе находки
    // складываются поверх старых и отчёт врёт при повторном запуске.
    await resetJournals(client, files)

    const lookups = new LookupCache(client)

    // id, которые уже встретились в этой выгрузке, — ловим дубли внутри файлов.
    const seenIds = new Set<string>()
    // ключ дедупликации -> id первой встреченной компании.
    const seenDedupKeys = new Map<string, string>()

    for (const { raw, file, index } of rows) {
      const rowNo = index + 1
      const fixes: Fix[] = []

      // --- id ---
      const idRes = normalizeText(raw.id, 'id')
      const id = idRes.value
      fixes.push(...idRes.fixes)

      if (!id || !/^c_\d{6}$/.test(id)) {
        await recordReject(client, {
          sourceFile: file,
          rowNumber: rowNo,
          externalId: id,
          reasonCode: 'BAD_ID',
          reason: `некорректный id: ${JSON.stringify(raw.id)}`,
          raw,
        })
        stats.rejected++
        continue
      }

      // --- имя ---
      const nameRes = normalizeText(raw.name, 'name')
      fixes.push(...nameRes.fixes)

      if (!nameRes.value) {
        await recordReject(client, {
          sourceFile: file,
          rowNumber: rowNo,
          externalId: id,
          reasonCode: 'MISSING_NAME',
          reason: 'пустое название компании',
          raw,
        })
        stats.rejected++
        continue
      }

      // --- остальные поля ---
      const cityRes = normalizeCity(raw.city)
      const catRes = normalizeText(raw.category, 'category')
      const addrRes = normalizeText(raw.address, 'address')
      const ratingRes = parseRating(raw.rating)
      const reviewsRes = parseReviewsCount(raw.reviews_count)
      const siteRes = parseSite(raw.site)
      const phoneRes = parsePhone(raw.phone)

      fixes.push(
        ...cityRes.fixes,
        ...catRes.fixes,
        ...addrRes.fixes,
        ...ratingRes.fixes,
        ...reviewsRes.fixes,
        ...siteRes.fixes,
        ...phoneRes.fixes
      )

      if (ratingRes.error) {
        await recordReject(client, {
          sourceFile: file,
          rowNumber: rowNo,
          externalId: id,
          reasonCode: 'BAD_RATING',
          reason: ratingRes.error,
          raw,
        })
        stats.rejected++
        continue
      }

      if (reviewsRes.error) {
        await recordReject(client, {
          sourceFile: file,
          rowNumber: rowNo,
          externalId: id,
          reasonCode: 'BAD_REVIEWS_COUNT',
          reason: reviewsRes.error,
          raw,
        })
        stats.rejected++
        continue
      }

      // --- дубль по id внутри выгрузки ---
      if (seenIds.has(id)) {
        await recordReject(client, {
          sourceFile: file,
          rowNumber: rowNo,
          externalId: id,
          reasonCode: 'DUPLICATE_ID_IN_SOURCE',
          reason: `id ${id} уже встречался в этой выгрузке (страницы пересекаются)`,
          raw,
        })
        stats.rejected++
        continue
      }
      seenIds.add(id)

      // --- дубль по содержимому (другой id, та же компания) ---
      const dedupKey = buildDedupKey(nameRes.value, cityRes.value, addrRes.value)

      if (dedupKey) {
        const twin = seenDedupKeys.get(dedupKey)
        if (twin && twin !== id) {
          await recordReject(client, {
            sourceFile: file,
            rowNumber: rowNo,
            externalId: id,
            reasonCode: 'DUPLICATE_COMPANY',
            reason: `совпадает с ${twin} по названию+городу+адресу`,
            raw,
          })
          stats.rejected++
          continue
        }
        seenDedupKeys.set(dedupKey, id)
      }

      // --- запись ---
      const cityId = await lookups.cityId(cityRes.value)
      const categoryId = await lookups.categoryId(catRes.value)

      const res = await client.query<{ inserted: boolean }>(
        `INSERT INTO companies
           (id, name, category_id, city_id, address, rating, reviews_count,
            site, phone, dedup_key, source, source_file)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           category_id = EXCLUDED.category_id,
           city_id = EXCLUDED.city_id,
           address = EXCLUDED.address,
           rating = EXCLUDED.rating,
           reviews_count = EXCLUDED.reviews_count,
           site = EXCLUDED.site,
           phone = EXCLUDED.phone,
           dedup_key = EXCLUDED.dedup_key,
           source_file = EXCLUDED.source_file
         RETURNING (xmax = 0) AS inserted`,
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
          file,
        ]
      )

      if (res.rows[0].inserted) stats.inserted++
      else stats.updated++

      if (fixes.length > 0) await recordFixes(client, file, id, fixes)
    }

    await finishRun(
      client,
      runId,
      stats,
      declaredTotal !== null ? `total из API: ${declaredTotal}` : undefined
    )

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  // --- Итоги ----------------------------------------------------------------

  section('Итог загрузки JSON')
  console.log(`Прочитано:   ${stats.read}`)
  console.log(`Вставлено:   ${stats.inserted}`)
  console.log(`Обновлено:   ${stats.updated}`)
  console.log(`В карантине: ${stats.rejected}`)

  const { rows: byReason } = await pool.query<{ reason_code: string; n: string }>(
    `SELECT reason_code, count(*)::text AS n
       FROM staging_rejects
      WHERE source_file LIKE 'page_%'
      GROUP BY reason_code ORDER BY 2 DESC`
  )

  if (byReason.length > 0) {
    console.log('\nПричины отбраковки:')
    for (const r of byReason) console.log(`  ${r.reason_code}: ${r.n}`)
  }

  const { rows: total } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM companies`
  )
  console.log(`\nВсего компаний в базе: ${total[0].n}`)
}

main()
  .catch((err) => {
    console.error('Ошибка загрузки JSON:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
