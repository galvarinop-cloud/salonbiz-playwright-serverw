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

app.post("/availability", (req, res) => {
  const { bookingDateAndTime } = req.body || {};
  return res.json({
    ok: true,
    available: true,
    bookingDateAndTime
  });
});

});
app.post("/book", async (req, res) => {
  const body = req.body || {};

  // NEW: accept Vapi-style args
  const {
    customerName,
    customerPhone,
    service,
    stylist,
    date,
    time,
    timezone,
    notes,
    email
  } = body;

  // Backward-compatible: also accept old shape
  let { client, serviceName, staffName, startIso } = body;

  // If Vapi-style fields are present, map them
  if (customerName || service || stylist || date || time || timezone) {
    const parts = String(customerName || "").trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] || "Unknown";
    const lastName = parts.slice(1).join(" ") || "Unknown";

    client = {
      firstName,
      lastName,
      phone: customerPhone || ""
      // you can include email if your flow needs it
    };

    serviceName = service;
    staffName = stylist || "Any";

    // Build an ISO string from date+time+timezone
    // NOTE: This assumes `time` like "2 PM" or "14:00".
    // If you standardize time to "HH:mm" it will be more reliable.
    startIso = `${date}T${time}`;
  }

  // Validate (same as before)
  if (!client?.firstName || !client?.lastName) {
    return res.status(400).json({ error: "customerName required (or client.firstName/client.lastName)" });
  }
  if (!serviceName) return res.status(400).json({ error: "service required (or serviceName)" });
  if (!staffName) return res.status(400).json({ error: "stylist required (or staffName)" });
  if (!startIso) return res.status(400).json({ error: "date/time required (or startIso)" });
  if (!timezone) {
    return res.status(400).json({ error: "timezone required (e.g., America/New_York)" });
  }

  const browser = await chromium.launch({ headless: true });
  const { context, page } = await getPage(browser);

  try {
    if (cookiesExpired()) cookieState = null;

    await loginIfNeeded(page);
    await saveCookies(context);

    // TODO: implement real booking here (selectors)
    return res.json({
      ok: true,
      message: "Logged in successfully. Booking automation not implemented yet (selectors needed).",
      mapped: { client, serviceName, staffName, startIso, notes, email, timezone }
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

app.get("/debug/screenshot", async (req, res) => {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await getPage(browser);

  try {
    if (cookiesExpired()) cookieState = null;

    await loginIfNeeded(page);
    await saveCookies(context);

    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, {
      waitUntil: "networkidle"
    });

    const buf = await page.screenshot({ fullPage: true });
    res.setHeader("Content-Type", "image/png");
    return res.status(200).send(buf);
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
