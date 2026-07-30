/**
 * Выполняет queries.sql и печатает результаты в консоль.
 *
 *   npm run queries
 *
 * Скрипт разбивает файл на отдельные запросы и показывает каждый вместе с
 * заголовком-комментарием — так вывод читается без сверки с исходником.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pool } from '../src/lib/db'
import { loadEnv, waitForDb } from './lib'

interface Block {
  title: string
  sql: string
}

/**
 * Режет SQL-файл на блоки «комментарий + запрос».
 *
 * Разделитель — точка с запятой в конце строки. Строковых литералов с ';'
 * в queries.sql нет, поэтому полноценный парсер здесь избыточен.
 */
function splitQueries(raw: string): Block[] {
  const blocks: Block[] = []
  const lines = raw.split(/\r?\n/)

  let comments: string[] = []
  let sql: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()

    // Рамки из дефисов и пустые комментарии в заголовок не берём.
    if (trimmed.startsWith('--')) {
      const text = trimmed.replace(/^--\s?/, '').trim()
      if (text && !/^[-=]+$/.test(text)) comments.push(text)
      continue
    }

    if (trimmed === '') continue

    sql.push(line)

    if (trimmed.endsWith(';')) {
      // Заголовок блока — первая содержательная строка комментария перед ним.
      const title =
        comments.find((c) => /^\d+\./.test(c)) ??
        comments[0] ??
        'Запрос'

      blocks.push({ title, sql: sql.join('\n') })
      comments = []
      sql = []
    }
  }

  return blocks
}

/** Печатает результат запроса простой ASCII-таблицей. */
function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('  (пусто)')
    return
  }

  const columns = Object.keys(rows[0])
  const widths = columns.map((col) =>
    Math.max(
      displayWidth(col),
      ...rows.map((r) => displayWidth(format(r[col])))
    )
  )

  const header = columns
    .map((c, i) => c.padEnd(widths[i]))
    .join('  │  ')
  console.log('  ' + header)
  console.log('  ' + widths.map((w) => '─'.repeat(w)).join('──┼──'))

  for (const row of rows) {
    const line = columns
      .map((c, i) => {
        const v = format(row[c])
        // Числа прижимаем вправо — так столбцы читаются глазами.
        return typeof row[c] === 'number' || /^[\d.,\s]+$/.test(v)
          ? v.padStart(widths[i])
          : v.padEnd(widths[i])
      })
      .join('  │  ')
    console.log('  ' + line)
  }
}

function displayWidth(s: string): number {
  return s.length
}

function format(v: unknown): string {
  if (v === null || v === undefined) return '—'
  return String(v)
}

async function main(): Promise<void> {
  loadEnv()
  await waitForDb()

  const raw = readFileSync(resolve(process.cwd(), 'queries.sql'), 'utf8')
  const blocks = splitQueries(raw)

  for (const [i, block] of blocks.entries()) {
    console.log(`\n${'═'.repeat(78)}`)
    console.log(`Запрос ${i + 1}. ${block.title}`)
    console.log('═'.repeat(78))

    const res = await pool.query(block.sql)
    printTable(res.rows as Record<string, unknown>[])
    console.log(`  → строк: ${res.rowCount}`)
  }
}

main()
  .catch((err) => {
    console.error('Ошибка выполнения запросов:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
