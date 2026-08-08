# Running NetLink on Windows

Every command here is PowerShell, run from the repository root.

---

## 1. Prerequisites

| | Minimum | Install |
|---|---|---|
| Windows | 10 (1809) or 11 | |
| Node.js | 20.11 LTS | `winget install OpenJS.NodeJS.LTS` |
| Go | **1.25** — Wails v2.13 requires it | `winget install GoLang.Go` |
| WebView2 runtime | Evergreen | `winget install Microsoft.EdgeWebView2Runtime` |
| Docker Desktop | any current (optional) | `winget install Docker.DockerDesktop` |
| Git | any current | `winget install Git.Git` |

Close and reopen PowerShell after installing anything, so the new `PATH` is picked up.

The Wails CLI is installed for you by the setup script. If you want it by hand:

```powershell
go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0
```

Add Go's bin directory to your `PATH` permanently so `wails` works in new terminals:

```powershell
$goBin = Join-Path (go env GOPATH) 'bin'
[Environment]::SetEnvironmentVariable('PATH', "$env:PATH;$goBin", 'User')
```

---

## 2. Setup

```powershell
git clone https://github.com/cristofar4/Netlink-hub.git
cd Netlink-hub
.\scripts\setup-windows.ps1
```

This checks every prerequisite, installs dependencies, writes a `.env` with a freshly generated signing key, starts PostgreSQL and Mailpit, and applies the migrations. It is safe to run repeatedly and will never overwrite an existing `.env` — regenerating the JWT secret would sign every existing session out.

If PowerShell refuses to run the script:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Using your own PostgreSQL instead of Docker: set `DATABASE_URL` in `.env`, then

```powershell
.\scripts\setup-windows.ps1 -SkipDatabase
cd apps\api; npx prisma migrate deploy; cd ..\..
```

The integration tests need a second database named `netlink_test`. Docker Compose creates it; otherwise create it yourself:

```powershell
createdb -U netlink netlink_test
```

---

## 3. Run it

```powershell
.\scripts\dev-windows.ps1
```

Starts PostgreSQL (if not already up), the API with hot reload, and the NetLink window through Wails.

| Variation | Command |
|---|---|
| API only | `.\scripts\dev-windows.ps1 -ApiOnly` |
| Also run the agent in the foreground | `.\scripts\dev-windows.ps1 -Agent` |
| Skip Docker | `.\scripts\dev-windows.ps1 -SkipDatabase` |

Once running:

| | |
|---|---|
| NetLink window | opens automatically |
| API | http://127.0.0.1:4000/api |
| API docs | http://127.0.0.1:4000/docs |
| Mailbox | http://localhost:8025 |

---

## 4. Your first run through

1. The window opens on **Welcome**. Choose **Create a NetLink account**.
2. Enter a name, an email and a password of at least 12 characters with upper, lower and a digit.
3. **The six-digit code appears in the API console output.** `EXPOSE_DEV_OTP=true` in development also returns it in the API response. To receive it as real email instead, set `MAIL_TRANSPORT=smtp`, `SMTP_HOST=localhost`, `SMTP_PORT=1025` in `.env`, restart the API, and read it at http://localhost:8025.
4. Type the code. The account is confirmed and you land on **Sign in**.
5. Sign in with the same email and password. Because this device is new, NetLink sends a second code and shows your email masked.
6. Tick **Trust this device** and enter the code. You land on **My Spaces**.
7. Click the **Computers** node on the map to see this device, rename it, or revoke it.
8. Open **Activity** to see every one of those steps recorded.

### Then connect a computer and use it

9. On **My Spaces**, click **Add a computer**. You get a single-use enrollment token.
10. Start the agent with it (see §5). Within a few seconds the map node turns green — that is a real heartbeat, not a placeholder. Stop the agent and it goes grey after 90 seconds.
11. **Device Power and Wake** now lists that computer, with every wake precondition shown and each action saying why it cannot be pressed if it cannot. Lock is the safest one to try.
12. **Files** — approve a folder, browse it, download something. Nothing outside the folder you approved is reachable, and the API refuses even a hand-crafted request that tries.
13. **Printers** — share a printer the agent found, then print a PDF. The preview is your own browser's; the document does not leave the machine until you press Print.
14. **Network Access** — press **Watch the screen**. A real WebRTC connection is established and you see the screen. Nothing you type or click is sent, and that is enforced on the computer being watched rather than by hiding buttons. **Take control** asks for a six-digit code first.
15. **Data Pool** — connect the Demo Provider with any account reference of 6+ digits, then issue a Data-Only Pass. Sign in as that person on another machine and you will see an allowance and nothing else. Every number here is labelled **Demo Provider**, because it is.

---

## 5. The agent

The agent is the background service. It runs on its own in production; for development you can drive it by hand:

```powershell
cd services\agent

go run .\cmd\netlink-agent status     # identity and how the key is protected
go run .\cmd\netlink-agent run -v     # foreground, verbose
go run .\cmd\netlink-agent reset      # forget this device identity
go run .\cmd\netlink-agent version
```

Installing it as a Windows service (needs an **Administrator** PowerShell):

```powershell
go build -o bin\netlink-agent.exe .\cmd\netlink-agent
.\bin\netlink-agent.exe install
sc.exe start NetLinkAgent

sc.exe query NetLinkAgent      # check it
sc.exe stop NetLinkAgent
.\bin\netlink-agent.exe uninstall
```

`status` shows the key protection. On Windows it should read `windows-dpapi`. Anything else means the key is not being sealed by the OS, and NetLink says so rather than implying otherwise.

The agent stores its identity in `%ProgramData%\NetLink\agent` — machine-wide, because the service runs as LocalSystem while the window runs as you. The desktop app keeps its own identity in `%AppData%\NetLink\desktop`.

---

## 6. Checks

```powershell
.\scripts\test-all.ps1                  # everything
.\scripts\test-all.ps1 -SkipBuilds      # faster loop
.\scripts\test-all.ps1 -SkipIntegration # no database needed
.\scripts\test-all.ps1 -FixFormatting   # apply Prettier and gofmt
```

The API integration tests need PostgreSQL running, because they exercise the real guards against real SQL.

---

## 7. Building for release

For a quick local build:

```powershell
cd apps\desktop
wails build -clean
# -> apps\desktop\build\bin\NetLink.exe

cd ..\..\services\agent
go build -ldflags "-s -w" -o bin\netlink-agent.exe .\cmd\netlink-agent
```

For a real release, use the script — it runs the whole gate first, then builds, signs and produces a signed update manifest:

```powershell
# Unsigned, for yourself. It will say loudly that it is unsigned.
.\scripts\build-release.ps1 -Version 1.0.0 -BaseUrl https://releases.example.com

# Signed, for other people.
.\scripts\build-release.ps1 -Version 1.0.0 `
    -CertificateThumbprint <your certificate thumbprint> `
    -ReleaseKeyPath E:\keys\netlink-release.key `
    -BaseUrl https://releases.example.com
```

Generate the release key once, and keep it offline:

```powershell
cd services\agent
go run .\cmd\netlink-release keygen --out E:\keys\netlink-release.key
```

That key decides what code runs on every NetLink installation. Anything that can read it can ship anything to everyone.

**Without a code-signing certificate the binaries are unsigned**, Windows SmartScreen will warn users, and the UAC prompt will say "Unknown publisher". The build script says so rather than pretending otherwise. Without a release key the manifest is unsigned, and no agent will apply the update — which is the correct behaviour, not a bug to work around.

---

## 8. Backups

```powershell
.\scripts\backup-windows.ps1 -Destination D:\netlink-backups
.\scripts\restore-windows.ps1 -BackupFile D:\netlink-backups\netlink-20260808-020000.dump
```

Every backup is verified by restoring it into a throwaway database before it is kept. Schedule it with Task Scheduler, keep a copy somewhere the API server cannot write to, and encrypt it at rest — it holds every account and the whole audit trail, though no passwords, no file contents and no screen frames, because none of those are ever stored.

---

## 9. Troubleshooting

**`wails: command not found`** — Go's bin directory is not on your `PATH`. See §1.

**`Go 1.25 or newer required`** — Wails v2.13 needs it. `winget upgrade GoLang.Go`, then reopen PowerShell.

**The window opens blank** — the WebView2 runtime is missing or damaged. `winget install Microsoft.EdgeWebView2Runtime`.

**`Invalid NetLink API configuration`** — the API validates its environment at boot and refuses to start on a bad one. The message names the exact variable. Most often `.env` is missing (run `setup-windows.ps1`) or `DATABASE_URL` is wrong.

**`Can't reach database server`** — PostgreSQL is not running. `docker compose up -d postgres`, or check `docker compose logs postgres`.

**The code never arrives** — with `MAIL_TRANSPORT=console` it is printed in the API console, not emailed. Switch to Mailpit (§4 step 3) to see it as real email.

**"That code has expired"** — codes last ten minutes and work once. Use **Send a new code**; there is a 60-second cooldown and a limit of three.

**"This device was removed from your account"** — the installation was revoked. Settings → **Forget this device identity**, then sign in again to enroll as a new device.

**Port 4000 is in use** — change `PORT` in `.env`, and change `VITE_NETLINK_API_URL` and `NETLINK_API_URL` to match.

**Integration tests fail with a connection error** — the `netlink_test` database does not exist. See §2.
