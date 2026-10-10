# Nouvex Mail

Open-source mail client that keeps all your accounts in sync across iOS, macOS and web.

```sh
cp .env.example .env
docker compose up -d
bun install && bun run db:migrate
bun dev
```

Then open http://localhost:5173, create an account and add a mail account. The local mail server takes any address
and password: use something like `you@nouvex.test`, IMAP server `127.0.0.1` port 993, SMTP server `127.0.0.1` port
465. Mail you send to another `@nouvex.test` address arrives there; add that account too to see it.
