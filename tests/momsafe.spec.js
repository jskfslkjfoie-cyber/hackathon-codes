import { test, expect } from '@playwright/test';

// NOTE: Firestore data (patients/hospitals) requires Firebase Anonymous Auth to be
// enabled on the project. Until then, watchPatients/watchHospitals never resolve,
// so these tests cover static UI/navigation only (no Firestore round-trip).
// Served over http:// (see playwright.config.js webServer) since Chromium/WebKit
// block ES module scripts under file://.
const url = '/code/momsafe.html';

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  return errors;
}

test('loads the staff console with the 보건소 view active by default', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => sessionStorage.setItem('momsafe_logged_in', '1'));
  await page.goto(url);

  await expect(page).toHaveTitle(/고맘워요/);
  await expect(page.locator('#v-health')).toBeVisible();
  await expect(page.locator('.subnav button.on')).toHaveText(/DASH-001/);

  expect(errors).toEqual([]);
});

test('보건소 sub-nav switches between DASH-001/003/004 panels', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => sessionStorage.setItem('momsafe_logged_in', '1'));
  await page.goto(url);

  await page.locator('[data-dash="alerts"]').click();
  await expect(page.locator('#dash-alerts')).toBeVisible();
  await expect(page.locator('#dash-list')).toBeHidden();

  await page.locator('[data-dash="infra"]').click();
  await expect(page.locator('#dash-infra')).toBeVisible();
  await expect(page.locator('#geo-map')).toBeVisible();

  expect(errors).toEqual([]);
});

test('switches to the 119 EMS view and shows the quick-lookup search bar', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => sessionStorage.setItem('momsafe_logged_in', '1'));
  await page.goto(url);

  await page.locator('button[data-r="ems"]').click();

  await expect(page.locator('#v-ems')).toBeVisible();
  await expect(page.locator('#v-health')).toBeHidden();
  await expect(page.locator('#ems-q-name')).toBeVisible();
  await expect(page.locator('#ems-q-phone4')).toBeVisible();

  expect(errors).toEqual([]);
});

test('EMS quick lookup reports no match for an unknown patient', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => sessionStorage.setItem('momsafe_logged_in', '1'));
  await page.goto(url);
  await page.locator('button[data-r="ems"]').click();

  await page.locator('#ems-q-name').fill('존재하지않는산모');
  await page.locator('#ems-q-phone4').fill('9999');
  await page.locator('#ems-search-btn').click();

  await expect(page.locator('#ems-q-err')).toContainText('찾을 수 없습니다');

  expect(errors).toEqual([]);
});

test('switches to the 병원 hospital view and renders the self-hospital picker', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => sessionStorage.setItem('momsafe_logged_in', '1'));
  await page.goto(url);

  await page.locator('button[data-r="hosp"]').click();

  await expect(page.locator('#v-hosp')).toBeVisible();
  await expect(page.locator('#self-hosp-pick')).toBeVisible();
  await expect(page.locator('#hosp-inbox')).toBeVisible();

  expect(errors).toEqual([]);
});
