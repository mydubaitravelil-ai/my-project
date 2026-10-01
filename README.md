# 🛡️ QA Monster

בוט בדיקות QA ואבטחה אוטומטי ל-**mydubai-travel.com** ו-**thailand-express.com**.
רץ כל יום ב-GitHub Actions, נותן לכל אתר ציון אבטחה וציון QA (A+ עד F), ושולח אליך דוח HTML עם הסבר ותיקון לכל ממצא.

## מה נבדק

| שכבה | בדיקות |
|---|---|
| **זמינות** | סטטוס, זמן טעינה, דף ריק, שגיאות JS, תמונות שבורות, משאבים שנכשלו |
| **קישורים** | זחילה על עד 60 דפים, קישורים פנימיים וחיצוניים שבורים, נכסים שבורים |
| **SEO** | title, description, h1, canonical, lang, Open Graph, alt, noindex, robots.txt, sitemap |
| **נגישות** | axe-core לפי WCAG 2.1 AA |
| **ביצועים** | TTFB, FCP, LCP, CLS, משקל דף, דחיסה, cache, תמונות כבדות |
| **מובייל** | גלילה אופקית, טקסט קטן, כפתורים קטנים, צילומי מסך במובייל/טאבלט/דסקטופ |
| **טפסים** | HTTPS, CAPTCHA, CSRF, תוויות, סוגי שדות. **בלי לשלוח את הטופס** |
| **הצפנה** | תעודת SSL ותוקפה, TLS ישן, הפניה ל-HTTPS, HSTS |
| **Headers ועוגיות** | CSP, clickjacking, nosniff, CORS, עוגיות Secure/HttpOnly, mixed content, ספריות JS ישנות, דליפת שגיאות |
| **קבצים חשופים** | `.env`, `.git`, גיבויי DB, phpinfo, לוגים, רשימות תיקיות, פאנלי ניהול |
| **OWASP ZAP** | סריקה פסיבית (baseline) כל יום. סריקה אקטיבית (full) רק בהפעלה ידנית |

## הפעלה

**אוטומטית:** כל יום ב-06:17 (שעון ישראל). תזמון כזה עובד רק אחרי מיזוג ל-branch הראשי.
**ידנית:** Actions → *QA Monster — site audit* → Run workflow.

**מקומית:**
```bash
npm ci && npx playwright install chromium
npm run audit:full                     # כל הבדיקות + דוח ב-reports/report.html
SITE=thailand-express npm run audit    # רק אתר אחד
```

## קבלת הדוח במייל

ב-GitHub: **Settings → Secrets and variables → Actions**:

| סוג | שם | ערך |
|---|---|---|
| Secret | `SMTP_USERNAME` | כתובת Gmail שממנה נשלח הדוח |
| Secret | `SMTP_PASSWORD` | [App Password של Gmail](https://myaccount.google.com/apppasswords) (לא הסיסמה הרגילה) |
| Variable | `REPORT_EMAIL` | הכתובת שאליה הדוח יישלח |
| Secret (רשות) | `SLACK_WEBHOOK_URL` | התראה ל-Slack כשיש ממצא חוסם |

גם בלי מייל מוגדר, כשיש ממצא חוסם נפתח Issue עם התווית `qa-monster`, ו-GitHub שולח לך עליו התראה במייל. ה-Issue נסגר לבד כשהכל מתוקן.

## הוספת אתר או זרימת משתמש

- **אתר:** מוסיפים אותו ל-`sites.json`. רק אתר שבבעלותך.
- **זרימה:** `tests/flows/<site-name>/*.spec.ts`.

מדריך מלא, כללי בטיחות ומתכוני תיקון נמצאים ב-[`.claude/skills/qa-monster/SKILL.md`](.claude/skills/qa-monster/SKILL.md).
