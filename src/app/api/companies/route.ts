import { NextResponse } from 'next/server'
import { getCompanies } from '@/lib/companies'

/**
 * GET /api/companies — та же выборка, что и на странице, в виде JSON.
 *
 * Страница /companies рендерится Server Component'ом и в этом обработчике не
 * нуждается. Он добавлен как проверяемая точка входа: результат удобно
 * посмотреть через curl, не открывая браузер (см. раздел «Как проверял»
 * в README).
 *
 * Параметры: ?q=&city=&category=&page=&per_page=
 */

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)

  try {
    const result = await getCompanies({
      search: searchParams.get('q') ?? undefined,
      city: searchParams.get('city') ?? undefined,
      category: searchParams.get('category') ?? undefined,
      page: Number(searchParams.get('page') ?? '1'),
      perPage: Number(searchParams.get('per_page') ?? '25'),
    })

    return NextResponse.json(result)
  } catch (err) {
    // Наружу отдаём общее сообщение: текст ошибки Postgres может содержать
    // строку подключения и структуру таблиц.
    console.error('GET /api/companies:', err)

    return NextResponse.json(
      { error: 'Не удалось получить список компаний' },
      { status: 500 }
    )
  }
}
