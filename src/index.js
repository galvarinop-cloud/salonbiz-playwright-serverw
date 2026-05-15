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

// Click tuning via env vars (already working for you)
const CREATE_CLICK_X_PCT = Number(process.env.CREATE_CLICK_X_PCT || 0.95);
const CREATE_CLICK_Y_PCT = Number(process.env.CREATE_CLICK_Y_PCT || 0.11);

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

  await page.waitForTimeout(2000);

  const userSel = 'input[formcontrolname="username"]';
  const passSel = 'input[formcontrolname="password"]';
  const submitSel = 'button[type="submit"]';

  if ((await page.locator(passSel).count()) === 0) return;

  await page.waitForSelector(userSel, { state: "visible", timeout: 15000 });
  await page.waitForSelector(passSel, { state: "visible", timeout: 15000 });

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

async function clickPinkCreateButton(page) {
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  const x = Math.floor(vp.width * CREATE_CLICK_X_PCT);
  const y = Math.floor(vp.height * CREATE_CLICK_Y_PCT);
  await page.mouse.click(x, y);
  await page.waitForTimeout(1200);
  return { x, y, vp, xPct: CREATE_CLICK_X_PCT, yPct: CREATE_CLICK_Y_PCT };
}

async function ensureCreatePanelOpen(page) {
  const serviceInput = page
    .locator("sbiz-book-right-panel")
    .locator('input[formcontrolname="service"]')
    .first();

  const visibleNow = await serviceInput.isVisible().catch(() => false);
  if (visibleNow) return serviceInput;

  await clickPinkCreateButton(page);
  await serviceInput.waitFor({ state: "visible", timeout: 20000 });
  return serviceInput;
}

async function typeaheadSelect(inputLocator, value) {
  await inputLocator.click({ timeout: 15000 });
  await inputLocator.fill("");
  await inputLocator.type(String(value), { delay: 35 });
  await inputLocator.page().waitForTimeout(600);
  await inputLocator.page().keyboard.press("ArrowDown");
  await inputLocator.page().keyboard.press("Enter");
}

async function setTextInput(inputLocator, value) {
  await inputLocator.click({ timeout: 15000 });
  await inputLocator.fill(String(value));
}

async function clickRightPanelCreate(page) {
  // The final submit button is a pink "Create" button on the right panel.
  // Try several robust selectors.
  const candidates = [
    page
      .locator("sbiz-book-right-panel")
      .locator('button:has-text("Create")'),
    page
      .locator("sbiz-book-right-panel")
      .locator('button:has-text("CREATE")'),
    page
      .locator("sbiz-book-right-panel")
      .locator('button.sb-edit-appointment__create-button'),
    page
      .locator("sbiz-book-right-panel")
      .locator('button[class*="create"]'),
    page
      .locator("sbiz-book-right-panel")
      .locator('button[type="submit"]')
  ];

  for (const loc of candidates) {
    if ((await loc.count().catch(() => 0)) > 0) {
      const btn = loc.first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 15000 });
        return true;
      }
    }
  }
  return false;
}

// ---- Vapi webhook helpers ----
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
  return res.status(statusCode).json({ results: [{ toolCallId, result }] });
}
function vapiError(res, toolCallId, message, statusCode = 400) {
  return vapiRespond(res, toolCallId, { ok: false, error: message }, statusCode);
}

// ---- health ----
app.get("/health", (req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

// ---- availability (stub) ----
app.post("/availability", (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);
  return vapiRespond(res, toolCallId, {
    ok: true,
    available: true,
    bookingDateAndTime: args?.bookingDateAndTime || null
  });
});

// ---- book (now actually fills fields + clicks create) ----
app.post("/book", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);

  const {
    customerName,
    customerPhone,
    service,
    stylist,
    date, // YYYY-MM-DD
    time, // HH:MM (24h)
    notes
  } = args;

  if (!customerName) return vapiError(res, toolCallId, "customerName required");
  if (!customerPhone) return vapiError(res, toolCallId, "customerPhone required");
  if (!service) return vapiError(res, toolCallId, "service required");
  if (!date) return vapiError(res, toolCallId, "date required");
  if (!time) return vapiError(res, toolCallId, "time required");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const { context, page } = await getPage(browser);

  let step = "start";
  try {
    if (cookiesExpired()) cookieState = null;

    step = "login";
    await loginIfNeeded(page);
    await saveCookies(context);

    step = "goto appointmentbook";
    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForTimeout(2500);

    step = "open create panel";
    await ensureCreatePanelOpen(page);

    const panel = page.locator("sbiz-book-right-panel");

    step = "client name";
    // These selectors might vary; adjust after we confirm actual formcontrolname values.
    // We try common patterns.
    const firstNameInput = panel.locator('input[formcontrolname="firstName"]').first();
    const lastNameInput = panel.locator('input[formcontrolname="lastName"]').first();
    const phoneInput = panel.locator('input[formcontrolname="phone"]').first();

    const parts = String(customerName).trim().split(/\s+/).filter(Boolean);
    const first = parts[0] || "";
    const last = parts.slice(1).join(" ") || "";

    if (await firstNameInput.count()) await setTextInput(firstNameInput, first);
    if (await lastNameInput.count()) await setTextInput(lastNameInput, last);
    if (await phoneInput.count()) await setTextInput(phoneInput, customerPhone);

    step = "service";
    const serviceInput = panel.locator('input[formcontrolname="service"]').first();
    await serviceInput.waitFor({ state: "visible", timeout: 15000 });
    await typeaheadSelect(serviceInput, service);

    step = "stylist (optional)";
    if (stylist) {
      const staffInput = panel
        .locator('input[formcontrolname="staff"], input[formcontrolname="stylist"]')
        .first();
      if ((await staffInput.count().catch(() => 0)) > 0) {
        await typeaheadSelect(staffInput, stylist);
      }
    }

    step = "start date/time";
    // Common control names; adjust once we confirm.
    const dateInput = panel.locator('input[formcontrolname="date"], input[formcontrolname="startDate"]').first();
    const timeInput = panel.locator('input[formcontrolname="time"], input[formcontrolname="startTime"]').first();

    if ((await dateInput.count().catch(() => 0)) > 0) await setTextInput(dateInput, date);
    if ((await timeInput.count().catch(() => 0)) > 0) await setTextInput(timeInput, time);

    step = "notes (optional)";
    if (notes) {
      const notesInput = panel.locator('textarea[formcontrolname="notes"], textarea').first();
      if ((await notesInput.count().catch(() => 0)) > 0) {
        await setTextInput(notesInput, notes);
      }
    }

    step = "click final create";
    const clicked = await clickRightPanelCreate(page);
    if (!clicked) {
      await page.screenshot({ path: "/tmp/book_error.png", fullPage: true }).catch(() => {});
      throw new Error('Could not find/click the right-panel final "Create" button');
    }

    step = "done screenshot";
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "/tmp/book_after.png", fullPage: true }).catch(() => {});

    return vapiRespond(res, toolCallId, {
      ok: true,
      step,
      message: "Attempted to create appointment. Verify in SalonBiz.",
      debug: {
        screenshots: ["/tmp/book_after.png"]
      }
    });
  } catch (e) {
    console.error("BOOK error at step:", step, e);
    await page.screenshot({ path: "/tmp/book_error.png", fullPage: true }).catch(() => {});
    return vapiRespond(
      res,
      toolCallId,
      { ok: false, step, error: e?.message || String(e) },
      500
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

// ---- cancel (still stub) ----
app.post("/cancel", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  return vapiRespond(res, toolCallId, {
    ok: false,
    status: "not_implemented",
    message: "Cancel not implemented yet."
  });
});

// ---- debug: click create + before/after screenshots ----
app.get("/debug/click_create", async (req, res) => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const { context, page } = await getPage(browser);
  let step = "start";

  try {
    if (cookiesExpired()) cookieState = null;

    step = "login";
    await loginIfNeeded(page);
    await saveCookies(context);

    step = "goto appointmentbook";
    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForTimeout(2500);

    step = "screenshot before";
    await page.screenshot({ path: "/tmp/create_before.png", fullPage: true });

    step = "click pink create";
    const click = await clickPinkCreateButton(page);

    step = "verify service visible";
    const serviceVisible = await page
      .locator("sbiz-book-right-panel")
      .locator('input[formcontrolname="service"]')
      .first()
      .isVisible()
      .catch(() => false);

    step = "screenshot after";
    await page.screenshot({ path: "/tmp/create_after.png", fullPage: true });

    return res.status(200).json({ ok: true, click, serviceVisible });
  } catch (e) {
    console.error("DEBUG click_create error at step:", step, e);
    await page.screenshot({ path: "/tmp/create_error.png", fullPage: true }).catch(() => {});
    return res.status(500).json({ ok: false, step, error: e?.message || String(e) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/create_before.png", (req, res) => res.sendFile("/tmp/create_before.png"));
app.get("/debug/create_after.png", (req, res) => res.sendFile("/tmp/create_after.png"));
app.get("/debug/create_error.png", (req, res) => res.sendFile("/tmp/create_error.png"));

app.listen(PORT, () => {
  console.log(`SalonBiz Playwright server listening on :${PORT}`);
});
