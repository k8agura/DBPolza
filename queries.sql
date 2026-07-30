-- ============================================================================
--  Задача 1 — три аналитических запроса по базе компаний.
--
--  Запуск:  npm run queries
--     либо: docker compose exec -T db psql -U polza -d polza -f /queries.sql
--
--  Во всех запросах работаем с представлением companies_full — оно уже
--  раскрывает справочники cities/categories, поэтому JOIN'ы не дублируются.
-- ============================================================================


-- ---------------------------------------------------------------------------
--  1. Топ-5 категорий по числу компаний.
--
--  Компании без категории (category IS NULL) в рейтинг не попадают: строка
--  «категория не указана» — это не категория, и в топе ей делать нечего.
--  Вторичная сортировка по имени даёт стабильный порядок при равенстве счётчиков
--  (иначе Postgres волен вернуть строки в любом порядке, и вывод «плавает»).
-- ---------------------------------------------------------------------------

SELECT
    category                                        AS "Категория",
    count(*)                                        AS "Компаний",
    round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS "Доля, %"
FROM companies_full
WHERE category IS NOT NULL
GROUP BY category
ORDER BY count(*) DESC, category
LIMIT 5;


-- ---------------------------------------------------------------------------
--  2. Средний рейтинг по городам среди компаний с 10+ отзывами.
--
--  Порог в 10 отзывов отсекает шум: компания с одним отзывом на пять звёзд
--  не должна тянуть городской средний вверх наравне с сотней оценок.
--
--  rating IS NOT NULL в условии — существенно. В выгрузке 79 компаний без
--  рейтинга; AVG сам по себе NULL игнорирует, но без явного фильтра счётчик
--  в «Компаний» посчитал бы и их, и средний оказался бы посчитан не по тому
--  множеству, которое показано рядом.
-- ---------------------------------------------------------------------------

SELECT
    city                                    AS "Город",
    count(*)                                AS "Компаний с 10+ отзывами",
    round(avg(rating), 2)                   AS "Средний рейтинг",
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY rating)::numeric, 2)
                                            AS "Медиана",
    sum(reviews_count)                      AS "Всего отзывов"
FROM companies_full
WHERE reviews_count >= 10
  AND rating IS NOT NULL
  AND city IS NOT NULL
GROUP BY city
HAVING count(*) >= 3        -- города с одной-двумя компаниями статистически бессмысленны
ORDER BY avg(rating) DESC, city;


-- ---------------------------------------------------------------------------
--  3. Доля компаний с сайтом по категориям.
--
--  «Сайт есть» = site IS NOT NULL. Загрузчик уже привёл к NULL мусорные
--  значения вида «нет сайта» и «https://» без домена, поэтому здесь достаточно
--  простой проверки — иначе доля была бы завышена.
--
--  FILTER (WHERE ...) вместо count(site): читается однозначнее и не зависит от
--  того, помнит ли читатель, что count(колонка) пропускает NULL.
-- ---------------------------------------------------------------------------

SELECT
    category                                                AS "Категория",
    count(*)                                                AS "Всего компаний",
    count(*) FILTER (WHERE site IS NOT NULL)                AS "С сайтом",
    round(
        100.0 * count(*) FILTER (WHERE site IS NOT NULL) / count(*),
        1
    )                                                       AS "Доля с сайтом, %"
FROM companies_full
WHERE category IS NOT NULL
GROUP BY category
ORDER BY 4 DESC, category;


-- ============================================================================
--  Дополнительно: запросы, которыми собран ANOMALIES.md.
--  Оставлены здесь, чтобы находки можно было перепроверить, а не принимать
--  на веру из текста отчёта.
-- ============================================================================

-- Что и почему не попало в базу.
SELECT
    source_file     AS "Файл",
    reason_code     AS "Код причины",
    count(*)        AS "Строк"
FROM staging_rejects
GROUP BY source_file, reason_code
ORDER BY source_file, count(*) DESC;

-- Какие значения загрузчик поправил на лету.
SELECT
    fix_code        AS "Правка",
    field           AS "Поле",
    count(*)        AS "Случаев",
    min(old_value)  AS "Пример: было",
    min(new_value)  AS "Пример: стало"
FROM load_fixes
GROUP BY fix_code, field
ORDER BY count(*) DESC;

-- Компании, у которых совпадает сайт, — при разных названиях это подозрительно.
SELECT
    lower(site)                     AS "Сайт",
    count(*)                        AS "Компаний",
    string_agg(id, ', ' ORDER BY id) AS "id"
FROM companies
WHERE site IS NOT NULL
GROUP BY lower(site)
HAVING count(*) > 1
ORDER BY count(*) DESC, lower(site);

-- То же по телефонам.
SELECT
    phone_norm                      AS "Телефон",
    count(*)                        AS "Компаний",
    string_agg(id, ', ' ORDER BY id) AS "id"
FROM companies
WHERE phone_norm IS NOT NULL
GROUP BY phone_norm
HAVING count(*) > 1
ORDER BY count(*) DESC, phone_norm;

-- Сводка по запускам загрузчика.
SELECT
    source          AS "Источник",
    rows_read       AS "Прочитано",
    rows_inserted   AS "Вставлено",
    rows_rejected   AS "В карантин",
    notes           AS "Заметки"
FROM load_runs
ORDER BY id;
