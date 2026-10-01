import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRunModel } from '../../lib/model.mjs';
import { renderEmailHtml, renderMarkdown } from '../../lib/render-email.mjs';
import { run } from './helpers.mjs';

test('email report escapes text that came from the audited sites', () => {
  const r = run('r', { sites: ['a'] }).start().check('a', 'availability', 'c', {
    findings: [{ fp: 'x', severity: 'high', title: '<img src=x onerror=alert(1)>', detail: '<script>alert(2)</script>\njavascript:alert(3)', url: 'https://a/"><svg onload=alert(4)>', fix: 'see https://example.org/fix.' }],
  }).end();
  const html = renderEmailHtml(buildRunModel(r.events));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<svg onload'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<a href="https://example.org/fix">'), 'trailing punctuation stays outside links');
  assert.ok(renderMarkdown(buildRunModel(r.events)).includes('ממצאים חוסמים'));
});
