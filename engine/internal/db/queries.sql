-- name: GetAccount :one
SELECT * FROM mail_account WHERE id = $1;

-- name: GetMailbox :one
SELECT * FROM mailbox WHERE account_id = $1 AND name = $2;

-- name: CreateMailbox :exec
INSERT INTO mailbox (id, account_id, name, role, uid_validity) VALUES ($1, $2, $3, $4, $5);

-- name: UpdateMailbox :exec
UPDATE mailbox SET role = $2, uid_validity = $3 WHERE id = $1;

-- name: ListMailboxes :many
SELECT * FROM mailbox WHERE account_id = $1;

-- name: DeleteMailbox :exec
DELETE FROM mailbox WHERE id = $1;

-- name: ClearMailbox :many
DELETE FROM message WHERE mailbox_id = $1 RETURNING id;

-- name: MaxUID :one
SELECT COALESCE(MAX(uid), 0)::bigint FROM message WHERE mailbox_id = $1;

-- name: InsertMessage :execrows
INSERT INTO message (id, account_id, mailbox_id, uid, message_id, subject, snippet, from_name, from_addr, sent_at, flags, size)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (mailbox_id, uid) DO NOTHING;

-- name: LogChange :one
WITH v AS (UPDATE mail_account SET version = version + 1 WHERE id = $1 RETURNING version)
INSERT INTO change_log (account_id, version, entity, entity_id, op)
SELECT $1, v.version, $2, $3, $4 FROM v
RETURNING version;

-- name: ListAccountIDs :many
SELECT id FROM mail_account;

-- name: GetMessagePlace :one
SELECT m.uid, b.name FROM message m JOIN mailbox b ON b.id = m.mailbox_id WHERE m.id = $1 AND m.account_id = $2;

-- name: ListFlags :many
SELECT id, uid, flags FROM message WHERE mailbox_id = $1;

-- name: SetFlags :exec
UPDATE message SET flags = $2 WHERE id = $1;

-- name: DeleteMessage :exec
DELETE FROM message WHERE id = $1;
