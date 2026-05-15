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

/**
 * Click the top-right pink "Create" button by coordinate (relative to viewport).
 * We click in the header area near the right side, slightly below the top edge.
 *
 * Tune via env vars if needed:
 * - CREATE_CLICK_X_PCT (default 0.90)
 * - CREATE_CLICK_Y_PCT (default 0.085)
 */
async function clickPinkCreateButton(page) {
  const vp = page.viewportSize() || { width: 1280, height: 720 };

  const xPct = Number(process.env.CREATE_CLICK_X_PCT || 0.9);
  const yPct = Number(process.env.CREATE_CLICK_Y_PCT || 0.085);

  const x = Math.floor(vp.width * xPct);
  const y = Math.floor(vp.height * yPct);

  await page.mouse.click(x, y);
  await page.waitForTimeout(1500);

  return { x, y, vp, xPct, yPct };
}

/**
 * Ensure appointment create panel is open by clicking pink Create,
 * then waiting for Service input.
 */
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

// ---- health ----
app.get("/health", (req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

// ---- debug: click pink create + before/after screenshots ----
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

    step = "verify service input visible";
    const serviceVisible = await page
      .locator("sbiz-book-right-panel")
      .locator('input[formcontrolname="service"]')
      .first()
      .isVisible()
      .catch(() => false);

    step = "screenshot after";
    await page.screenshot({ path: "/tmp/create_after.png", fullPage: true });

    return res.status(200).json({
      ok: true,
      click,
      serviceVisible,
      message:
        "Open /debug/create_before.png and /debug/create_after.png to confirm it clicked the pink Create button."
    });
  } catch (e) {
    console.error("DEBUG /debug/click_create error at step:", step, e);
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

// ---- debug: fill service (clicks pink create first) ----
app.get("/debug/fill_service", async (req, res) => {
  const service = String(req.query.service || "Shape Me Haircut");

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

    step = "ensure create panel open";
    const serviceInput = await ensureCreatePanelOpen(page);

    step = "type service";
    await serviceInput.click();
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.type(service, { delay: 40 });

    step = "select suggestion";
    await page.waitForTimeout(800);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    step = "screenshot";
    const buf = await page.screenshot({ fullPage: true });
    res.setHeader("Content-Type", "image/png");
    return res.status(200).send(buf);
  } catch (e) {
    console.error("DEBUG /debug/fill_service error at step:", step, e);
    await page.screenshot({ path: "/tmp/fill_service_error.png", fullPage: true }).catch(() => {});
    return res.status(500).json({ ok: false, step, error: e?.message || String(e) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/debug/fill_service_error.png", (req, res) =>
  res.sendFile("/tmp/fill_service_error.png")
);

app.listen(PORT, () => {
  console.log(`SalonBiz Playwright server listening on :${PORT}`);
});
