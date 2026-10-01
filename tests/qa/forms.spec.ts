import { test } from '../../lib/fixtures';
import { auditPages } from '../../lib/pages';

test.setTimeout(10 * 60_000);

// Read-only inspection: forms are NEVER submitted against the live sites.
test('forms are well-formed and safe (no submission)', async ({ page, request, site, findings, log }) => {
  for (const url of await auditPages(request, site)) {
    await test.step(url, async () => {
      const res = await page.goto(url, { waitUntil: 'load', timeout: 45_000 }).catch(() => null);
      if (!res?.ok()) return;
      const forms = await page.$$eval('form', (fs) => fs.map((f, i) => {
        const fields = [...f.querySelectorAll<HTMLInputElement>('input, select, textarea')]
          .filter((el) => !['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type));
        const labelled = (el: HTMLElement) => !!(
          el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('placeholder') || el.getAttribute('title') ||
          (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label'));
        return {
          index: i,
          id: f.id || f.getAttribute('name') || `form #${i + 1}`,
          action: f.action,
          method: (f.getAttribute('method') || 'get').toLowerCase(),
          fieldCount: fields.length,
          unlabelled: fields.filter((el) => !labelled(el)).map((el) => el.name || el.type),
          hasPassword: fields.some((el) => el.type === 'password'),
          passwordAutocomplete: fields.filter((el) => el.type === 'password').map((el) => el.autocomplete),
          emailAsText: fields.filter((el) => el.type === 'text' && /mail/i.test(el.name + el.id)).map((el) => el.name || el.id),
          telAsText: fields.filter((el) => el.type === 'text' && /phone|tel|mobile|טלפון/i.test(el.name + el.id + el.placeholder)).map((el) => el.name || el.id),
          required: fields.filter((el) => el.required).length,
          hiddenTokens: [...f.querySelectorAll<HTMLInputElement>('input[type=hidden]')].map((h) => h.name).filter((n) => /csrf|token|nonce|authenticity/i.test(n)).length,
          hasCaptcha: !!f.querySelector('[class*="captcha" i], [data-sitekey], iframe[src*="recaptcha"], iframe[src*="turnstile"], iframe[src*="hcaptcha"]'),
          submitButtons: f.querySelectorAll('button, input[type=submit]').length,
        };
      }));
      log.metric('forms', forms.length, { url });
      for (const f of forms) {
        const where = `${f.id} on ${url}`;
        if (f.action.startsWith('http://')) findings.critical('Form submits over unencrypted HTTP', { url, detail: `${where} → ${f.action}`, fix: 'Change the form action to https://.' });
        if (f.hasPassword && f.method === 'get') findings.high('Password form uses GET — credentials end up in URLs/logs', { url, detail: where });
        if (f.method === 'post' && f.fieldCount >= 2 && !f.hasCaptcha) findings.low('POST form without visible CAPTCHA / bot protection — spam risk', {
          url, detail: where, fix: 'Add Cloudflare Turnstile / reCAPTCHA v3 or a honeypot + server-side rate limit.',
        });
        if (f.method === 'post' && !f.hiddenTokens) findings.info('POST form without a visible CSRF token field (verify server-side protection)', { url, detail: where });
        if (f.unlabelled.length) findings.low(`${f.unlabelled.length} form field(s) without a label`, { url, detail: `${where}: ${f.unlabelled.join(', ')}` });
        if (f.emailAsText.length) findings.low('Email field uses type="text" (use type="email")', { url, detail: `${where}: ${f.emailAsText.join(', ')}` });
        if (f.telAsText.length) findings.low('Phone field uses type="text" (use type="tel" for mobile keyboard)', { url, detail: `${where}: ${f.telAsText.join(', ')}` });
        if (f.fieldCount >= 2 && f.required === 0) findings.low('Form has no required fields — empty submissions possible', { url, detail: where });
        if (!f.submitButtons) findings.info('Form without a submit button (JS-driven?)', { url, detail: where });
      }
    });
  }
});
