# What the server can read

Nouvex syncs your mailboxes on the server, so new mail is there on every device even when they're all off. What it stores of your mail it keeps encrypted for you: whoever runs the server, us included, can't read it from the database, the S3 bucket or a backup. This page says exactly how far that goes.

## How it works

- **Your password never leaves your device.** The apps turn it into two keys (PBKDF2, 600 000 rounds, salted with your address). One goes to the server in place of the password and is hashed there again. The other never leaves the device.
- **Your key pair.** When you set your password, your device makes an X25519 key pair. The server keeps the public key and the private key wrapped with the key that never leaves your device. Only your password opens it, on a device you've unlocked.
- **Each message gets its own key.** When the engine fetches a message, it seals that key to your public key (HPKE, RFC 9180) and encrypts the message with it (AES-256-GCM): subject, sender, recipients, preview, attachment names, sign-in codes and meetings it found, the body and every attachment. The engine can't open what it stored a moment ago; your devices can.
- **Passwords are never set for you.** An admin adds you with a one-time link where you pick your own password. A reset works the same way. The server then drops what it stored for you and fetches your mail again from your mailboxes, sealed to your new key.

The code is in `engine/internal/seal`, `packages/sdk/src/crypto.ts` and `apps/apple/Nouvex/Crypto.swift`.

## What the server still sees

- **Mail while it passes through.** The engine reads each message once, in memory, to encrypt it, find codes and meetings, sort it into a tab and judge whether it's spam. Mail you send passes through in plain text on its way to your provider. Someone who changes the engine's code could keep a copy. Running your own server (docs/deploy.md) is the answer to that.
- **The passwords of your mail accounts.** The engine needs them to sync while none of your devices is on. They are encrypted with the server's `SECRETS_KEY`, so they're safe in a stolen backup, not from whoever runs the server.
- **Metadata:**
  - when a message was sent, its size and flags (read, starred)
  - which tab it's sorted into, and whether the engine took it for spam
  - the addresses you wrote to and the senders you sorted by hand, kept only as SHA-256; like Message-IDs, a guessed address can be checked against them
  - your folder names, your account addresses and mail servers
  - the names of your groups and their focus times, your accounts' short names, colors and order
  - which messages belong to one conversation (Message-IDs are kept only as SHA-256)
- **Remote images and fonts.** When a mail loads pictures or a rich mail its fonts, the server fetches them for you, so it sees their addresses. Set Pictures in mail to Ask first to decide each time.
- **Answers to rich mail forms.** When you confirm sending a form in a rich mail (docs/rich-mail.md), the server passes your answer on to the sender and keeps nothing. The designed version of a rich mail is stored sealed, like the body.
- **Messages scheduled to send later** wait encrypted with `SECRETS_KEY`, because the server has to send them on its own.
- **Announcements** from whoever runs the server (docs/deploy.md) wait in the bucket for a day as they were written, before the engine seals a copy for each user. They're the same for everyone, not anyone's mail.

## On your devices

Opened mail is stored on the device you read it on, like in any mail app: in the browser's IndexedDB and in the Apple apps' database. The private key stays in the Keychain on Apple devices, and in the browser as a key the page can use but not read back. Signing out deletes both.
