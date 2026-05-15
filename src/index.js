import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const SALONBIZ_BASE_URL =
  process.env.SALONBIZ_BASE_URL || "https://central-app.salonbiz.com";
const SALONBIZ_USERNAME = process.env.SALONBIZ_USERNAME;
const SALONBIZ_PASSWORD = process.env.SALONBIZ_PASSWORD;

let cookieState = null;
let cookieStateSetAt = 0;
const COOKIE_TTL_MS = Number(process.env.COOKIE_TTL_MS || 1000 * 60 * 60 * 6);

function requiredEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

async function getPage(browser) {
  const context = await browser.newContext(
    cookieState ? { storageState: cookieState } : undefined
  );
  const page = await context.newPage();
  return { context, page };
}

async function saveCookies(context) {
  cookieState = await context.storageState();
  cookieStateSetAt = Date.now();
}

function cookiesExpired() {
  return !cookieState || Date.now() - cookieStateSetAt > COOKIE_TTL_MS;
}

async function loginIfNeeded(page) {
  requiredEnv("SALONBIZ_USERNAME", SALONBIZ_USERNAME);
  requiredEnv("SALONBIZ_PASSWORD", SALONBIZ_PASSWORD);

  await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, {
    waitUntil: "domcontentloaded"
  });

  const hasLogin =
    (await page.locator('input[type="password"]').count()) > 0;

  if (!hasLogin) return;

  const userInput = page.locator('input[type="text"], input[type="email"]').first();
  const passInput = page.locator('input[type="password"]').first();

  await userInput.fill(SALONBIZ_USERNAME);
  await passInput.fill(SALONBIZ_PASSWORD);

  const loginButton = page
    .getByRole("button", { name: /log in|login|sign in/i })
    .first();

  if ((await loginButton.count()) > 0) {
    await loginButton.click();
  } else {
    await page.keyboard.press("Enter");
  }

  await page.waitForLoadState("domcontentloaded");
}

app.get("/health", async (req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.post("/book", async (req, res) => {
  const {
    client,
    serviceName,
    staffName,
    startIso,
    notes
  } = req.body || {};

  if (!client?.firstName || !client?.lastName || !client?.phone) {
    return res.status(400).json({ error: "client.firstName, client.lastName, client.phone required" });
  }
  if (!serviceName) return res.status(400).json({ error: "serviceName required" });
  if (!staffName) return res.status(400).json({ error: "staffName required" });
  if (!startIso) return res.status(400).json({ error: "startIso required" });

  const browser = await chromium.launch({ headless: true });
  const { context, page } = await getPage(browser);

  try {
    if (cookiesExpired()) cookieState = null;

    await loginIfNeeded(page);

    await saveCookies(context);

    return res.json({
      ok: true,
      message: "Server deployed. Booking automation selectors not finalized yet.",
      received: { client, serviceName, staffName, startIso, notes }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.post("/cancel", async (req, res) => {
  const { clientName, staffName, startIso } = req.body || {};
  if (!clientName) return res.status(400).json({ error: "clientName required" });
  if (!staffName) return res.status(400).json({ error: "staffName required" });
  if (!startIso) return res.status(400).json({ error: "startIso required" });

  const browser = await chromium.launch({ headless: true });
  const { context, page } = await getPage(browser);

  try {
    if (cookiesExpired()) cookieState = null;

    await loginIfNeeded(page);

    await saveCookies(context);

    return res.json({
      ok: true,
      message: "Server deployed. Cancel automation selectors not finalized yet.",
      received: { clientName, staffName, startIso }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`SalonBiz Playwright server listening on :${PORT}`);
});
