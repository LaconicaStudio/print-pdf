// PaveVue PDF render service — a deliberately dumb "HTML/URL in → PDF out"
// microservice. It knows nothing about reports, templates, or pricing: the
// main app composes the final HTML (with a <base href> pointing back at
// itself for js/, photo-cache/ and other relative assets) and POSTs it here.
//
//   POST /render  { html | url, baseUrl?, output?: 'pdf'|'html', waitUntil?, timeout? }
//     → application/pdf bytes (default), or the rendered DOM as text/html
//       when output === 'html' (used by the main app's debug endpoints).
//     baseUrl: origin to serve the HTML under (via request interception) so
//     its relative assets (js/, photo-cache/) resolve same-origin against
//     the main app instead of an opaque about:blank origin.
//   GET  /health  → browser/pool status.
//
// Auth: optional. Set RENDER_TOKEN and requests must carry
// "Authorization: Bearer <token>" (the main app sends RENDER_SERVICE_TOKEN).

const crypto = require('crypto');
const express = require('express');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3002;
const POOL_SIZE = parseInt(process.env.BROWSER_POOL_SIZE, 10) || 4;
const RENDER_TOKEN = process.env.RENDER_TOKEN || '';
const MAX_TIMEOUT = 180000;

const log = (tag, msg) => console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);

// ─── Browser pool ────────────────────────────────────────
let browserInstance = null;
const pagePool = [];      // available pages
const pageQueue = [];     // waiting resolvers

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  log('POOL', `Launching browser with pool of ${POOL_SIZE} pages...`);
  browserInstance = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  browserInstance.on('disconnected', () => {
    log('POOL', 'Browser disconnected, will relaunch on next request');
    browserInstance = null;
    pagePool.length = 0;
  });
  // Pre-warm pages
  for (let i = 0; i < POOL_SIZE; i++) {
    const page = await browserInstance.newPage();
    pagePool.push(page);
  }
  log('POOL', `Browser ready, ${POOL_SIZE} pages warmed up`);
  return browserInstance;
}

async function acquirePage() {
  await getBrowser();
  if (pagePool.length > 0) {
    return pagePool.pop();
  }
  // Wait for a page to be released
  return new Promise(resolve => pageQueue.push(resolve));
}

async function releasePage(page) {
  try {
    // Reset page state for reuse
    await page.goto('about:blank');
  } catch {
    // Page is broken, create a new one
    try { await page.close(); } catch {}
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
    } catch {
      return; // browser dead, will relaunch
    }
  }
  if (pageQueue.length > 0) {
    const resolve = pageQueue.shift();
    resolve(page);
  } else {
    pagePool.push(page);
  }
}

// ─── HTTP API ────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '100mb' }));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    browserConnected: !!(browserInstance && browserInstance.connected),
    poolAvailable: pagePool.length,
    poolWaiting: pageQueue.length,
  });
});

app.post('/render', async (req, res) => {
  if (RENDER_TOKEN) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== RENDER_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  }

  const { html, url, output = 'pdf' } = req.body || {};
  const baseUrl = (req.body.baseUrl || '').replace(/\/$/, '');
  if (!html && !url) {
    return res.status(400).json({ error: 'Missing required field: html or url' });
  }
  if (output !== 'pdf' && output !== 'html') {
    return res.status(400).json({ error: `Invalid output "${output}": expected pdf or html` });
  }
  const waitUntil = ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'].includes(req.body.waitUntil)
    ? req.body.waitUntil : 'networkidle0';
  const timeout = Math.min(parseInt(req.body.timeout, 10) || 60000, MAX_TIMEOUT);

  const t0 = Date.now();
  const desc = url ? `url="${url}"` : `html (${(html.length / 1024).toFixed(0)} KB)`;
  const page = await acquirePage();
  try {
    page.on('pageerror', err => log('RENDER', `PAGE ERROR: ${err.message}`));
    page.on('requestfailed', r => log('RENDER', `REQUEST FAILED: ${r.url()} — ${r.failure()?.errorText}`));

    if (url) {
      await page.goto(url, { waitUntil, timeout });
    } else if (baseUrl) {
      // Root-level path: relative assets resolve against the URL's directory.
      const syntheticUrl = `${baseUrl}/__render-${crypto.randomUUID()}.html`;
      await page.setRequestInterception(true);
      page.on('request', (intercepted) => {
        if (intercepted.isInterceptResolutionHandled()) return;
        if (intercepted.url() === syntheticUrl) {
          intercepted.respond({ status: 200, contentType: 'text/html', body: html });
        } else {
          intercepted.continue();
        }
      });
      await page.goto(syntheticUrl, { waitUntil, timeout });
    } else {
      await page.setContent(html, { waitUntil, timeout });
    }

    if (output === 'html') {
      const rendered = await page.content();
      log('RENDER', `${desc} → html (${(rendered.length / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return res.type('html').send(rendered);
    }

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    log('RENDER', `${desc} → pdf (${(pdf.length / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    res.type('application/pdf').send(Buffer.from(pdf));
  } catch (err) {
    log('RENDER', `FAILED ${desc}: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    page.removeAllListeners('pageerror');
    page.removeAllListeners('request');
    page.removeAllListeners('requestfailed');
    try { await page.setRequestInterception(false); } catch {}
    await releasePage(page);
  }
});

const server = app.listen(PORT, async () => {
  log('SERVER', `PaveVue render service running on http://localhost:${PORT}`);
  try {
    await getBrowser();
  } catch (err) {
    log('SERVER', `Browser pool failed to start: ${err.message}`);
  }
});

process.on('unhandledRejection', (err) => {
  log('SERVER', `UNHANDLED REJECTION: ${err?.message || err}`);
  console.error(err);
});

process.on('SIGTERM', async () => {
  log('SERVER', 'SIGTERM received, shutting down...');
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    log('SERVER', 'Browser closed');
  }
  server.close(() => {
    log('SERVER', 'Server closed');
    process.exit(0);
  });
});
