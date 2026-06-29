import { test, expect } from '@playwright/test';

// NOTE: Account creation needs Firebase Anonymous Auth enabled (see momsafe.spec.js note).
// These tests cover APP-001's client-side form/validation, which works pre-auth.
const url = '/code/patient.html';

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  return errors;
}

test('first-time visitor sees APP-001 registration with bottom nav hidden', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(url);

  await expect(page).toHaveTitle(/고맘워요/);
  await expect(page.locator('#r-name')).toBeVisible();
  await expect(page.locator('#bottomnav')).toBeHidden();
  await expect(page.locator('#r-submit')).toBeDisabled();

  expect(errors).toEqual([]);
});

test('registration submit stays disabled until all required fields + consent are valid', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(url);

  await page.locator('#r-name').fill('홍길동');
  await page.locator('#r-phone').fill('01012345678');
  await expect(page.locator('#r-phone')).toHaveValue('010-1234-5678');
  await expect(page.locator('#r-submit')).toBeDisabled();

  const today = new Date().toISOString().slice(0, 10);
  await page.locator('#r-edd').fill(today);
  await expect(page.locator('#r-submit')).toBeDisabled();

  await page.locator('#r-consent').check();
  await expect(page.locator('#r-submit')).toBeEnabled();

  expect(errors).toEqual([]);
});

test('EDD date picker blocks past dates', async ({ page }) => {
  await page.goto(url);
  const today = new Date().toISOString().slice(0, 10);
  await expect(page.locator('#r-edd')).toHaveAttribute('min', today);
});
