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
    .replace(/\s+/g, "") // remove spaces
    .replace(/\(at\)|\sat\s/gi, "@")
    .replace(/\s?dot\s?/gi, ".")
    .toLowerCase();
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function uniq(arr) {
  return Array.from(new Set(arr));
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
  // Select first suggestion
  await inputLocator.page().keyboard.press("ArrowDown");
  await inputLocator.page().keyboard.press("Enter");
}

async function setTextInput(inputLocator, value) {
  await inputLocator.click({ timeout: 15000 });
  await inputLocator.fill(String(value));
}

/**
 * Reads the currently open ngb-typeahead suggestion list under an input.
 * Works with your DOM: <ngb-typeahead-window ...> <button class="dropdown-item">...</button>
 */
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

/**
 * Scrape all typeahead results by querying a-z0-9, dedupe union.
 * This is "full mode" and will be slower but complete.
 */
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

    // slight backoff
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

// -------------------- routes --------------------
app.get("/health", (req, res) => res.json({ ok: true, now: new Date().toISOString() }));
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
    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, { waitUntil: "domcontentloaded" });
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
    await page.screenshot({ path: "/tmp/services_error.png", fullPage: true }).catch(() => {});
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
    await page.screenshot({ path: "/tmp/stylists_error.png", fullPage: true }).catch(() => {});
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
  // In your HTML, the final "Create" isn't shown in the snippet,
  // so we try several patterns.
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

async function runBooking(page, {
  isNewClient,
  customerName,
  customerPhone,
  customerEmail,
  service,
  stylist,
  startTime,
  customDuration,
  requestReason,
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
 * This MUST return { results: [...] }.
 */
app.post("/book", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);

  // Normalize args (assistant may send old/new fields)
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

  // Validation (fail fast so assistant can ask again)
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

  // ✅ Respond immediately so Vapi never times out
  vapiRespond(res, toolCallId, {
    ok: true,
    message: "Booking started"
  });

  // ✅ Continue booking in the background
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

      // Optional stylist validation (keep or remove)
      if (stylist) {
        step = "validateStylist";
        await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2500);
        await ensureCreatePanelOpen(page);

        const staffInput = page
          .locator("sbiz-book-right-panel")
          .locator('input[formcontrolname="staff"]')
          .first();
        await staffInput.waitFor({ state: "visible", timeout: 20000 });

        await staffInput.click();
        await staffInput.fill("");
        await staffInput.type(String(stylist).slice(0, 1), { delay: 20 });
        await page.waitForTimeout(450);
        const staffOptions = await readNgbTypeaheadOptions(page);
        if (staffOptions.length && !staffOptions.some((x) => x.toLowerCase() === String(stylist).toLowerCase())) {
          console.log("WARN stylist not in immediate suggestions:", stylist, staffOptions.slice(0, 10));
        }
      }

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
        console.error("BOOKING_FAILED_CREATE_BUTTON_NOT_FOUND", { step, toolCallId });
        return;
      }

      console.log("BOOKING_SUCCESS", {
        toolCallId,
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
      });
    } catch (e) {
      console.error("BOOKING_FAILED", { toolCallId, step, error: e?.message || String(e) });
      await page.screenshot({ path: "/tmp/book_error.png", fullPage: true }).catch(() => {});
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  })();
});

// Debug images
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
