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
const BOOK_TIMEOUT_MS = Number(process.env.BOOK_TIMEOUT_MS || 120000);

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

// Normalize loose voice time strings → "5:00 PM"
const WORD_TO_HOUR = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12};
function normalizeStartTime(raw) {
  if (!raw) return raw;
  let s = String(raw).trim().toLowerCase();
  for (const [w,n] of Object.entries(WORD_TO_HOUR)) s = s.replace(new RegExp('\\b'+w+'\\b','g'),String(n));
  if (/^\d{1,2}:\d{2}\s*(am|pm)$/i.test(s)) return s.replace(/^(\d{1,2}:\d{2})\s*(am|pm)$/i,(_,t,p)=>t+' '+p.toUpperCase());
  const m1=s.match(/^(\d{1,2})\s*(am|pm)$/i); if(m1) return `${m1[1]}:00 ${m1[2].toUpperCase()}`;
  const m2=s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i); if(m2) return `${m2[1]}:${m2[2]} ${m2[3].toUpperCase()}`;
  const m3=s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if(m3){let h=parseInt(m3[1],10);const mn=m3[2]||'00';const ap=h<12?'AM':'PM';if(h===0)h=12;else if(h>12)h-=12;return `${h}:${mn} ${ap}`;}
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
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(3000);
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
    await page.waitForTimeout(2500);
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
    const filtered = stylistsRaw.filter(n => n && !n.toLowerCase().includes("head spa"));
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
  return res.status(statusCode).json({ results: [{ toolCallId, result }] });
}
function vapiError(res, toolCallId, message, statusCode = 400) {
  return vapiRespond(res, toolCallId, { ok: false, error: message }, statusCode);
}

// ── Booking helpers ────────────────────────────────────────────

async function selectService(page, serviceStr) {
  const panel = page.locator("sbiz-book-right-panel");
  const serviceInput = panel.locator('input[formcontrolname="service"]').first();

  // Click the service input — SalonBiz opens an "Add Service" modal
  await serviceInput.click({ timeout: 15000 });
  await page.waitForTimeout(1000);

  // Wait for the Add Service modal
  const modal = page.locator("ngb-modal-window").first();
  const modalVisible = await modal.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);

  if (!modalVisible) {
    // Fallback: typeahead style (should not happen in current SalonBiz)
    await serviceInput.type(serviceStr, { delay: 25 });
    await page.waitForTimeout(600);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    return;
  }

  // Find the search input inside the modal's "Select Service" panel
  // It's the input with a magnifying glass icon at the top right of the modal
  const searchBox = modal.locator('input[type="search"]').first();
  const searchBoxVisible = await searchBox.isVisible().catch(() => false);
  const actualSearchBox = searchBoxVisible
    ? searchBox
    : modal.locator('input').nth(0); // first input in modal

  await actualSearchBox.waitFor({ state: "visible", timeout: 5000 });
  await actualSearchBox.click();
  await actualSearchBox.fill(serviceStr);
  await page.waitForTimeout(1500); // wait for filter

  // Try to find the best matching row
  const rows = modal.locator("table tbody tr");
  const rowCount = await rows.count().catch(() => 0);
  console.log("[selectService] After search '" + serviceStr + "': " + rowCount + " rows found");

  if (rowCount > 0) {
    // Try exact match first (row name cell contains service text)
    const serviceNameLower = serviceStr.toLowerCase();
    let clicked = false;
    for (let i = 0; i < Math.min(rowCount, 20); i++) {
      const nameCell = rows.nth(i).locator("td").first();
      const cellText = (await nameCell.innerText().catch(() => "")).toLowerCase();
      if (cellText.includes(serviceNameLower) || serviceNameLower.includes(cellText.replace(/\s+/g," ").trim())) {
        await rows.nth(i).click({ timeout: 10000 });
        clicked = true;
        console.log("[selectService] Clicked row: " + cellText);
        break;
      }
    }
    if (!clicked) {
      // Fall back to first row
      await rows.first().click({ timeout: 10000 });
      console.log("[selectService] Fell back to first row");
    }
  } else {
    // No results — clear and try first available row
    await actualSearchBox.fill("");
    await page.waitForTimeout(800);
    const allRows = modal.locator("table tbody tr");
    const total = await allRows.count().catch(() => 0);
    if (total > 0) {
      await allRows.first().click({ timeout: 10000 });
      console.log("[selectService] No search results, clicked first available row");
    } else {
      throw new Error("No services found in Add Service modal for: " + serviceStr);
    }
  }

  await page.waitForTimeout(500);

  // Click "Select Service" button to confirm
  const selectBtn = modal.locator('button:has-text("Select Service")').first();
  await selectBtn.waitFor({ state: "visible", timeout: 5000 });
  await selectBtn.click({ timeout: 10000 });

  // Wait for modal to close
  await modal.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
}


async function selectExistingClient(page, nameStr, phoneStr) {
  const panel = page.locator("sbiz-book-right-panel");
  const { firstName, lastName } = splitName(nameStr);

  // Step 1: Type name in the inline search input
  const inlineInput = panel.locator('input[placeholder="Search by name or contact"]').first();
  await inlineInput.waitFor({ state: "visible", timeout: 15000 });
  await inlineInput.click();
  await inlineInput.fill("");
  await inlineInput.type(lastName || firstName, { delay: 25 }); // search by last name for better results
  await page.waitForTimeout(400);

  // Step 2: Click the Search button next to the inline input (this opens the modal)
  const inlineSearchBtn = panel.locator('sbiz-search-client button:has-text("Search")').first();
  await inlineSearchBtn.click({ timeout: 10000 });
  await page.waitForTimeout(1000);

  // Step 3: Wait for the Client Search modal
  const modal = page.locator("ngb-modal-window").first();
  await modal.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(500);

  // Step 4: Fill modal search fields more carefully
  // Clear and fill firstName
  const fnInput = modal.locator('input[formcontrolname="firstName"]').first();
  if (await fnInput.isVisible().catch(() => false)) {
    await fnInput.click({ clickCount: 3 });
    await fnInput.fill(firstName);
    await fnInput.press("Tab");
  }
  // Clear and fill lastName
  const lnInput = modal.locator('input[formcontrolname="lastName"]').first();
  if (await lnInput.isVisible().catch(() => false)) {
    await lnInput.click({ clickCount: 3 });
    await lnInput.fill(lastName);
    await lnInput.press("Tab");
  }

  // Step 5: Click the Search button INSIDE the modal
  const modalSearchBtn = modal.locator('button:has-text("Search")').first();
  await modalSearchBtn.click({ timeout: 10000 });
  await page.waitForTimeout(3000); // wait for results to load

  // Step 6: Check row count and try to click matching row
  let rowClicked = false;
  const rows = modal.locator("table tbody tr");
  let rowCount = await rows.count().catch(() => 0);
  console.log("[selectExistingClient] Search for '" + nameStr + "' returned " + rowCount + " rows");

  if (rowCount === 0) {
    // Try phone-only search as fallback
    if (phoneStr && digitsOnly(phoneStr).length >= 7) {
      const fnInp2 = modal.locator('input[formcontrolname="firstName"]').first();
      const lnInp2 = modal.locator('input[formcontrolname="lastName"]').first();
      const ctInp2 = modal.locator('input[formcontrolname="contact"]').first();
      if (await fnInp2.isVisible().catch(() => false)) { await fnInp2.click({ clickCount: 3 }); await fnInp2.fill(""); }
      if (await lnInp2.isVisible().catch(() => false)) { await lnInp2.click({ clickCount: 3 }); await lnInp2.fill(""); }
      if (await ctInp2.isVisible().catch(() => false)) {
        await ctInp2.click({ clickCount: 3 });
        await ctInp2.fill(digitsOnly(phoneStr).slice(-10));
      }
      await modalSearchBtn.click({ timeout: 10000 });
      await page.waitForTimeout(3000);
      rowCount = await rows.count().catch(() => 0);
      console.log("[selectExistingClient] Phone search returned " + rowCount + " rows");
    }
  }

  if (rowCount > 0) {
    // Try to match by phone number first
    if (phoneStr && digitsOnly(phoneStr).length >= 7) {
      const phoneDigits = digitsOnly(phoneStr).slice(-7);
      for (let i = 0; i < rowCount; i++) {
        const rowText = await rows.nth(i).innerText().catch(() => "");
        if (digitsOnly(rowText).includes(phoneDigits)) {
          await rows.nth(i).click({ timeout: 10000 });
          rowClicked = true;
          console.log("[selectExistingClient] Matched by phone, row " + i);
          break;
        }
      }
    }
    // Fall back to first row
    if (!rowClicked) {
      await rows.first().click({ timeout: 10000 });
      rowClicked = true;
      console.log("[selectExistingClient] Clicked first row as fallback");
    }
  }

  if (!rowClicked) {
    // Screenshot before closing modal
    await page.screenshot({ path: "/tmp/client_search_failed.png", fullPage: true }).catch(() => {});
    // Close modal
    const closeBtn = modal.locator('button:has-text("Close"), button[aria-label="Close"]').first();
    await closeBtn.click({ timeout: 5000 }).catch(() => page.keyboard.press("Escape"));
    await page.waitForTimeout(500);
    throw new Error('Client not found: "' + nameStr + '" (phone: ' + phoneStr + '). Will create as new client.');
  }

  // Step 7: Click the Select button to confirm the selection
  await page.waitForTimeout(500);
  const selectBtn = modal.locator('button:has-text("Select")').first();
  const selectBtnVisible = await selectBtn.isVisible().catch(() => false);
  if (selectBtnVisible) {
    await selectBtn.click({ timeout: 10000 });
  } else {
    // Some versions have just a "Select" link or the row click already selects
    console.log("[selectExistingClient] No Select button visible, row click may have been enough");
  }

  // Step 8: Wait for the modal to close
  await modal.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
}
async function createNewClientInModal(page, { customerName, customerPhone, customerEmail }) {
  const modal = page.locator("ngb-modal-window").first();
  await modal.waitFor({ state: "visible", timeout: 20000 });

  const { firstName, lastName } = splitName(customerName);
  if (!firstName || !lastName) {
    await page.screenshot({ path: "/tmp/new_client_missing_lastname.png", fullPage: true }).catch(() => {});
    throw new Error("New client requires first AND last name.");
  }

  // Fill an Angular reactive form field via the browser, triggering all Angular events
  const fillAngularField = async (locator, value) => {
    await locator.waitFor({ state: "visible", timeout: 8000 });
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    // Use evaluate to set value with Angular's native setter + proper events
    await locator.evaluate((el, val) => {
      // Clear existing value
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // Set new value
      nativeInputValueSetter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, String(value));
    await page.waitForTimeout(100);
    // Also type it character-by-character to ensure Angular picks it up
    await locator.click({ clickCount: 3 });
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await locator.type(String(value), { delay: 20 });
    await locator.press('Tab');
    await page.waitForTimeout(150);
  };

  // Scroll modal to top
  await modal.evaluate(el => {
    const body = el.querySelector(".modal-body, .sbiz-modal__body, .modal-content");
    if (body) body.scrollTop = 0;
    el.scrollTop = 0;
  }).catch(() => {});
  await page.waitForTimeout(400);

  // Fill First Name
  const fnInput = modal.locator('input[formcontrolname="firstName"]').first();
  await fillAngularField(fnInput, firstName);

  // Fill Last Name
  const lnInput = modal.locator('input[formcontrolname="lastName"]').first();
  await fillAngularField(lnInput, lastName);

  // Fill Mobile Phone
  const telInput = modal.locator('input[formcontrolname="telMobile"]').first();
  const phoneFormatted = formatUsPhoneMaybe(customerPhone);
  await fillAngularField(telInput, phoneFormatted);

  // Fill email if provided (some forms require it)
  if (customerEmail && isValidEmail(customerEmail)) {
    const emailInput = modal.locator('input[formcontrolname="email"]').first();
    const emailVisible = await emailInput.isVisible().catch(() => false);
    if (emailVisible) await fillAngularField(emailInput, customerEmail);
  }

  await page.waitForTimeout(800);

  // Take screenshot to verify fields are filled before clicking Create
  await page.screenshot({ path: "/tmp/new_client_before_create.png", fullPage: true }).catch(() => {});

  // Try to find and click the Create/Submit button
  const submitSelectors = [
    'button[type="submit"]:has-text("Create")',
    'button.sbiz-btn--primary:has-text("Create")',
    'button:has-text("Create")',
    'button[type="submit"]'
  ];

  let createBtn = null;
  for (const sel of submitSelectors) {
    const btn = modal.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      createBtn = btn;
      break;
    }
  }

  if (!createBtn) throw new Error("Could not find Create button in new client modal");

  await createBtn.scrollIntoViewIfNeeded().catch(() => {});
  await createBtn.click({ timeout: 15000 });
  await page.waitForTimeout(3000);

  let stillVisible = await modal.isVisible().catch(() => false);
  if (stillVisible) {
    // Take error screenshot and check error text
    await page.screenshot({ path: "/tmp/new_client_submit_failed.png", fullPage: true }).catch(() => {});
    const errorText = await modal.locator(".sbiz-alert, .alert, .invalid-feedback, [class*='error'], .text-danger").first().innerText().catch(() => "");
    console.log("[createNewClientInModal] Modal still open after Create click. Error text:", errorText);

    // Try strategy 2: Use Enter key
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    stillVisible = await modal.isVisible().catch(() => false);
  }

  if (stillVisible) {
    // Strategy 3: Re-fill fields and try again - sometimes fields lose value
    console.log("[createNewClientInModal] Retrying field fill...");
    await fillAngularField(fnInput, firstName);
    await fillAngularField(lnInput, lastName);
    await fillAngularField(telInput, phoneFormatted);
    await page.waitForTimeout(500);
    await createBtn.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(3000);
    stillVisible = await modal.isVisible().catch(() => false);
  }

  if (stillVisible) {
    await page.screenshot({ path: "/tmp/new_client_submit_failed.png", fullPage: true }).catch(() => {});
    throw new Error("New client modal did not close after create. Form may have validation errors.");
  }

  await modal.waitFor({ state: "hidden", timeout: 20000 }).catch(() => {});
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
    // Try to find existing client; if not found, fall back to creating them
    try {
      await selectExistingClient(page, customerName, customerPhone);
    } catch (e) {
      console.log("Existing client not found, creating new:", e.message);
      // Save a screenshot to see why client search failed
      await page.screenshot({ path: "/tmp/client_search_failed.png", fullPage: true }).catch(() => {});
      // Client not in system — create them as new
      // Need to navigate back and open create panel fresh
      await navigateToBookingDate(page, startDate);
      await clickClientCreateButton(page);
      await createNewClientInModal(page, { customerName, customerPhone, customerEmail: "" });
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
  const stylist = args.stylist || null;
  const startTime = args.startTime || args.time || null;
  try {
    const { schedule, cached, cacheAgeMs } = await getScheduleCached(dateStr);
    const summary = Object.entries(schedule).map(([name, data]) => ({
      name,
      isWorking: data.isWorking,
      notWorkingPeriods: data.notWorkingPeriods.map(p => ({ from: minutesToTimeStr(p.startMin), to: minutesToTimeStr(p.endMin) }))
    }));
    let specificCheck = null;
    if (stylist && startTime) {
      specificCheck = checkStylistAvailability(schedule, stylist, startTime);
    } else if (stylist) {
      const key = Object.keys(schedule).find(k => k.toLowerCase() === stylist.toLowerCase());
      specificCheck = key
        ? { available: schedule[key].isWorking, reason: schedule[key].isWorking ? `${stylist} is working that day.` : `${stylist} is not working that day.` }
        : { available: false, reason: `${stylist} does not appear on the schedule for ${dateStr}.` };
    }
    return vapiRespond(res, toolCallId, {
      ok: true, date: dateStr, cached, cacheAgeMs,
      stylistCount: summary.length, schedule: summary,
      ...(specificCheck ? { specificCheck } : {})
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
  if (isNewClient) {
    const { firstName, lastName } = splitName(customerName);
    if (!firstName || !lastName) return vapiError(res, toolCallId, "For new clients, please provide first AND last name.");
    // Email not required for phone bookings
    // Email validation not required
  }
  if (!service) return vapiError(res, toolCallId, "service required");
  if (PHONE_BOOKABLE_SERVICES.size && !PHONE_BOOKABLE_SERVICES.has(service)) {
    return vapiError(res, toolCallId, `Service "${service}" is not phone-bookable. Choose a different service.`);
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

// ── Legacy /book/status route (kept for compatibility) ─────────
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

app.listen(PORT, () => {
  console.log(`SalonBiz Playwright server listening on :${PORT}`);
  setTimeout(() => {
    getStylistsCached()
      .then(({ cached }) => console.log(`Stylist cache warmed (cached=${cached})`))
      .catch(e => console.warn("Stylist cache warmup failed:", e?.message || e));
  }, 2000);
  setInterval(() => { getStylistsCached().catch(() => {}); }, STYLIST_CACHE_TTL_MS);
});
