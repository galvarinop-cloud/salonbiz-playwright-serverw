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

function cookiesExpired() {
  return !cookieState || Date.now() - cookieStateSetAt > COOKIE_TTL_MS;
}

async function getPage(browser) {
  const context = await browser.newContext(
    cookieState ? { storageState: cookieState } : undefined
  );
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  return { context, page };
}

async function saveCookies(context) {
  cookieState = await context.storageState();
  cookieStateSetAt = Date.now();
}

async function loginIfNeeded(page) {
  requiredEnv("SALONBIZ_USERNAME", SALONBIZ_USERNAME);
  requiredEnv("SALONBIZ_PASSWORD", SALONBIZ_PASSWORD);

  await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, {
    waitUntil: "domcontentloaded"
  });

  const hasLogin = (await page.locator('input[type="password"]').count()) > 0;
  if (!hasLogin) return;

  const userInput = page
    .locator('input[type="text"], input[type="email"]')
    .first();
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

/**
 * Vapi Function tool webhooks must respond with:
 * { results: [{ toolCallId, result }] }
 */
function getToolCallInfo(req) {
  const toolCall =
    req.body?.message?.toolCallList?.[0] ||
    req.body?.message?.toolCalls?.[0] ||
    null;

  const toolCallId = toolCall?.id || null;

  let args = {};
  try {
    const rawArgs = toolCall?.function?.arguments;
    args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs || {};
  } catch {
    args = {};
  }

  return { toolCallId, args };
}

function vapiResult(res, toolCallId, result, statusCode = 200) {
  return res.status(statusCode).json({
    results: [
      {
        toolCallId,
        result
      }
    ]
  });
}

function vapiError(res, toolCallId, message, statusCode = 400) {
  return vapiResult(res, toolCallId, { ok: false, error: message }, statusCode);
}

app.get("/health", async (req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

/**
 * Availability tool: Amare-Hair-salon-Check-Availability
 * Expects args: { bookingDateAndTime: "YYYY-MM-DDTHH:mm:ss" }
 */
app.post("/availability", (req, res) => {
  const { toolCallId, args } = getToolCallInfo(req);

  const bookingDateAndTime =
    args.bookingDateAndTime || req.body?.bookingDateAndTime;

  if (!bookingDateAndTime) {
    return vapiError(res, toolCallId, "bookingDateAndTime required");
  }

  // For now, always return available
  return vapiResult(res, toolCallId, {
    ok: true,
    available: true,
    bookingDateAndTime
  });
});

/**
 * Booking tool: salonbiz_book_appointment
 * Expects Vapi args:
 * { customerName, customerPhone, service, stylist, date, time, timezone, notes?, email? }
 */
app.post("/book", async (req, res) => {
  const { toolCallId, args } = getToolCallInfo(req);

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
  } = args;

  if (!customerName) return vapiError(res, toolCallId, "customerName required");
  if (!service) return vapiError(res, toolCallId, "service required");
  if (!date) return vapiError(res, toolCallId, "date required");
  if (!time) return vapiError(res, toolCallId, "time required");
  if (!timezone) return vapiError(res, toolCallId, "timezone required");

  const parts = String(customerName).trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] || "";
  const lastName = parts.slice(1).join(" ") || "";

  if (!firstName || !lastName) {
    return vapiError(
      res,
      toolCallId,
      "customerName must include first and last name"
    );
  }

  const startIso = `${date}T${time}`;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const { context, page } = await getPage(browser);

  try {
    if (cookiesExpired()) cookieState = null;

    await loginIfNeeded(page);
    await saveCookies(context);

    // TODO: implement real booking selectors.
    // For now, return a successful-shaped response so the assistant flow works.
    return vapiResult(res, toolCallId, {
      ok: true,
      status: "received",
      message:
        "Logged in successfully. Booking automation not implemented yet (selectors needed).",
      mapped: {
        client: { firstName, lastName, phone: customerPhone || "" },
        serviceName: service,
        staffName: stylist || "Any",
        startIso,
        timezone,
        notes: notes || null,
        email: email || null
      }
    });
  } catch (e) {
    return vapiResult(
      res,
      toolCallId,
      { ok: false, error: e?.message || String(e) },
      500
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

/**
 * Cancel tool: salonbiz_cancel_appointment
 * Expects Vapi args:
 * { customerName, customerPhone?, date, time, timezone, notes?, confirmationRequired }
 */
app.post("/cancel", async (req, res) => {
  const { toolCallId, args } = getToolCallInfo(req);

  const {
    customerName,
    customerPhone,
    date,
    time,
    timezone,
    notes,
    confirmationRequired
  } = args;

  if (!confirmationRequired) {
    return vapiError(res, toolCallId, "confirmationRequired must be true");
  }
  if (!customerName) return vapiError(res, toolCallId, "customerName required");
  if (!date) return vapiError(res, toolCallId, "date required");
  if (!time) return vapiError(res, toolCallId, "time required");
  if (!timezone) return vapiError(res, toolCallId, "timezone required");

  const startIso = `${date}T${time}`;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const { context, page } = await getPage(browser);

  try {
    if (cookiesExpired()) cookieState = null;

    await loginIfNeeded(page);
    await saveCookies(context);

    // TODO: implement real cancel selectors.
    return vapiResult(res, toolCallId, {
      ok: true,
      status: "received",
      message:
        "Logged in successfully. Cancel automation not implemented yet (selectors needed).",
      mapped: {
        customerName,
        customerPhone: customerPhone || null,
        startIso,
        timezone,
        notes: notes || null
      }
    });
  } catch (e) {
    return vapiResult(
      res,
      toolCallId,
      { ok: false, error: e?.message || String(e) },
      500
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/screenshot", async (req, res) => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
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
