# 🛡️ QA Monster

בוט בדיקות QA ואבטחה אוטומטי ל-**mydubai-travel.com** ול-**thailand-express.com**.
הוא רץ כל יום ב-GitHub Actions, נותן לכל אתר ציון אבטחה וציון QA (A+ עד F), משווה לריצה הקודמת (מה חדש ומה נפתר), שולח דוח במייל ומציג הכול בדשבורד.

## איך זה בנוי

```
בדיקות Playwright ─┐
סריקות OWASP ZAP ───┼─► logger ─► runs/<run>/events.jsonl ─► lib/model.mjs ─┬─► דוח HTML במייל
                    │                (מקור האמת היחיד)        (ציונים, השוואה) └─► דשבורד
```

כל בדיקה שולחת אירועים דרך ה-logger (`lib/logger.cjs`): ממצאים, מדדים, צילומי מסך, התחלה וסיום של כל בדיקה. גם דוח המייל וגם הדשבורד מחושבים מאותו `events.jsonl` ובאותו קוד (`lib/model.mjs`), כך שאין שתי גרסאות של האמת. כשריצה נסגרת, ההשוואה לריצה הקודמת נשמרת בתוך הריצה עצמה (`run.end`), ולכן הדשבורד מציג בדיוק את מה שנשלח במייל.

## מה נבדק

| שכבה | בדיקות |
|---|---|
| **זמינות** | סטטוס, זמן טעינה, דף ריק, שגיאות JS, תמונות שבורות, משאבים שנכשלו |
| **קישורים** | זחילה על עד 60 דפים, קישורים פנימיים וחיצוניים שבורים, נכסים שבורים |
| **SEO** | title, description, h1, canonical, lang, Open Graph, alt, noindex, robots.txt, sitemap |
| **נגישות** | axe-core לפי WCAG 2.1 AA |
| **ביצועים** | TTFB, FCP, LCP, CLS, משקל דף, דחיסה, cache, תמונות כבדות |
| **מובייל** | גלילה אופקית, טקסט קטן, כפתורים קטנים, צילומי מסך במובייל/טאבלט/דסקטופ |
| **טפסים** | HTTPS, CAPTCHA, CSRF, תוויות, סוגי שדות. **הטפסים לא נשלחים** |
| **הצפנה** | תעודת SSL ותוקפה, TLS ישן, הפניה ל-HTTPS, HSTS |
| **Headers ועוגיות** | CSP, clickjacking, nosniff, CORS, עוגיות Secure/HttpOnly, mixed content, ספריות JS ישנות, דליפת שגיאות |
| **קבצים חשופים** | `.env`, `.git`, גיבויי DB, phpinfo, לוגים, רשימות תיקיות, פאנלי ניהול |
| **OWASP ZAP** | סריקה פסיבית (baseline) של האתרים החיים. סריקה אקטיבית רק ב-staging או מקומית |

## הרצה מקומית

```bash
npm ci && npx playwright install chromium
npm run audit            # כל הבדיקות, סגירת הריצה והשוואה לקודמת, דוח ב-runs/<run>/report.html
npm run dashboard        # http://127.0.0.1:4173
```

עוד פקודות:

| פקודה | מה היא עושה |
|---|---|
| `SITE=thailand-express npm run audit` | רק אתר אחד |
| `npm run audit:security` / `npm run audit:qa` | רק בדיקות אבטחה / רק QA |
| `npm run report` | סוגר את הריצה האחרונה ובונה מחדש את דוח המייל |
| `npm run sync` | מוריד ריצות מ-GitHub Actions אל `runs/` (צריך `gh auth login` או `GITHUB_TOKEN`) |
| `npm run zap -- --site mydubai-travel` | סריקת ZAP פסיבית מקומית (צריך Docker) |
| `npm run test:unit` / `npm run typecheck` | בדיקות יחידה / בדיקת טיפוסים |

## הדשבורד

`npm run dashboard` ופותחים את http://127.0.0.1:4173.

- **סקירה:** כל האתרים זה לצד זה, עם ציון אבטחה וציון QA (A–F), מגמה, ממצאים לפי חומרה, חדשים/נפתרו מול הריצה הקודמת וכיסוי בדיקות. מתחת יש טבלת השוואה לפי תחום, ורשימת הממצאים החוסמים.
- **בורר אתרים:** לשונית לכל אתר. בכל לשונית: גרף מגמת ציונים, מדדי ביצועים מול תקציב, ממצאים עם סינון (חומרה, תחום, רק חדשים, חיפוש), מה נפתר, סטטוס כל בדיקה וצילומי מסך.
- **ריצות:** בוחרים כל ריצה מהרשימה. ריצה שרצה עכשיו מתעדכנת חי, וכשמתחילה ריצה חדשה הדשבורד עובר אליה.
- **ריצות מ-GitHub Actions:** הכפתור "סנכרון מ-GitHub" מוריד את ה-artifact בשם `qa-monster-events` של הריצות האחרונות. אפשר גם לגרור לדשבורד קובץ `events.jsonl`.
- **תצוגת מייל:** מציגה את דוח המייל של הריצה, שנבנה מאותם נתונים.

## GitHub Actions

הריצה האוטומטית היא כל יום ב-03:17 UTC, כלומר 06:17 בשעון קיץ ו-05:17 בשעון חורף. היא פועלת רק אחרי מיזוג ל-branch הראשי.
להרצה ידנית: Actions → *QA Monster — site audit* → Run workflow. אפשר לבחור מצב ZAP, אתר וסף כישלון.

כל ריצה שומרת:
- **`qa-monster-events`**: ‏`events.jsonl`, דוח המייל וצילומי המסך. זה מה שהדשבורד טוען.
- **`playwright-report`**: traces וצילומים של בדיקות שנכשלו.
- **`zap-report-<site>`**: דוחות ZAP המקוריים.

### מדיניות ZAP

| מצב | יעד | מתי |
|---|---|---|
| `baseline` (פסיבי) | האתרים החיים | כל יום, ברירת מחדל |
| `full` (אקטיבי, שולח payloads של תקיפה) | רק `stagingUrl` מ-`sites.json` | רק בהרצה ידנית. כתובת של האתר החי נחסמת בקוד (`scripts/lib/zap-policy.mjs`) |
| `full` מקומי | `stagingUrl` או כתובת מקומית (localhost / רשת פנימית) | `npm run zap -- --site <name> --full` או `--url http://localhost:3000 --full` |

## קבלת הדוח במייל

כל פרטי ה-SMTP נשמרים **רק ב-GitHub Secrets**, ולא בקוד. ב-GitHub: **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | ערך |
|---|---|
| `SMTP_SERVER` | שרת הדואר היוצא (ב-Gmail: `smtp.gmail.com`) |
| `SMTP_PORT` | ‏`465` (SSL) או `587` (STARTTLS) |
| `SMTP_USERNAME` | שם המשתמש בשרת הדואר |
| `SMTP_PASSWORD` | הסיסמה. ב-Gmail זו [App Password](https://myaccount.google.com/apppasswords) ולא הסיסמה הרגילה |
| `REPORT_EMAIL` | הכתובת שאליה נשלח הדוח |
| `SMTP_FROM` (רשות) | כתובת השולח, אם היא שונה משם המשתמש |
| `SLACK_WEBHOOK_URL` (רשות) | התראה ל-Slack כשיש ממצא חוסם |

כל עוד לא הוגדרו כל ה-Secrets, שלב המייל מדולג. במקביל, כשיש ממצא חוסם נפתח Issue עם התווית `qa-monster`, ו-GitHub שולח עליו התראה במייל. ה-Issue נסגר לבד כשהכול מתוקן.

## הוספת אתר, staging או זרימת משתמש

- **אתר:** מוסיפים אותו ל-`sites.json`. רק אתר שבבעלותך.
- **staging:** ממלאים `stagingUrl` באותו אתר ב-`sites.json`. זה התנאי לסריקת ZAP אקטיבית.
- **זרימת משתמש:** `tests/flows/<site-name>/*.spec.ts`. היא רצה רק לאתר שלה.

מדריך מלא, כללי בטיחות, מבנה האירועים ומתכוני תיקון: [`.claude/skills/qa-monster/SKILL.md`](.claude/skills/qa-monster/SKILL.md).
