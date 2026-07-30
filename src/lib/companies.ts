import { query } from './db'

/**
 * Доступ к данным для страницы /companies.
 *
 * Всё выполняется на сервере: модуль импортируется только из Server Component,
 * строка подключения к базе в браузер не попадает.
 */

export interface Company {
  id: string
  name: string
  category: string | null
  city: string | null
  address: string | null
  rating: number | null
  reviews_count: number
  site: string | null
  phone: string | null
}

export interface CompanyFilters {
  search?: string
  city?: string
  category?: string
  page?: number
  perPage?: number
}

export interface CompanyPage {
  items: Company[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export const DEFAULT_PER_PAGE = 25

/**
 * Список компаний с поиском по названию и фильтрами.
 *
 * Условия собираются в массив и склеиваются через AND, значения передаются
 * параметрами ($1, $2, …). Конкатенации пользовательского ввода в SQL нет —
 * иначе поиск по названию превратился бы в точку SQL-инъекции.
 */
export async function getCompanies(
  filters: CompanyFilters = {}
): Promise<CompanyPage> {
  const conditions: string[] = []
  const params: unknown[] = []

  const search = filters.search?.trim()
  if (search) {
    params.push(`%${escapeLike(search)}%`)
    // ILIKE даёт регистронезависимый поиск, GIN-индекс с pg_trgm его ускоряет.
    conditions.push(`name ILIKE $${params.length}`)
  }

  if (filters.city) {
    params.push(filters.city)
    conditions.push(`city = $${params.length}`)
  }

  if (filters.category) {
    params.push(filters.category)
    conditions.push(`category = $${params.length}`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // Считаем общее число совпадений отдельным запросом — нужно для пагинации.
  const countRows = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM companies_full ${where}`,
    params
  )
  const total = Number(countRows[0]?.total ?? 0)

  const perPage = clamp(filters.perPage ?? DEFAULT_PER_PAGE, 1, 100)
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  const page = clamp(filters.page ?? 1, 1, totalPages)
  const offset = (page - 1) * perPage

  params.push(perPage, offset)

  const items = await query<Company>(
    `SELECT id, name, category, city, address, rating, reviews_count, site, phone
       FROM companies_full
       ${where}
      ORDER BY reviews_count DESC, name
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  return { items, total, page, perPage, totalPages }
}

/** Список городов для выпадающего фильтра — только те, где есть компании. */
export async function getCities(): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `SELECT DISTINCT ci.name
       FROM companies c
       JOIN cities ci ON ci.id = c.city_id
      ORDER BY ci.name`
  )
  return rows.map((r) => r.name)
}

export async function getCategories(): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `SELECT DISTINCT cat.name
       FROM companies c
       JOIN categories cat ON cat.id = c.category_id
      ORDER BY cat.name`
  )
  return rows.map((r) => r.name)
}

/**
 * Экранирует спецсимволы LIKE.
 *
 * Без этого поиск по «100%» превращается в «что угодно», а «_» совпадает
 * с любым одиночным символом — пользователь видит непонятную выдачу.
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(Math.trunc(n), min), max)
}
