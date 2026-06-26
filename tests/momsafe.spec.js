import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const fileUrl = pathToFileURL(path.resolve(process.cwd(), 'code', 'momsafe.html')).toString();

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

test('loads and renders the default 보건소 view with no errors', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(fileUrl);

  await expect(page).toHaveTitle(/맘스세이프/);
  await expect(page.locator('#v-health')).toBeVisible();
  await expect(page.locator('#health-kpi .kpi')).toHaveCount(4);
  await expect(page.locator('#mom-rows tr')).toHaveCount(6);

  expect(errors).toEqual([]);
});

test('switches to the 119 EMS view and populates the mom picker', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(fileUrl);

  await page.locator('button[data-r="ems"]').click();

  await expect(page.locator('#v-ems')).toBeVisible();
  await expect(page.locator('#v-health')).toBeHidden();
  await expect(page.locator('#ems-pick option')).toHaveCount(7); // placeholder + 6 moms

  expect(errors).toEqual([]);
});

test('switches to the 병원 hospital view and renders the resource list', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(fileUrl);

  await page.locator('button[data-r="hosp"]').click();

  await expect(page.locator('#v-hosp')).toBeVisible();
  await expect(page.locator('#hosp-res')).toContainText('중앙대학교병원');
  await expect(page.locator('#hosp-inbox')).toContainText('현재 수용 요청이 없습니다');

  expect(errors).toEqual([]);
});

test('full relay flow: diary entry raises 예비위험도 and routes to EMS hospital priority', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(fileUrl);

  await page.locator('#mom-rows tr').first().click();
  await expect(page.locator('#drawer')).toBeVisible();

  await page.locator('#diary').fill('아침부터 머리가 아프고 눈앞이 흐릿해요. 배도 자주 뭉쳐요.');
  await page.locator('#drawer-body button', { hasText: '증상 분류 실행' }).click();
  await expect(page.locator('#diary-out')).toContainText('예비위험도');

  await page.locator('#drawer-body button', { hasText: '119 현장 화면으로 보내기' }).click();

  await expect(page.locator('#v-ems')).toBeVisible();
  await expect(page.locator('#ems-right')).toContainText('치료적합 병원 우선순위');

  expect(errors).toEqual([]);
});
