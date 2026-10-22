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
INSERT INTO message (id, account_id, mailbox_id, uid, message_id, sent_at, flags, size, refs, thread_id, category, key, sealed)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (mailbox_id, uid) DO NOTHING;

-- name: GetUserKey :one
SELECT k.public_key FROM user_key k JOIN mail_account a ON a.user_id = k.user_id WHERE a.id = $1;

-- name: SetSealedTo :exec
UPDATE mail_account SET sealed_to = $2 WHERE id = $1;

-- name: KnownMessages :many
SELECT id FROM message WHERE id = ANY(sqlc.arg(ids)::text[]);

-- name: LogChange :one
WITH v AS (UPDATE mail_account SET version = version + 1 WHERE id = $1 RETURNING version)
INSERT INTO change_log (account_id, version, entity, entity_id, op)
SELECT $1, v.version, $2, $3, $4 FROM v
RETURNING version;

-- name: ListAccountIDs :many
SELECT id FROM mail_account;

-- name: ListArchivedAccountIDs :many
SELECT id FROM mail_account WHERE archived_at IS NOT NULL;

-- name: GetMessagePlace :one
SELECT m.uid, b.name FROM message m JOIN mailbox b ON b.id = m.mailbox_id WHERE m.id = $1 AND m.account_id = $2;

-- name: ListFlags :many
SELECT id, uid, flags FROM message WHERE mailbox_id = $1;

-- name: SetFlags :exec
UPDATE message SET flags = $2 WHERE id = $1;

-- name: DeleteMessage :exec
DELETE FROM message WHERE id = $1;

-- name: GetMessageID :one
SELECT message_id FROM message WHERE id = $1 AND account_id = $2;

-- name: SetSyncError :exec
UPDATE mail_account SET sync_error = $2 WHERE id = $1;

-- name: ThreadsFor :many
-- Conversations a message belongs to: those of the messages it answers, of messages that answer it, and of other
-- copies of it (the same mail in Sent and INBOX). Without a Message-ID only the first counts.
SELECT DISTINCT thread_id FROM message
WHERE account_id = sqlc.arg(account_id) AND thread_id <> ''
  AND (message_id = ANY(sqlc.arg(refs)::text[])
    OR (sqlc.arg(message_id)::text <> '' AND (refs && ARRAY[sqlc.arg(message_id)::text] OR message_id = sqlc.arg(message_id)::text)));

-- name: MergeThread :many
UPDATE message SET thread_id = sqlc.arg(keep)::text WHERE account_id = sqlc.arg(account_id) AND thread_id = sqlc.arg(thread_id) RETURNING id;

-- name: AddJob :exec
INSERT INTO scheduled (id, account_id, run_at, kind, payload) VALUES ($1, $2, $3, $4, $5);

-- name: TakeDueJobs :many
-- Taken jobs are gone; a job that fails is added again.
DELETE FROM scheduled
WHERE id IN (SELECT id FROM scheduled WHERE run_at <= now() ORDER BY run_at LIMIT 20 FOR UPDATE SKIP LOCKED)
RETURNING *;

-- name: FindByRole :one
SELECT m.id FROM message m JOIN mailbox b ON b.id = m.mailbox_id
WHERE m.account_id = $1 AND m.message_id = $2 AND b.role = $3
LIMIT 1;
