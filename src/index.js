import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Log every request (helps debugging on Railway)
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

const PORT = process.env.PORT || 3000;

const SALONBIZ_BASE_URL =
  process.env.SALONBIZ_BASE_URL || "https://central-app.salonbiz.com";
const SALONBIZ_USERNAME = process.env.SALONBIZ_USERNAME;
const SALONBIZ_PASSWORD = process.env.SALONBIZ_PASSWORD;

// ---- cookie cache (to avoid logging in on every tool call) ----
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

/**
 * More robust login that works across slightly different SalonBiz login pages.
 * If already logged in, it returns quickly.
 */
async function loginIfNeeded(page) {
  requiredEnv("SALONBIZ_USERNAME", SALONBIZ_USERNAME);
  requiredEnv("SALONBIZ_PASSWORD", SALONBIZ_PASSWORD);

  await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, {
    waitUntil: "domcontentloaded"
  });

  // Let any SPA/login widgets finish loading
  await page.waitForTimeout(1500);

  // If password input doesn't exist, assume we're already logged in
  const passwordCount = await page.locator('input[type="password"]').count();
  if (passwordCount === 0) return;

  // Try common username/email field patterns
  const emailOrUser = page
    .locator(
      'input[type="email"], input[name*="user" i], input[name*="email" i], input[placeholder*="email" i], input[placeholder*="user" i], input[type="text"]'
    )
    .first();

  const passInput = page.locator('input[type="password"]').first();

  await emailOrUser.click({ timeout: 5000 }).catch(() => {});
  await emailOrUser.fill(SALONBIZ_USERNAME);

  await passInput.click({ timeout: 5000 }).catch(() => {});
  await passInput.fill(SALONBIZ_PASSWORD);

  // Click the first visible "login" style button, else submit via Enter
  const loginBtn = page
    .locator(
      'button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), input[type="submit"]'
    )
    .first();

  if ((await loginBtn.count()) > 0) {
    await loginBtn.click({ timeout: 5000 });
  } else {
    await page.keyboard.press("Enter");
  }

  // Give time for redirect/app load
  await page.waitForTimeout(3000);
}

// ---- Vapi tool-call helpers ----
// Vapi Function tool webhooks must respond with:
// { results: [{ toolCallId, result }] }
function extractToolCall(req) {
  return (
    req.body?.message?.toolCallList?.[0] ||
    req.body?.message?.toolCalls?.[0] ||
    null
  );
}

function extractToolCallId(req) {
  const toolCall = extractToolCall(req);
  return toolCall?.id || null;
}

function extractArgs(req) {
  const toolCall = extractToolCall(req);
  const raw = toolCall?.function?.arguments;

  // Sometimes Vapi sends args as an object
  if (raw && typeof raw === "object") return raw;

  // Sometimes args come as a JSON string
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  return {};
}

function vapiRespond(res, toolCallId, result, statusCode = 200) {
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
  return vapiRespond(res, toolCallId, { ok: false, error: message }, statusCode);
}

// ---- basic health ----
app.get("/health", (req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

// ---- Availability tool endpoint ----
app.post("/availability", (req, res) => {
  console.log("AVAILABILITY WEBHOOK BODY:", JSON.stringify(req.body));

  const toolCall = extractToolCall(req);
  const toolCallId = toolCall?.id || null;

  let args = toolCall?.function?.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  } else if (!args || typeof args !== "object") {
    args = {};
  }

  const bookingDateAndTime = args?.bookingDateAndTime;

  // TODO: Replace with real availability logic.
  return vapiRespond(res, toolCallId, {
    ok: true,
    available: true,
    bookingDateAndTime
  });
});

// ---- Book tool endpoint ----
app.post("/book", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);

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
    return vapiError(res, toolCallId, "customerName must include first and last name");
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

    // TODO: implement booking selectors for SalonBiz backoffice.
    // IMPORTANT: return ok:false so the assistant does not claim booking succeeded.
    return vapiRespond(res, toolCallId, {
      ok: false,
      status: "not_implemented",
      message:
        "Booking automation not implemented yet. The system attempted login, but could not complete the booking.",
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
    console.error("BOOK error:", e);
    return vapiRespond(res, toolCallId, { ok: false, error: e?.message || String(e) }, 500);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

// ---- Cancel tool endpoint ----
app.post("/cancel", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);

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

    // TODO: implement cancel selectors for SalonBiz backoffice.
    // IMPORTANT: return ok:false so the assistant does not claim cancel succeeded.
    return vapiRespond(res, toolCallId, {
      ok: false,
      status: "not_implemented",
      message:
        "Cancel automation not implemented yet. The system attempted login, but could not complete the cancellation.",
      mapped: {
        customerName,
        customerPhone: customerPhone || null,
        startIso,
        timezone,
        notes: notes || null
      }
    });
  } catch (e) {
    console.error("CANCEL error:", e);
    return vapiRespond(res, toolCallId, { ok: false, error: e?.message || String(e) }, 500);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

// ---- Debug: one-off screenshot (returns PNG directly) ----
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
      waitUntil: "domcontentloaded"
    });

    const buf = await page.screenshot({ fullPage: true });
    res.setHeader("Content-Type", "image/png");
    return res.status(200).send(buf);
  } catch (e) {
    console.error("DEBUG screenshot error:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

// ---- Debug: persist a screenshot to /tmp and view it via URL ----
app.get("/debug/salonbiz", async (req, res) => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const { context, page } = await getPage(browser);

  try {
    if (cookiesExpired()) cookieState = null;

    await loginIfNeeded(page);
    await saveCookies(context);

    await page.waitForTimeout(1500);
    await page.screenshot({ path: "/tmp/salonbiz.png", fullPage: true });

    return res.status(200).json({
      ok: true,
      message: "Screenshot saved. Open /debug/salonbiz.png to view it."
    });
  } catch (e) {
    console.error("DEBUG /debug/salonbiz error:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/salonbiz.png", (req, res) => {
  return res.sendFile("/tmp/salonbiz.png");
});

// ---- Debug: login before/after screenshots ----
app.get("/debug/login", async (req, res) => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const { context, page } = await getPage(browser);

  try {
    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, {
      waitUntil: "domcontentloaded"
    });

    await page.waitForTimeout(1500);
    await page.screenshot({ path: "/tmp/login_before.png", fullPage: true });

    await loginIfNeeded(page);

    await page.waitForTimeout(2000);
    await page.screenshot({ path: "/tmp/login_after.png", fullPage: true });

    return res.status(200).json({
      ok: true,
      message:
        "Saved /tmp/login_before.png and /tmp/login_after.png. Open /debug/login_before.png and /debug/login_after.png"
    });
  } catch (e) {
    console.error("DEBUG /debug/login error:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/login_before.png", (req, res) => {
  return res.sendFile("/tmp/login_before.png");
});

app.get("/debug/login_after.png", (req, res) => {
  return res.sendFile("/tmp/login_after.png");
});

app.listen(PORT, () => {
  console.log(`SalonBiz Playwright server listening on :${PORT}`);
});
