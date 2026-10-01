import { test, expect } from '../../../lib/fixtures';

// Critical user flow: a visitor lands on the home page and can reach a way to contact / book.
// Extend this file with the real flows (search a package, open a deal, reach WhatsApp/contact form).
test('visitor can find a way to contact or book', async ({ page, site, findings }) => {
  await page.goto(site.baseUrl + '/');
  const cta = page.locator('a[href^="tel:"], a[href*="wa.me"], a[href*="whatsapp"], a[href*="contact"], a[href*="צור"], form');
  if ((await cta.count()) === 0) findings.high('No contact / WhatsApp / booking entry point found on the home page');
  await expect(page.locator('body')).toBeVisible();
});
