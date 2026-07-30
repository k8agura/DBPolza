-- ============================================================================
--  Polza Agency — тестовое задание
--  Схема БД для выгрузки компаний (page_*.json) и доп. выгрузки (review.csv)
--
--  Применяется идемпотентно: npm run db:schema (или docker compose run loader)
-- ============================================================================

-- ---------------------------------------------------------------------------
--  Справочники: города и категории вынесены отдельно.
--
--  Зачем: в review.csv города приходят в виде «Москва», «москва», «Москва »,
--  «Moscow», «Санкат-Петербург» и в битой кодировке «РњРѕСЃРєРІР°». Если хранить
--  город строкой в companies, любой GROUP BY по городу молча разъезжается на
--  несколько «Москв». Справочник + канонизация на входе решают это в одном месте.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cities (
    id      SMALLSERIAL PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE          -- каноническое написание: «Москва»
);

CREATE TABLE IF NOT EXISTS categories (
    id      SMALLSERIAL PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE
);

-- ---------------------------------------------------------------------------
--  Основная таблица компаний.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS companies (
    -- Внешний id из выгрузки (c_000001). Натуральный ключ: он стабилен между
    -- страницами и повторными выгрузками, поэтому именно по нему делаем UPSERT.
    id              TEXT PRIMARY KEY
                    CHECK (id ~ '^c_[0-9]{6}$'),

    name            TEXT NOT NULL
                    CHECK (length(btrim(name)) > 0),

    category_id     SMALLINT REFERENCES categories(id),
    city_id         SMALLINT REFERENCES cities(id),

    address         TEXT,

    -- rating NULL — это «рейтинга нет», а не «рейтинг 0». В исходных данных
    -- 79 таких записей, и подменять их нулём означало бы занизить средние.
    rating          NUMERIC(2,1)
                    CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),

    reviews_count   INTEGER NOT NULL DEFAULT 0
                    CHECK (reviews_count >= 0),

    site            TEXT,
    phone           TEXT,

    -- Нормализованный телефон (только цифры) — для поиска дублей по контакту.
    phone_norm      TEXT
                    GENERATED ALWAYS AS (NULLIF(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), '')) STORED,

    -- Ключ дедупликации: имя+город+адрес без регистра, пунктуации и
    -- организационно-правовой формы. Заполняется загрузчиком (нужна одинаковая
    -- логика в TS и SQL, поэтому считаем в одном месте — в коде).
    dedup_key       TEXT,

    -- Происхождение записи: из какого файла приехала и когда.
    source          TEXT NOT NULL DEFAULT 'unknown',
    source_file     TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Индексы -----------------------------------------------------------------

-- Фильтры страницы /companies.
CREATE INDEX IF NOT EXISTS idx_companies_city      ON companies (city_id);
CREATE INDEX IF NOT EXISTS idx_companies_category  ON companies (category_id);

-- Сортировка по рейтингу: NULL-рейтинги в конце и вне индекса.
CREATE INDEX IF NOT EXISTS idx_companies_rating    ON companies (rating DESC NULLS LAST)
    WHERE rating IS NOT NULL;

-- Запрос «средний рейтинг среди компаний с 10+ отзывами» — частичный индекс
-- покрывает ровно этот отбор и не раздувается на «нулевых» компаниях.
CREATE INDEX IF NOT EXISTS idx_companies_reviewed  ON companies (city_id, rating)
    WHERE reviews_count >= 10 AND rating IS NOT NULL;

-- Поиск по названию. pg_trgm даёт быстрый ILIKE '%подстрока%' — обычный btree
-- на таком шаблоне бесполезен.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON companies USING gin (name gin_trgm_ops);

-- Поиск потенциальных дублей.
CREATE INDEX IF NOT EXISTS idx_companies_dedup     ON companies (dedup_key);
CREATE INDEX IF NOT EXISTS idx_companies_phone     ON companies (phone_norm)
    WHERE phone_norm IS NOT NULL;

-- --- Авто-обновление updated_at ----------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_companies_touch ON companies;
CREATE TRIGGER trg_companies_touch
    BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
--  Карантин: строки, которые не прошли валидацию.
--
--  Принцип: загрузчик ничего не выбрасывает молча. Всё, что не поехало в
--  companies, лежит здесь в исходном виде вместе с причиной. Отчёт по
--  аномалиям (ANOMALIES.md) строится SQL-запросом отсюда, а не пересказом
--  логов — это делает находки проверяемыми.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staging_rejects (
    id              BIGSERIAL PRIMARY KEY,
    source_file     TEXT NOT NULL,
    row_number      INTEGER,              -- номер строки в исходном файле
    external_id     TEXT,                 -- id из строки, если он там был
    reason_code     TEXT NOT NULL,        -- машиночитаемый код: DUPLICATE_ID, BAD_RATING, ...
    reason          TEXT NOT NULL,        -- человекочитаемое пояснение
    raw             JSONB NOT NULL,       -- строка как есть
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rejects_reason ON staging_rejects (reason_code);
CREATE INDEX IF NOT EXISTS idx_rejects_file   ON staging_rejects (source_file);

-- ---------------------------------------------------------------------------
--  Журнал правок: строка загружена, но значение по дороге поменяли.
--
--  Отличается от staging_rejects тем, что здесь запись всё-таки попала в
--  companies. Нужен, чтобы «мы починили кодировку/город/рейтинг» не было
--  утверждением на словах: видно поле, старое и новое значение.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS load_fixes (
    id              BIGSERIAL PRIMARY KEY,
    source_file     TEXT NOT NULL,
    external_id     TEXT,
    field           TEXT NOT NULL,
    fix_code        TEXT NOT NULL,        -- MOJIBAKE_FIXED, CITY_CANONICALIZED, ...
    old_value       TEXT,
    new_value       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fixes_code ON load_fixes (fix_code);

-- ---------------------------------------------------------------------------
--  Журнал запусков загрузчика — воспроизводимость и быстрый ответ на вопрос
--  «что именно залилось в прошлый раз».
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS load_runs (
    id              BIGSERIAL PRIMARY KEY,
    source          TEXT NOT NULL,        -- json_pages | review_csv
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    rows_read       INTEGER NOT NULL DEFAULT 0,
    rows_inserted   INTEGER NOT NULL DEFAULT 0,
    rows_updated    INTEGER NOT NULL DEFAULT 0,
    rows_rejected   INTEGER NOT NULL DEFAULT 0,
    notes           TEXT
);

-- ---------------------------------------------------------------------------
--  Удобное представление: компании с раскрытыми справочниками.
--  Используется страницей /companies и queries.sql, чтобы не повторять JOIN'ы.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW companies_full AS
SELECT
    c.id,
    c.name,
    cat.name  AS category,
    ci.name   AS city,
    c.address,
    c.rating,
    c.reviews_count,
    c.site,
    c.phone,
    c.source,
    c.source_file,
    c.created_at,
    c.updated_at
FROM companies c
LEFT JOIN categories cat ON cat.id = c.category_id
LEFT JOIN cities     ci  ON ci.id  = c.city_id;
