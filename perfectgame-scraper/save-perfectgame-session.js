// save-perfectgame-session.js
//
// Purpose:
// Opens Perfect Game in a normal Playwright browser, lets you log in,
// then saves the authenticated browser session to perfectgame-auth.json.
//
// Run:
//   node save-perfectgame-session.js
//
// Then run:
//   node perfectgame-scraper.js

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const AUTH_FILE = path.join(__dirname, "perfectgame-auth.json");

const CONFIG = {
  headless: false,
  slowMo: 75,
  authFile: AUTH_FILE,
  startUrl: "https://www.perfectgame.org/",
  loginUrl: "https://www.perfectgame.org/Login.aspx",
  username: process.env.PG_USERNAME || "",
  password: process.env.PG_PASSWORD || "",
};

function logJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function safeFill(page, selectors, value) {
  if (!value) return false;

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.fill(value, { timeout: 3000 });
        return true;
      }
    } catch {
      // try next selector
    }
  }

  return false;
}

async function safeClick(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 3000 });
        return true;
      }
    } catch {
      // try next selector
    }
  }

  return false;
}

async function maybeAutoLogin(page) {
  console.log("Opening Perfect Game login page...");
  await page.goto(CONFIG.loginUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(2000);

  const filledUsername = await safeFill(page, [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[name*="login" i]',
    'input[id*="login" i]',
    'input[type="text"]',
  ], CONFIG.username);

  const filledPassword = await safeFill(page, [
    'input[type="password"]',
    'input[name*="password" i]',
    'input[id*="password" i]',
    'input[name*="pass" i]',
    'input[id*="pass" i]',
  ], CONFIG.password);

  if (!filledUsername || !filledPassword) {
    console.log("");
    console.log("I could not confidently find the username/password fields.");
    console.log("Please log in manually in the browser window.");
    return false;
  }

  console.log("Credentials filled. Attempting login...");

  const clicked = await safeClick(page, [
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Log In")',
    'input[value*="Login" i]',
    'input[value*="Log In" i]',
    'a:has-text("Login")',
    'a:has-text("Log In")',
  ]);

  if (!clicked) {
    console.log("I filled the credentials, but could not confidently click the login button.");
    console.log("Please click the login button manually in the browser window.");
    return false;
  }

  await page.waitForTimeout(5000);
  return true;
}

async function main() {
  console.log("Starting Perfect Game session saver...");

  if (fs.existsSync(CONFIG.authFile)) {
    console.log(`Deleting old auth file: ${CONFIG.authFile}`);
    fs.unlinkSync(CONFIG.authFile);
  }

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    slowMo: CONFIG.slowMo,
  });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });

  const page = await context.newPage();

  try {
    await maybeAutoLogin(page);

    console.log("");
    console.log("============================================================");
    console.log("ACTION REQUIRED");
    console.log("============================================================");
    console.log("1. In the browser window, make sure you are logged into Perfect Game.");
    console.log("2. Navigate to a Perfect Game page that shows you as logged in.");
    console.log("3. Then come back here and press ENTER.");
    console.log("============================================================");
    console.log("");

    await new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
    });

    await context.storageState({ path: CONFIG.authFile });

    await browser.close();

    if (!fs.existsSync(CONFIG.authFile)) {
      throw new Error("Session file was not created.");
    }

    logJson({
      success: true,
      authFile: CONFIG.authFile,
      message: "Perfect Game session saved successfully. Now run: node perfectgame-scraper.js",
    });
  } catch (error) {
    await browser.close();

    logJson({
      success: false,
      error: error.message,
    });

    process.exitCode = 1;
  }
}

main();