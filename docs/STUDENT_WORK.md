# ПР8 — студентська робота

Мета: зрозуміти та перевірити авторизацію через короткочасний access JWT, ротацію refresh token і відкликання сесій.

## Що реалізовано

У початковій заготовці вже були register, login, перевірка пароля через Argon2id, валідація DTO, access JWT, refresh cookie, ротація, захист від replay, logout і захищений `/api/auth/me`.

Студентська частина:

- Валідація login через `LoginDto` та `AuthService.login`, відхилення невідомих полів через ValidationPipe і перевірка issuer/audience JWT через AuthGuard. Приклади ручних HTTP-запитів наведені в `docs/api.http`.
- `GET /api/auth/sessions`: захищений список лише власних сесій із полями `id`, `createdAt`, `expiresAt`, `revokedAt`.
- `SessionCleanupService`: стартове та періодичне очищення. За замовчуванням сесії видаляються через 7 днів після завершення строку; історія токенів видаляється каскадно. Налаштування: `SESSION_RETENTION_DAYS`, `SESSION_CLEANUP_INTERVAL_SECONDS`. Retention потрібно погодити з викладачем.
- Наведені нижче схеми й відповіді на контрольні запитання. Фактичні результати запуску — у [VERIFICATION.md](VERIFICATION.md).

За уточненою вимогою викладача автоматизовані тести прибрано. Валідація login залишається у застосунку: некоректні дані дають 400, а неіснуючий email чи неправильний пароль — однаковий 401 без створення сесії. Ця логіка була в початковій заготовці; її не слід представляти як нову студентську реалізацію.

## Схема login

```mermaid
sequenceDiagram
    participant C as Клієнт
    participant A as NestJS API
    participant D as PostgreSQL
    C->>A: POST /api/auth/login, email/password, CSRF header
    A->>A: Перевірка Origin, DTO та rate limit
    A->>D: Знайти User за нормалізованим email
    D-->>A: User або відсутній
    A->>A: Argon2id verify; dummy hash для відсутнього User
    alt Неправильні credentials
        A-->>C: 401 Invalid email or password
    else Вхід успішний
        A->>A: Згенерувати refresh token і SHA-256 hash
        A->>D: Створити Session та RefreshToken з hash
        A->>A: Підписати access JWT
        A-->>C: 200, access у JSON, refresh в HttpOnly cookie
        C->>A: GET /api/auth/me, Bearer access
        A->>A: Перевірити JWT та claims
        A->>D: Перевірити активність Session
        A-->>C: 200, id/email/createdAt
    end
```

## Схема refresh

```mermaid
sequenceDiagram
    participant C as Клієнт
    participant A as NestJS API
    participant D as PostgreSQL
    C->>A: POST /api/auth/refresh, cookie, CSRF header
    A->>A: Перевірити формат, обчислити SHA-256
    A->>D: Знайти RefreshToken за hash
    alt Невідомий token
        A-->>C: 401, очистити cookie
    else Відомий token
        A->>D: BEGIN; SELECT Session FOR UPDATE
        A->>D: Повторно прочитати token і Session
        alt Session вже відкликана або token зник
            A->>D: COMMIT без змін
            A-->>C: 401, очистити cookie
        else usedAt задано або строк минув
            A->>D: Записати revokedAt
            A->>D: COMMIT
            A-->>C: 401, очистити cookie
        else Token і Session чинні
            A->>D: Старому token встановити usedAt
            A->>D: Зберегти hash нового token
            A->>D: COMMIT
            A-->>C: 200, новий access і нова refresh cookie
        end
    end
```

## Навіщо row lock

`SELECT ... FOR UPDATE` блокує рядок конкретної Session до завершення транзакції. Два refresh однієї сесії не можуть одночасно прийняти один token як невикористаний. Другий запит чекає commit першого, повторно читає token, бачить `usedAt` і відкликає Session. Тому навіть токени з успішної першої відповіді вже не працюють після завершення обох запитів.

Блокується Session, а не лише RefreshToken: так refresh різних токенів цієї сесії та logout узгоджуються через один рядок. Інші сесії працюють незалежно. Guard виконує звичайний SELECT без такого блокування; уже авторизований запит не скасовується заднім числом.

## Відповіді на контрольні запитання

1. **Чому password encryption не замінює hashing?** Шифрування оборотне: за наявності ключа можна відновити пароль. Для входу відновлення не потрібне — достатньо перевірити введений пароль за збереженим hash. Спеціальний повільний алгоритм із випадковою salt ускладнює перебір після викрадення БД. Hash не робить слабкий пароль невразливим до підбору.

2. **Чому для пароля Argon2id, а для випадкового refresh — SHA-256?** Людські паролі передбачувані, тому Argon2id навмисно витрачає час і пам’ять на кожну спробу. Salt дає різні hash однаковим паролям і заважає повторному використанню готових таблиць. Refresh має 256 біт криптографічної випадковості, тому його перебір практично нездійсненний. Швидкого SHA-256 достатньо для пошуку такого токена без зберігання raw значення; для людських паролів він непридатний.

3. **Що таке refresh replay і навіщо usedAt?** Це повторне надсилання токена, який уже використали для ротації. `usedAt` фіксує використання, а збережена історія hash дозволяє впізнати старий token. Сервер відкликає відповідну Session: перестають працювати і новий refresh, і access цієї сесії. Інші сесії не відкликаються. Replay може спричинити як викрадення token, так і помилковий повтор запиту клієнтом.

4. **Чому revoke повинен закомітитися до exception?** Exception усередині callback `$transaction` спричинить rollback і скасує `revokedAt`. Callback має записати відкликання й повернути результат відмови; після commit сервіс кидає `UnauthorizedException`, і клієнт отримує 401.

5. **Чим відрізняються JWT exp і expiresAt Session?** `exp` обмежує дію конкретного access JWT — тут 15 хвилин. `Session.expiresAt` обмежує всю серверну сесію — 7 днів від login. Refresh не переносить завершення сесії. Guard перевіряє обидві межі та `revokedAt`, тому навіть JWT із чинним `exp` не працює після logout або завершення Session.

6. **Чому HttpOnly не замінює CSRF-захист?** HttpOnly забороняє JavaScript читати cookie, але браузер продовжує додавати її до запитів. Для CSRF достатньо спричинити запит, читати cookie не потрібно. Тут застосовуються SameSite=Strict, власний заголовок `X-CSRF-Protection: 1`, перевірка Origin, коли він є, і обмежений CORS. HttpOnly також не усуває можливість шкідливого скрипту на дозволеному сайті виконувати запити від користувача.

7. **Як уникнути одночасних refresh у web-клієнті?** Використати single-flight: один спільний Promise поточного refresh, результату якого чекають усі запити. Після успіху вони використовують новий access, після 401 клієнт очищує access і показує login. Promise скидається у `finally`. Refresh не можна рекурсивно повторювати через той самий retry-перехоплювач; початковий запит слід повторювати не більше одного разу. Для кількох вкладок потрібна координація між ними, наприклад Web Locks і BroadcastChannel. У цій реалізації втрата відповіді та повтор старої cookie вимагають нового login.

## Запуск і ручна перевірка

Команди для PowerShell із кореня проєкту. Налаштуйте `.env` за README; не перезаписуйте вже наявний секрет.

```powershell
docker compose up -d --wait
npm run db:generate
npm run db:deploy
npm run build
npm start
```

У `docs/api.http` виконайте register → login → me → refresh → logout. Збережіть access із відповіді login у змінну `@access`. Для демонстрації replay окремо збережіть стару cookie перед refresh; повтор старої cookie має відкликати всю цю сесію. Команди з cookie-файлами наведені в `docs/CURL.md`.

Перевірте неіснуючий email і неправильний пароль (401), неправильний формат email та зайве поле (400), запит без Bearer (401), POST без CSRF header (403). Окремо покажіть `/sessions` із чинним access та поля hash/usedAt/revokedAt у Prisma Studio. Перевірку issuer/audience можна пояснити на коді `AuthGuard.verifyAsync`: обидва очікувані значення передаються явно.

Rate limit залишається активним. Паролі, cookie й токени не додавайте до скриншотів звіту.
