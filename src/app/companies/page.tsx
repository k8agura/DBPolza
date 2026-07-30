import Link from 'next/link'
import {
  getCompanies,
  getCities,
  getCategories,
  DEFAULT_PER_PAGE,
} from '@/lib/companies'

/**
 * Страница /companies — таблица компаний с поиском по названию и фильтром
 * по городу.
 *
 * Это Server Component: запрос к Postgres выполняется на сервере, в браузер
 * уходит уже готовая разметка. Строка подключения к базе на клиент не попадает.
 *
 * Фильтры сделаны обычной HTML-формой с method="get" — состояние живёт в URL.
 * Так работает кнопка «назад», ссылку со фильтром можно переслать, и всё это
 * без единой строчки клиентского JS.
 */

// Данные меняются после каждой загрузки, кэшировать выдачу нельзя.
export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{
    q?: string
    city?: string
    category?: string
    page?: string
  }>
}

export default async function CompaniesPage({ searchParams }: PageProps) {
  const params = await searchParams

  const search = params.q ?? ''
  const city = params.city ?? ''
  const category = params.category ?? ''
  const page = Number(params.page ?? '1')

  const [result, cities, categories] = await Promise.all([
    getCompanies({
      search,
      city: city || undefined,
      category: category || undefined,
      page,
      perPage: DEFAULT_PER_PAGE,
    }),
    getCities(),
    getCategories(),
  ])

  const hasFilters = Boolean(search || city || category)

  return (
    <main className="page">
      <header className="page-header">
        <h1 className="page-title">Компании</h1>
        <p className="page-subtitle">
          База из выгрузки API и review.csv. Данные читаются из PostgreSQL
          на сервере.
        </p>
      </header>

      {/* method="get" — состояние фильтров остаётся в адресной строке */}
      <form className="filters" method="get" action="/companies">
        <div className="field field-grow">
          <label htmlFor="q">Поиск по названию</label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={search}
            placeholder="например, Сфера"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor="city">Город</label>
          <select id="city" name="city" defaultValue={city}>
            <option value="">Все города</option>
            {cities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="category">Категория</label>
          <select id="category" name="category" defaultValue={category}>
            <option value="">Все категории</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <button className="btn" type="submit">
          Найти
        </button>

        {hasFilters && (
          <Link className="btn btn-secondary" href="/companies">
            Сбросить
          </Link>
        )}
      </form>

      <p className="result-line">
        Найдено: <strong>{result.total.toLocaleString('ru-RU')}</strong>
        {hasFilters && ' по заданным условиям'}
        {result.total > 0 && (
          <>
            {' '}
            · страница {result.page} из {result.totalPages}
          </>
        )}
      </p>

      {result.items.length === 0 ? (
        <div className="table-wrap">
          <p className="empty">
            Ничего не найдено. Попробуй изменить условия поиска.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Название</th>
                <th>Категория</th>
                <th>Город</th>
                <th className="num">Рейтинг</th>
                <th className="num">Отзывов</th>
                <th>Сайт</th>
                <th>Телефон</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="cell-name">{c.name}</div>
                    {c.address && (
                      <div className="cell-address">{c.address}</div>
                    )}
                  </td>
                  <td>
                    {c.category ? (
                      <span className="badge">{c.category}</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{c.city ?? <span className="muted">—</span>}</td>
                  <td className="num">
                    {c.rating === null ? (
                      <span className="muted">—</span>
                    ) : (
                      Number(c.rating).toFixed(1)
                    )}
                  </td>
                  <td className="num">
                    {c.reviews_count.toLocaleString('ru-RU')}
                  </td>
                  <td>
                    {c.site ? (
                      <a
                        href={c.site}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {c.site.replace(/^https?:\/\//, '')}
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">
                    {c.phone ?? <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result.totalPages > 1 && (
        <Pagination
          page={result.page}
          totalPages={result.totalPages}
          search={search}
          city={city}
          category={category}
        />
      )}
    </main>
  )
}

function Pagination({
  page,
  totalPages,
  search,
  city,
  category,
}: {
  page: number
  totalPages: number
  search: string
  city: string
  category: string
}) {
  const href = (p: number) => {
    const qs = new URLSearchParams()
    if (search) qs.set('q', search)
    if (city) qs.set('city', city)
    if (category) qs.set('category', category)
    if (p > 1) qs.set('page', String(p))
    const s = qs.toString()
    return s ? `/companies?${s}` : '/companies'
  }

  // Показываем не больше пяти номеров вокруг текущей страницы.
  const window = 2
  const from = Math.max(1, page - window)
  const to = Math.min(totalPages, page + window)
  const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i)

  return (
    <nav className="pagination">
      {page > 1 ? (
        <Link href={href(page - 1)}>← Назад</Link>
      ) : (
        <span className="disabled">← Назад</span>
      )}

      {from > 1 && (
        <>
          <Link href={href(1)}>1</Link>
          {from > 2 && <span className="disabled">…</span>}
        </>
      )}

      {numbers.map((n) =>
        n === page ? (
          <span key={n} className="current">
            {n}
          </span>
        ) : (
          <Link key={n} href={href(n)}>
            {n}
          </Link>
        )
      )}

      {to < totalPages && (
        <>
          {to < totalPages - 1 && <span className="disabled">…</span>}
          <Link href={href(totalPages)}>{totalPages}</Link>
        </>
      )}

      {page < totalPages ? (
        <Link href={href(page + 1)}>Вперёд →</Link>
      ) : (
        <span className="disabled">Вперёд →</span>
      )}
    </nav>
  )
}
