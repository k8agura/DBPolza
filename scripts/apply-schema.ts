/**
 * Применяет schema.sql к базе. Идемпотентно: все объекты создаются через
 * IF NOT EXISTS / OR REPLACE, поэтому скрипт можно гонять сколько угодно раз.
 *
 *   npm run db:schema
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pool } from '../src/lib/db'
import { loadEnv, waitForDb, section } from './lib'

async function main(): Promise<void> {
  loadEnv()
  await waitForDb()

  section('Применяю schema.sql')

  const sql = readFileSync(resolve(process.cwd(), 'schema.sql'), 'utf8')
  await pool.query(sql)

  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  )

  console.log('Таблицы:', rows.map((r) => r.table_name).join(', '))
  console.log('Схема применена.')
}

main()
  .catch((err) => {
    console.error('Ошибка применения схемы:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
