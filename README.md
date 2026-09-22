# Email Checker — сервис проверки email-списков

Веб-версия скрипта `check_emails.py`: пользователи загружают свой файл,
получают результат (keep/delete), админ пополняет базу известных
недействительных адресов (suppression-list) из bounce-отчётов.

- **Фронтенд:** Next.js → Netlify (бесплатный тариф Starter/Free)
- **Backend + БД:** Supabase (Postgres + Auth + Storage + Edge Functions,
  бесплатный тариф Free)
- **Проверки:** только офлайн — синтаксис, опечатки, disposable-домены,
  suppression-list, MX-запись. **Никакого SMTP/RCPT TO** — по вашему
  явному решению, риска для чьей-либо IP-репутации нет.

---

## 1. Архитектура

```
Пользователь → Netlify (Next.js) → БРАУЗЕР: разбор файла, офлайн-проверки,
                                            SHA-256 хэши (lib/processFile.ts)
                                  → Edge Function 'check-suppression'
                                       (батчами по 2000 хэшей → Postgres)
                                  → Edge Function 'resolve-mx'
                                       (батчами по 3000 уникальных доменов
                                        → Deno.resolveDns)
                                  → БРАУЗЕР: сборка xlsx (SheetJS)
                                  → Storage bucket 'results' (сам пользователь)
                                  → скачивание через signed URL (60 сек)

Админ → Netlify /admin → Storage 'uploads' → Edge Function 'import-bounces'
                                             └─ email → SHA-256 хэш → suppression_entries
```

**Почему тяжёлая работа (парсинг файла, построчные проверки, хэширование)
перенесена в браузер, а не в Edge Function:** у Supabase Edge Functions
(рантайм Deno) есть жёсткий лимит CPU-времени на один запрос. На файлах
до нескольких тысяч строк это было незаметно, но на 100k+ строк функция
упирается в лимит и падает (`CPU time hard limit reached`). У браузера
такого лимита нет — 165 000 строк обрабатываются там за секунды. Сервер
(Edge Functions) остаётся ответственным только за то, что и должно быть
на сервере: доступ к suppression-list (обычные пользователи не видят эту
таблицу напрямую через RLS) и DNS-резолв MX по батчам уникальных доменов.

---

## 2. Деплой Supabase

1. Создайте проект на [supabase.com](https://supabase.com) (бесплатный тариф).
2. Установите Supabase CLI локально: `npm install -g supabase`.
3. Авторизуйтесь и привяжите проект:
   ```
   supabase login
   supabase link --project-ref <ваш-project-ref>
   ```
4. Примените миграции (создаст таблицы, RLS-политики, buckets):
   ```
   supabase db push
   ```
5. Разверните Edge Functions:
   ```
   supabase functions deploy check-suppression
   supabase functions deploy resolve-mx
   supabase functions deploy import-bounces
   supabase functions deploy purge-expired
   ```
6. Задайте секреты для функций (service_role key — **только сюда**, никогда
   в web/):
   ```
   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<из Dashboard -> Settings -> API>
   ```
   `SUPABASE_URL` и `SUPABASE_ANON_KEY` Supabase передаёт функциям
   автоматически, задавать их вручную не нужно.
7. Сделайте себя админом (после первой регистрации через фронтенд):
   ```sql
   update public.profiles set role = 'admin' where id = '<ваш user_id из auth.users>';
   ```
8. Включите Cron Jobs в Dashboard → Database → Cron Jobs для вызова
   `purge-expired` **не реже раза в час** (не раз в сутки — при TTL
   в 1 день редкий запуск даёт данным висеть в базе на сутки-двое
   вместо суток). Пример SQL для Dashboard:
   ```sql
   select cron.schedule('purge-expired-checks', '0 * * * *',
     $$ select public.purge_expired_checks(); select net.http_post(
          url:='https://<project>.functions.supabase.co/purge-expired',
          headers:='{"Authorization": "Bearer <service_role_key>"}'::jsonb); $$);
   ```

---

## 3. Деплой фронтенда на Netlify

1. Залейте проект в свой GitHub-репозиторий.
2. На [netlify.com](https://netlify.com) → Add new site → Import an existing
   project → выберите репозиторий.
3. В настройках сборки (Site settings → Build & deploy → Base directory):
   - **Base directory**: `web`
   - **Build command**: `npm run build`
   - **Publish directory**: Netlify сам подставит нужную для Next.js
     (через встроенный `@netlify/plugin-nextjs` — он подключается
     автоматически, когда Netlify видит Next.js проект, отдельный
     `netlify.toml` для этого не обязателен).
4. Добавьте переменные окружения (Site settings → Environment variables):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`

   Оба значения — из Supabase Dashboard → Project Settings → API.
   **Не добавляйте service_role key на Netlify** — фронтенду он не нужен
   и не должен быть доступен браузеру ни в каком виде.
5. Deploy. Готово — Netlify даёт бесплатный домен `*.netlify.app`.
6. Если Netlify подключён к GitHub (Continuous Deployment включён по
   умолчанию при импорте через Git) — каждый `git push` в основную ветку
   автоматически запускает пересборку и деплой, вручную ничего жать не
   нужно.

---

## 4. Локальная разработка

```
cd web
cp .env.example .env.local   # заполните реальными значениями
npm install
npm run dev
```

---

## 5. Безопасность и персональные данные — что сделано и почему

Список email — это персональные данные. Ниже разбор мер по стадиям
жизненного цикла данных, как вы просили.

### 5.1 Сбор и передача (in transit)
- Netlify и Supabase используют HTTPS/TLS по умолчанию везде — от браузера
  до Storage и Edge Functions. Отдельно настраивать не нужно.
- Файл пользователя загружается напрямую в Supabase Storage из браузера
  (через authenticated-запрос с anon key + RLS), не проходя через
  промежуточный сервер, которому не нужно его видеть.

### 5.2 Авторизация и разграничение доступа
- Supabase Auth — email/пароль (можно добавить magic link или OAuth
  позже без изменения схемы).
- **Row Level Security (RLS) включён на всех таблицах.** Пользователь
  физически не может через API увидеть чужие проверки/результаты —
  это гарантируется на уровне базы, а не только логикой фронтенда.
  Даже если кто-то напишет свой клиент к вашему Supabase API напрямую
  с чужим JWT — ничего чужого не увидит.
- Роль `admin` хранится в отдельной таблице `profiles`, а не в
  JWT/localStorage — назначить её может только SQL-запрос с доступом
  к базе (вы, вручную), это не поле, которое можно подделать с клиента.
- Все обращения к `suppression_entries` (самая чувствительная таблица)
  идут только через Edge Function с `service_role` key — у обычных
  пользователей нет прямого доступа к ней ни на чтение, ни на запись,
  даже теоретического через RLS.

### 5.3 Минимизация данных
- **Suppression-list хранит SHA-256 хэш email, а не сам адрес.**
  Если база когда-либо утечёт, восстановить исходные адреса из хэшей
  невозможно (это классический one-way hash), при этом точное сравнение
  "совпадает / не совпадает" продолжает работать корректно.
- Загруженный пользователем файл удаляется из bucket `uploads` сразу
  после обработки — не хранится "просто на всякий случай".
- И результаты, и метаданные проверки автоматически удаляются через
  **1 день** (`expires_at` в таблице `checks` + Edge Function
  `purge-expired`, вызываемая по расписанию не реже раза в час). Срок
  можно изменить в миграции `0012_short_retention.sql`. Важно: это
  жёсткое удаление — если пользователь не скачал результат в течение
  суток, файл и запись о проверке пропадают безвозвратно.
- Скачивание результата — через **временную signed URL (60 секунд)**,
  а не через постоянную публичную ссылку на файл.

### 5.4 Аудит
- Все действия админа (импорт bounce-отчётов) логируются в
  `admin_audit_log` — кто, когда, сколько адресов добавил. Это не
  персональные данные пользователей сервиса, но обеспечивает
  прослеживаемость изменений в общей базе.

### 5.5 Что нужно сделать вам дополнительно (вне кода)
- **Политика конфиденциальности и условия использования** — юридический
  документ, а не код; нужен, если сервисом будут пользоваться третьи
  лица, особенно из ЕС (GDPR) — у вас как минимум работает 14-дневное
  хранение, это стоит явно прописать пользователю.
- **Договор с Supabase/Netlify как с обработчиками данных** (Data
  Processing Agreement) — у обоих есть готовые DPA, доступные в аккаунте,
  подписываются в пару кликов, если это требуется по вашей юрисдикции.
- **2FA для админского аккаунта** — Supabase Auth поддерживает, включите
  вручную в Dashboard для вашего аккаунта.
- Если объём вырастет и понадобится SMTP-верификация — делать это нужно
  через специализированный платный сервис верификации с отдельным пулом
  IP, не через эту инфраструктуру (см. обсуждение рисков блокировки IP
  в предыдущих итерациях этого проекта).

---

## 6. Структура репозитория

```
supabase/
  migrations/
    0001_init.sql                 — таблицы, RLS, роли, purge-функция
    0002_storage.sql              — buckets + storage policies
    0003_suppression_upsert.sql   — батч-upsert suppression-list
    0004_trap_protection.sql      — флаг is_trap, защита от перезаписи
    0005_client_side_processing.sql — политики для клиентской обработки
                                       (results insert, checks update)
  functions/
    _shared/
      emailUtils.ts              — синтаксис, опечатки, disposable, хэш,
                                     классификация категорий bounce-отчётов
      mxCheck.ts                  — резолв MX через Deno.resolveDns
      parseFile.ts                 — разбор xlsx/csv (для import-bounces;
                                       обычные bounce-отчёты небольшие,
                                       CPU-лимит здесь не проблема)
    check-suppression/index.ts    — батч-сверка хэшей (лёгкая, только БД)
    resolve-mx/index.ts           — батч-резолв MX уникальных доменов
    import-bounces/index.ts       — импорт bounce-отчёта (admin)
    purge-expired/index.ts        — автоочистка просроченных данных
web/
  app/
    page.tsx                      — загрузка файла + история проверок
    login/page.tsx                — вход/регистрация
    admin/page.tsx                 — импорт bounce-отчётов
  lib/
    supabaseClient.ts              — клиент с anon key
    emailUtils.ts                  — офлайн-проверки (копия для браузера)
    parseFile.ts                    — разбор xlsx/csv в браузере
    processFile.ts                  — оркестратор: парсинг → офлайн →
                                       батч-запросы к Edge Functions → сборка
    useUser.ts / useAdmin.ts       — хуки авторизации
```

**Почему `check-emails` (старая тяжёлая функция) удалена:** она пыталась
делать всё за один вызов Edge Function — на больших файлах (100k+ строк)
это упиралось в CPU time limit платформы. См. раздел 1 "Архитектура".

## 7. Ограничения бесплатных тарифов, о которых стоит знать

- **Supabase Free:** проект "засыпает" после 7 дней без запросов (первый
  запрос после паузы будет медленным, дальше нормально); 500 MB БД,
  1 GB Storage, 2 GB egress/мес — для текстовых email-списков этого
  надолго хватит.
- **Netlify Free (Starter):** в отличие от Vercel Hobby, коммерческое
  использование разрешено; лимиты — 100 GB bandwidth/мес, 300 минут
  сборки/мес, 125k вызовов функций/мес (серверные функции здесь не
  критичны — вся тяжёлая работа в Supabase Edge Functions).
- Оба сервиса не гарантируют SLA на бесплатном тарифе — для чего-то
  критичного к аптайму стоит рассматривать платный план после теста.
