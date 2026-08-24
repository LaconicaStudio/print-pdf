# print-pdf — PaveVue Render Service

Тупой микросервис «HTML/URL → PDF» на Puppeteer. Не знает ничего про отчёты:
основное приложение само собирает финальный HTML (шаблон + `REPORT_DATA` +
`<base href>` на себя для `js/` и `photo-cache/`) и присылает его сюда.

## API

- `POST /render` — `{ html | url, output?: 'pdf' | 'html', waitUntil?, timeout? }`
  → байты PDF (`application/pdf`), либо отрендеренный DOM (`text/html`)
  при `output: 'html'` (используется debug-endpoint'ами основного приложения).
- `GET /health` — статус браузера и пула страниц.

## Env

| Переменная | Значение |
|---|---|
| `PORT` | порт, по умолчанию 3002 |
| `BROWSER_POOL_SIZE` | размер пула прогретых вкладок, по умолчанию 4 |
| `RENDER_TOKEN` | если задан — требуется `Authorization: Bearer <token>` |
| `PUPPETEER_EXECUTABLE_PATH` | путь до Chromium (в Docker-образе уже задан) |

## Подключение основного приложения

В основном приложении (pdfpavenue) задать:

- `RENDER_SERVICE_URL` — адрес этого сервиса (например `http://render.railway.internal:3002`).
  Не задан → приложение рендерит локально своим Puppeteer, как раньше.
- `RENDER_SERVICE_TOKEN` — тот же токен, что `RENDER_TOKEN` здесь.
- `PUBLIC_BASE_URL` — адрес основного приложения, по которому этот сервис
  сможет забрать ассеты страницы (движок и фото). Внутри Railway лучше
  private-адрес, чтобы не платить за egress.

Откат: убрать `RENDER_SERVICE_URL` и перезапустить основное приложение.

## Локальный запуск

```bash
cd render-service
npm install
node server.js
```
