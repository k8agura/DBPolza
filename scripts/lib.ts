/**
 * Общая обвязка для скриптов загрузки: подключение к БД, справочники,
 * запись правок/отбраковок, журнал запусков.
 */

import { resolve } from 'node:path'
import type { PoolClient } from 'pg'
import { pool, loadEnvFile } from '../src/lib/db'
import type { Fix } from '../src/lib/normalize'

// ---------------------------------------------------------------------------
//  .env
// ---------------------------------------------------------------------------

/** Реэкспорт: парсер .env живёт рядом с пулом, чтобы порядок вызовов не имел значения. */
export const loadEnv = loadEnvFile

// ---------------------------------------------------------------------------
//  Справочники
// ---------------------------------------------------------------------------

/**
 * Кэш справочников city/category: id по имени.
 * Вставка идёт через ON CONFLICT, поэтому параллельные запуски безопасны.
 */
export class LookupCache {
  private cities = new Map<string, number>()
  private categories = new Map<string, number>()

  constructor(private client: PoolClient) {}

  async cityId(name: string | null): Promise<number | null> {
    return this.lookup('cities', this.cities, name)
  }

  async categoryId(name: string | null): Promise<number | null> {
    return this.lookup('categories', this.categories, name)
  }

  private async lookup(
    table: 'cities' | 'categories',
    cache: Map<string, number>,
    name: string | null
  ): Promise<number | null> {
    if (!name) return null

    const cached = cache.get(name)
    if (cached !== undefined) return cached

    const res = await this.client.query<{ id: number }>(
      `INSERT INTO ${table} (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name]
    )

    const id = res.rows[0].id
    cache.set(name, id)
    return id
  }
}

// ---------------------------------------------------------------------------
//  Журналы
// ---------------------------------------------------------------------------

export interface RejectInput {
  sourceFile: string
  rowNumber: number | null
  externalId: string | null
  reasonCode: string
  reason: string
  raw: unknown
}

export async function recordReject(
  client: PoolClient,
  r: RejectInput
): Promise<void> {
  await client.query(
    `INSERT INTO staging_rejects
       (source_file, row_number, external_id, reason_code, reason, raw)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      r.sourceFile,
      r.rowNumber,
      r.externalId,
      r.reasonCode,
      r.reason,
      JSON.stringify(r.raw),
    ]
  )
}

export async function recordFixes(
  client: PoolClient,
  sourceFile: string,
  externalId: string | null,
  fixes: Fix[]
): Promise<void> {
  for (const f of fixes) {
    await client.query(
      `INSERT INTO load_fixes
         (source_file, external_id, field, fix_code, old_value, new_value)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sourceFile, externalId, f.field, f.code, f.oldValue, f.newValue]
    )
  }
}

export interface RunStats {
  read: number
  inserted: number
  updated: number
  rejected: number
}

export async function startRun(
  client: PoolClient,
  source: string
): Promise<number> {
  const res = await client.query<{ id: number }>(
    `INSERT INTO load_runs (source) VALUES ($1) RETURNING id`,
    [source]
  )
  return res.rows[0].id
}

/**
 * Очищает журналы предыдущего запуска по тем же файлам.
 *
 * Без этого повторный прогон складывает находки поверх старых, и отчёт врёт:
 * после второго запуска ALREADY_IN_DB показывал 196 вместо 6, потому что
 * строки, вставленные в первый раз, во второй уже лежали в базе. Загрузка
 * компаний идемпотентна (UPSERT), журналы должны вести себя так же.
 */
export async function resetJournals(
  client: PoolClient,
  sourceFiles: string[]
): Promise<void> {
  if (sourceFiles.length === 0) return

  await client.query(`DELETE FROM staging_rejects WHERE source_file = ANY($1)`, [
    sourceFiles,
  ])
  await client.query(`DELETE FROM load_fixes WHERE source_file = ANY($1)`, [
    sourceFiles,
  ])
}

export async function finishRun(
  client: PoolClient,
  runId: number,
  stats: RunStats,
  notes?: string
): Promise<void> {
  await client.query(
    `UPDATE load_runs
        SET finished_at = now(),
            rows_read = $2, rows_inserted = $3,
            rows_updated = $4, rows_rejected = $5,
            notes = $6
      WHERE id = $1`,
    [runId, stats.read, stats.inserted, stats.updated, stats.rejected, notes ?? null]
  )
}

// ---------------------------------------------------------------------------
//  Прочее
// ---------------------------------------------------------------------------

export function dataDir(): string {
  return resolve(process.cwd(), process.env.DATA_DIR ?? './data_pack')
}

/** Ждёт готовности Postgres — контейнер БД может подниматься дольше загрузчика. */
export async function waitForDb(attempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (err) {
      if (i === attempts) throw err
      if (i === 1) process.stdout.write('Жду Postgres')
      process.stdout.write('.')
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

export function section(title: string): void {
  console.log(`\n${'─'.repeat(70)}\n${title}\n${'─'.repeat(70)}`)
}
