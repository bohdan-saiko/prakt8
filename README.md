# ПР8 — JWT authentication і refresh flow на NestJS

Навчальна заготовка з робочою реалізацією для розбору: NestJS 11, Prisma Client 6.19, PostgreSQL 16. Для роботи потрібні Node.js 22+, npm і Docker Compose або власний PostgreSQL. Версії зафіксовані для відтворення лабораторної, це не заява про їхню актуальність для production.

## Що потрібно зрозуміти

1. Пароль зберігається як Argon2id hash. Під час login виконується verify, а не розшифрування.
2. Access token діє 15 хвилин і передається через `Authorization: Bearer ...`.
3. Refresh token є випадковим 256-бітним значенням. Він не є JWT. Сервер зберігає тільки SHA-256 hash.
4. Кожен login створює окрему Session. Кожне refresh позначає попередній токен використаним і видає новий.
5. Повтор старого токена відкликає всю його Session. Інші сесії користувача залишаються активними.
6. AuthGuard перевіряє JWT і стан Session у БД. Тому logout також блокує ще не прострочений access token.

## Запуск

```bash
npm ci
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Скопіюйте отримане випадкове значення в `JWT_SECRET` у `.env`. Приклад зі словом REPLACE застосунок навмисно відхиляє. `.env` не додавайте в Git.

```bash
docker compose up -d --wait
npm run db:generate
npm run db:deploy
npm run build
npm start
```

API: `http://localhost:3000/api`. `db:deploy` застосовує готову початкову міграцію. Коли самі змінюєте schema, створюйте нову міграцію: `npm run db:migrate -- --name describe_change`.

`npm run start:dev` компілює один раз і запускає Node у watch-режимі для dist. Для автоматичної перекомпіляції відкрийте другий термінал із `npx tsc --watch`. Найпростіше для лабораторної після змін знову виконати `npm run build` і `npm start`.

## Маршрути

| Метод і маршрут | Вхід | Результат |
|---|---|---|
| POST /api/auth/register | email, password | 201, безпечні поля користувача |
| POST /api/auth/login | email, password | 200, access JWT і refresh cookie |
| POST /api/auth/refresh | refresh cookie | 200, новий access і нова cookie |
| POST /api/auth/logout | refresh cookie | 204, revoke сесії та очищення cookie |
| GET /api/auth/me | Bearer access token | 200, id/email/createdAt |
| GET /api/auth/sessions | Bearer access token | 200, сесії поточного користувача: id/createdAt/expiresAt/revokedAt |

У цій заготовці `/me` розташовано під `/api/auth/me`. Якщо завдання вимагає саме `/api/me`, винесіть метод в окремий controller з `@Controller()` і `@Get('me')`.

Усі POST-запити потребують `X-CSRF-Protection: 1`. Коли браузер надсилає Origin, він повинен дорівнювати FRONTEND_ORIGIN. Не вмикайте wildcard CORS з credentials. Відсутня чи неправильна cookie повертає 401. Logout без cookie ідемпотентно повертає 204.

## Порядок розбору файлів

1. `prisma/schema.prisma`: User, Session та RefreshToken. Один User має багато Session, одна Session має історію refresh tokens.
2. `src/auth/dto.ts`: email нормалізується до нижнього регістру. Пароль реєстрації має 15–128 символів. Не обрізайте пробіли пароля.
3. `src/auth/crypto.ts`: Argon2id для пароля, криптографічна випадковість для токена, SHA-256 для його hash.
4. `src/auth/auth.service.ts`: register, login, refresh, logout.
5. `src/auth/auth.controller.ts`: HTTP та cookie. Raw refresh ніколи не повертається в JSON.
6. `src/auth/auth.guard.ts`: підпис, алгоритм, issuer, audience, exp, тип токена, sub, sid, активність сесії.
7. `src/bootstrap.ts`: validation, CORS, CSRF header, Helmet, no-store.
8. `src/auth/session-cleanup.service.ts`: фонове видалення прострочених сесій після retention.
9. `docs/api.http`: запити для ручної перевірки успішного входу та негативних сценаріїв.

## Register і login

Register створює hash через Argon2id з memoryCost 19456 KiB, timeCost 2, parallelism 1. Argon2 генерує випадкову salt сам і включає її в збережений рядок. Email має UNIQUE в БД. Повтор email повертає 409.

Login перевіряє пароль і створює Session із фіксованим строком життя 7 днів. Для неіснуючого email виконується перевірка dummy hash, а повідомлення однакове: Invalid email or password. Це зменшує, але не гарантує усунення, різниць у часі відповіді.

JWT payload містить `sub` користувача, `sid` сесії та `type: access`, а також часові claims, issuer і audience. Пароля або refresh token в JWT немає. JWT підписаний, але його payload не зашифрований.

## Ротація крок за кроком

1. Сервер дістає cookie та перевіряє її формат.
2. Обчислює SHA-256 і знаходить збережений RefreshToken.
3. Починає транзакцію та блокує рядок Session через SELECT FOR UPDATE.
4. Повторно читає token і session всередині транзакції.
5. Якщо usedAt вже є, відкликає Session і повертає результат відмови.
6. Якщо token/session прострочені, відкликає Session.
7. Інакше встановлює usedAt, створює hash нового токена та завершує транзакцію.
8. Після commit видає JWT і нову cookie або повертає 401.

Важливий момент: після запису revokedAt не можна викидати помилку всередині transaction callback, інакше rollback скасує саме відкликання. Тут callback повертає результат, а exception виникає вже після commit.

Термін сесії абсолютний: refresh не подовжує його безкінечно. Історія використаних hash зберігається до завершення сесії для виявлення replay. Невідомий випадковий token не дозволяє знайти й відкликати чужу сесію.

Під час двох паралельних refresh один пройде, другий буде replay та відкличе Session. Навіть токен першої відповіді після цього не працює. Це свідома сувора політика. Клієнт має виконувати refresh через single-flight: тільки один refresh одночасно. Втрата відповіді та повтор того самого запиту також вимагатиме нового login. Grace period тут немає.

## Де зберігати токени на web

Access тримайте в пам’яті застосунку. Refresh браузер отримує через HttpOnly cookie, доступу JavaScript до неї немає. Після перезавантаження сторінки можна викликати refresh й відновити access у пам’яті.

```ts
const response = await fetch('http://localhost:3000/api/auth/refresh', {
  method: 'POST',
  credentials: 'include',
  headers: { 'X-CSRF-Protection': '1' },
});
// Спочатку перевірте response.ok. На 401 очистіть access та покажіть login.
```

Cookie: HttpOnly, SameSite=Strict, Path=/api/auth, Secure у NODE_ENV=production. Локальна HTTP-конфігурація навмисно має Secure=false. Для frontend localhost:5173 та API localhost:3000 схема й hostname однакові, origin різні, site спільний. Не змішуйте localhost і 127.0.0.1. Cross-site deployment потребує окремого дизайну cookie/CSRF, ця заготовка його не реалізує.

## Перевірка вручну

Повна послідовність запитів є у `docs/api.http` (VS Code REST Client) та `docs/CURL.md`. Refresh надсилайте з cookie, `/me` з access JWT. Не вставляйте реальні паролі чи токени у скриншоти звіту.

## Перевірка роботи

За уточненою вимогою викладача робота здається без автоматизованих тестів. Перевірте компіляцію командою `npm run build`, запустіть API через `npm start`, а HTTP-сценарії виконайте вручну через `docs/api.http` або `docs/CURL.md`.

Перевірте правильний login, неіснуючий email, неправильний пароль, некоректні та зайві поля, захищені маршрути, refresh, повтор старої cookie та logout. Очікувані HTTP-статуси наведені в документації. Rate limit залишається активним; якщо отримали 429, зачекайте завершення його вікна.

## Робота студентів

На парі: запустіть проєкт, зареєструйтеся, виконайте login → me → refresh → logout. У Prisma Studio переконайтеся, що немає raw password/token. Відтворіть повтор старої cookie й поясніть, чому нова теж перестала працювати.

Самостійно:
- Перевірте валідацію login: формат email, наявність пароля, відмову для неіснуючого email або неправильного пароля.
- Перевірте відхилення невідомих body-полів та перевірку issuer/audience у JWT.
- Додайте GET /api/auth/sessions із безпечними полями без tokenHash.
- Додайте видалення прострочених сесій фоновою задачею з погодженим retention.
- Намалюйте схему login/refresh і поясніть призначення row lock.

Здати: код, README із командами, результати перевірки збірки і коротку ручну демонстрацію негативних сценаріїв. Кожен студент називає свою частину реалізації. Готовий код потрібно вміти пояснити, а не лише запустити.

### Виконана студентська частина

- Валідація login працює через `LoginDto` та `AuthService.login`: некоректні дані → 400; неіснуючий email або неправильний пароль → однаковий 401. Невідомі body-поля відхиляє ValidationPipe, issuer/audience JWT перевіряє AuthGuard. Приклади ручних запитів наведені в `docs/api.http`.
- Додано захищений `GET /api/auth/sessions`: повертає лише сесії власника access token, включно з відкликаними та простроченими, поки їх не видалено. Поля: `id`, `createdAt`, `expiresAt`, `revokedAt`; дані інших користувачів і tokenHash відсутні.
- `SessionCleanupService` запускається під час старту і далі раз на годину. Політика за замовчуванням: зберігати історію 7 днів після `Session.expiresAt`, потім видаляти Session разом із RefreshToken через каскадний FK. Умова: `expiresAt <= now - retention`. Ранній logout не прискорює видалення історії. Налаштування: `SESSION_RETENTION_DAYS=7` (1–365), `SESSION_CLEANUP_INTERVAL_SECONDS=3600` (1–86400). Політику можна змінити в `.env` відповідно до вимог викладача.
- Очищення не перекривається в одному процесі, помилка журналюється без секретів і повторюється на наступному інтервалі. Під час завершення застосунку таймер зупиняється. Для великої БД потрібні окремі рішення щодо пакетного видалення; тут обсяг навчальний.
- [Схеми login/refresh, row lock та відповіді на контрольні запитання](docs/STUDENT_WORK.md).
- [Результати перевірки збірки та план ручної демонстрації](docs/VERIFICATION.md).

### Запуск у PowerShell (Windows)

Команди використовують порт `5433`, опублікований у `compose.yaml`. У контейнері PostgreSQL працює на `5432`.

```powershell
npm ci
Copy-Item .env.example .env  # лише для першого запуску, якщо .env ще немає
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# Вставте згенероване значення у JWT_SECRET у .env.
docker compose up -d --wait
npm run db:generate
npm run db:deploy
npm run build
npm start
```

Після запуску відкрийте `docs/api.http` у VS Code REST Client або скористайтеся командами `docs/CURL.md`. Окрема база для автоматизованих перевірок не потрібна.

Для перегляду таблиць: `npx prisma studio`. У `User` має бути Argon2id `passwordHash`, у `RefreshToken` — SHA-256 `tokenHash` та `usedAt` після refresh. Перевірте ці значення під час ручної демонстрації.

## Межі заготовки

Це навчальна реалізація, не готова production identity platform. Немає перевірки email, відновлення пароля, MFA та перевірки паролів за списком витоків. Rate limiter зберігає лічильники в пам’яті одного процесу і не є захистом розподіленого deployment. Перед reverse proxy потрібно правильно й обмежено налаштувати trust proxy. Не логувати Authorization, Cookie, Set-Cookie чи body auth запитів.

Перевірка сесії в БД на кожному protected request дає revoke, але додає DB-запит. Уже авторизований запит, що виконується паралельно з logout, не відкочується. Hash refresh обчислюється швидко, бо token має високу ентропію. Для паролів швидкий SHA-256 непридатний.

## Контрольні запитання

1. Чому password encryption не замінює hashing?
2. Чому для пароля Argon2id, а для випадкового refresh — SHA-256?
3. Що таке refresh replay і навіщо зберігати usedAt?
4. Чому revoke повинен закомітитися до exception?
5. Чим відрізняються JWT exp і expiresAt Session?
6. Чому HttpOnly не замінює CSRF-захист?
7. Як уникнути одночасних refresh у web-клієнті?

## Джерела

- https://docs.nestjs.com/security/authentication
- https://docs.nestjs.com/security/encryption-and-hashing
- https://docs.nestjs.com/security/rate-limiting
- https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- https://datatracker.ietf.org/doc/html/rfc9700#section-4.14

Цей застосунок є власним auth flow, а не повним OAuth authorization server. RFC використано як джерело принципу ротації та виявлення повторного використання.
