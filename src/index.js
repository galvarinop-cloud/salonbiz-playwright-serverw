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

// Click tuning via env vars (working values from your tests)
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

/**
 * SalonBiz login (Angular-friendly).
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

/**
 * Select existing client:
 * - Types into the Client search box (placeholder "Search by name or contact")
 * - ArrowDown + Enter to pick the first suggestion
 */
async function selectExistingClient(page, query) {
  const clientSearch = page
    .locator("sbiz-book-right-panel")
    .locator('input[placeholder="Search by name or contact"]')
    .first();

  await clientSearch.waitFor({ state: "visible", timeout: 15000 });
  await typeaheadSelect(clientSearch, query);
}

/**
 * Click the "Create" button next to the client search (to create a new client).
 * This opens a modal/panel we need to inspect and then automate.
 */
async function clickClientCreateButton(page) {
  const btn = page
    .locator("sbiz-book-right-panel")
    .locator("sbiz-search-client")
    .locator('button:has-text("Create")')
    .last();

  await btn.waitFor({ state: "visible", timeout: 15000 });
  await btn.click({ timeout: 15000 });
  await page.waitForTimeout(1200);
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

// ---- book (still WIP; will be upgraded after we map New Client DOM) ----
app.post("/book", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);

  const {
    isNewClient,
    customerName,
    customerPhone,
    customerEmail,
    service,
    stylist,
    startTime, // ex: "2:30 PM" (SalonBiz startTime field seems to accept this)
    customDuration, // ex: "60"
    requestReason,
    notes
  } = args;

  if (isNewClient == null)
    return vapiError(res, toolCallId, "isNewClient required (true/false)");
  if (!customerName) return vapiError(res, toolCallId, "customerName required");
  if (!customerPhone) return vapiError(res, toolCallId, "customerPhone required");
  if (!service) return vapiError(res, toolCallId, "service required");

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

    step = "client";
    if (isNewClient) {
      // We will implement this after we inspect the new-client DOM
      await clickClientCreateButton(page);

      await page.screenshot({ path: "/tmp/new_client_opened.png", fullPage: true }).catch(() => {});
      return vapiRespond(res, toolCallId, {
        ok: false,
        step,
        status: "needs_new_client_dom",
        message:
          "New client creation flow opened, but not automated yet. Run /debug/new_client_dom to capture selectors.",
        debugScreenshot: "/tmp/new_client_opened.png"
      });
    } else {
      // Existing client: search by name or phone (we’ll use name + phone)
      const query = `${customerName} ${customerPhone}`.trim();
      await selectExistingClient(page, query);
    }

    step = "fill service";
    const serviceInput = page
      .locator("sbiz-book-right-panel")
      .locator('input[formcontrolname="service"]')
      .first();
    await typeaheadSelect(serviceInput, service);

    step = "fill staff (optional)";
    if (stylist) {
      const staffInput = page
        .locator("sbiz-book-right-panel")
        .locator('input[formcontrolname="staff"]')
        .first();
      await typeaheadSelect(staffInput, stylist);
    }

    step = "fill startTime (optional)";
    if (startTime) {
      const startInput = page
        .locator("sbiz-book-right-panel")
        .locator('input[formcontrolname="startTime"]')
        .first();
      await setTextInput(startInput, startTime);
    }

    step = "fill customDuration (optional)";
    if (customDuration) {
      const durInput = page
        .locator("sbiz-book-right-panel")
        .locator('input[formcontrolname="customDuration"]')
        .first();
      await setTextInput(durInput, customDuration);
    }

    step = "fill requestReason (optional)";
    if (requestReason) {
      const reqInput = page
        .locator("sbiz-book-right-panel")
        .locator('input[formcontrolname="requestReason"]')
        .first();
      await setTextInput(reqInput, requestReason);
    }

    // Notes isn't in snippet yet; likely below. We'll handle after we confirm.
    if (notes) {
      const notesInput = page
        .locator("sbiz-book-right-panel")
        .locator('textarea[formcontrolname="notes"], textarea')
        .first();
      if ((await notesInput.count().catch(() => 0)) > 0) {
        await setTextInput(notesInput, notes);
      }
    }

    await page.screenshot({ path: "/tmp/book_filled.png", fullPage: true }).catch(() => {});

    return vapiRespond(res, toolCallId, {
      ok: true,
      step,
      status: "filled_fields_only",
      message:
        "Filled client/service/staff/time/length fields. Next step is clicking the final pink Create button and handling notes/confirmation.",
      debugScreenshot: "/tmp/book_filled.png"
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

// ---- cancel (stub) ----
app.post("/cancel", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  return vapiRespond(res, toolCallId, {
    ok: false,
    status: "not_implemented",
    message: "Cancel not implemented yet."
  });
});

// ---- debug: click create ----
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

// ---- debug: dump right panel DOM (already working) ----
app.get("/debug/create_dom", async (req, res) => {
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

    step = "screenshot";
    await page.screenshot({ path: "/tmp/create_form.png", fullPage: true });

    step = "extract right panel html";
    const panelHtml = await page
      .locator("sbiz-book-right-panel")
      .evaluate((el) => el.innerHTML);

    return res.status(200).json({
      ok: true,
      step,
      url: page.url(),
      rightPanelHtmlSnippet: String(panelHtml).slice(0, 180000)
    });
  } catch (e) {
    console.error("DEBUG create_dom error at step:", step, e);
    return res.status(500).json({ ok: false, step, error: e?.message || String(e) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/create_form.png", (req, res) => res.sendFile("/tmp/create_form.png"));

/**
 * NEW: debug route to capture NEW CLIENT modal/panel DOM.
 * Steps:
 * 1) open create panel
 * 2) click Client -> Create
 * 3) screenshot + return HTML of whichever container popped up
 */
app.get("/debug/new_client_dom", async (req, res) => {
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

    step = "click client create";
    await clickClientCreateButton(page);

    step = "screenshot";
    await page.screenshot({ path: "/tmp/new_client.png", fullPage: true });

    // Common patterns for modals in Angular apps:
    const modalCandidates = [
      page.locator("ngb-modal-window").first(),
      page.locator(".modal").first(),
      page.locator(".cdk-overlay-container").first(),
      page.locator("sbiz-book-right-panel").first() // fallback
    ];

    let html = null;
    let matched = null;

    for (const loc of modalCandidates) {
      const count = await loc.count().catch(() => 0);
      if (count > 0) {
        const visible = await loc.isVisible().catch(() => false);
        if (visible) {
          html = await loc.evaluate((el) => el.innerHTML);
          matched = await loc.evaluate((el) => el.tagName + (el.className ? `.${el.className}` : ""));
          break;
        }
      }
    }

    return res.status(200).json({
      ok: true,
      step,
      matchedContainer: matched,
      screenshot: "/debug/new_client.png",
      htmlSnippet: (html || "").slice(0, 180000)
    });
  } catch (e) {
    console.error("DEBUG new_client_dom error at step:", step, e);
    await page.screenshot({ path: "/tmp/new_client_error.png", fullPage: true }).catch(() => {});
    return res.status(500).json({ ok: false, step, error: e?.message || String(e) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/new_client.png", (req, res) => res.sendFile("/tmp/new_client.png"));
app.get("/debug/new_client_error.png", (req, res) =>
  res.sendFile("/tmp/new_client_error.png")
);

app.listen(PORT, () => {
  console.log(`SalonBiz Playwright server listening on :${PORT}`);
});
