# Getting NetLink onto your phone

## The fast way — see it in 10 minutes, no accounts, no APK

If you just want NetLink running on your phone today, skip everything below.
This needs **no Expo account, no Google account, no hosting, and no APK** — your
phone runs the app straight from your PC over your own Wi-Fi.

Your phone and your PC must be on the same Wi-Fi network.

**1. On your phone:** install **Expo Go** from the Play Store.

**2. On your Windows PC**, get NetLink running:

```powershell
git clone https://github.com/cristofar4/Netlink-hub.git
cd Netlink-hub
git checkout claude/app-rebuild-g5evlg
.\scripts\setup-windows.ps1
```

**3. Let your phone reach the API.** By default it listens only on localhost,
which your phone cannot see. In `.env`, change:

```
HOST=0.0.0.0
```

Find your PC's address on the network:

```powershell
ipconfig | Select-String IPv4
```

You want the one that looks like `192.168.x.x`.

**4. Start the API and the desktop app:**

```powershell
.\scripts\dev-windows.ps1
```

Create your account in the NetLink window. The six-digit code appears in the API
console — in development it is also returned in the response, so you never have
to go hunting for it.

**5. Point the phone app at your PC and start it:**

```powershell
cd apps\mobile
$env:EXPO_PUBLIC_NETLINK_API_URL = "http://192.168.x.x:4000/api"   # your address
npx expo start
```

A QR code appears in the terminal.

**6. Open Expo Go on your phone and scan it.** NetLink loads. Sign in with the
account you just made.

To make the phone actually *do* something, enrol your PC's agent — in the
NetLink window, **My Spaces → Add a computer**, then on the PC:

```powershell
cd services\agent
go run .\cmd\netlink-agent run --token PASTE_TOKEN_HERE
```

Now **Power** on your phone can lock, sleep or restart that PC.

### What this way is and is not

It is real: real accounts, real device keys in the Android Keystore, real
signed power commands, your real PC.

It is **not** something to leave running. The connection is plain HTTP over your
own network, which is acceptable while both machines are yours and on the same
Wi-Fi, and is not acceptable for anything else. The Settings screen says so. It
also stops working the moment you leave the house, because your phone can no
longer see your PC.

For a version that works anywhere, and for the Play Store, carry on below.

---

# The full way — a real deployment

The shortest honest path from this repository to an app you can open on your own
phone and use against your own computer.

There are four steps and they must happen in order. Two of them need accounts;
none of them need a credit card.

| | | Time | Needs |
|---|---|---|---|
| 1 | An email sender | 5 min | Free Brevo or Resend account |
| 2 | The control plane, on the internet | 10 min | Free Render account |
| 3 | The agent, on your Windows PC | 10 min | Your PC |
| 4 | The Android app, on your phone | 20 min | Free Expo account |

> The four steps below give you an APK that works from anywhere, on mobile data,
> without your PC running the dev server. The fast way above is for a first look.

---

## Before you start: what needs what

It is worth understanding why the order is fixed, because skipping ahead wastes
the most time.

```
   Your phone                  The control plane              Your Windows PC
  ┌────────────┐              ┌──────────────────┐          ┌────────────────┐
  │  NetLink   │─── HTTPS ───▶│  API + Postgres  │◀── signed ──│ NetLink agent │
  │  Android   │              │   (on Render)    │          │  (service)     │
  └─────┬──────┘              └────────┬─────────┘          └───────┬────────┘
        │                              │                            │
        │                    sends six-digit codes                  │
        │                              ▼                            │
        │                       ┌─────────────┐                     │
        │                       │    SMTP     │                     │
        │                       └─────────────┘                     │
        └──────────── direct, encrypted: files and screen ──────────┘
```

Three consequences:

- **Without SMTP, nobody can sign in.** Not even you. Every sign-in from a new
  device needs a six-digit code, and that code arrives by email.
- **Without the control plane, the phone has nothing to talk to.** It is not a
  peer-to-peer app that finds your PC on its own; the control plane is what
  holds identity and permissions.
- **Without the agent, your Space is empty.** The phone will sign in perfectly
  and show "no computers", because there are none.

---

## 1. An email sender

Any SMTP provider works. Two with free tiers that need no card:

- **Brevo** — 300 emails a day. Create an account, then **SMTP & API → SMTP**.
  You get a host, a login and a key.
- **Resend** — 3,000 a month. Create an account, add a domain (or use their
  test one), then **API Keys**.

Write down four things — you need them in step 2:

```
SMTP_HOST       e.g. smtp-relay.brevo.com
SMTP_USER       the login they show you
SMTP_PASSWORD   the key they show you (shown once)
MAIL_FROM       Your Company <you@yourdomain.com>
```

`MAIL_FROM` has to be an address the provider has verified. Using an
unverified one is the most common reason the first sign-in code never arrives.
The API refuses to start in production while it is still the development
default, because that address is on a domain that does not exist.

### Make the emails yours

The verification codes are the only messages this product sends, and they are
the most phishable thing about it — short, urgent, and asking for an action. The
defence is that the real one is recognisable, so set the name people will see:

```
BRAND_NAME            Your Company
BRAND_URL             https://yourcompany.com          (optional)
BRAND_SUPPORT_EMAIL   help@yourcompany.com             (optional)
BRAND_FOOTER          Your Company Ltd, Lagos          (optional)
```

`BRAND_NAME` appears in every subject line, in the body and in the footer — and
the apps read it from the server too, so the name on the sign-in screen is the
same one in the inbox. That match is what somebody checks before typing a code
in. Make it agree with the domain in `MAIL_FROM`.

---

## 2. The control plane

1. Push this repository to your own GitHub account, if it is not there already.
2. Sign in to [render.com](https://render.com) with GitHub.
3. **New → Blueprint**, pick this repository. Render reads `render.yaml` and
   proposes a web service and a PostgreSQL database. Approve it.
4. Open **netlink-api → Environment** and add the four SMTP values from step 1.
5. Wait for the first deploy. It builds the Docker image, runs the database
   migrations on boot, and starts.

Check it:

```
https://netlink-api-XXXX.onrender.com/api/health
```

You want `"status": "ok"` and `"database": { "status": "up" }`.
`"mail"` should say `smtp`. If it says `console`, the SMTP variables did not
take — no code will ever arrive.

**Write down that URL.** It goes into the phone app and the agent.

Two things about the free tier, said plainly:

- The service **sleeps after 15 minutes idle**. The next request takes about
  50 seconds. That is not a bug in NetLink; it is what free means.
- The free database is **deleted after 30 days**. Before that matters, move to a
  paid instance or to your own server with `docker-compose.yml`.

---

## 3. The agent, on your Windows PC

This is the part that makes the Space non-empty.

```powershell
git clone https://github.com/cristofar4/Netlink-hub.git
cd Netlink-hub
git checkout claude/app-rebuild-g5evlg

.\scripts\setup-windows.ps1
```

Point it at your deployed API rather than localhost — edit `.env`:

```
NETLINK_API_URL=https://netlink-api-XXXX.onrender.com/api
VITE_NETLINK_API_URL=https://netlink-api-XXXX.onrender.com/api
```

Then open the desktop app, create your account, and create a Space:

```powershell
.\scripts\dev-windows.ps1
```

In the NetLink window: **My Spaces → Add a computer**. You get a single-use
enrolment token. Give it to the agent:

```powershell
cd services\agent
go run .\cmd\netlink-agent run --api https://netlink-api-XXXX.onrender.com/api --token PASTE_TOKEN_HERE
```

The map node turns green within a few seconds. That green is a real heartbeat.

To keep it running after you close that terminal, install it as a service —
from an **Administrator** PowerShell:

```powershell
go build -o bin\netlink-agent.exe .\cmd\netlink-agent
.\bin\netlink-agent.exe install
sc.exe start NetLinkAgent
```

For Wake-on-LAN to actually work later, you also need to enable it in your PC's
BIOS/UEFI and in the network adapter's power settings. The app tells you which
preconditions are unmet rather than leaving you guessing.

---

## 4. The Android app

You do not need Android Studio. Expo builds it in the cloud and gives you a
link.

```bash
npm install -g eas-cli
eas login          # free account, created at expo.dev
```

Point the app at your API — edit `apps/mobile/app.json`:

```json
"extra": { "netlinkApiUrl": "https://netlink-api-XXXX.onrender.com/api" }
```

Then build an APK:

```bash
cd apps/mobile
eas build --platform android --profile preview
```

It takes roughly 10–15 minutes. When it finishes you get a URL. **Open that URL
on your phone**, download the APK, and install it — Android will ask you to
allow installing from that source, which is expected for an app that did not
come from the Play Store.

Sign in with the account you created in step 3. Your Space and your PC should
be there, and **Power** should be able to lock it.

> The `preview` profile builds an APK on purpose. The Play Store needs an AAB,
> which is what the `production` profile makes — but an AAB cannot be installed
> directly on a phone, so it is the wrong thing for testing.

---

## Then what — the Play Store

Everything above gets NetLink onto **your** phone. Putting it in front of other
people is a different job, and mostly not a coding one:

1. A **Google Play Developer account** — $25, once, and identity verification
   that takes a few days.
2. A **privacy policy at a public URL**. Required, and Google checks it exists.
3. The **Data safety form**, declaring what the app collects.
4. **Store listing** — icon, feature graphic, screenshots, descriptions.
5. **Content rating** questionnaire.

Remote-access apps get closer scrutiny than average, which is reasonable — the
category is genuinely abused. Two things in NetLink's favour, and one to watch:

- The app requests only `INTERNET` and `ACCESS_NETWORK_STATE`, and explicitly
  blocks camera, microphone, location, contacts and storage. A remote-access app
  asking for the microphone is how a review goes badly.
- Nothing is hidden: there is no background service, no accessibility-service
  abuse, no device-admin request.
- **The Data Pool is switched off in release builds.** The only provider that
  exists is a Demo Provider whose usage figures are generated. Shipping a screen
  of simulated network usage would misrepresent what the app does — which is a
  policy violation with account-level consequences, not a cosmetic issue. It
  switches on the day a real carrier adapter exists.

---

## When you outgrow the free tier

`docker-compose.yml` runs the whole control plane on any VPS. You supply a
reverse proxy for TLS — Caddy is two lines and gets certificates by itself:

```
netlink.yourdomain.com {
    reverse_proxy localhost:4000
}
```

Then set the same environment variables from `render.yaml`, and take backups
with `scripts/backup-windows.ps1` — or its `pg_dump` equivalent on Linux. The
backup script verifies every backup by restoring it, which is the only way to
know a backup is real.
