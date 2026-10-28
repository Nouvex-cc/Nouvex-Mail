# Running your own server

Everything runs on one machine with Docker: Postgres, NATS, SeaweedFS for mail bodies, the API, the sync engine, and Caddy in front, which serves the web app, passes the API's paths through and gets the HTTPS certificate. The web app and the Apple apps all talk to the same domain.

## What you need

- A Linux server with Docker and the compose plugin, 2 GB of RAM or more.
- A domain whose A record (and AAAA, if the server has IPv6) points at the server.
- Ports 80 and 443 open.

## First start

```sh
sudo git clone https://github.com/Nouvex-cc/Nouvex-Mail.git /opt/nouvex && cd /opt/nouvex
cp deploy/.env.example deploy/.env
```

Fill in `deploy/.env`. Each secret is one `openssl rand -base64 32`. Keep a copy of `SECRETS_KEY` somewhere safe: the mail account passwords are encrypted with it, and without it every account has to be added again.

```sh
docker compose -f deploy/compose.yml up -d --build
```

The database schema is created on the first start.

## Accounts

Nobody can sign up on the server's page; accounts are added here. You never set or see anyone's password: the command prints a link, valid once within a week, where the person picks their own.

```sh
docker compose -f deploy/compose.yml exec api bun dist/user.js add you@example.com "Your Name"
```

For someone who forgot their password, `user.js reset you@example.com` prints a new link. Their mail is stored encrypted with a key only their password opens, so a reset drops what was stored and fetches it again from their mailboxes.

## Announcements

To tell your users about something new, write a rich mail (docs/rich-mail.md) and put it into their inboxes in Nouvex. It never reaches their mail servers, and each copy is sealed for its reader like the rest of their mail.

```sh
bun packages/rich/src/cli.ts build mail.html --from "Nouvex <hello@your.domain>" -o mail.eml
docker compose -f deploy/compose.yml exec -T api bun dist/announce.js - --to you@example.com < mail.eml
docker compose -f deploy/compose.yml exec -T api bun dist/announce.js - --all < mail.eml
```

Try it on yourself first. Announcing the same message again (same Message-ID) adds nothing. Its "Try it" buttons (`nx-action`) open places in Nouvex, which only mail put there this way may do.

## Pushes to the iPhone app

New mail reaches the iPhone app as a push while it isn't running. Set `APNS_KEY`, `APNS_KEY_ID` and `APNS_TEAM_ID` in `deploy/.env` (see `.env.example`), with a key from the team the app is signed with; `cc.nouvex.Nouvex` is the topic. A push carries the message's sender and subject only sealed, and the app opens them (docs/security.md). Without the key the app notifies while it's open, as before.

## Sorting

The `embed` container turns mail into vectors (Text Embeddings Inference with multilingual-e5-small), which the engine sorts tabs with, and a model per user learns from (docs/security.md). It needs about 1 GB of memory and downloads the model, about 500 MB, on its first start. While it isn't up, the engine sorts by rules alone. Without `EMBED_URL` the engine doesn't use it at all.

## Passkeys in the Apple apps

Passkeys work in the web app on any domain. The Apple apps are tied to `mail.nouvex.cc` (`apps/apple/Nouvex/Nouvex.entitlements`), so on another domain they sign in with a password; for passkeys there, build the apps with your own team and domain in the entitlements, `deploy/` is unchanged apart from the team id in `apps/web/public/.well-known/apple-app-site-association`.

## Behind another reverse proxy

If a proxy in front already takes ports 80 and 443 and does HTTPS, set `SITE=:80` in `deploy/.env` and point the proxy at port 80 of this machine, with WebSockets on. `DOMAIN` stays the public name, sign-in cookies and links use it.

## Updates

The server keeps itself on the newest `main` that passed CI:

```sh
sudo cp deploy/nouvex-update.service deploy/nouvex-update.timer /etc/systemd/system/
sudo systemctl enable --now nouvex-update.timer
```

Every two minutes `deploy/update.sh` looks at `main`, waits for its checks, rebuilds and restarts. A commit whose CI failed, or whose build fails on the server, is skipped. What it did: `journalctl -u nouvex-update`. Without the timer, run `deploy/update.sh` by hand.

## Backups

The state lives in the `pg` and `s3` volumes. A database dump:

```sh
docker compose -f deploy/compose.yml exec postgres pg_dump -U nouvex nouvex | gzip > nouvex-$(date +%F).sql.gz
```

Mail bodies and attachments are in the `s3` volume:

```sh
docker run --rm -v nouvex_s3:/data -v "$PWD":/backup alpine tar czf /backup/s3-$(date +%F).tgz -C /data .
```

Keep `deploy/.env` with them.

## Logs

```sh
docker compose -f deploy/compose.yml logs -f api engine
```
