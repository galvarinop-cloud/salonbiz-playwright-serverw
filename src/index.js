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

const CREATE_CLICK_X_PCT = Number(process.env.CREATE_CLICK_X_PCT || 0.95);
const CREATE_CLICK_Y_PCT = Number(process.env.CREATE_CLICK_Y_PCT || 0.11);

let cookieState = null;
let cookieStateSetAt = 0;
const COOKIE_TTL_MS = Number(process.env.COOKIE_TTL_MS || 1000 * 60 * 60 * 6);

const PHONE_BOOKABLE_SERVICES_RAW = process.env.PHONE_BOOKABLE_SERVICES || "";
const PHONE_BOOKABLE_SERVICES = new Set(
  PHONE_BOOKABLE_SERVICES_RAW
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean)
);

// ============================================================
// STYLIST CACHE
// ============================================================
let stylistCache = { value: null, fetchedAt: 0 };
const STYLIST_CACHE_TTL_MS = Number(
  process.env.STYLIST_CACHE_TTL_MS || 10 * 60 * 1000
);

// ============================================================
// SCHEDULE CACHE
// Keyed by "YYYY-MM-DD". TTL = 5 min (schedules can change intraday).
// ============================================================
const scheduleCache = new Map();
const SCHEDULE_CACHE_TTL_MS = Number(
  process.env.SCHEDULE_CACHE_TTL_MS || 5 * 60 * 1000
);

function scheduleExpired(entry) {
  return !entry || Date.now() - entry.fetchedAt > SCHEDULE_CACHE_TTL_MS;
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
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
  if (d.length === 10)
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return String(phone || "");
}

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || "" };
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

function formatYYYYMMDD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ============================================================
// TIME PARSING HELPERS
// ============================================================
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim().toUpperCase();

  // "H:MM AM/PM"
  const ampm = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2], 10);
    const period = ampm[3];
    if (period === "AM" && h === 12) h = 0;
    if (period === "PM" && h !== 12) h += 12;
    return h * 60 + m;
  }

  // "HH:MM" 24-hour
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) return parseInt(h24[1], 10) * 60 + parseInt(h24[2], 10);

  // "5PM" / "5 PM"
  const compact = s.match(/^(\d{1,2})\s*(AM|PM)$/);
  if (compact) {
    let h = parseInt(compact[1], 10);
    if (compact[2] === "AM" && h === 12) h = 0;
    if (compact[2] === "PM" && h !== 12) h += 12;
    return h * 60;
  }

  return null;
}

function minutesToTimeStr(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

// ============================================================
// BROWSER HELPERS
// ============================================================
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
  const win = page.locator("ngb-typeahead-window.dropdown-menu.show").first();
  const options = win.locator("button.dropdown-item");
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

// ============================================================
// DATE NAVIGATION
// ============================================================
async function readDisplayedDate(page) {
  const candidates = [
    'sbiz-date-picker input[type="date"]',
    'sbiz-date-picker input',
    'input[formcontrolname="date"]',
    ".appointment-book-date",
    ".sbiz-calendar-header .date",
  ];
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if ((await el.count().catch(() => 0)) === 0) continue;
    const val = await el
      .inputValue()
      .catch(async () => el.innerText().catch(() => ""));
    if (!val) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(val.trim())) return val.trim();
    const mdy = val.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy)
      return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  }
  return "";
}

async function stepToDateViaArrows(page, targetDateStr) {
  const target = new Date(targetDateStr + "T12:00:00");
  const prevSel = [
    'button[aria-label*="previous" i]',
    'button[aria-label*="prev" i]',
    ".sbiz-prev-day",
    ".prev-day",
  ].join(", ");
  const nextSel = [
    'button[aria-label*="next" i]',
    ".sbiz-next-day",
    ".next-day",
  ].join(", ");

  for (let step = 0; step < 14; step++) {
    const current = await readDisplayedDate(page);
    if (current === targetDateStr) return;
    if (!current) return;

    const diff = target - new Date(current + "T12:00:00");
    if (diff > 0) {
      const btn = page.locator(nextSel).first();
      if (!(await btn.isVisible().catch(() => false))) return;
      await btn.click({ timeout: 10000 });
    } else {
      const btn = page.locator(prevSel).first();
      if (!(await btn.isVisible().catch(() => false))) return;
      await btn.click({ timeout: 10000 });
    }
    await page.waitForTimeout(1500);
  }
}

async function navigateToDate(page, dateStr) {
  await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook?date=${dateStr}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(3000);

  if ((await readDisplayedDate(page)) === dateStr) return;

  const datePickerSelectors = [
    'input[formcontrolname="date"]',
    'input[type="date"]',
    ".sbiz-datepicker input",
    "sbiz-date-picker input",
  ];
  for (const sel of datePickerSelectors) {
    const inp = page.locator(sel).first();
    if ((await inp.count().catch(() => 0)) === 0) continue;
    if (!(await inp.isVisible().catch(() => false))) continue;
    await inp.click({ timeout: 10000 });
    await page.keyboard.press("Control+a");
    await page.keyboard.type(dateStr, { delay: 30 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2500);
    if ((await readDisplayedDate(page)) === dateStr) return;
    break;
  }

  await stepToDateViaArrows(page, dateStr);
}

// ============================================================
// TIME MAP — pixel Y → minutes since midnight
// ============================================================
async function buildTimeMap(page) {
  const timeLabels = [];
  const selectors = [
    ".time-label",
    ".sbiz-time-label",
    "[class*='time-label']",
    "[class*='time-slot-label']",
    "sbiz-time-column span",
    "sbiz-time-column div",
  ];

  for (const sel of selectors) {
    const els = await page.locator(sel).all().catch(() => []);
    if (els.length < 2) continue;
    for (const el of els) {
      const text = await el.innerText().catch(() => "");
      const minutes = parseTimeToMinutes(text.trim());
      if (minutes === null) continue;
      const bb = await el.boundingBox().catch(() => null);
      if (!bb) continue;
      timeLabels.push({ minutes, y: bb.y + bb.height / 2 });
    }
    if (timeLabels.length >= 2) break;
  }

  timeLabels.sort((a, b) => a.y - b.y);
  return timeLabels;
}

function pixelToMinutes(y, timeMap) {
  if (!timeMap || timeMap.length < 2) return null;

  if (y >= timeMap[timeMap.length - 1].y) {
    const a = timeMap[timeMap.length - 2];
    const b = timeMap[timeMap.length - 1];
    return Math.round(a.minutes + ((y - a.y) / (b.y - a.y)) * (b.minutes - a.minutes));
  }
  if (y <= timeMap[0].y) {
    const a = timeMap[0];
    const b = timeMap[1];
    return Math.round(a.minutes + ((y - a.y) / (b.y - a.y)) * (b.minutes - a.minutes));
  }
  for (let i = 0; i < timeMap.length - 1; i++) {
    const a = timeMap[i];
    const b = timeMap[i + 1];
    if (y >= a.y && y <= b.y) {
      return Math.round(a.minutes + ((y - a.y) / (b.y - a.y)) * (b.minutes - a.minutes));
    }
  }
  return null;
}

// ============================================================
// CORE SCHEDULE SCRAPER
// ============================================================
// Reads the SalonBiz appointment book for a specific date.
// Returns: { [stylistFirstName]: { isWorking, notWorkingPeriods, rawName } }
//
// "Not Working" detection:
//   - Looks for DOM elements containing "not working" text (case-insensitive)
//   - Maps their pixel position to time using the time ruler
//   - A stylist is marked isWorking=false if their Not Working blocks
//     cover 4+ hours total
async function scrapeScheduleForDate(page, dateStr) {
  await navigateToDate(page, dateStr);
  await page.waitForTimeout(2000);

  const timeMap = await buildTimeMap(page);

  const schedule = {};

  // Try named column components first
  const columnSelectors = [
    "sbiz-provider-column",
    ".provider-column",
    ".stylist-column",
    "[class*='provider-col']",
  ];

  let columnEls = null;
  for (const sel of columnSelectors) {
    if ((await page.locator(sel).count().catch(() => 0)) > 0) {
      columnEls = page.locator(sel);
      break;
    }
  }

  if (columnEls) {
    const colCount = await columnEls.count();
    for (let i = 0; i < colCount; i++) {
      const col = columnEls.nth(i);
      const rawName = await col
        .locator(
          ".provider-name, .stylist-name, sbiz-provider-header, " +
          "[class*='provider-name'], h4, h3, .name"
        )
        .first()
        .innerText()
        .catch(() => "");
      const firstName = String(rawName || "").trim().split(/\s+/)[0];
      if (!firstName) continue;
      if (rawName.toLowerCase().includes("head spa")) continue;

      const notWorkingPeriods = await extractNotWorkingPeriods(col, timeMap);
      const totalBlockedMinutes = notWorkingPeriods.reduce(
        (sum, p) => sum + Math.max(0, p.endMin - p.startMin), 0
      );
      schedule[firstName] = {
        isWorking: notWorkingPeriods.length === 0 || totalBlockedMinutes < 4 * 60,
        notWorkingPeriods,
        rawName: rawName.trim(),
      };
    }
  } else {
    // Fallback: match Not Working blocks to column headers by X position
    await scrapeScheduleFallback(page, timeMap, schedule);
  }

  return schedule;
}

async function extractNotWorkingPeriods(columnLocator, timeMap) {
  const periods = [];
  const blocks = await columnLocator
    .locator("div")
    .all()
    .catch(() => []);

  for (const block of blocks) {
    const text = await block.innerText().catch(() => "");
    if (!/not working/i.test(text)) continue;
    const bb = await block.boundingBox().catch(() => null);
    if (!bb || bb.height < 5) continue;
    const startMin = pixelToMinutes(bb.y, timeMap);
    const endMin = pixelToMinutes(bb.y + bb.height, timeMap);
    if (startMin !== null && endMin !== null && endMin > startMin) {
      periods.push({ startMin, endMin });
    }
  }
  return periods;
}

async function scrapeScheduleFallback(page, timeMap, schedule) {
  const headers = await page
    .locator(
      "sbiz-provider-header, .provider-header, [class*='column-header'], " +
      "thead th .name"
    )
    .all()
    .catch(() => []);

  const nwBlocks = await page.locator("div").all().catch(() => []);
  const nwFiltered = [];
  for (const b of nwBlocks) {
    const t = await b.innerText().catch(() => "");
    if (/not working/i.test(t)) {
      const bb = await b.boundingBox().catch(() => null);
      if (bb && bb.height > 5) nwFiltered.push({ el: b, bb, text: t });
    }
  }

  for (const header of headers) {
    const rawName = await header.innerText().catch(() => "");
    const firstName = String(rawName || "").trim().split(/\s+/)[0];
    if (!firstName) continue;
    if (rawName.toLowerCase().includes("head spa")) continue;

    const hbb = await header.boundingBox().catch(() => null);
    if (!hbb) continue;

    const notWorkingPeriods = [];
    for (const { bb } of nwFiltered) {
      const cx = bb.x + bb.width / 2;
      if (cx >= hbb.x - 5 && cx <= hbb.x + hbb.width + 5) {
        const startMin = pixelToMinutes(bb.y, timeMap);
        const endMin = pixelToMinutes(bb.y + bb.height, timeMap);
        if (startMin !== null && endMin !== null && endMin > startMin) {
          notWorkingPeriods.push({ startMin, endMin });
        }
      }
    }

    const totalBlockedMinutes = notWorkingPeriods.reduce(
      (sum, p) => sum + Math.max(0, p.endMin - p.startMin), 0
    );
    schedule[firstName] = {
      isWorking: notWorkingPeriods.length === 0 || totalBlockedMinutes < 4 * 60,
      notWorkingPeriods,
      rawName: rawName.trim(),
    };
  }
}

// ============================================================
// SCHEDULE AVAILABILITY CHECK
// ============================================================
function checkStylistAvailability(scheduleMap, stylistFirstName, startTimeStr) {
  if (!scheduleMap || !stylistFirstName) {
    return { available: true, reason: "no schedule data" };
  }

  const key = Object.keys(scheduleMap).find(
    (k) => k.toLowerCase() === stylistFirstName.toLowerCase()
  );

  if (!key) {
    return {
      available: false,
      reason: `${stylistFirstName} does not appear on the schedule for that day.`,
    };
  }

  const entry = scheduleMap[key];

  if (!entry.isWorking) {
    return {
      available: false,
      reason: `${stylistFirstName} is not working that day.`,
    };
  }

  const requestedMin = parseTimeToMinutes(startTimeStr);
  if (requestedMin !== null) {
    for (const period of entry.notWorkingPeriods) {
      if (requestedMin >= period.startMin && requestedMin < period.endMin) {
        return {
          available: false,
          reason: `${stylistFirstName} is not working at ${startTimeStr} (blocked ${minutesToTimeStr(period.startMin)}–${minutesToTimeStr(period.endMin)}).`,
        };
      }
    }
  }

  return { available: true };
}

// ============================================================
// CACHED SCHEDULE FETCH
// ============================================================
async function getScheduleCached(dateStr) {
  const entry = scheduleCache.get(dateStr);
  if (!scheduleExpired(entry)) {
    return {
      schedule: entry.data,
      cached: true,
      cacheAgeMs: Date.now() - entry.fetchedAt,
    };
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const { context, page } = await getPage(browser);

  try {
    if (cookiesExpired()) cookieState = null;
    await loginIfNeeded(page);
    await saveCookies(context);
    const data = await scrapeScheduleForDate(page, dateStr);
    scheduleCache.set(dateStr, { fetchedAt: Date.now(), data });
    return { schedule: data, cached: false, cacheAgeMs: 0 };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ============================================================
// STYLIST CACHE
// ============================================================
async function fetchStylistsFromSalonBiz() {
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
    await ensureCreatePanelOpen(page);

    step = "scrapeStaff";
    const staffInput = page
      .locator("sbiz-book-right-panel")
      .locator('input[formcontrolname="staff"]')
      .first();
    await staffInput.waitFor({ state: "visible", timeout: 20000 });
    const stylistsRaw = await scrapeTypeaheadUniverse(staffInput, page);

    const filtered = stylistsRaw.filter((name) => {
      const n = String(name || "").trim().toLowerCase();
      return n && !n.includes("head spa");
    });
    const cleaned = filtered
      .map((name) => String(name).trim().split(/\s+/)[0])
      .filter(Boolean);
    return Array.from(new Set(cleaned));
  } catch (e) {
    console.error("fetchStylistsFromSalonBiz error at step:", step, e);
    await page
      .screenshot({ path: "/tmp/stylists_error.png", fullPage: true })
      .catch(() => {});
    throw new Error(`${step}: ${e?.message || String(e)}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function getStylistsCached() {
  const now = Date.now();
  if (stylistCache.value && now - stylistCache.fetchedAt < STYLIST_CACHE_TTL_MS) {
    return { stylists: stylistCache.value, cached: true, cacheAgeMs: now - stylistCache.fetchedAt };
  }
  const stylists = await fetchStylistsFromSalonBiz();
  stylistCache = { value: stylists, fetchedAt: now };
  return { stylists, cached: false, cacheAgeMs: 0 };
}

// ============================================================
// VAPI HELPERS
// ============================================================
function extractToolCall(req) {
  return (
    req.body?.message?.toolCallList?.[0] ||
    req.body?.message?.toolCalls?.[0] ||
    null
  );
}
function extractToolCallId(req) {
  return extractToolCall(req)?.id || null;
}
function extractArgs(req) {
  const toolCall = extractToolCall(req);
  const raw = toolCall?.function?.arguments;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}
function vapiRespond(res, toolCallId, result, statusCode = 200) {
  return res.status(statusCode).json({ results: [{ toolCallId, result }] });
}
function vapiError(res, toolCallId, message, statusCode = 400) {
  return vapiRespond(res, toolCallId, { ok: false, error: message }, statusCode);
}

// ============================================================
// BOOKING JOB STORE
// ============================================================
const bookingJobs = new Map();
function newJobId() {
  return `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of bookingJobs.entries()) {
    if (now - job.createdAt > 1000 * 60 * 30) bookingJobs.delete(jobId);
  }
}, 1000 * 60).unref?.();

// ============================================================
// DATE INPUT HELPER (booking panel)
// ============================================================
const DATE_INPUT_SELECTOR =
  process.env.DATE_INPUT_SELECTOR ||
  'sbiz-book-right-panel input[formcontrolname="startDate"], ' +
  'sbiz-book-right-panel input[formcontrolname="date"], ' +
  'sbiz-book-right-panel input[type="date"]';

async function setAppointmentDateIfPossible(page, startDate) {
  if (!startDate) return { didSetDate: false, selectorUsed: null };
  const dateInput = page.locator(DATE_INPUT_SELECTOR).first();
  if ((await dateInput.count().catch(() => 0)) === 0)
    return { didSetDate: false, selectorUsed: null };
  await dateInput.click({ timeout: 15000 }).catch(() => {});
  await dateInput.fill(String(startDate)).catch(() => {});
  await dateInput.page().keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(600);
  return { didSetDate: true, selectorUsed: DATE_INPUT_SELECTOR };
}

// ============================================================
// ROUTES
// ============================================================
app.get("/health", (req, res) =>
  res.json({ ok: true, now: new Date().toISOString() })
);
app.get("/debug/ping", (req, res) => res.json({ ok: true, msg: "pong" }));

// ----------------------------------------------------------
// POST /services
// ----------------------------------------------------------
app.post("/services", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  if (!PHONE_BOOKABLE_SERVICES.size) {
    return vapiError(res, toolCallId,
      "PHONE_BOOKABLE_SERVICES env var is empty."
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
    const phoneBookable = allServices.filter((s) =>
      PHONE_BOOKABLE_SERVICES.has(s)
    );
    return vapiRespond(res, toolCallId, {
      ok: true,
      countAll: allServices.length,
      countPhoneBookable: phoneBookable.length,
      services: phoneBookable,
    });
  } catch (e) {
    console.error("SERVICES error at step:", step, e);
    await page.screenshot({ path: "/tmp/services_error.png", fullPage: true }).catch(() => {});
    return vapiRespond(res, toolCallId,
      { ok: false, step, error: e?.message || String(e), debug: "/debug/services_error.png" },
      500
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

// ----------------------------------------------------------
// POST /stylists
// ----------------------------------------------------------
app.post("/stylists", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  try {
    const { stylists, cached, cacheAgeMs } = await getStylistsCached();
    return vapiRespond(res, toolCallId, {
      ok: true, cached, cacheAgeMs, count: stylists.length, stylists,
    });
  } catch (e) {
    console.error("STYLISTS error:", e);
    return vapiRespond(res, toolCallId,
      { ok: false, error: e?.message || String(e), debug: "/debug/stylists_error.png" },
      500
    );
  }
});

// ----------------------------------------------------------
// POST /schedule   ← NEW ENDPOINT
// Lists every stylist's working status for a given date.
// Args: { date: "YYYY-MM-DD" }
// Optionally check a specific stylist + time:
// Args: { date, stylist, startTime }
// ----------------------------------------------------------
app.post("/schedule", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);

  const dateStr = args.date || args.startDate || formatYYYYMMDD(new Date());
  const stylist = args.stylist || null;
  const startTime = args.startTime || args.time || null;

  try {
    const { schedule, cached, cacheAgeMs } = await getScheduleCached(dateStr);

    // Build a clean summary for the AI
    const summary = Object.entries(schedule).map(([name, data]) => ({
      name,
      isWorking: data.isWorking,
      notWorkingPeriods: data.notWorkingPeriods.map((p) => ({
        from: minutesToTimeStr(p.startMin),
        to: minutesToTimeStr(p.endMin),
      })),
    }));

    // If a specific stylist + time was asked about, include availability
    let specificCheck = null;
    if (stylist && startTime) {
      specificCheck = checkStylistAvailability(schedule, stylist, startTime);
    } else if (stylist) {
      const key = Object.keys(schedule).find(
        (k) => k.toLowerCase() === stylist.toLowerCase()
      );
      if (key) {
        specificCheck = {
          available: schedule[key].isWorking,
          reason: schedule[key].isWorking
            ? `${stylist} is working that day.`
            : `${stylist} is not working that day.`,
        };
      } else {
        specificCheck = {
          available: false,
          reason: `${stylist} does not appear on the schedule for ${dateStr}.`,
        };
      }
    }

    return vapiRespond(res, toolCallId, {
      ok: true,
      date: dateStr,
      cached,
      cacheAgeMs,
      stylistCount: summary.length,
      schedule: summary,
      ...(specificCheck ? { specificCheck } : {}),
    });
  } catch (e) {
    console.error("SCHEDULE error:", e);
    await (async () => {
      // take debug screenshot if possible
    })().catch(() => {});
    return vapiRespond(res, toolCallId,
      { ok: false, error: e?.message || String(e) },
      500
    );
  }
});

// ----------------------------------------------------------
// POST /availability   (updated — schedule check first)
// ----------------------------------------------------------
app.post("/availability", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);

  const service = args.service || "";
  const stylist = args.stylist || undefined;
  const startTime = args.startTime || args.time || "";
  const startDate = args.startDate || formatYYYYMMDD(new Date(Date.now() + 24 * 60 * 60 * 1000));

  if (!service) return vapiError(res, toolCallId, "service required");
  if (!startTime) return vapiError(res, toolCallId, "startTime required (e.g. '5:00 PM')");

  // ---- Step 1: Schedule check (fast, uses cache) ----
  if (stylist) {
    try {
      const { schedule } = await getScheduleCached(startDate);
      const check = checkStylistAvailability(schedule, stylist, startTime);
      if (!check.available) {
