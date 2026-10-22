# Running your own server

Everything runs on one machine with Docker: Postgres, NATS, SeaweedFS for mail bodies, the API, the sync engine, and Caddy in front, which serves the web app, passes the API's paths through and gets the HTTPS certificate. The web app and the Apple apps all talk to the same domain.

## What you need

- A Linux server with Docker and the compose plugin, 2 GB of RAM or more.
- A domain whose A record (and AAAA, if the server has IPv6) points at the server.
- Ports 80 and 443 open.

## First start

```sh
git clone https://github.com/Nouvex-cc/Nouvex-Mail.git && cd Nouvex-Mail
cp deploy/.env.example deploy/.env
```

Fill in `deploy/.env`. Each secret is one `openssl rand -base64 32`. Keep a copy of `SECRETS_KEY` somewhere safe: the mail account passwords are encrypted with it, and without it every account has to be added again.

```sh
docker compose -f deploy/compose.yml up -d --build
```

The database schema is created on the first start. Open `https://<your domain>`, create an account, add a mailbox. In the Apple apps, enter the same address as the server when signing in.

## Updates

```sh
git pull
docker compose -f deploy/compose.yml up -d --build
```

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
