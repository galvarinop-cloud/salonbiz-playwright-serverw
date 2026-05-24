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
// Keyed by "YYYY-MM-DD" so each date is cached separately.
// TTL is shorter (5 min) since schedules can change intraday.
// ============================================================
const scheduleCache = new Map(); // key: "YYYY-MM-DD" → { fetchedAt, data }
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
// Converts "5:00 PM", "17:00", "5pm" → minutes since midnight (integer).
// Returns null if unparseable.
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim().toUpperCase();

  // "HH:MM AM/PM" or "H:MM AM/PM"
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
  if (h24) {
    return parseInt(h24[1], 10) * 60 + parseInt(h24[2], 10);
  }

  // "5PM" / "5 PM"
  const compact = s.match(/^(\d{1,2})\s*(AM|PM)$/);
  if (compact) {
    let h = parseInt(compact[1], 10);
    const period = compact[2];
    if (period === "AM" && h === 12) h = 0;
    if (period === "PM" && h !== 12) h += 12;
    return h * 60;
  }

  return null;
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
  const window = page
    .locator("ngb-typeahead-window.dropdown-menu.show")
    .first();
  const options = window.locator("button.dropdown-item");
  const count = await options.count().catch(() => 0);
  if (!count) return [];
  const texts = [];
  for (let i = 0; i < count; i++) {
    const t = await options.nth(i).innerText().catch(() => "");
    const cleaned = String(t || "")
      .replace(/\s+/g, " ")
      .trim();
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
// DATE NAVIGATION HELPER
// ============================================================
// Navigates the SalonBiz appointment book to a specific date.
// SalonBiz uses a date picker in the top bar. We try several
// strategies in order:
//   1. URL query param  ?date=YYYY-MM-DD  (works on some versions)
//   2. Click the date header and type into the date picker input
//   3. Click forward/back arrows until the correct date is shown
//
// After navigation, waits for the stylist column headers to load.
async function navigateToDate(page, dateStr) {
  // dateStr = "YYYY-MM-DD"
  // Strategy 1: append ?date= to URL
  const urlWithDate = `${SALONBIZ_BASE_URL}/appointmentbook?date=${dateStr}`;
  await page.goto(urlWithDate, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Check if the page is showing the correct date by reading the
  // displayed date text in the top bar.
  const displayedDate = await readDisplayedDate(page);
  if (displayedDate === dateStr) return;

  // Strategy 2: Find the date input in the top bar and type the date.
  // SalonBiz renders a date picker near the navigation arrows.
  const datePickerSelectors = [
    'input[formcontrolname="date"]',
    'input[type="date"]',
    ".sbiz-datepicker input",
    "sbiz-date-picker input",
    '[placeholder*="date" i]',
    '[aria-label*="date" i]',
  ];

  for (const sel of datePickerSelectors) {
    const inp = page.locator(sel).first();
    const exists = (await inp.count().catch(() => 0)) > 0;
    if (!exists) continue;
    const visible = await inp.isVisible().catch(() => false);
    if (!visible) continue;

    await inp.click({ timeout: 10000 });
    await page.keyboard.press("Control+a");
    await page.keyboard.type(dateStr, { delay: 30 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2500);

    const d2 = await readDisplayedDate(page);
    if (d2 === dateStr) return;
    break;
  }

  // Strategy 3: Click the navigation arrows to step to the target date.
  // This is the most reliable but slowest fallback.
  await stepToDateViaArrows(page, dateStr);
}

// Reads the currently-displayed date from the appointment book header.
// Returns "YYYY-MM-DD" or "" if it can't be determined.
async function readDisplayedDate(page) {
  // Try to find a date display element. SalonBiz typically shows
  // something like "May 23, 2026" or "05/23/2026" in a header.
  const candidates = [
    'sbiz-date-picker input[type="date"]',
    'sbiz-date-picker input',
    'input[formcontrolname="date"]',
    ".appointment-book-date",
    ".sbiz-calendar-header .date",
    "[data-testid='current-date']",
  ];

  for (const sel of candidates) {
    const el = page.locator(sel).first();
    const count = await el.count().catch(() => 0);
    if (!count) continue;
    const val = await el.inputValue().catch(async () => el.innerText().catch(() => ""));
    if (val) {
      // Try to parse as YYYY-MM-DD directly
      if (/^\d{4}-\d{2}-\d{2}$/.test(val.trim())) return val.trim();
      // Try MM/DD/YYYY
      const mdy = val.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (mdy)
        return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
    }
  }
  return "";
}

// Steps forward or backward one day at a time using the nav arrows.
// Gives up after 14 steps in either direction.
async function stepToDateViaArrows(page, targetDateStr) {
  const target = new Date(targetDateStr + "T12:00:00");
  const MAX_STEPS = 14;

  // Arrow button selectors (prev / next)
  const prevSel = [
    'button[aria-label*="previous" i]',
    'button[aria-label*="prev" i]',
    ".sbiz-prev-day",
    ".prev-day",
    "button.prev",
    'button:has-text("<")',
  ].join(", ");
  const nextSel = [
    'button[aria-label*="next" i]',
    ".sbiz-next-day",
    ".next-day",
    "button.next",
    'button:has-text(">")',
  ].join(", ");

  for (let step = 0; step < MAX_STEPS; step++) {
    const current = await readDisplayedDate(page);
    if (current === targetDateStr) return;

    if (!current) {
      // Can't read date — give up
      return;
    }

    const currentDate = new Date(current + "T12:00:00");
    const diff = target - currentDate; // ms

    if (diff > 0) {
      // Need to go forward
      const btn = page.locator(nextSel).first();
      const v = await btn.isVisible().catch(() => false);
      if (!v) return;
      await btn.click({ timeout: 10000 });
    } else {
      // Need to go backward
      const btn = page.locator(prevSel).first();
      const v = await btn.isVisible().catch(() => false);
      if (!v) return;
      await btn.click({ timeout: 10000 });
    }

    await page.waitForTimeout(1500);
  }
}

// ============================================================
// CORE SCHEDULE SCRAPER
// ============================================================
// This is the main new function. It reads the appointment book
// for a specific date and returns a schedule map:
//
//   {
//     "Daniela": { isWorking: true,  notWorkingPeriods: [] },
//     "Kendra":  { isWorking: false, notWorkingPeriods: [{ startMin: 0, endMin: 1439 }] },
//     ...
//   }
//
// HOW IT WORKS:
//   - Each stylist column is identified by sbiz-provider-column or
//     similar container with a header showing the stylist name.
//   - Inside each column, we look for blocks that contain both
//     "blocked" (case-insensitive) AND "not working" text.
//   - If a "Not Working" block spans a large fraction of the day
//     (or the whole day) we mark isWorking = false.
//   - We also record the pixel position of each "Not Working" block
//     relative to the column so we can check specific time slots.
//   - The time ruler on the left (or inside each column) provides
//     the mapping from pixel position → time.
//
// PIXEL-TO-TIME MAPPING:
//   SalonBiz renders the appointment book as a scrollable grid.
//   The left side shows time labels (e.g. "9:00 am", "9:15", ...).
//   We read those label positions to build a px-per-minute ratio,
//   then use that to convert block top/height → start/end minutes.
//
async function scrapeScheduleForDate(page, dateStr) {
  // Navigate to the correct date
  await navigateToDate(page, dateStr);
  await page.waitForTimeout(2000);

  // ---- Step 1: Build a pixel → minutes map from time labels ----
  // We look for all visible time labels in the appointment grid.
  const timeMap = await buildTimeMap(page);

  // ---- Step 2: Read each stylist column ----
  // SalonBiz column headers contain the stylist's name.
  // We find all column header elements and their bounding boxes,
  // then for each column we find "Not Working" blocks inside it.

  const schedule = {}; // stylistFirstName → { isWorking, notWorkingPeriods }

  // Try to find the column container. SalonBiz uses various component names.
  const columnSelectors = [
    "sbiz-provider-column",
    ".provider-column",
    ".stylist-column",
    "[class*='provider-col']",
    "[class*='stylist-col']",
  ];

  let columnEls = null;
  for (const sel of columnSelectors) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count > 0) {
      columnEls = page.locator(sel);
      break;
    }
  }

  if (!columnEls) {
    // Fallback: try to extract schedule data from DOM text only
    return await scrapeScheduleFallback(page, timeMap);
  }

  const colCount = await columnEls.count();

  for (let i = 0; i < colCount; i++) {
    const col = columnEls.nth(i);

    // Read stylist name from the column header
    const rawName = await col
      .locator(
        ".provider-name, .stylist-name, sbiz-provider-header, " +
        "[class*='provider-name'], [class*='header'] .name, " +
        "h4, h3, .name, [class*='name']"
      )
      .first()
      .innerText()
      .catch(() => "");

    const firstName = String(rawName || "").trim().split(/\s+/)[0];
    if (!firstName) continue;

    // Skip Head Spa room
    if (rawName.toLowerCase().includes("head spa")) continue;

    // Find "Not Working" / blocked blocks inside this column
    const notWorkingBlocks = await col
      .locator(
        ":text-matches('not working', 'i'), " +
        "[class*='blocked']:has-text('Not Working'), " +
        ".sbiz-block:has-text('Not Working'), " +
        "div:has-text('Not Working')"
      )
      .all()
      .catch(() => []);

    const notWorkingPeriods = [];

    for (const block of notWorkingBlocks) {
      // Confirm it really says "Not Working" (not just partial match)
      const blockText = await block.innerText().catch(() => "");
      if (!/not working/i.test(blockText)) continue;

      // Get bounding box of the block relative to the page
      const bb = await block.boundingBox().catch(() => null);
      if (!bb) continue;

      // Convert pixel positions to minutes using timeMap
      const startMin = pixelToMinutes(bb.y, timeMap);
      const endMin = pixelToMinutes(bb.y + bb.height, timeMap);

      if (startMin !== null && endMin !== null) {
        notWorkingPeriods.push({ startMin, endMin });
      }
    }

    // A stylist is considered "not working" for the whole day if
    // there's a Not Working block that covers 4+ hours of time,
    // OR if the total blocked time covers more than 50% of an 8-hour day.
    const totalBlockedMinutes = notWorkingPeriods.reduce(
      (sum, p) => sum + Math.max(0, p.endMin - p.startMin),
      0
    );
    const isWorking =
      notWorkingPeriods.length === 0 || totalBlockedMinutes < 4 * 60;

    schedule[firstName] = { isWorking, notWorkingPeriods, rawName };
  }

  return schedule;
}

// ============================================================
// FALLBACK SCHEDULE SCRAPER (no column components found)
// ============================================================
// If we can't find sbiz-provider-column elements, we fall back to
// reading the DOM text to find "Not Working" mentions and which
// stylist column they belong to.
async function scrapeScheduleFallback(page, timeMap) {
  const schedule = {};

  // Get all header cells (stylist names in the top row)
  const headers = await page
    .locator(
      "sbiz-provider-header, .provider-header, " +
      "thead th .name, [class*='column-header']"
    )
    .all()
    .catch(() => []);

  // Get all "Not Working" blocks anywhere on the page
  const nwBlocks = await page
    .locator("div:has-text('Not Working')")
    .all()
    .catch(() => []);

  // For each header, find its x-range and check which NW blocks fall within it
  for (const header of headers) {
    const rawName = await header.innerText().catch(() => "");
    const firstName = String(rawName || "").trim().split(/\s+/)[0];
    if (!firstName) continue;
    if (rawName.toLowerCase().includes("head spa")) continue;

    const hbb = await header.boundingBox().catch(() => null);
    if (!hbb) continue;

    const notWorkingPeriods = [];

    for (const block of nwBlocks) {
      const blockText = await block.innerText().catch(() => "");
      if (!/not working/i.test(blockText)) continue;

      const bb = await block.boundingBox().catch(() => null);
      if (!bb) continue;

      // Check if block's x center falls within the header's x range
      const blockCenterX = bb.x + bb.width / 2;
      if (
        blockCenterX >= hbb.x - 5 &&
        blockCenterX <= hbb.x + hbb.width + 5
      ) {
        const startMin = pixelToMinutes(bb.y, timeMap);
        const endMin = pixelToMinutes(bb.y + bb.height, timeMap);
        if (startMin !== null && endMin !== null) {
          notWorkingPeriods.push({ startMin, endMin });
        }
      }
    }

    const totalBlockedMinutes = notWorkingPeriods.reduce(
      (sum, p) => sum + Math.max(0, p.endMin - p.startMin),
      0
    );
    const isWorking =
      notWorkingPeriods.length === 0 || totalBlockedMinutes < 4 * 60;

    schedule[firstName] = { isWorking, notWorkingPeriods, rawName };
  }

  return schedule;
}

// ============================================================
// TIME MAP BUILDER
// ============================================================
// Reads the time labels on the left side of the appointment book
// (e.g. "9:00 am", "9:30 am", ...) and builds a sorted array of
// { minutes, y } pairs used to convert pixel Y → time in minutes.
async function buildTimeMap(page) {
  const timeLabels = [];

  // SalonBiz renders time labels in various ways
  const timeLabelSelectors = [
    ".time-label",
    ".sbiz-time-label",
    "[class*='time-label']",
    "[class*='time-slot-label']",
    ".hour-label",
    "sbiz-time-column span",
    "sbiz-time-column div",
    ".appointment-time",
  ];

  for (const sel of timeLabelSelectors) {
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

  // Sort by y position
  timeLabels.sort((a, b) => a.y - b.y);
  return timeLabels;
}

// ============================================================
// PIXEL → MINUTES CONVERTER
// ============================================================
// Given a Y pixel and a timeMap (sorted array of {y, minutes}),
// interpolates to find the time in minutes since midnight.
function pixelToMinutes(y, timeMap) {
  if (!timeMap || timeMap.length < 2) return null;

  // Below all known points — extrapolate from last two
  if (y >= timeMap[timeMap.length - 1].y) {
    const a = timeMap[timeMap.length - 2];
    const b = timeMap[timeMap.length - 1];
    const ratio = (y - a.y) / (b.y - a.y);
    return Math.round(a.minutes + ratio * (b.minutes - a.minutes));
  }

  // Above all known points — extrapolate from first two
  if (y <= timeMap[0].y) {
    const a = timeMap[0];
    const b = timeMap[1];
    const ratio = (y - a.y) / (b.y - a.y);
    return Math.round(a.minutes + ratio * (b.minutes - a.minutes));
  }

  // Interpolate between surrounding points
  for (let i = 0; i < timeMap.length - 1; i++) {
    const a = timeMap[i];
    const b = timeMap[i + 1];
    if (y >= a.y && y <= b.y) {
      const ratio = (y - a.y) / (b.y - a.y);
      return Math.round(a.minutes + ratio * (b.minutes - a.minutes));
    }
  }

  return null;
}

// ============================================================
// SCHEDULE AVAILABILITY CHECK
// ============================================================
// Given a scheduleMap and a requested time string, checks if the
// stylist is working AND the requested time is not in a "Not Working"
// period.
//
// Returns: { available: true } or { available: false, reason: string }
function checkStylistAvailability(scheduleMap, stylistFirstName, startTimeStr) {
  if (!scheduleMap || !stylistFirstName) {
    // No schedule data — can't check, assume available
    return { available: true, reason: "no schedule data" };
  }

  // Case-insensitive lookup
  const key = Object.keys(scheduleMap).find(
    (k) => k.toLowerCase() === stylistFirstName.toLowerCase()
  );

  if (!key) {
    // Stylist not found in schedule — may mean they aren't on the
    // appointment book at all that day (completely off)
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

  // Check if the requested time falls in any Not Working period
  const requestedMin = parseTimeToMinutes(startTimeStr);
  if (requestedMin !== null && entry.notWorkingPeriods.length > 0) {
    for (const period of entry.notWorkingPeriods) {
      if (requestedMin >= period.startMin && requestedMin < period.endMin) {
        const fmt = (m) => {
          const h = Math.floor(m / 60);
          const min = m % 60;
          const ampm = h < 12 ? "AM" : "PM";
          const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
        };
        return {
          available: false,
          reason: `${stylistFirstName} is not working at ${startTimeStr} (blocked ${fmt(period.startMin)}–${fmt(period.endMin)}).`,
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
    return { schedule: entry.data, cached: true, cacheAgeMs: Date.now() - entry.fetchedAt };
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
// STYLIST CACHE (unchanged from original)
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
      if (!n) return false;
      if (n.includes("head spa")) return false;
      return true;
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
  if (
    stylistCache.value &&
    now - stylistCache.fetchedAt < STYLIST_CACHE_TTL_MS
  ) {
    return {
      stylists: stylistCache.value,
      cached: true,
      cacheAgeMs: now - stylistCache.fetchedAt,
    };
  }
  const stylists = await fetchStylistsFromSalonBiz();
  stylistCache = { value: stylists, fetchedAt: now };
  return { stylists, cached: false, cacheAgeMs: 0 };
}

// ============================================================
// VAPI HELPERS (unchanged)
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

// ============================================================
// BOOKING JOB STORE (unchanged)
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
// DATE INPUT HELPER (unchanged)
// ============================================================
const DATE_INPUT_SELECTOR =
  process.env.DATE_INPUT_SELECTOR ||
  'sbiz-book-right-panel input[formcontrolname="startDate"], ' +
  'sbiz-book-right-panel input[formcontrolname="date"], ' +
  'sbiz-book-right-panel input[type="date"]';

async function setAppointmentDate
