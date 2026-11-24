# הרשמה למפגשי אימון אישי – תוכנית רקיע

אתר סטטי (GitHub Pages) + שרת חינמי ב-Google Apps Script.

| קובץ | תפקיד |
|---|---|
| `index.html`, `style.css`, `app.js` | האתר |
| `config.js` | הגדרות: Client ID, כתובת השרת, מספר וואטסאפ |
| `availability.json` | **המועדים הפתוחים** – מתעדכן כל תחילת חודש |
| `apps-script/Code.gs` | השרת: אימות, יומן + Google Meet, אימיילים, תזכורות, ביטול |

## מה קורה כשמישהו נרשם
1. מתחבר עם Google ובוחר מועד פנוי.
2. נוצר אירוע ב**יומן שלך** עם קישור **Google Meet**, וההזמנה נכנסת ל**יומן של הנרשם/ת**.
3. נשלח אימייל אישור עם הקישור ל-Meet, ואליך מגיע אימייל על הרשמה חדשה.
4. **24 שעות לפני** ו**שעתיים לפני** נשלחות תזכורות עם הקישור ל-Meet.

## תצוגת הבעלים
כשאת/ה מחובר/ת לאתר עם החשבון שבו הותקן השרת, מופיעה רשימת "המפגשים הקרובים". ליד כל מפגש מוצגת שעת ישראל וגם השעה המקומית. השעה המקומית נלקחת מאזור הזמן שמוגדר **במחשב** ולא מהרשת, ולכן VPN לא משפיע עליה. כדי שהיא תתעדכן בכל מדינה, צריך להשאיר ב-Windows את ההגדרה "Set time zone automatically" מופעלת.

---

## ההתקנה – שלב אחר שלב (פעם אחת, כ-30 דקות)

### שלב 1 – להעלות את האתר ל-GitHub
1. להעלות את כל הקבצים לריפו ב-GitHub.
2. בריפו: **Settings → Pages → Source: Deploy from a branch → main / (root) → Save**.
3. אחרי דקה הכתובת תופיע שם, למשל `https://USERNAME.github.io/REPO/`. לשמור אותה בצד.

### שלב 2 – ליצור "מפתח התחברות עם Google"
1. להיכנס ל-[console.cloud.google.com](https://console.cloud.google.com) ולבחור למעלה **New Project**.
2. בתפריט: **APIs & Services → OAuth consent screen** → External → למלא שם אפליקציה ("תוכנית רקיע") ואימייל → לשמור. בסוף ללחוץ **Publish app**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://USERNAME.github.io`
4. להעתיק את ה-**Client ID** (מסתיים ב-`apps.googleusercontent.com`).

### שלב 3 – להקים את השרת
1. ליצור **Google Sheet** חדש (בחשבון שהיומן שלו ישמש למפגשים).
2. בתוכו: **Extensions → Apps Script**.
3. למחוק את מה שיש שם ולהדביק את כל התוכן של `apps-script/Code.gs`.
4. בצד שמאל, ליד **Services**, ללחוץ **+** → לבחור **Google Calendar API** → **Add**. (זה מה שמאפשר את Google Meet.)
5. למלא למעלה בקוד, בתוך `CONFIG`:
   - `CLIENT_ID` – מה שהעתקת בשלב 2
   - `AVAILABILITY_URL` – הכתובת משלב 1 + `availability.json`
   - `SITE_URL` – הכתובת משלב 1
   - `WHATSAPP` – המספר שלך בפורמט `9725XXXXXXXX`
6. לשמור, לבחור למעלה את הפונקציה **setup** וללחוץ **Run**. לאשר את כל ההרשאות (יומן, Gmail, גיליון). אם מופיע "Google hasn't verified this app": **Advanced → Go to… (unsafe)**. זה הקוד שלך, אז זה בסדר.
7. **Deploy → New deployment** → סוג **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - → **Deploy**, ולהעתיק את הכתובת שמסתיימת ב-`/exec`.

### שלב 4 – לחבר את האתר לשרת
בקובץ `config.js` למלא:
- `googleClientId` – מה שהעתקת בשלב 2
- `apiUrl` – הכתובת משלב 3.7
- `whatsappNumber` – המספר שלך

ולהעלות את השינוי ל-GitHub.

### שלב 5 – בדיקה
להיכנס לאתר, להירשם למפגש עם חשבון Google אחר, ולוודא שהגיעו האישור, האירוע ביומן וקישור ה-Meet. אחר כך לבטל דרך הגיליון.

---

## בשוטף

**כל תחילת חודש:** לשלוח לי את הימים והשעות, ואני אעדכן את `availability.json`.

**ביטול מפגש:** בגיליון, בלשונית Bookings, לסמן את שורת המפגש → בתפריט העליון **מפגשים → ביטול המפגש בשורה המסומנת**. הנרשם/ת מקבל/ת אימייל, המועד נפתח מחדש, ואפשר לבחור מועד חדש.

**שינוי בקוד השרת:** Deploy → Manage deployments → ✏️ → Version: New version → Deploy (הכתובת לא משתנה).

### מצב הדגמה
כש-`apiUrl` ריק, האתר עובד בלי שמירה. כדי לראות גם את תצוגת הבעלים, מוסיפים `?owner` לכתובת.
