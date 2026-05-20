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

// "Pink create" click fallback if panel isn't open
const CREATE_CLICK_X_PCT = Number(process.env.CREATE_CLICK_X_PCT || 0.95);
const CREATE_CLICK_Y_PCT = Number(process.env.CREATE_CLICK_Y_PCT || 0.11);

// TTL for cookies
let cookieState = null;
let cookieStateSetAt = 0;
const COOKIE_TTL_MS = Number(process.env.COOKIE_TTL_MS || 1000 * 60 * 60 * 6);

// Allowlist of phone-bookable services
const PHONE_BOOKABLE_SERVICES_RAW = process.env.PHONE_BOOKABLE_SERVICES || "";
const PHONE_BOOKABLE_SERVICES = new Set(
  PHONE_BOOKABLE_SERVICES_RAW
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean)
);

function requiredEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}
function cookiesExpired() {
  return !cookieState || Date.now() - cookieStateSetAt > COOKIE_TTL_MS;
}
function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}
function formatUsPhoneMaybe(phone) {
  const d = digitsOnly(phone);
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return String(phone || "");
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
function normalizeEmail(raw) {
  if (!raw) return "";
  return String(raw)
    .trim()
    .replace(/\s+/g, "")
    .replace(/\(at\)|\sat\s/gi, "@")
    .replace(/\s?dot\s?/gi, ".")
    .toLowerCase();
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
    waitUntil: "domcontentloaded",
  });

  await page.waitForTimeout(2000);

  const userSel = 'input[formcontrolname="username"]';
  const passSel = 'input[formcontrolname="password"]';
  const submitSel = 'button[type="submit"]';

  // already logged in
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
      password: String(SALONBIZ_PASSWORD),
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
  await inputLocator.type(String(value), { delay: 25 });
  await inputLocator.page().waitForTimeout(600);
  await inputLocator.page().keyboard.press("ArrowDown");
  await inputLocator.page().keyboard.press("Enter");
}

async function setTextInput(inputLocator, value) {
  await inputLocator.click({ timeout: 15000 });
  await inputLocator.fill(String(value));
}

async function readNgbTypeaheadOptions(page) {
  const window = page.locator("ngb-typeahead-window.dropdown-menu.show").first();
  const options = window.locator("button.dropdown-item");
  const count = await options.count().catch(() => 0);
  if (!count) return [];

  const texts = [];
  for (let i = 0; i < count; i++) {
    const t = await options.nth(i).innerText().catch(() => "");
    const cleaned = String(t || "").replace(/\s+/g, " ").trim();
    if (cleaned) texts.push(cleaned);
  }
  return texts;
}

async function scrapeTypeaheadUniverse(inputLocator, page) {
  const queries = [
    ..."abcdefghijklmnopqrstuvwxyz".split(""),
    ..."0123456789".split(""),
  ];

  const all = new Set();

  for (const q of queries) {
    await inputLocator.click();
    await inputLocator.fill("");
    await inputLocator.type(q, { delay: 20 });

    await page.waitForTimeout(450);

    const items = await readNgbTypeaheadOptions(page);
    for (const it of items) all.add(it);

    await page.waitForTimeout(120);
  }

  return Array.from(all).sort((a, b) => a.localeCompare(b));
}

// -------------------- Vapi tool webhook helpers --------------------
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

// -------------------- Booking Job Store (only-confirm-when-done) --------------------
const bookingJobs = new Map(); // jobId -> { status, createdAt, result?, error?, debugScreenshot? }
function newJobId() {
  return `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of bookingJobs.entries()) {
    if (now - job.createdAt > 1000 * 60 * 30) bookingJobs.delete(jobId);
  }
}, 1000 * 60).unref?.();
// -------------------- routes --------------------
app.get("/health", (req, res) =>
  res.json({ ok: true, now: new Date().toISOString() })
);
app.get("/debug/ping", (req, res) => res.json({ ok: true, msg: "pong" }));

/**
 * Vapi tool: list services that are phone-bookable
 * POST /services
 */
app.post("/services", async (req, res) => {
  const toolCallId = extractToolCallId(req);

  if (!PHONE_BOOKABLE_SERVICES.size) {
    return vapiError(
      res,
      toolCallId,
      "PHONE_BOOKABLE_SERVICES env var is empty. Add comma or newline separated service names."
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const { context, page } = await getPage(browser);

  let step = "start";
  try {
    if (cookiesExpired()) cookieState = null;

    step = "login";
    await loginIfNeeded(page);
    await saveCookies(context);

    step = "openPanel";
    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2500);
    const serviceInput = await ensureCreatePanelOpen(page);

    step = "scrapeServices";
    const allServices = await scrapeTypeaheadUniverse(serviceInput, page);

    const phoneBookable = allServices.filter((s) => PHONE_BOOKABLE_SERVICES.has(s));

    return vapiRespond(res, toolCallId, {
      ok: true,
      countAll: allServices.length,
      countPhoneBookable: phoneBookable.length,
      services: phoneBookable,
    });
  } catch (e) {
    console.error("SERVICES error at step:", step, e);
    await page
      .screenshot({ path: "/tmp/services_error.png", fullPage: true })
      .catch(() => {});
    return vapiRespond(
      res,
      toolCallId,
      { ok: false, step, error: e?.message || String(e), debug: "/debug/services_error.png" },
      500
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

/**
 * Vapi tool: list stylists (staff)
 * POST /stylists
 */
app.post("/stylists", async (req, res) => {
  const toolCallId = extractToolCallId(req);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const { context, page } = await getPage(browser);

  let step = "start";
  try {
    if (cookiesExpired()) cookieState = null;

    step = "login";
    await loginIfNeeded(page);
    await saveCookies(context);

    step = "openPanel";
    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await ensureCreatePanelOpen(page);

    step = "scrapeStaff";
    const staffInput = page
      .locator("sbiz-book-right-panel")
      .locator('input[formcontrolname="staff"]')
      .first();
    await staffInput.waitFor({ state: "visible", timeout: 20000 });

    const stylists = await scrapeTypeaheadUniverse(staffInput, page);

    return vapiRespond(res, toolCallId, {
      ok: true,
      count: stylists.length,
      stylists,
    });
  } catch (e) {
    console.error("STYLISTS error at step:", step, e);
    await page
      .screenshot({ path: "/tmp/stylists_error.png", fullPage: true })
      .catch(() => {});
    return vapiRespond(
      res,
      toolCallId,
      { ok: false, step, error: e?.message || String(e), debug: "/debug/stylists_error.png" },
      500
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

// Availability stub (you can keep your real one if you have it)
app.post("/availability", (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);
  return vapiRespond(res, toolCallId, {
    ok: true,
    available: true,
    bookingDateAndTime: args?.bookingDateAndTime || null,
  });
});

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
    await page.screenshot({ path: "/tmp/new_client_missing_lastname.png", fullPage: true }).catch(() => {});
    throw new Error("New client requires first AND last name.");
  }

  const phoneFormatted = formatUsPhoneMaybe(customerPhone);
  const emailNormalized = normalizeEmail(customerEmail);

  await setTextInput(modal.locator('input[formcontrolname="firstName"]').first(), firstName);
  await setTextInput(modal.locator('input[formcontrolname="lastName"]').first(), lastName);
  await setTextInput(modal.locator('input[formcontrolname="telMobile"]').first(), phoneFormatted);
  await setTextInput(modal.locator('input[formcontrolname="email"]').first(), emailNormalized);

  await modal
    .locator('button[type="submit"]:has-text("Create")')
    .first()
    .click({ timeout: 15000 });

  await page.waitForTimeout(1500);

  const stillVisible = await modal.isVisible().catch(() => false);
  if (stillVisible) {
    const alertText = await modal.locator(".sbiz-alert").innerText().catch(() => "");
    await page.screenshot({ path: "/tmp/new_client_submit_failed.png", fullPage: true }).catch(() => {});
    throw new Error(
      `New client modal did not close. SalonBiz error: ${alertText || "(no alert text found)"}`
    );
  }

  await modal.waitFor({ state: "hidden", timeout: 20000 });
  await page.waitForTimeout(800);
}

async function clickFinalAppointmentCreate(page) {
  const panel = page.locator("sbiz-book-right-panel");

  const candidates = [
    panel.locator('.sbiz-btn--primary:has-text("Create")'),
    panel.locator('button.sbiz-btn--primary:has-text("Create")'),
    panel.locator('button[type="submit"]:has-text("Create")'),
    panel.locator('button:has-text("Create")'),
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

async function runBooking(
  page,
  {
    isNewClient,
    customerName,
    customerPhone,
    customerEmail,
    service,
    stylist,
    startTime,
    customDuration,
    requestReason,
  }
) {
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

  // scroll to bottom of right panel if needed
  await panel
    .evaluate((el) => {
      const scrollable = el.querySelector(".scrollable");
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
    })
    .catch(() => {});

  const clicked = await clickFinalAppointmentCreate(page);
  return { clickedFinalCreate: clicked };
}

/**
 * Vapi tool webhook: /book
 * Returns immediately with jobId; booking runs in background.
 */
/**
 * Vapi tool webhook: /book
 * Returns immediately with jobId; booking runs in background.
 */
app.post("/book", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);

  const isNewClient = Boolean(args.isNewClient);

  const customerName = args.customerName || args.name || "";
  const customerPhone = args.customerPhone || args.phone || "";
  const customerEmailRaw = args.customerEmail || args.email || "";
  const customerEmail = normalizeEmail(customerEmailRaw);

  const service = args.service || "";
  const stylist = args.stylist || undefined;

  const startTime = args.startTime || args.time || "";
  const customDuration = String(args.customDuration || "60");
  const requestReason = args.requestReason || args.notes || undefined;

  // Validation (fail fast)
  if (!customerName) return vapiError(res, toolCallId, "customerName required");
  if (!customerPhone) return vapiError(res, toolCallId, "customerPhone required");

  if (isNewClient) {
    const { firstName, lastName } = splitName(customerName);
    if (!firstName || !lastName) {
      return vapiError(res, toolCallId, "For new clients, please provide first AND last name.");
    }
    if (!customerEmail) return vapiError(res, toolCallId, "Email required for new clients.");
    if (!isValidEmail(customerEmail)) {
      return vapiError(res, toolCallId, `That email looks invalid: "${customerEmail}". Please repeat it.`);
    }
  }

  if (!service) return vapiError(res, toolCallId, "service required");
  if (PHONE_BOOKABLE_SERVICES.size && !PHONE_BOOKABLE_SERVICES.has(service)) {
    return vapiError(res, toolCallId, `Service "${service}" is not phone-bookable. Choose a different service.`);
  }

  if (!startTime) return vapiError(res, toolCallId, "startTime required (e.g., '2:00 PM')");
  if (!customDuration) return vapiError(res, toolCallId, "customDuration required (e.g., '60')");

  // Create job + respond immediately
  const jobId = newJobId();
  bookingJobs.set(jobId, { status: "running", createdAt: Date.now() });

  vapiRespond(res, toolCallId, { ok: true, jobId, status: "running" });

  // Run Playwright in the background
  void (async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
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
        requestReason,
      });

      await page.screenshot({ path: "/tmp/appt_after.png", fullPage: true }).catch(() => {});

      if (!result.clickedFinalCreate) {
        await page.screenshot({ path: "/tmp/appt_create_not_found.png", fullPage: true }).catch(() => {});
        bookingJobs.set(jobId, {
          status: "failed",
          createdAt: bookingJobs.get(jobId)?.createdAt || Date.now(),
          error: 'Could not find/click the FINAL appointment "Create" button.',
          debugScreenshot: "/debug/appt_create_not_found.png",
        });
        return;
      }

      bookingJobs.set(jobId, {
        status: "succeeded",
        createdAt: bookingJobs.get(jobId)?.createdAt || Date.now(),
        result: {
          ok: true,
          message: "Booked successfully",
          debugScreenshot: "/debug/appt_after.png",
          normalized: {
            isNewClient,
            customerName,
            customerPhone: digitsOnly(customerPhone),
            customerEmail,
            service,
            stylist,
            startTime,
            customDuration,
          },
        },
      });
    } catch (e) {
      console.error("BOOK error at step:", step, e);
      await page.screenshot({ path: "/tmp/book_error.png", fullPage: true }).catch(() => {});
      bookingJobs.set(jobId, {
        status: "failed",
        createdAt: bookingJobs.get(jobId)?.createdAt || Date.now(),
        error: `${step}: ${e?.message || String(e)}`,
        debugScreenshot: "/debug/book_error.png",
      });
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  })();
});
// ---------- New endpoint: /book/status ----------
app.post("/book/status", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);
  const jobId = args.jobId;

  if (!jobId) return vapiError(res, toolCallId, "jobId required");

  const job = bookingJobs.get(jobId);
  if (!job) {
    return vapiRespond(res, toolCallId, { ok: false, jobId, status: "not_found" });
  }

  return vapiRespond(res, toolCallId, {
    ok: true,
    jobId,
    status: job.status,
    result: job.result,
    error: job.error,
    debugScreenshot: job.debugScreenshot,
  });
});

// ---------- Debug images ----------
app.get("/debug/appt_after.png", (req, res) => res.sendFile("/tmp/appt_after.png"));
app.get("/debug/appt_create_not_found.png", (req, res) =>
  res.sendFile("/tmp/appt_create_not_found.png")
);
app.get("/debug/book_error.png", (req, res) => res.sendFile("/tmp/book_error.png"));
app.get("/debug/services_error.png", (req, res) => res.sendFile("/tmp/services_error.png"));
app.get("/debug/stylists_error.png", (req, res) => res.sendFile("/tmp/stylists_error.png"));
app.get("/debug/new_client_submit_failed.png", (req, res) =>
  res.sendFile("/tmp/new_client_submit_failed.png")
);
app.get("/debug/new_client_missing_lastname.png", (req, res) =>
  res.sendFile("/tmp/new_client_missing_lastname.png")
);

app.listen(PORT, () => {
  console.log(`SalonBiz Playwright server listening on :${PORT}`);
});
