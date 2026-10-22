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

Nobody can sign up on the server's page; accounts are added here. The password is read from stdin, so it stays out of the shell history:

```sh
read -rs pw && echo "$pw" | docker compose -f deploy/compose.yml exec -T api bun dist/user.js add you@example.com "Your Name"
```

`user.js password you@example.com` sets a new password the same way, for someone who forgot theirs. Then open `https://<your domain>` and sign in. In the Apple apps, enter the same address as the server when signing in.

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
