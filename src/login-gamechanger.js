require("dotenv").config();
const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const GC_USERNAME = process.env.GC_USERNAME;
const GC_PASSWORD = process.env.GC_PASSWORD;
const GC_TEAM_NAME = process.env.GC_TEAM_NAME || "33s baseball";

const STORAGE_DIR = path.join(__dirname, "..", "storage");
const STORAGE_STATE = path.join(STORAGE_DIR, "gamechanger-auth.json");

function ensureEnv() {
  const missing = [];

  if (!GC_USERNAME) missing.push("GC_USERNAME");
  if (!GC_PASSWORD) missing.push("GC_PASSWORD");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. Check your .env file.`
    );
  }

  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

async function clickIfVisible(page, locator, description, timeout = 5000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    await locator.click();
    console.log(`Clicked: ${description}`);
    return true;
  } catch {
    return false;
  }
}

async function fillIfVisible(page, locator, value, description, timeout = 7000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    await locator.fill(value);
    console.log(`Filled: ${description}`);
    return true;
  } catch {
    return false;
  }
}

async function waitForPossibleVerification(page) {
  console.log("Checking for possible email verification / MFA screen...");

  const codeFieldCandidates = [
    page.getByLabel(/code/i),
    page.getByPlaceholder(/code/i),
    page.locator('input[name*="code" i]'),
    page.locator('input[id*="code" i]'),
    page.locator('input[type="tel"]'),
    page.locator('input[inputmode="numeric"]')
  ];

  for (const field of codeFieldCandidates) {
    try {
      await field.first().waitFor({ state: "visible", timeout: 5000 });

      console.log("");
      console.log("====================================================");
      console.log("GameChanger is asking for a verification code.");
      console.log("Enter the code manually in the browser window.");
      console.log("After the login completes, this script will continue.");
      console.log("====================================================");
      console.log("");

      await page.waitForFunction(() => {
        const bodyText = document.body.innerText.toLowerCase();

        const stillLooksLikeCodeScreen =
          bodyText.includes("verification") ||
          bodyText.includes("verify") ||
          bodyText.includes("code") ||
          bodyText.includes("security");

        const hasCodeInput =
          !!document.querySelector('input[name*="code" i]') ||
          !!document.querySelector('input[id*="code" i]') ||
          !!document.querySelector('input[type="tel"]') ||
          !!document.querySelector('input[inputmode="numeric"]');

        return !stillLooksLikeCodeScreen || !hasCodeInput;
      }, null, { timeout: 180000 });

      console.log("Verification appears to be complete.");
      return true;
    } catch {
      // Try next possible code field
    }
  }

  console.log("No verification code field detected.");
  return false;
}

async function waitForLoginSuccess(page) {
  console.log("Waiting for login to complete...");

  try {
    await page.waitForLoadState("networkidle", { timeout: 30000 });
  } catch {
    // Some modern apps never fully go idle. That's fine.
  }

  const possibleLoggedInIndicators = [
    page.getByRole("button", { name: /profile|account|menu|settings/i }),
    page.getByText(/my teams/i),
    page.getByText(/schedule/i),
    page.getByText(/team/i),
    page.getByText(/feed/i)
  ];

  for (const indicator of possibleLoggedInIndicators) {
    try {
      await indicator.first().waitFor({ state: "visible", timeout: 10000 });
      console.log("Login success indicator detected.");
      return true;
    } catch {
      // Try next indicator
    }
  }

  console.log("Could not confirm login with a known page marker.");
  console.log("If the browser looks logged in, the session will still be saved.");
  return false;
}

async function loginToGameChanger() {
  ensureEnv();

  const browser = await chromium.launch({
    headless: false,
    slowMo: 75
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }
  });

  const page = await context.newPage();

  console.log("Opening GameChanger...");
  await page.goto("https://gc.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    // Fine. App may keep background requests alive.
  }

  console.log("Looking for Sign In button...");

  const signInClicked =
    await clickIfVisible(
      page,
      page.getByRole("link", { name: /sign in/i }),
      "Sign In link"
    ) ||
    await clickIfVisible(
      page,
      page.getByRole("button", { name: /sign in/i }),
      "Sign In button"
    ) ||
    await clickIfVisible(
      page,
      page.getByText(/sign in/i).first(),
      "Sign In text"
    );

  if (!signInClicked) {
    throw new Error("Could not find the GameChanger Sign In button/link.");
  }

  console.log("Entering username...");

  const usernameFilled =
    await fillIfVisible(
      page,
      page.getByLabel(/email|username/i),
      GC_USERNAME,
      "username/email field"
    ) ||
    await fillIfVisible(
      page,
      page.getByPlaceholder(/email|username/i),
      GC_USERNAME,
      "username/email placeholder field"
    ) ||
    await fillIfVisible(
      page,
      page.locator('input[type="email"]').first(),
      GC_USERNAME,
      "email input"
    ) ||
    await fillIfVisible(
      page,
      page.locator('input[name*="email" i], input[name*="username" i]').first(),
      GC_USERNAME,
      "email/username input by name"
    );

  if (!usernameFilled) {
    throw new Error("Could not find the username/email field.");
  }

  console.log("Clicking Continue...");

  const continueClicked =
    await clickIfVisible(
      page,
      page.getByRole("button", { name: /continue/i }),
      "Continue button"
    ) ||
    await clickIfVisible(
      page,
      page.getByText(/continue/i).first(),
      "Continue text"
    );

  if (!continueClicked) {
    throw new Error("Could not find the Continue button after username entry.");
  }

  console.log("Entering password...");

  const passwordFilled =
    await fillIfVisible(
      page,
      page.getByLabel(/password/i),
      GC_PASSWORD,
      "password field"
    ) ||
    await fillIfVisible(
      page,
      page.getByPlaceholder(/password/i),
      GC_PASSWORD,
      "password placeholder field"
    ) ||
    await fillIfVisible(
      page,
      page.locator('input[type="password"]').first(),
      GC_PASSWORD,
      "password input"
    );

  if (!passwordFilled) {
    throw new Error("Could not find the password field.");
  }

  console.log("Submitting password...");

  const submitClicked =
    await clickIfVisible(
      page,
      page.getByRole("button", { name: /sign in|log in|continue|submit/i }),
      "password submit button"
    ) ||
    await page.keyboard.press("Enter").then(() => {
      console.log("Pressed Enter to submit password.");
      return true;
    });

  if (!submitClicked) {
    throw new Error("Could not submit password.");
  }

  await waitForPossibleVerification(page);

  await waitForLoginSuccess(page);

  console.log(`Temporary hardcoded team name: ${GC_TEAM_NAME}`);

  await context.storageState({ path: STORAGE_STATE });

  console.log("");
  console.log("Authenticated session saved here:");
  console.log(STORAGE_STATE);
  console.log("");
  console.log("You can reuse this login session in future scraper scripts.");

  await browser.close();
}

loginToGameChanger().catch((error) => {
  console.error("");
  console.error("Login failed:");
  console.error(error.message);
  console.error("");
  process.exit(1);
});