import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Pool } from 'pg'

/**
 * Единый пул подключений для скриптов загрузки и для Next.js.
 *
 * Пул создаётся лениво — при первом обращении, а не при импорте модуля.
 * Иначе получается ловушка: импорты в ES-модулях выполняются раньше любого
 * кода, поэтому пул успевал создаться до того, как скрипт прочитает .env,
 * и падал с «DATABASE_URL не задан» даже при корректном файле.
 *
 * В dev-режиме Next.js перезагружает модули на каждое изменение файла, поэтому
 * готовый пул кладём в globalThis — иначе на каждый hot-reload создаётся новый
 * пул и Postgres упирается в лимит соединений.
 */

const globalForPg = globalThis as unknown as { _pgPool?: Pool }

/**
 * Минимальный парсер .env — чтобы скрипты работали и без docker compose,
 * который подставляет переменные сам. Тянуть dotenv ради десяти строк не хочется.
 * Next.js читает .env самостоятельно, для него это no-op.
 */
export function loadEnvFile(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8')

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      const eq = trimmed.indexOf('=')
      if (eq === -1) continue

      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')

      // Переменные окружения приоритетнее файла.
      if (process.env[key] === undefined) process.env[key] = value
    }
  } catch {
    // .env может отсутствовать — это норма внутри Docker.
  }
}

function createPool(): Pool {
  loadEnvFile()

  const connectionString = process.env.DATABASE_URL

  if (!connectionString) {
    throw new Error(
      'DATABASE_URL не задан. Скопируй .env.example в .env (см. README).'
    )
  }

  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
}

export function getPool(): Pool {
  if (!globalForPg._pgPool) {
    globalForPg._pgPool = createPool()
  }
  return globalForPg._pgPool
}

/**
 * Прокси поверх ленивого пула: `pool.query(...)` работает как обычно, но
 * подключение создаётся только в момент первого вызова.
 */
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const real = getPool()
    const value = Reflect.get(real, prop, receiver)
    return typeof value === 'function' ? value.bind(real) : value
  },
})

/** Короткий помощник: выполнить запрос и получить только строки. */
export async function query<T>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await getPool().query(text, params)
  return res.rows as T[]
}
