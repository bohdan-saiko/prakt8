# Ручна перевірка

Команди для Bash. Cookie-файли містять секрети, не додавайте їх у Git.

```bash
curl -i -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' -H 'X-CSRF-Protection: 1' \
  -d '{"email":"student@example.com","password":"A long student passphrase"}'

curl -i -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -H 'X-CSRF-Protection: 1' \
  -d '{"email":"student@example.com","password":"A long student passphrase"}'
```

Скопіюйте accessToken із JSON у змінну ACCESS локально. Не публікуйте його.

```bash
curl -i http://localhost:3000/api/auth/me -H "Authorization: Bearer $ACCESS"

cp cookies.txt old-cookies.txt
curl -i -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/auth/refresh \
  -H 'X-CSRF-Protection: 1'

# Старий token повторно: 401 і revoke всієї цієї сесії.
curl -i -b old-cookies.txt -X POST http://localhost:3000/api/auth/refresh \
  -H 'X-CSRF-Protection: 1'

# Новий token після replay теж відхиляється.
curl -i -b cookies.txt -X POST http://localhost:3000/api/auth/refresh \
  -H 'X-CSRF-Protection: 1'
```

Для окремої перевірки logout виконайте login знову, потім:

```bash
curl -i -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/auth/logout \
  -H 'X-CSRF-Protection: 1'
```

Очікується 204 без тіла. Старий access теж повертає 401 на /me. Видаліть cookie-файли після роботи.
