import { defineConfig } from 'drizzle-kit'

// `generate` працює без бази — з'єднання потрібне тільки `migrate`, тож
// відсутній URL не має ламати генерацію міграції. DDL іде через session pooler
// (:5432, `MIGRATE_DATABASE_URL`), а не через транзакційний `DATABASE_URL`:
// у transaction mode міграція з кількох statement-ів може роз'їхатись по
// з'єднаннях. Обидва рядки читаються з `.env` у корені (`--env-file` у скрипті).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? '' },
  // `caprail_api` — роль у схемі, яку міграція має створити; ролі Supabase
  // (anon, authenticated, …) уже є і в diff не потрапляють.
  entities: { roles: { provider: 'supabase' } },
  strict: true,
  verbose: true,
})
