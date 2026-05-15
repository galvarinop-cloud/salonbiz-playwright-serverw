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

// Working values from your tests
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
  await inputLocator.page().waitForTimeout(700);
  await inputLocator.page().keyboard.press("ArrowDown");
  await inputLocator.page().keyboard.press("Enter");
}

async function setTextInput(inputLocator, value) {
  await inputLocator.click({ timeout: 15000 });
  await inputLocator.fill(String(value));
}

function splitName(full) {
  const parts = String(full || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const firstName = parts[0] || "";
  const lastName = parts.slice(1).join(" ") || "";
  return { firstName, lastName };
}

async function selectExistingClient(page, query) {
  const clientSearch = page
    .locator("sbiz-book-right-panel")
    .locator('input[placeholder="Search by name or contact"]')
    .first();

  await clientSearch.waitFor({ state: "visible", timeout: 15000 });
  await typeaheadSelect(clientSearch, query);
}

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

async function createNewClientInModal(page, { customerName, customerPhone, customerEmail }) {
  const modal = page.locator("ngb-modal-window").first();
  await modal.waitFor({ state: "visible", timeout: 20000 });

  const { firstName, lastName } = splitName(customerName);
  if (!firstName || !lastName) {
    throw new Error("customerName must include first and last name for new client creation");
  }

  await setTextInput(modal.locator('input[formcontrolname="firstName"]').first(), firstName);
  await setTextInput(modal.locator('input[formcontrolname="lastName"]').first(), lastName);
  await setTextInput(modal.locator('input[formcontrolname="telMobile"]').first(), customerPhone);

  if (customerEmail) {
    await setTextInput(modal.locator('input[formcontrolname="email"]').first(), customerEmail);
  }

  await modal.locator('button[type="submit"]:has-text("Create")').first().click({ timeout: 15000 });
  await modal.waitFor({ state: "hidden", timeout: 20000 });
  await page.waitForTimeout(800);
}

async function clickFinalAppointmentCreate(page) {
  const panel = page.locator("sbiz-book-right-panel");

  const candidates = [
    panel.locator('.sbiz-btn--primary:has-text("Create")'),
    panel.locator('button.sbiz-btn--primary:has-text("Create")'),
    panel.locator('button[type="submit"]:has-text("Create")'),
    panel.locator('button:has-text("Create")')
  ];

  for (const loc of candidates) {
    const count = await loc.count().catch(() => 0);
    if (count > 0) {
      const btn = loc.last();
      const visible = await btn.isVisible().catch(() => false);
      if (visible) {
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

// ---- core booking runner (used by /book and debug routes) ----
async function runBooking(page, {
  isNewClient,
  customerName,
  customerPhone,
  customerEmail,
  service,
  stylist,
  startTime,
  customDuration,
  requestReason
}) {
  await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  await ensureCreatePanelOpen(page);

  if (isNewClient) {
    await clickClientCreateButton(page);
    await createNewClientInModal(page, { customerName, customerPhone, customerEmail });
  } else {
    await selectExistingClient(page, `${customerName} ${customerPhone}`.trim());
  }

  const panel = page.locator("sbiz-book-right-panel");

  await typeaheadSelect(panel.locator('input[formcontrolname="service"]').first(), service);

  if (stylist) {
    await typeaheadSelect(panel.locator('input[formcontrolname="staff"]').first(), stylist);
  }

  await setTextInput(panel.locator('input[formcontrolname="startTime"]').first(), startTime);
  await setTextInput(panel.locator('input[formcontrolname="customDuration"]').first(), customDuration);

  if (requestReason) {
    await setTextInput(panel.locator('input[formcontrolname="requestReason"]').first(), requestReason);
  }

  await panel
    .evaluate((el) => {
      const scrollable = el.querySelector(".scrollable");
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
    })
    .catch(() => {});

  const clicked = await clickFinalAppointmentCreate(page);
  return { clickedFinalCreate: clicked };
}

// ---- book (Vapi tool webhook) ----
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
    startTime,
    customDuration,
    requestReason
  } = args;

  if (typeof isNewClient !== "boolean")
    return vapiError(res, toolCallId, "isNewClient required (true/false boolean)");
  if (!customerName) return vapiError(res, toolCallId, "customerName required");
  if (!customerPhone) return vapiError(res, toolCallId, "customerPhone required");
  if (!service) return vapiError(res, toolCallId, "service required");
  if (!startTime) return vapiError(res, toolCallId, "startTime required (ex: 2:30 PM)");
  if (!customDuration) return vapiError(res, toolCallId, "customDuration required (ex: 60)");

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

    step = "runBooking";
    const result = await runBooking(page, {
      isNewClient,
      customerName,
      customerPhone,
      customerEmail,
      service,
      stylist,
      startTime,
      customDuration,
      requestReason
    });

    await page.screenshot({ path: "/tmp/appt_after.png", fullPage: true }).catch(() => {});

    if (!result.clickedFinalCreate) {
      await page.screenshot({ path: "/tmp/appt_create_not_found.png", fullPage: true }).catch(() => {});
      return vapiRespond(
        res,
        toolCallId,
        {
          ok: false,
          step,
          error:
            'Could not find/click the FINAL appointment "Create" button. Open /debug/appt_create_not_found.png.',
          debug: "/debug/appt_create_not_found.png"
        },
        500
      );
    }

    return vapiRespond(res, toolCallId, {
      ok: true,
      message: "Submitted appointment create. Verify in SalonBiz.",
      debugScreenshot: "/debug/appt_after.png"
    });
  } catch (e) {
    console.error("BOOK error at step:", step, e);
    await page.screenshot({ path: "/tmp/book_error.png", fullPage: true }).catch(() => {});
    return vapiRespond(
      res,
      toolCallId,
      { ok: false, step, error: e?.message || String(e), debugScreenshot: "/debug/book_error.png" },
      500
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/appt_after.png", (req, res) => res.sendFile("/tmp/appt_after.png"));
app.get("/debug/appt_create_not_found.png", (req, res) =>
  res.sendFile("/tmp/appt_create_not_found.png")
);
app.get("/debug/book_error.png", (req, res) => res.sendFile("/tmp/book_error.png"));

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

  try {
    if (cookiesExpired()) cookieState = null;

    await loginIfNeeded(page);
    await saveCookies(context);

    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    await page.screenshot({ path: "/tmp/create_before.png", fullPage: true });
    const click = await clickPinkCreateButton(page);

    const serviceVisible = await page
      .locator("sbiz-book-right-panel")
      .locator('input[formcontrolname="service"]')
      .first()
      .isVisible()
      .catch(() => false);

    await page.screenshot({ path: "/tmp/create_after.png", fullPage: true });

    return app.response.json.call(res, { ok: true, click, serviceVisible });
  } catch (e) {
    await page.screenshot({ path: "/tmp/create_error.png", fullPage: true }).catch(() => {});
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/create_before.png", (req, res) => res.sendFile("/tmp/create_before.png"));
app.get("/debug/create_after.png", (req, res) => res.sendFile("/tmp/create_after.png"));
app.get("/debug/create_error.png", (req, res) => res.sendFile("/tmp/create_error.png"));

// ---- debug: dump right panel DOM ----
app.get("/debug/create_dom", async (req, res) => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const { context, page } = await getPage(browser);

  try {
    if (cookiesExpired()) cookieState = null;

    await loginIfNeeded(page);
    await saveCookies(context);

    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    await ensureCreatePanelOpen(page);

    await page.screenshot({ path: "/tmp/create_form.png", fullPage: true });

    const panelHtml = await page
      .locator("sbiz-book-right-panel")
      .evaluate((el) => el.innerHTML);

    return res.status(200).json({
      ok: true,
      url: page.url(),
      rightPanelHtmlSnippet: String(panelHtml).slice(0, 180000)
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/create_form.png", (req, res) => res.sendFile("/tmp/create_form.png"));

// ---- debug: capture new client modal DOM ----
app.get("/debug/new_client_dom", async (req, res) => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const { context, page } = await getPage(browser);

  try {
    if (cookiesExpired()) cookieState = null;

    await loginIfNeeded(page);
    await saveCookies(context);

    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    await ensureCreatePanelOpen(page);
    await clickClientCreateButton(page);

    await page.screenshot({ path: "/tmp/new_client.png", fullPage: true });

    const modal = page.locator("ngb-modal-window").first();
    await modal.waitFor({ state: "visible", timeout: 15000 });
    const html = await modal.evaluate((el) => el.innerHTML);

    return res.status(200).json({
      ok: true,
      screenshot: "/debug/new_client.png",
      htmlSnippet: String(html).slice(0, 180000)
    });
  } catch (e) {
    await page.screenshot({ path: "/tmp/new_client_error.png", fullPage: true }).catch(() => {});
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/new_client.png", (req, res) => res.sendFile("/tmp/new_client.png"));
app.get("/debug/new_client_error.png", (req, res) =>
  res.sendFile("/tmp/new_client_error.png")
);

// ---- NEW: debug runner for existing client booking ----
app.get("/debug/run_book_existing", async (req, res) => {
  const customerName = String(req.query.name || "");
  const customerPhone = String(req.query.phone || "");
  const service = String(req.query.service || "");
  const startTime = String(req.query.time || "");
  const customDuration = String(req.query.length || "");
  const stylist = req.query.stylist ? String(req.query.stylist) : undefined;
  const requestReason = req.query.requestReason ? String(req.query.requestReason) : undefined;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const { context, page } = await getPage(browser);

  let step = "start";
  try {
    step = "validate";
    if (!customerName || !customerPhone || !service || !startTime || !customDuration) {
      return res.status(400).json({
        ok: false,
        error:
          "Missing required query params: name, phone, service, time, length"
      });
    }

    step = "login";
    await loginIfNeeded(page);
    await saveCookies(context);

    step = "runBooking";
    const result = await runBooking(page, {
      isNewClient: false,
      customerName,
      customerPhone,
      service,
      stylist,
      startTime,
      customDuration,
      requestReason
    });

    await page.screenshot({ path: "/tmp/debug_run_existing.png", fullPage: true }).catch(() => {});

    return res.status(200).json({
      ok: true,
      step,
      result,
      screenshot: "/debug/debug_run_existing.png"
    });
  } catch (e) {
    await page.screenshot({ path: "/tmp/debug_run_existing_error.png", fullPage: true }).catch(() => {});
    return res.status(500).json({
      ok: false,
      step,
      error: e?.message || String(e),
      screenshot: "/debug/debug_run_existing_error.png"
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/debug_run_existing.png", (req, res) =>
  res.sendFile("/tmp/debug_run_existing.png")
);
app.get("/debug/debug_run_existing_error.png", (req, res) =>
  res.sendFile("/tmp/debug_run_existing_error.png")
);

// ---- NEW: debug runner for new client booking ----
app.get("/debug/run_book_new", async (req, res) => {
  const customerName = String(req.query.name || "");
  const customerPhone = String(req.query.phone || "");
  const customerEmail = req.query.email ? String(req.query.email) : undefined;
  const service = String(req.query.service || "");
  const startTime = String(req.query.time || "");
  const customDuration = String(req.query.length || "");
  const stylist = req.query.stylist ? String(req.query.stylist) : undefined;
  const requestReason = req.query.requestReason ? String(req.query.requestReason) : undefined;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const { context, page } = await getPage(browser);

  let step = "start";
  try {
    step = "validate";
    if (!customerName || !customerPhone || !service || !startTime || !customDuration) {
      return res.status(400).json({
        ok: false,
        error:
          "Missing required query params: name, phone, service, time, length"
      });
    }

    step = "login";
    await loginIfNeeded(page);
    await saveCookies(context);

    step = "runBooking";
    const result = await runBooking(page, {
      isNewClient: true,
      customerName,
      customerPhone,
      customerEmail,
      service,
      stylist,
      startTime,
      customDuration,
      requestReason
    });

    await page.screenshot({ path: "/tmp/debug_run_new.png", fullPage: true }).catch(() => {});

    return res.status(200).json({
      ok: true,
      step,
      result,
      screenshot: "/debug/debug_run_new.png"
    });
  } catch (e) {
    await page.screenshot({ path: "/tmp/debug_run_new_error.png", fullPage: true }).catch(() => {});
    return res.status(500).json({
      ok: false,
      step,
      error: e?.message || String(e),
      screenshot: "/debug/debug_run_new_error.png"
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/debug_run_new.png", (req, res) => res.sendFile("/tmp/debug_run_new.png"));
app.get("/debug/debug_run_new_error.png", (req, res) =>
  res.sendFile("/tmp/debug_run_new_error.png")
);

app.listen(PORT, () => {
  console.log(`SalonBiz Playwright server listening on :${PORT}`);
