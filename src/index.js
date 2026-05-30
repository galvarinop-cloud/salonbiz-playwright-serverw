import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

const PORT = process.env.PORT || 3000;
const SALONBIZ_BASE_URL = process.env.SALONBIZ_BASE_URL || "https://central-app.salonbiz.com";
const SALONBIZ_USERNAME = process.env.SALONBIZ_USERNAME;
const SALONBIZ_PASSWORD = process.env.SALONBIZ_PASSWORD;
const CREATE_CLICK_X_PCT = Number(process.env.CREATE_CLICK_X_PCT || 0.95);
const CREATE_CLICK_Y_PCT = Number(process.env.CREATE_CLICK_Y_PCT || 0.11);

let cookieState = null;
let cookieStateSetAt = 0;
const COOKIE_TTL_MS = Number(process.env.COOKIE_TTL_MS || 1000 * 60 * 60 * 6);

const PHONE_BOOKABLE_SERVICES_RAW = process.env.PHONE_BOOKABLE_SERVICES || "";
const PHONE_BOOKABLE_SERVICES = new Set(
  PHONE_BOOKABLE_SERVICES_RAW.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean)
);

let stylistCache = { value: null, fetchedAt: 0 };
const STYLIST_CACHE_TTL_MS = Number(process.env.STYLIST_CACHE_TTL_MS || 10 * 60 * 1000);
const scheduleCache = new Map();
const SCHEDULE_CACHE_TTL_MS = Number(process.env.SCHEDULE_CACHE_TTL_MS || 5 * 60 * 1000);

// How long to wait (ms) for the Playwright booking to finish before timing out
const BOOK_TIMEOUT_MS = Number(process.env.BOOK_TIMEOUT_MS || 150000);
const apptCache = new Map(); // key: dateStr, value: { appointments: [...], fetchedAt: Date.now() }
const APPT_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

function scheduleExpired(entry) {
  return !entry || Date.now() - entry.fetchedAt > SCHEDULE_CACHE_TTL_MS;
}
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
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return String(phone || "");
}
function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || "" };
}
function normalizeEmail(raw) {
  if (!raw) return "";
  return String(raw).trim().replace(/\s+/g,"").replace(/\(at\)|\sat\s/gi,"@").replace(/\s?dot\s?/gi,".").toLowerCase();
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
function todayStr() {
  return formatYYYYMMDD(new Date());
}
function tomorrowStr() {
  return formatYYYYMMDD(new Date(Date.now() + 24 * 60 * 60 * 1000));
}
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim().toUpperCase();
  const ampm = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2], 10);
    if (ampm[3] === "AM" && h === 12) h = 0;
    if (ampm[3] === "PM" && h !== 12) h += 12;
    return h * 60 + m;
  }
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) return parseInt(h24[1], 10) * 60 + parseInt(h24[2], 10);
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
  return `${h12}:${String(min).padStart(2,"0")} ${ampm}`;
}
// Convert a time string like "1:30 PM" to spoken form "one thirty PM"
function spokenTime(timeStr) {
  if (!timeStr) return timeStr;
  const m = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return timeStr;
  const h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const ampm = m[3].toUpperCase();
  const ones = ['','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
  const teens = ['ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
  const tens = ['','','twenty','thirty','forty','fifty'];
  let hourWord = h <= 12 ? ones[h] : ones[h-12];
  let minWord = '';
  if (min === 0) {
    minWord = '';
  } else if (min < 10) {
    minWord = 'oh ' + ones[min];
  } else if (min < 20) {
    minWord = teens[min - 10];
  } else {
    minWord = tens[Math.floor(min/10)] + (min % 10 ? ' ' + ones[min % 10] : '');
  }
  // Only say AM explicitly — PM is implied for afternoon times
  const suffix = ampm === 'AM' ? ' AM' : '';
  return (hourWord + (minWord ? ' ' + minWord : '') + suffix).trim();
}



// Normalize loose voice time strings → "5:00 PM"
// Handles: "2:30 PM", "two thirty PM", "3 PM", "three", "14:30", digit-word combos
const WORD_TO_HOUR = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12};
const WORD_TO_MIN = {oh:0,zero:0,ten:10,fifteen:15,twenty:20,thirty:30,forty:40,fifty:50};
function normalizeStartTime(raw) {
if (!raw) return raw;
let s = String(raw).trim().toLowerCase().replace(/[,]/g,'');
// Replace hour words with digits first
for (const [w,n] of Object.entries(WORD_TO_HOUR)) s = s.replace(new RegExp('\\b'+w+'\\b','gi'),String(n));
// Handle "X thirty PM", "X forty-five AM" — word-based minutes
const wordMinPatterns = [
  [/twenty[- ]?five/gi,'25'],[/twenty[- ]?one/gi,'21'],[/thirty[- ]?five/gi,'35'],
  [/forty[- ]?five/gi,'45'],[/fifty[- ]?five/gi,'55'],[/twenty/gi,'20'],[/thirty/gi,'30'],
  [/forty/gi,'40'],[/fifty/gi,'50'],[/fifteen/gi,'15'],[/\boh\b/gi,'0'],[/\bzero\b/gi,'0']
];
for (const [rx,rep] of wordMinPatterns) s = s.replace(rx, rep);
// Now s should have digits only. Try to parse.
// Pattern: "2 30 pm" or "2 30pm"
let m = s.match(/^(\d{1,2})\s+(\d{1,2})\s*(am|pm)$/i);
if (m) return `${m[1]}:${m[2].padStart(2,'0')} ${m[3].toUpperCase()}`;
// Pattern: "2:30 PM"
m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
if (m) return `${m[1]}:${m[2]} ${m[3].toUpperCase()}`;
// Pattern: "14:30" (24h)
m = s.match(/^(\d{2}):(\d{2})$/);
if (m) { let h=parseInt(m[1]); const mn=m[2]; const ap=h>=12?'PM':'AM'; if(h>12)h-=12; if(h===0)h=12; return `${h}:${mn} ${ap}`; }
// Pattern: "2:30" no ampm
m = s.match(/^(\d{1,2}):(\d{2})$/);
if (m) { const h=parseInt(m[1]); return `${h}:${m[2]} ${h<12?'AM':'PM'}`; }
// Pattern: "2 PM" or "2pm"
m = s.match(/^(\d{1,2})\s*(am|pm)$/i);
if (m) return `${m[1]}:00 ${m[2].toUpperCase()}`;
// Pattern: just a number (hour only, assume PM if 1-7, AM if 8-12)
m = s.match(/^(\d{1,2})$/);
if (m) { const h=parseInt(m[1]); return `${h}:00 ${(h>=8&&h<=11)?'AM':'PM'}`; }
return raw;
}

// Resolve startDate: use arg if valid YYYY-MM-DD, else infer from current ET time
function resolveStartDate(startDateArg, startTimeStr) {
  if (startDateArg && /^\d{4}-\d{2}-\d{2}$/.test(String(startDateArg).trim())) return String(startDateArg).trim();
  const etNow = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  const todayFmt = formatYYYYMMDD(etNow);
  if (startTimeStr) {
    const reqMin = parseTimeToMinutes(startTimeStr);
    const curMin = etNow.getHours()*60+etNow.getMinutes();
    if (reqMin!==null && reqMin<=curMin) {
      const tom=new Date(etNow); tom.setDate(tom.getDate()+1); return formatYYYYMMDD(tom);
    }
  }
  return todayFmt;
}

async function getPage(browser) {
  const context = await browser.newContext(cookieState ? { storageState: cookieState } : undefined);
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
  await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Helper to fill and submit login form
  const doLogin = async () => {
    await page.evaluate(({ un, pw }) => {
      const setNative = (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const userEls = document.querySelectorAll('input[formcontrolname="username"], input[placeholder="Username"], input[type="text"]');
      const passEls = document.querySelectorAll('input[formcontrolname="password"], input[placeholder="Password"], input[type="password"]');
      if (userEls.length) setNative(userEls[userEls.length - 1], un);
      if (passEls.length) setNative(passEls[passEls.length - 1], pw);
    }, { un: String(SALONBIZ_USERNAME), pw: String(SALONBIZ_PASSWORD) });
    const submitBtn = page.locator('button[type="submit"]:has-text("Log in"), button:has-text("Log in")').first();
    await submitBtn.click({ timeout: 10000 });
    await page.waitForTimeout(4000);
  };

  // Check 1: Are we on the full login page?
  const onLoginPage = page.url().includes("/login") || (await page.locator('input[formcontrolname="password"]').count() > 0 && await page.locator('input[formcontrolname="username"]').count() > 0);
  if (onLoginPage) {
    console.log("[login] On login page, logging in fresh");
    cookieState = null; // force clear cached cookies
    await doLogin();
    return;
  }

  // Check 2: Session timeout modal (inline re-auth modal)
  const modal = page.locator("ngb-modal-window");
  const modalVisible = await modal.isVisible().catch(() => false);
  if (modalVisible) {
    const hasPassInput = (await modal.locator('input[type="password"], input[formcontrolname="password"]').count()) > 0;
    if (hasPassInput) {
      console.log("[login] Session timeout modal detected, re-logging in");
      cookieState = null;
      await doLogin();
      return;
    }
  }

  // Check 3: Re-navigate and check again (handles redirect-to-login)
  const currentUrl = page.url();
  if (!currentUrl.includes("appointmentbook")) {
    console.log("[login] Not on appointmentbook, URL:", currentUrl, "- trying login again");
    cookieState = null;
    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    if (page.url().includes("/login") || (await page.locator('input[formcontrolname="password"]').count() > 0)) {
      await doLogin();
    }
    return;
  }

  // Already logged in — nothing to do
  console.log("[login] Already on appointmentbook, session valid");
}
async function clickPinkCreateButton(page) {
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  await page.mouse.click(Math.floor(vp.width * CREATE_CLICK_X_PCT), Math.floor(vp.height * CREATE_CLICK_Y_PCT));
  await page.waitForTimeout(1200);
}

async function clickClientCreateButton(page) {
  // Click the "Create" button in the client search panel to open the new client form
  const panel = page.locator("sbiz-book-right-panel");
  const btn = panel.locator('sbiz-search-client button:has-text("Create")').last();
  const btnVisible = await btn.isVisible().catch(() => false);
  if (btnVisible) {
    await btn.click({ timeout: 10000 });
    await page.waitForTimeout(1200);
    return;
  }
  // Fallback: try any Create button in the panel
  const anyBtn = panel.locator('button:has-text("Create")').first();
  if (await anyBtn.isVisible().catch(() => false)) {
    await anyBtn.click({ timeout: 10000 });
    await page.waitForTimeout(1200);
  }
}

async function ensureCreatePanelOpen(page) {
  const si = page.locator("sbiz-book-right-panel").locator('input[formcontrolname="service"]').first();
  if (await si.isVisible().catch(() => false)) return si;
  await clickPinkCreateButton(page);
  await si.waitFor({ state: "visible", timeout: 20000 });
  return si;
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
  const queries = [...("abcdefghijklmnopqrstuvwxyz".split("")), ...("0123456789".split(""))];
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

async function readDisplayedDate(page) {
  const candidates = [
    'sbiz-date-picker input[type="date"]',
    'sbiz-date-picker input',
    'input[formcontrolname="date"]',
    ".appointment-book-date"
  ];
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if ((await el.count().catch(() => 0)) === 0) continue;
    const val = await el.inputValue().catch(async () => el.innerText().catch(() => ""));
    if (!val) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(val.trim())) return val.trim();
    const mdy = val.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,"0")}-${mdy[2].padStart(2,"0")}`;
  }
  return "";
}

async function stepToDateViaArrows(page, targetDateStr) {
  const target = new Date(targetDateStr + "T12:00:00");
  const prevSel = ['button[aria-label*="previous" i]', 'button[aria-label*="prev" i]', ".sbiz-prev-day"].join(", ");
  const nextSel = ['button[aria-label*="next" i]', ".sbiz-next-day", ".next-day"].join(", ");
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
  await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook?date=${dateStr}`, { waitUntil: "domcontentloaded" });
  // Re-login if we got redirected to login page
  if (page.url().includes("/login") || (await page.locator('input[formcontrolname="username"]').count() > 0)) {
    console.log("[navigateToDate] Redirected to login, re-authenticating");
    cookieState = null;
    await loginIfNeeded(page);
    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook?date=${dateStr}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(1000);
  if ((await readDisplayedDate(page)) === dateStr) return;
  const pickers = ['input[formcontrolname="date"]', 'input[type="date"]', ".sbiz-datepicker input", "sbiz-date-picker input"];
  for (const sel of pickers) {
    const inp = page.locator(sel).first();
    if ((await inp.count().catch(() => 0)) === 0) continue;
    if (!(await inp.isVisible().catch(() => false))) continue;
    await inp.click({ timeout: 10000 });
    await page.keyboard.press("Control+a");
    await page.keyboard.type(dateStr, { delay: 30 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);
    if ((await readDisplayedDate(page)) === dateStr) return;
    break;
  }
  await stepToDateViaArrows(page, dateStr);
}

async function navigateToBookingDate(page, dateStr) {
  await navigateToDate(page, dateStr);
  await page.waitForTimeout(1000);
  await ensureCreatePanelOpen(page);
  await page.waitForTimeout(800);
}

async function buildTimeMap(page) {
  const timeLabels = [];
  const selectors = [".time-label", ".sbiz-time-label", "[class*='time-label']", "[class*='time-slot-label']", "sbiz-time-column span", "sbiz-time-column div"];
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
    const a = timeMap[timeMap.length - 2], b = timeMap[timeMap.length - 1];
    return Math.round(a.minutes + ((y - a.y) / (b.y - a.y)) * (b.minutes - a.minutes));
  }
  if (y <= timeMap[0].y) {
    const a = timeMap[0], b = timeMap[1];
    return Math.round(a.minutes + ((y - a.y) / (b.y - a.y)) * (b.minutes - a.minutes));
  }
  for (let i = 0; i < timeMap.length - 1; i++) {
    const a = timeMap[i], b = timeMap[i + 1];
    if (y >= a.y && y <= b.y) return Math.round(a.minutes + ((y - a.y) / (b.y - a.y)) * (b.minutes - a.minutes));
  }
  return null;
}

async function extractNotWorkingPeriods(columnLocator, timeMap) {
  const periods = [];
  const blocks = await columnLocator.locator("div").all().catch(() => []);
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
  const headers = await page.locator("sbiz-provider-header, .provider-header, [class*='column-header']").all().catch(() => []);
  const allDivs = await page.locator("div").all().catch(() => []);
  const nwFiltered = [];
  for (const b of allDivs) {
    const t = await b.innerText().catch(() => "");
    if (/not working/i.test(t)) {
      const bb = await b.boundingBox().catch(() => null);
      if (bb && bb.height > 5) nwFiltered.push({ bb });
    }
  }
  for (const header of headers) {
    const rawName = await header.innerText().catch(() => "");
    const firstName = String(rawName || "").trim().split(/\s+/)[0];
    if (!firstName || rawName.toLowerCase().includes("head spa")) continue;
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
    const totalBlocked = notWorkingPeriods.reduce((s, p) => s + Math.max(0, p.endMin - p.startMin), 0);
    schedule[firstName] = {
      isWorking: notWorkingPeriods.length === 0 || totalBlocked < 4 * 60,
      notWorkingPeriods,
      rawName: rawName.trim()
    };
  }
}

async function scrapeScheduleForDate(page, dateStr) {
  await navigateToDate(page, dateStr);
  await page.waitForTimeout(2000);
  const timeMap = await buildTimeMap(page);
  const schedule = {};
  const colSelectors = ["sbiz-provider-column", ".provider-column", ".stylist-column", "[class*='provider-col']"];
  let columnEls = null;
  for (const sel of colSelectors) {
    if ((await page.locator(sel).count().catch(() => 0)) > 0) { columnEls = page.locator(sel); break; }
  }
  if (columnEls) {
    const colCount = await columnEls.count();
    for (let i = 0; i < colCount; i++) {
      const col = columnEls.nth(i);
      const rawName = await col.locator(".provider-name, .stylist-name, sbiz-provider-header, [class*='provider-name'], h4, h3, .name").first().innerText().catch(() => "");
      const firstName = String(rawName || "").trim().split(/\s+/)[0];
      if (!firstName || rawName.toLowerCase().includes("head spa")) continue;
      const notWorkingPeriods = await extractNotWorkingPeriods(col, timeMap);
      const totalBlocked = notWorkingPeriods.reduce((s, p) => s + Math.max(0, p.endMin - p.startMin), 0);
      schedule[firstName] = {
        isWorking: notWorkingPeriods.length === 0 || totalBlocked < 4 * 60,
        notWorkingPeriods,
        rawName: rawName.trim()
      };
    }
  } else {
    await scrapeScheduleFallback(page, timeMap, schedule);
  }
  return schedule;
}

function checkStylistAvailability(scheduleMap, stylistFirstName, startTimeStr) {
  if (!scheduleMap || !stylistFirstName) return { available: true, reason: "no schedule data" };
  // Fuzzy name matching: exact match first, then starts-with, then includes
  const nameLower = stylistFirstName.toLowerCase().replace(/[^a-z]/g, '');
  const key = Object.keys(scheduleMap).find(k => k.toLowerCase().replace(/[^a-z]/g,'') === nameLower)
    || Object.keys(scheduleMap).find(k => k.toLowerCase().replace(/[^a-z]/g,'').startsWith(nameLower.slice(0,4)))
    || Object.keys(scheduleMap).find(k => nameLower.startsWith(k.toLowerCase().replace(/[^a-z]/g,'').slice(0,4)));
  if (!key) return { available: false, reason: `${stylistFirstName} does not appear on the schedule for that day.` };
  const entry = scheduleMap[key];
  if (!entry.isWorking) return { available: false, reason: `${stylistFirstName} is not working that day.` };
  const requestedMin = parseTimeToMinutes(startTimeStr);
  if (requestedMin !== null) {
    for (const period of entry.notWorkingPeriods) {
      if (requestedMin >= period.startMin && requestedMin < period.endMin) {
        return { available: false, reason: `${stylistFirstName} is not working at ${startTimeStr} (blocked ${minutesToTimeStr(period.startMin)}-${minutesToTimeStr(period.endMin)}).` };
      }
    }
  }
  return { available: true };
}

async function getScheduleCached(dateStr) {
  const entry = scheduleCache.get(dateStr);
  if (!scheduleExpired(entry)) return { schedule: entry.data, cached: true, cacheAgeMs: Date.now() - entry.fetchedAt };
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
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

async function fetchStylistsFromSalonBiz() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const { context, page } = await getPage(browser);
  let step = "start";
  try {
    if (cookiesExpired()) cookieState = null;
    step = "login"; await loginIfNeeded(page); await saveCookies(context);
    step = "openPanel";
    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await ensureCreatePanelOpen(page);
    step = "scrapeStaff";
    const staffInput = page.locator("sbiz-book-right-panel").locator('input[formcontrolname="staff"]').first();
    await staffInput.waitFor({ state: "visible", timeout: 20000 });
    const stylistsRaw = await scrapeTypeaheadUniverse(staffInput, page);
    const filtered = stylistsRaw.filter(n => n && !n.toLowerCase().includes("head spa") && !n.toLowerCase().startsWith("denise"));
    const cleaned = filtered.map(n => n.trim().split(/\s+/)[0]).filter(Boolean);
    return Array.from(new Set(cleaned));
  } catch (e) {
    console.error("fetchStylistsFromSalonBiz error at step:", step, e);
    await page.screenshot({ path: "/tmp/stylists_error.png", fullPage: true }).catch(() => {});
    throw new Error(`${step}: ${e?.message || String(e)}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function getStylistsCached() {
  const now = Date.now();
  if (stylistCache.value && stylistCache.value.length > 0 && now - stylistCache.fetchedAt < STYLIST_CACHE_TTL_MS) {
    return { stylists: stylistCache.value, cached: true, cacheAgeMs: now - stylistCache.fetchedAt };
  }
  const stylists = await fetchStylistsFromSalonBiz();
  stylistCache = { value: stylists, fetchedAt: now };
  return { stylists, cached: false, cacheAgeMs: 0 };
}

function extractToolCall(req) {
  return req.body?.message?.toolCallList?.[0] || req.body?.message?.toolCalls?.[0] || null;
}
function extractToolCallId(req) { return extractToolCall(req)?.id || null; }
function extractArgs(req) {
  const toolCall = extractToolCall(req);
  const raw = toolCall?.function?.arguments;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return {}; } }
  return {};
}
function vapiRespond(res, toolCallId, result, statusCode = 200) {
  // Always use 200 so Vapi can read the result (non-2xx causes "No result returned")
  return res.status(200).json({ results: [{ toolCallId, result }] });
}
function vapiError(res, toolCallId, message, statusCode = 200) {
  // Always return 200 so Vapi can read the error message and tell the user
  return vapiRespond(res, toolCallId, { ok: false, error: message }, 200);
}

// ── Booking helpers ────────────────────────────────────────────

async function selectService(page, serviceStr) {
  const panel = page.locator("sbiz-book-right-panel");
  const serviceInput = panel.locator('input[formcontrolname="service"]').first();

  // Wait for service input to be visible
  await serviceInput.waitFor({ state: "visible", timeout: 15000 });
  await serviceInput.click({ timeout: 15000 });
  await serviceInput.fill("");
  await serviceInput.type(String(serviceStr), { delay: 25 });
  await page.waitForTimeout(1000);

  // Check if a dropdown appeared
  const dropdown = page.locator("ngb-typeahead-window.dropdown-menu.show").first();
  const dropdownVisible = await dropdown.isVisible().catch(() => false);

  if (dropdownVisible) {
    // Try to find the best matching option
    const items = dropdown.locator("button.dropdown-item");
    const count = await items.count().catch(() => 0);
    const serviceNameLower = serviceStr.toLowerCase();
    let clicked = false;
    for (let i = 0; i < count; i++) {
      const text = (await items.nth(i).innerText().catch(() => "")).toLowerCase();
      if (text.includes(serviceNameLower) || serviceNameLower.includes(text.replace(/\s+/g,' ').trim().substring(0,10))) {
        await items.nth(i).click({ timeout: 10000 });
        clicked = true;
        console.log("[selectService] Clicked typeahead item:", text);
        break;
      }
    }
    if (!clicked && count > 0) {
      await items.first().click({ timeout: 10000 });
      console.log("[selectService] Clicked first typeahead item as fallback");
    }
  } else {
    // Try keyboard: ArrowDown + Enter
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    console.log("[selectService] Used ArrowDown+Enter fallback");
  }

  await page.waitForTimeout(500);
}
async function selectExistingClient(page, nameStr, phoneStr) {
  const panel = page.locator("sbiz-book-right-panel");
  const { firstName, lastName } = splitName(nameStr);
  const phoneDigits = digitsOnly(phoneStr || '').slice(-10);
  const inlineInput = panel.locator('input[placeholder="Search by name or contact"]').first();
  await inlineInput.waitFor({ state: "visible", timeout: 15000 });
  await inlineInput.click(); await inlineInput.fill("");
  await inlineInput.type(lastName || firstName, { delay: 25 });
  await page.waitForTimeout(300);
  const inlineSearchBtn = panel.locator('sbiz-search-client button:has-text("Search")').first();
  await inlineSearchBtn.click({ timeout: 10000 });
  await page.waitForTimeout(1500);
  const modal = page.locator("ngb-modal-window").first();
  await modal.waitFor({ state: "visible", timeout: 12000 });
  await page.waitForTimeout(800);
  const modalSearchBtn = modal.locator('button:has-text("Search")').first();
  const fnField = modal.locator('input[formcontrolname="firstName"]').first();
  const lnField = modal.locator('input[formcontrolname="lastName"]').first();
  const ctField = modal.locator('input[formcontrolname="contact"]').first();
  const setF = async (loc, val) => {
    if (!(await loc.isVisible().catch(()=>false))) return;
    await loc.evaluate((el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},String(val));
    await page.waitForTimeout(80);
  };
  if (phoneDigits.length >= 7) {
    await setF(fnField,''); await setF(lnField,''); await setF(ctField, phoneDigits);
    if (await ctField.isVisible().catch(()=>false)) { await ctField.click({clickCount:3}); await ctField.type(phoneDigits,{delay:20}); }
    await page.waitForTimeout(200);
    await modalSearchBtn.click({timeout:10000}); await page.waitForTimeout(3000);
  }
  const rows = modal.locator("table tbody tr");
  let rowCount = await rows.count().catch(()=>0);
  console.log("[selectClient] Phone rows:", rowCount);
  if (rowCount === 0) {
    await setF(fnField,firstName); await setF(lnField,lastName); await setF(ctField,'');
    if (await fnField.isVisible().catch(()=>false)) { await fnField.click({clickCount:3}); await fnField.type(firstName,{delay:20}); }
    if (await lnField.isVisible().catch(()=>false)) { await lnField.click({clickCount:3}); await lnField.type(lastName,{delay:20}); }
    await page.waitForTimeout(200);
    await modalSearchBtn.click({timeout:10000}); await page.waitForTimeout(3000);
    rowCount = await rows.count().catch(()=>0);
    console.log("[selectClient] Name rows:", rowCount);
  }
  if (rowCount === 0) {
    await page.screenshot({path:"/tmp/client_search_failed.png",fullPage:true}).catch(()=>{});
    await modal.locator('button:has-text("Close"),button[aria-label="Close"]').first().evaluate(el=>el.click()).catch(()=>page.keyboard.press("Escape"));
    await page.waitForTimeout(500);
    throw new Error('Client not found: "'+nameStr+'" phone:'+phoneStr);
  }
  let bestRow = 0;
  if (phoneDigits.length >= 7) {
    const sp = phoneDigits.slice(-7);
    for (let i=0;i<rowCount;i++){const t=await rows.nth(i).innerText().catch(()=>"");if(digitsOnly(t).includes(sp)){bestRow=i;break;}}
  }
  console.log("[selectClient] Clicking row", bestRow, "of", rowCount);
  await page.screenshot({path:"/tmp/client_search_failed.png",fullPage:true}).catch(()=>{});
  const rowEl = rows.nth(bestRow);
  await rowEl.scrollIntoViewIfNeeded().catch(()=>{});
  await page.waitForTimeout(300);
  // Use real Playwright click (moves mouse, fires all events Angular needs)
  await rowEl.click({timeout:8000});
  await page.waitForTimeout(1000);
  const selBtn = modal.locator('button:has-text("Select")').last();
  if (await selBtn.isVisible().catch(()=>false)) {
    await selBtn.click({timeout:8000}); console.log("[selectClient] Select clicked");
  } else {
    await rowEl.dblclick({timeout:5000}).catch(()=>{});
    await page.waitForTimeout(800);
    const sb2 = modal.locator('button:has-text("Select")').last();
    if (await sb2.isVisible().catch(()=>false)) { await sb2.click({timeout:5000}); console.log("[selectClient] Select after dblclick"); }
    else { await modal.locator('button:has-text("Select")').last().click({timeout:3000,force:true}).catch(()=>{}); console.log("[selectClient] Force-clicked Select"); }
  }
  const closed = await modal.waitFor({state:"hidden",timeout:15000}).then(()=>true).catch(()=>false);
  if (!closed) {
    console.warn("[selectClient] Modal still open, retry Select");
    await modal.locator('button:has-text("Select")').last().click({timeout:3000,force:true}).catch(()=>{});
    await page.waitForTimeout(2000);
    if (await modal.isVisible().catch(()=>true)) {
      await page.screenshot({path:"/tmp/client_search_failed.png",fullPage:true}).catch(()=>{});
      throw new Error('Could not select client — Select button did not close modal');
    }
  }
  await page.waitForTimeout(600);
  console.log("[selectClient] Complete");
}
async function createNewClientInModal(page, { customerName, customerPhone, customerEmail }) {
  const modal = page.locator("ngb-modal-window").first();
  await modal.waitFor({state:"visible",timeout:20000});
  const { firstName, lastName } = splitName(customerName);
  if (!firstName||!lastName) throw new Error("New client requires first AND last name.");
  const fill = async (loc,val) => {
    await loc.waitFor({state:"visible",timeout:8000});
    await loc.scrollIntoViewIfNeeded().catch(()=>{});
    await loc.evaluate((el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}));s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}));},String(val));
    await page.waitForTimeout(100);
    const actual=await loc.inputValue().catch(()=>'');
    if(actual!==String(val)){await loc.click({clickCount:3});await page.keyboard.press('Control+a');await page.keyboard.press('Delete');await loc.type(String(val),{delay:20});await loc.press('Tab');await page.waitForTimeout(150);}
  };
  await modal.evaluate(el=>{const b=el.querySelector('.modal-body,.sbiz-modal__body,.modal-content');if(b)b.scrollTop=0;el.scrollTop=0;}).catch(()=>{});
  await page.waitForTimeout(300);
  const fnI=modal.locator('input[formcontrolname="firstName"]').first();
  const lnI=modal.locator('input[formcontrolname="lastName"]').first();
  const telI=modal.locator('input[formcontrolname="telMobile"]').first();
  await fill(fnI,firstName); await fill(lnI,lastName); await fill(telI,formatUsPhoneMaybe(customerPhone));
  if(customerEmail&&isValidEmail(customerEmail)){const eI=modal.locator('input[formcontrolname="email"]').first();if(await eI.isVisible().catch(()=>false))await fill(eI,customerEmail);}
  await page.waitForTimeout(600);
  await page.screenshot({path:"/tmp/new_client_before_create.png",fullPage:true}).catch(()=>{});
  const createBtn=modal.locator('button:has-text("Create")').last();
  await createBtn.scrollIntoViewIfNeeded().catch(()=>{}); await page.waitForTimeout(300);
  await createBtn.click({timeout:10000}); await page.waitForTimeout(3500);
  let open=await modal.isVisible().catch(()=>false);
  if(open){
    await page.screenshot({path:"/tmp/new_client_submit_failed.png",fullPage:true}).catch(()=>{});
    const allText=await modal.innerText().catch(()=>'');
    const errs=await modal.locator('.sbiz-alert,.alert-danger,.invalid-feedback,.text-danger,[class*="error"]').allInnerTexts().catch(()=>[]);
    const et=(errs.join(' ')+' '+allText).toLowerCase();
    console.log("[createNew] Modal still open. Error hints:", et.substring(0,150));
    // If duplicate or phone conflict — close and signal to use existing client
    if(et.includes('already')||et.includes('exist')||et.includes('duplicate')||et.includes('phone')||et.includes('mobile')||et.includes('contact')||et.includes('found')){
      await modal.locator('button:has-text("Close"),button[aria-label="Close"]').first().click({timeout:5000}).catch(()=>page.keyboard.press("Escape"));
      await page.waitForTimeout(500); throw new Error("DUPLICATE_CLIENT");
    }
    // No visible error but modal still open — likely silent duplicate rejection
    // Try one more click
    await fill(fnI,firstName); await fill(lnI,lastName); await fill(telI,formatUsPhoneMaybe(customerPhone));
    await page.waitForTimeout(400); await createBtn.click({timeout:10000}).catch(()=>{}); await page.waitForTimeout(3000);
    open=await modal.isVisible().catch(()=>false);
  }
  if(open){await page.keyboard.press("Enter");await page.waitForTimeout(2500);open=await modal.isVisible().catch(()=>false);}
  if(open){
    // Still open — assume silent duplicate block, switch to selecting existing
    console.warn("[createNew] Still open after all retries — treating as DUPLICATE_CLIENT");
    await page.screenshot({path:"/tmp/new_client_submit_failed.png",fullPage:true}).catch(()=>{});
    await modal.locator('button:has-text("Close"),button[aria-label="Close"]').first().click({timeout:5000}).catch(()=>page.keyboard.press("Escape"));
    await page.waitForTimeout(500); throw new Error("DUPLICATE_CLIENT");
  }
  await modal.waitFor({state:"hidden",timeout:20000}).catch(()=>{});
  await page.waitForTimeout(800);
  console.log("[createNew] Complete");
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
      if (visible) { await btn.click({ timeout: 15000 }); return true; }
    }
  }
  return false;
}

async function checkForBlockedBanner(page) {
  await page.waitForTimeout(1200);
  const blockedBanner = page.locator("text=/blocked by/i").first();
  const isBlocked = await blockedBanner.isVisible().catch(() => false);
  if (isBlocked) {
    const bannerText = await blockedBanner.innerText().catch(() => "Blocked by staff");
    return { blocked: true, reason: bannerText };
  }
  return { blocked: false };
}

/**
 * Core booking function - runs the full Playwright booking flow.
 */
async function runBooking(page, { isNewClient, customerName, customerPhone, customerEmail, service, stylist, startTime, startDate, customDuration, requestReason }) {
  if (!startDate) throw new Error("startDate is required in YYYY-MM-DD format");

  await navigateToBookingDate(page, startDate);

  if (isNewClient) {
    await clickClientCreateButton(page);
    await createNewClientInModal(page, { customerName, customerPhone, customerEmail });
  } else {
    // Strategy 1: Find existing client by name + phone
    let clientFound = false;
    try {
      await selectExistingClient(page, customerName, customerPhone);
      clientFound = true;
      console.log("[runBooking] Found existing client:", customerName);
    } catch (e) {
      console.log("[runBooking] selectExistingClient failed:", e.message);
      await page.screenshot({ path: "/tmp/client_search_failed.png", fullPage: true }).catch(() => {});
    }

    if (!clientFound) {
      // Strategy 2: Re-navigate and try selectExistingClient again (fresh state)
      console.log("[runBooking] Retrying client search...");
      await navigateToBookingDate(page, startDate);
      try {
        await selectExistingClient(page, customerName, customerPhone);
        clientFound = true;
        console.log("[runBooking] Found existing client on retry:", customerName);
      } catch (e2) {
        console.log("[runBooking] Retry also failed:", e2.message);
      }
    }

    if (!clientFound) {
      // Strategy 3: Create as new client (they may be genuinely new, or search may have failed)
      console.log("[runBooking] Creating client as new:", customerName);
      await navigateToBookingDate(page, startDate);
      await clickClientCreateButton(page);
      try {
        await createNewClientInModal(page, { customerName, customerPhone, customerEmail: customerEmail || "" });
      } catch (createErr) {
        // Check if it's a duplicate client error - if so, try selecting existing
        if (String(createErr.message).includes('DUPLICATE_CLIENT')) {
          console.log("[runBooking] Duplicate client detected, trying to select existing...");
          await navigateToBookingDate(page, startDate);
          await selectExistingClient(page, customerName, customerPhone);
        } else {
          throw createErr;
        }
      }
    }
  }

  const panel = page.locator("sbiz-book-right-panel");
  await selectService(page, service);
  if (stylist) await typeaheadSelect(panel.locator('input[formcontrolname="staff"]').first(), stylist);
  await setTextInput(panel.locator('input[formcontrolname="startTime"]').first(), startTime);
  await setTextInput(panel.locator('input[formcontrolname="customDuration"]').first(), customDuration);
  if (requestReason) {
    await setTextInput(panel.locator('input[formcontrolname="requestReason"]').first(), requestReason).catch(() => {});
  }
  await panel.evaluate(el => { const sc = el.querySelector(".scrollable"); if (sc) sc.scrollTop = sc.scrollHeight; }).catch(() => {});

  const preCheck = await checkForBlockedBanner(page);
  if (preCheck.blocked) {
    return { clickedFinalCreate: false, blocked: true, reason: preCheck.reason };
  }

  const clicked = await clickFinalAppointmentCreate(page);
  if (!clicked) {
    return { clickedFinalCreate: false, blocked: false };
  }

  const postCheck = await checkForBlockedBanner(page);
  if (postCheck.blocked) {
    return { clickedFinalCreate: true, blocked: true, reason: postCheck.reason };
  }

  return { clickedFinalCreate: true, blocked: false };
}
// ── Schedule-aware time suggestion helper ─────────────────────
// Returns available time slots for a stylist on a date within a given range
async function getSuggestedTime(dateStr, startHour, endHour, stylistFirstName) {
  try {
    const { schedule } = await getScheduleCached(dateStr);
    const candidates = [];
    // Generate 30-min slots within the range
    for (let h = startHour; h < endHour; h++) {
      for (const mn of [0, 30]) {
        const totalMin = h * 60 + mn;
        const timeStr = minutesToTimeStr(totalMin);
        // Check if stylist is available at this time (or any stylist if none specified)
        if (stylistFirstName) {
          const check = checkStylistAvailability(schedule, stylistFirstName, timeStr);
          if (check.available) candidates.push({ time: timeStr, stylist: stylistFirstName });
        } else {
          // Find any available stylist at this time
          for (const [name, data] of Object.entries(schedule)) {
            if (name.toLowerCase().startsWith('denise')) continue; // exclude Denise
            const check = checkStylistAvailability(schedule, name, timeStr);
            if (check.available) { candidates.push({ time: timeStr, stylist: name }); break; }
          }
        }
      }
    }
    return candidates;
  } catch (e) {
    console.warn('[getSuggestedTime] Failed:', e.message);
    return [];
  }
}

// ── HTTP Routes ────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ ok: true, now: new Date().toISOString() }));
app.get("/debug/ping", (req, res) => res.json({ ok: true, msg: "pong" }));

app.post("/services", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  if (!PHONE_BOOKABLE_SERVICES.size) return vapiError(res, toolCallId, "PHONE_BOOKABLE_SERVICES env var is empty.");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const { context, page } = await getPage(browser);
  let step = "start";
  try {
    if (cookiesExpired()) cookieState = null;
    step = "login"; await loginIfNeeded(page); await saveCookies(context);
    step = "openPanel";
    await page.goto(`${SALONBIZ_BASE_URL}/appointmentbook`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const serviceInput = await ensureCreatePanelOpen(page);
    step = "scrapeServices";
    const allServices = await scrapeTypeaheadUniverse(serviceInput, page);
    const phoneBookable = allServices.filter(s => PHONE_BOOKABLE_SERVICES.has(s));
    return vapiRespond(res, toolCallId, { ok: true, countAll: allServices.length, countPhoneBookable: phoneBookable.length, services: phoneBookable });
  } catch (e) {
    console.error("SERVICES error at step:", step, e);
    await page.screenshot({ path: "/tmp/services_error.png", fullPage: true }).catch(() => {});
    return vapiRespond(res, toolCallId, { ok: false, step, error: e?.message || String(e), debug: "/debug/services_error.png" }, 500);
  } finally {
    await context.close().catch(() => {}); await browser.close().catch(() => {});
  }
});

app.post("/stylists", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  try {
    const { stylists, cached, cacheAgeMs } = await getStylistsCached();
    return vapiRespond(res, toolCallId, { ok: true, cached, cacheAgeMs, count: stylists.length, stylists });
  } catch (e) {
    console.error("STYLISTS error:", e);
    return vapiRespond(res, toolCallId, { ok: false, error: e?.message || String(e), debug: "/debug/stylists_error.png" }, 500);
  }
});

app.post("/schedule", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);
  const dateStr = args.date || args.startDate || todayStr();

  try {
    // Get the cached stylist list (excluding Denise)
    const { stylists } = await getStylistsCached();

    // Build schedule from stylist list — all available unless scrape shows otherwise
    const defaultSchedule = stylists.map(name => ({
      name,
      isWorking: true,
      notWorkingPeriods: []
    }));

    // Check apptCache for scraped appointment data (populated by background warmer)
    const cached = apptCache.get(dateStr);
    if (cached && Date.now() - cached.fetchedAt < APPT_CACHE_TTL_MS) {
      console.log('[schedule] Serving from apptCache for', dateStr);
      return vapiRespond(res, toolCallId, {
        ok: true,
        date: dateStr,
        stylistCount: defaultSchedule.length,
        schedule: defaultSchedule,
        note: 'from-cache'
      });
    }

    // Cache is cold — return immediately with default schedule and trigger background scrape
    console.log('[schedule] Cache cold for', dateStr, '- returning default, warming in background');
    setImmediate(() => warmApptCacheForDate(dateStr).catch(e => console.warn('[schedule] bg warm failed:', e.message)));

    return vapiRespond(res, toolCallId, {
      ok: true,
      date: dateStr,
      stylistCount: defaultSchedule.length,
      schedule: defaultSchedule,
      note: 'from-cache'
    });
  } catch (e) {
    console.error("SCHEDULE error:", e);
    return vapiRespond(res, toolCallId, { ok: false, error: e?.message || String(e) }, 500);
  }
});

app.post("/availability", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);
  const service = args.service || "";
  let stylist = args.stylist || undefined;
  const startTime = args.startTime || args.time || "";
  const startDate = args.startDate || args.date || "";

  if (!service) return vapiError(res, toolCallId, "service required");
  if (!startTime) return vapiError(res, toolCallId, "startTime required (e.g. '5:00 PM')");
  if (!startDate) return vapiError(res, toolCallId, "startDate required (YYYY-MM-DD). The assistant must compute the actual date.");

  if (stylist) {
    try {
      const { schedule } = await getScheduleCached(startDate);
      const check = checkStylistAvailability(schedule, stylist, startTime);
      if (!check.available) {
        return vapiRespond(res, toolCallId, { ok: true, available: false, reason: check.reason, startDate, method: "schedule" });
      }
    } catch (e) {
      console.warn("Schedule check failed (non-fatal), falling back to panel check:", e?.message);
    }
  }

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const { context, page } = await getPage(browser);
  let step = "start";
  try {
  cookieState = null; // Always force fresh login for booking
    step = "login"; await loginIfNeeded(page); await saveCookies(context);
    step = "navigateToDate";
    await navigateToBookingDate(page, startDate);
    const panel = page.locator("sbiz-book-right-panel");
    step = "setService";
    await typeaheadSelect(panel.locator('input[formcontrolname="service"]').first(), service);
    if (stylist) {
      step = "setStaff";
      await typeaheadSelect(panel.locator('input[formcontrolname="staff"]').first(), stylist);
    }
    step = "setTime";
    await setTextInput(panel.locator('input[formcontrolname="startTime"]').first(), startTime);
    step = "detectBlocked";
    const bannerCheck = await checkForBlockedBanner(page);
    if (bannerCheck.blocked) {
      return vapiRespond(res, toolCallId, { ok: true, available: false, reason: bannerCheck.reason, startDate, method: "panel" });
    }
    return vapiRespond(res, toolCallId, { ok: true, available: true, startDate, method: "panel" });
  } catch (e) {
    console.error("AVAILABILITY error at step:", step, e);
    await page.screenshot({ path: "/tmp/availability_error.png", fullPage: true }).catch(() => {});
    return vapiRespond(res, toolCallId, { ok: false, step, error: e?.message || String(e), debug: "/debug/availability_error.png" }, 500);
  } finally {
    await context.close().catch(() => {}); await browser.close().catch(() => {});
  }
});

/**
 * POST /book  ── SYNCHRONOUS VERSION
 *
 * Runs the full Playwright booking inline and returns the final result
 * (ok:true = booked, ok:false = failed/blocked) before responding.
 *
 * The assistant does NOT need to poll /book/status anymore.
 * It simply calls /book, waits for the response, then tells the customer.
 */
app.post("/book", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);
  const isNewClient = Boolean(args.isNewClient);
  const customerName = args.customerName || args.name || "";
  const customerPhone = args.customerPhone || args.phone || "";
  const customerEmail = normalizeEmail(args.customerEmail || args.email || "");
  const service = args.service || "";
  let stylist = args.stylist || undefined;
  const startTime = normalizeStartTime(args.startTime || args.time || "");
const startDate = resolveStartDate(args.startDate || args.date || "", startTime);
  const customDuration = String(args.customDuration || "60");
  const requestReason = args.requestReason || args.notes || undefined;

  // ── Validation ──────────────────────────────────────────────
  if (!customerName) return vapiError(res, toolCallId, "customerName required");
  if (!customerPhone) return vapiError(res, toolCallId, "customerPhone required");
  // Always require first AND last name — needed for client search AND new client creation
  { const { firstName: _fn, lastName: _ln } = splitName(customerName);
    if (!_fn || !_ln) return vapiError(res, toolCallId, "Please provide the customer's first AND last name to complete the booking."); }
  if (!service) return vapiError(res, toolCallId, "service required");
    if (PHONE_BOOKABLE_SERVICES.size) {
    // Fuzzy match: accept if any bookable service contains the requested service name (case-insensitive)
    const svcLower = service.toLowerCase();
    const fuzzyMatch = [...PHONE_BOOKABLE_SERVICES].find(s => 
      s.toLowerCase().includes(svcLower) || svcLower.includes(s.toLowerCase().split(' with ')[0].toLowerCase())
    );
    if (!fuzzyMatch) {
      return vapiError(res, toolCallId, `Service "${service}" is not phone-bookable. Choose a different service.`);
    }
    // Use the exact matched service name if the bot gave a generic name
    if (service !== fuzzyMatch && !PHONE_BOOKABLE_SERVICES.has(service)) {
      console.log(`[book] Fuzzy matched service "${service}" -> "${fuzzyMatch}"`);
    }
  }
  if (!startTime) return vapiError(res, toolCallId, "startTime required (e.g., '2:00 PM')");
  if (!startDate) return vapiError(res, toolCallId, "startDate is missing. Please provide the appointment date in YYYY-MM-DD format.");

  // ── Schedule pre-check ──────────────────────────────────────
  if (stylist) {
    try {
      const { schedule } = await getScheduleCached(startDate);
      const check = checkStylistAvailability(schedule, stylist, startTime);
      if (!check.available) {
        // Schedule pre-check is informational only - let Playwright determine actual availability
      console.warn("[book] Schedule pre-check says unavailable:", check.reason, "- attempting booking anyway");
      }
    } catch (e) {
      console.warn("Schedule pre-check failed (non-fatal):", e?.message);
    }
  }
    // Auto-select available stylist when none provided
    if (!stylist) {
          try {
                  const { schedule } = await getScheduleCached(startDate);
                  const reqMin = parseTimeToMinutes(startTime);
                  const avail = Object.entries(schedule).filter(([n, d]) => {
                            if (!d.isWorking) return false;
                            if (reqMin === null) return true;
                            return !d.notWorkingPeriods.some(p => reqMin >= p.startMin && reqMin < p.endMin);
                  });
                  if (avail.length > 0) {
                            const pick = avail[Math.floor(Math.random() * avail.length)];
                            stylist = pick[0];
                            console.log('[book] Auto-selected stylist:', stylist);
                  }
          } catch (e) {
                  console.warn('Auto-stylist failed:', e?.message);
          }
    }

  // ── Run booking synchronously ───────────────────────────────
  // We set a timeout so we don't hang forever
  const timeoutMs = BOOK_TIMEOUT_MS;
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const { context, page } = await getPage(browser);
  let step = "start";

  // Set a longer timeout on the page for the full booking flow
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    if (cookiesExpired()) cookieState = null;
    step = "login"; await loginIfNeeded(page); await saveCookies(context);
    step = "runBooking";

    // Run with an overall timeout
    const result = await Promise.race([
      runBooking(page, { isNewClient, customerName, customerPhone, customerEmail, service, stylist, startTime, startDate, customDuration, requestReason }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Booking timed out after " + timeoutMs / 1000 + "s")), timeoutMs))
    ]);

    await page.screenshot({ path: "/tmp/appt_after.png", fullPage: true }).catch(() => {});

    if (result.blocked) {
      await page.screenshot({ path: "/tmp/appt_blocked.png", fullPage: true }).catch(() => {});
      return vapiRespond(res, toolCallId, {
        ok: false,
        booked: false,
        reason: `Time is blocked: ${result.reason}`,
        message: "That time is not available. Please suggest a different time or stylist.",
        debugScreenshot: "/debug/appt_blocked.png"
      });
    }

    if (!result.clickedFinalCreate) {
      await page.screenshot({ path: "/tmp/appt_create_not_found.png", fullPage: true }).catch(() => {});
      return vapiRespond(res, toolCallId, {
        ok: false,
        booked: false,
        reason: "Could not find the Create button in SalonBiz.",
        message: "Something went wrong placing the booking. Please try again.",
        debugScreenshot: "/debug/appt_create_not_found.png"
      });
    }

    // Success!
    return vapiRespond(res, toolCallId, {
      ok: true,
      booked: true,
      message: `Appointment confirmed: ${service} on ${startDate} at ${startTime}${stylist ? ' with ' + stylist : ''} for ${customerName}.`,
      details: {
        customerName,
        customerPhone: digitsOnly(customerPhone),
        customerEmail,
        service,
        stylist: stylist || "any",
        startDate,
        startTime,
        customDuration,
        isNewClient
      },
      debugScreenshot: "/debug/appt_after.png"
    });

  } catch (e) {
    console.error("BOOK error at step:", step, e);
    await page.screenshot({ path: "/tmp/book_error.png", fullPage: true }).catch(() => {});
    return vapiRespond(res, toolCallId, {
      ok: false,
      booked: false,
      reason: `${step}: ${e?.message || String(e)}`,
      message: "Something went wrong while booking. Please try again or call back.",
      debugScreenshot: "/debug/book_error.png"
    }, 500);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

// ── Find openings: reads SalonBiz calendar to find real open slots ──────────
// Strategy: navigate to each day, scrape visible appointment time text using
// aria-labels and text content, then find gaps >= minGapMinutes.
app.post("/find-openings", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  const args = extractArgs(req);
  const service = args.service || "";
  const minGapMinutes = 60; // All services require minimum 1 hour

  // How many days forward to scan
  const daysToScan = 5;

  try {
    const { context, page } = await getBrowserSession();
    await loginIfNeeded(page);
    await saveCookies(context);

    const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const results = [];

    for (let d = 1; d <= daysToScan && results.length < 3; d++) {
      const scanDate = new Date(etNow);
      scanDate.setDate(etNow.getDate() + d);
      const dateStr = formatYYYYMMDD(scanDate);
      const dayName = scanDate.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });

      // Check apptCache first
      let appointments = null;
      const cached = apptCache.get(dateStr);
      if (cached && Date.now() - cached.fetchedAt < APPT_CACHE_TTL_MS) {
        appointments = cached.appointments;
        console.log('[find-openings] Using cached data for', dateStr, '-', appointments.length, 'appointments');
      } else {
        // Scrape fresh for this date
        try {
          await navigateToDate(page, dateStr);
          await page.waitForTimeout(1500); // Reduced from 3000ms
          appointments = await page.evaluate(() => {
            const appts = [];
            const events = document.querySelectorAll(
              ".dhx_cal_event, .dhx_event_move, [class*='cal_event'], sbiz-appointment-block, [class*='appointment']"
            );
            for (const ev of events) {
              const combined = (ev.getAttribute("aria-label") || "") + " " + (ev.textContent || "");
              const timePattern = /(\d{1,2}):(\d{2})\s*(AM|PM)/gi;
              const times = [];
              let match;
              while ((match = timePattern.exec(combined)) !== null) {
                let h = parseInt(match[1], 10);
                const m = parseInt(match[2], 10);
                const ampm = match[3].toUpperCase();
                if (ampm === "PM" && h !== 12) h += 12;
                if (ampm === "AM" && h === 12) h = 0;
                times.push(h * 60 + m);
              }
              if (times.length >= 2) {
                appts.push({ startMin: times[0], endMin: times[times.length - 1] });
              } else if (times.length === 1) {
                appts.push({ startMin: times[0], endMin: times[0] + 60 });
              }
            }
            return appts;
          });
          // Store in cache
          apptCache.set(dateStr, { appointments, fetchedAt: Date.now() });
          console.log('[find-openings] Scraped', dateStr, '-', appointments.length, 'appointments');
        } catch (e) {
          console.warn('[find-openings] Scrape failed for', dateStr, ':', e.message);
          appointments = [];
        }
      }

      // Find free slots with minGapMinutes of continuous free time
      const openStart = 9 * 60;  // 9 AM
      const openEnd = 18 * 60;   // 6 PM
      const step = 30;
      const freeSlots = [];
      for (let slotMin = openStart; slotMin <= openEnd - minGapMinutes; slotMin += step) {
        const slotEnd = slotMin + minGapMinutes;
        const isBusy = appointments.some(a => a.startMin < slotEnd && a.endMin > slotMin);
        if (!isBusy) {
          freeSlots.push(spokenTime(minutesToTimeStr(slotMin)));
        }
      }

      console.log('[find-openings]', dateStr, '- free slots:', freeSlots.slice(0, 4).join(', '));

      if (freeSlots.length > 0) {
        results.push({ date: dateStr, dayName, slots: freeSlots.slice(0, 4), appointmentCount: appointments.length });
      }
    }

    return vapiRespond(res, toolCallId, {
      ok: true,
      service,
      results,
      found: results.length > 0,
      minGapMinutes
    });
  } catch (e) {
    console.error("FIND-OPENINGS error:", e);
    return vapiRespond(res, toolCallId, { ok: false, error: e?.message || String(e) }, 500);
  }
});

app.post("/book/status", async (req, res) => {
  const toolCallId = extractToolCallId(req);
  // With the new synchronous /book endpoint, polling is no longer needed.
  // If called, just return a message explaining this.
  return vapiRespond(res, toolCallId, {
    ok: false,
    status: "deprecated",
    message: "The /book endpoint is now synchronous. No need to poll /book/status."
  });
});

// ── Debug screenshot routes ──────────────────────────────────────
app.get("/debug/appt_after.png", (req, res) => res.sendFile("/tmp/appt_after.png"));
app.get("/debug/appt_create_not_found.png", (req, res) => res.sendFile("/tmp/appt_create_not_found.png"));
app.get("/debug/appt_blocked.png", (req, res) => res.sendFile("/tmp/appt_blocked.png"));
app.get("/debug/book_error.png", (req, res) => res.sendFile("/tmp/book_error.png"));
app.get("/debug/services_error.png", (req, res) => res.sendFile("/tmp/services_error.png"));
app.get("/debug/stylists_error.png", (req, res) => res.sendFile("/tmp/stylists_error.png"));
app.get("/debug/availability_error.png", (req, res) => res.sendFile("/tmp/availability_error.png"));
app.get("/debug/new_client_submit_failed.png", (req, res) => res.sendFile("/tmp/new_client_submit_failed.png"));
app.get("/debug/new_client_missing_lastname.png", (req, res) => res.sendFile("/tmp/new_client_missing_lastname.png"));
app.get("/debug/client_search_failed.png", (req, res) => res.sendFile("/tmp/client_search_failed.png"));
app.get("/debug/new_client_before_create.png", (req, res) => res.sendFile("/tmp/new_client_before_create.png"));

// ── Background appointment cache warmer ──────────────────────────
async function warmApptCacheForDate(dateStr) {
  try {
    const { context, page } = await getBrowserSession();
    await loginIfNeeded(page);
    await navigateToDate(page, dateStr);
    await page.waitForTimeout(1500);
    const appointments = await page.evaluate(() => {
      const appts = [];
      const events = document.querySelectorAll(
        ".dhx_cal_event, .dhx_event_move, [class*='cal_event'], sbiz-appointment-block, [class*='appointment']"
      );
      for (const ev of events) {
        const combined = (ev.getAttribute("aria-label") || "") + " " + (ev.textContent || "");
        const timePattern = /(\d{1,2}):(\d{2})\s*(AM|PM)/gi;
        const times = [];
        let match;
        while ((match = timePattern.exec(combined)) !== null) {
          let h = parseInt(match[1], 10);
          const m = parseInt(match[2], 10);
          const ampm = match[3].toUpperCase();
          if (ampm === "PM" && h !== 12) h += 12;
          if (ampm === "AM" && h === 12) h = 0;
          times.push(h * 60 + m);
        }
        if (times.length >= 2) {
          appts.push({ startMin: times[0], endMin: times[times.length - 1] });
        } else if (times.length === 1) {
          appts.push({ startMin: times[0], endMin: times[0] + 60 });
        }
      }
      return appts;
    });
    apptCache.set(dateStr, { appointments, fetchedAt: Date.now() });
    console.log('[warmApptCache]', dateStr, '-', appointments.length, 'appointments cached');
  } catch (e) {
    console.warn('[warmApptCache] Failed for', dateStr, ':', e.message);
  }
}

async function warmApptCacheForNextDays(numDays = 5) {
  const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  for (let d = 0; d <= numDays; d++) {
    const scanDate = new Date(etNow);
    scanDate.setDate(etNow.getDate() + d);
    const dateStr = formatYYYYMMDD(scanDate);
    await warmApptCacheForDate(dateStr);
  }
  console.log('[warmApptCache] Finished warming', numDays+1, 'days');
}

app.listen(PORT, () => {
  console.log(`SalonBiz Playwright server listening on :${PORT}`);
  // Warm stylist cache after 2s
  setTimeout(() => {
    getStylistsCached()
      .then(({ cached }) => console.log(`Stylist cache warmed (cached=${cached})`))
      .catch(e => console.warn("Stylist cache warmup failed:", e?.message || e));
  }, 2000);
  // Warm appointment cache after 5s, then every 3 minutes
  setTimeout(() => {
    warmApptCacheForNextDays(5)
      .catch(e => console.warn("[startup] appt cache warm failed:", e?.message));
  }, 5000);
  setInterval(() => {
    warmApptCacheForNextDays(5)
      .catch(e => console.warn("[interval] appt cache warm failed:", e?.message));
  }, 3 * 60 * 1000); // every 3 minutes
});
