import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

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

/**
 * SalonBiz login.
 * Uses Angular-friendly value setting + input/change events.
 */
async function loginIfNeeded(page) {
  requiredEnv("SALONBIZ_USERNAME", SALONBIZ_USERNAME);
  requiredEnv("SALONBIZ_PASSWORD", SALONBIZ_PASSWORD);

  await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, {
    waitUntil: "domcontentloaded"
  });

  await page.waitForTimeout(2000);

  const userSel = 'input[formcontrolname="username"]';
  const passSel = 'input[formcontrolname="password"]';
  const submitSel = 'button[type="submit"]';

  // If already logged in, password field won't exist
  if ((await page.locator(passSel).count()) === 0) return;

  await page.waitForSelector(userSel, { state: "visible", timeout: 15000 });
  await page.waitForSelector(passSel, { state: "visible", timeout: 15000 });

  // Set values and fire events that Angular listens to
  await page.evaluate(
    ({ userSel, passSel, username, password }) => {
      const user = document.querySelector(userSel);
      const pass = document.querySelector(passSel);
      if (!user || !pass) throw new Error("Login inputs not found");

      const setNative = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        )?.set;
        setter.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      setNative(user, username);
      setNative(pass, password);
    },
    {
      userSel,
      passSel,
      username: String(SALONBIZ_USERNAME),
      password: String(SALONBIZ_PASSWORD)
    }
  );

  await page.click(submitSel);

  await page.waitForTimeout(4000);
}

// ---- Vapi tool-call helpers ----
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

  if (raw && typeof raw === "object") return raw;

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

// ---- health ----
app.get("/health", (req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

// ---- availability ----
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

  return vapiRespond(res, toolCallId, {
    ok: true,
    available: true,
    bookingDateAndTime
  });
});

// ---- book ----
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

    return vapiRespond(res, toolCallId, {
      ok: false,
      status: "not_implemented",
      message:
        "Booking automation not implemented yet. Login should now work; next step is implementing booking selectors.",
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
    return vapiRespond(
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

// ---- cancel ----
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

    return vapiRespond(res, toolCallId, {
      ok: false,
      status: "not_implemented",
      message:
        "Cancel automation not implemented yet. Login should now work; next step is implementing cancel selectors.",
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
    return vapiRespond(
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

// ---- debug: screenshot (returns PNG) ----
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

// ---- debug: persist screenshot to /tmp/salonbiz.png ----
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

// ---- debug: login before/after screenshots ----
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

// ---- debug: dump initial login DOM snippet ----
app.get("/debug/login_dom", async (req, res) => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const { context, page } = await getPage(browser);

  try {
    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, {
      waitUntil: "domcontentloaded"
    });

    await page.waitForTimeout(2000);

    const html = await page.content();

    return res.status(200).json({
      ok: true,
      url: page.url(),
      htmlSnippet: html.slice(0, 60000)
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
