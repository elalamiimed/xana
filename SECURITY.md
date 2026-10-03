# Security

Xana runs on your machine, holds your life in a SQLite file, and stores API keys
you paste into it. That combination means two different questions get called
"security", and it is worth separating them before either is answered.

**The repository does not contain your data.** `data/` and `.env` are ignored,
and `scripts/check-no-secrets.mjs` is the tripwire on the other side of that
gate: it reads the files a clone would receive and fails if a credential shape,
a real value from this machine's `.env`, or a real home directory appears in
any of them. That is a guard against publishing, not a security boundary.

**The running app is a local service.** It is a web server that any process on
your machine can reach, and it will do what it is told. Its protections are the
ones a single-user local tool can have: it binds to `127.0.0.1` by default,
integrations ask permission before they are allowed to do anything, and
everything that needs the network is off until you switch it on.

## Reporting a vulnerability

Use **Security → Report a vulnerability** on this repository — GitHub's private
advisory channel. It stays private until a fix exists and is the only channel
that does.

If that is unavailable to you, open an issue that describes the *class* of
problem without a working exploit, and say you have one. Do not paste a real
credential, a database file, or a personal detail into an issue.

This is a personal project without a security team or a release process.
Reports are read and answered on a best-effort basis, and the honest expectation
is days rather than hours. There is nothing to pay a bounty with.

## What is in scope

Things worth reporting:

- Anything that lets a **remote** page or service reach the local API — a
  missing origin check, a CORS mistake, a URL that a browser can be made to
  fetch on the app's behalf.
- Anything that lets the **phone endpoint** be used without the token, or that
  leaks the token to a caller who should not have it. Token comparisons use
  `timingSafeEqual` on equal-length buffers (`src/lib/plugins/health-bridge.ts`,
  `src/lib/plugins/google-calendar.ts`); a way around that is a real finding.
- A **permission** that a plugin can exercise without it having been granted —
  the `net.read` / `net.write` gate is meant to be the thing that decides.
- Anything that causes a **credential to be written somewhere it is not meant
  to be**: a log, an error message, a health report, a crash dump, a response
  body.
- Supply-chain problems in what is shipped: a dependency, a lock file, an
  install script.

## What is not a vulnerability

These are deliberate, and a report about them will be answered with this list:

- **API keys sit in plaintext in `data/settings.json`.** The file is the
  user's, on the user's machine, and the alternative — a keychain integration —
  would make the app depend on a platform store it currently does not need.
  File permissions are the protection, and they are the operating system's job.
  This is why `data/` is ignored and why a backup of it is treated as a secret.
- **There is no authentication on the local API.** It binds to `127.0.0.1`.
  Anyone who can open a connection to that port is already running code on the
  machine, and could read the database file directly.
- **`HOSTNAME=0.0.0.0 npm run dev` exposes the app to your network.** It is
  documented, it is opt-in, and it removes the only thing standing between your
  data and the network. Do not do it on a network you do not control.
- **The phone endpoint's token is a bearer token.** Holding it is the
  authorisation; there is no second factor. It is generated on this machine,
  stored in `data/settings.json` and on the phone, and revoking it means
  generating a new one.
- **The app can read and write files under paths you configure**, for the
  folders feature. That is the feature.

## The one thing to check before you file

If you are about to include a credential in a report, stop: rotate it first.
A key that has been in a terminal, a screenshot or a chat is compromised
whether or not a fix follows, and a report is not improved by containing it.
