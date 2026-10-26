-- name: GetAccount :one
SELECT * FROM mail_account WHERE id = $1;

-- name: CreateMailbox :exec
INSERT INTO mailbox (id, account_id, name, role, uid_validity) VALUES ($1, $2, $3, $4, $5);

-- name: UpdateMailbox :exec
UPDATE mailbox SET role = $2, uid_validity = $3 WHERE id = $1;

-- name: SetFolderState :exec
UPDATE mailbox SET uid_next = $2, message_count = $3, highest_mod_seq = $4 WHERE id = $1;

-- name: ListMailboxes :many
SELECT * FROM mailbox WHERE account_id = $1;

-- name: DeleteMailbox :exec
DELETE FROM mailbox WHERE id = $1;

-- name: ClearMailbox :many
DELETE FROM message WHERE mailbox_id = $1 RETURNING id;

-- name: MaxUID :one
SELECT COALESCE(MAX(uid), 0)::bigint FROM message WHERE mailbox_id = $1;

-- name: CountMessages :one
SELECT count(*) FROM message WHERE mailbox_id = $1;

-- name: InsertMessage :execrows
INSERT INTO message (id, account_id, mailbox_id, uid, message_id, sent_at, flags, size, refs, thread_id, category, key, sealed, spam)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
ON CONFLICT (mailbox_id, uid) DO NOTHING;

-- name: ListContacts :many
SELECT hash FROM contact WHERE user_id = $1;

-- name: AddContacts :exec
INSERT INTO contact (user_id, hash) SELECT $1, unnest(sqlc.arg(hashes)::text[]) ON CONFLICT DO NOTHING;

-- name: ListSenderRules :many
SELECT sender, category, spam FROM sender_rule WHERE user_id = $1;

-- name: GetUserKey :one
SELECT k.public_key FROM user_key k JOIN mail_account a ON a.user_id = k.user_id WHERE a.id = $1;

-- name: SetSealedTo :exec
UPDATE mail_account SET sealed_to = $2 WHERE id = $1;

-- name: KnownMessages :many
SELECT id FROM message WHERE id = ANY(sqlc.arg(ids)::text[]);

-- name: LogChanges :one
-- Logs the changes in order under the account's next versions and returns the last one.
WITH v AS (
  UPDATE mail_account SET version = version + cardinality(sqlc.arg(entity_ids)::text[]) WHERE id = sqlc.arg(account_id) RETURNING version
), logged AS (
  INSERT INTO change_log (account_id, version, entity, entity_id, op)
  SELECT sqlc.arg(account_id), v.version - cardinality(sqlc.arg(entity_ids)::text[]) + i,
    (sqlc.arg(entities)::text[])[i], (sqlc.arg(entity_ids)::text[])[i], (sqlc.arg(ops)::text[])[i]
  FROM v, generate_series(1, cardinality(sqlc.arg(entity_ids)::text[])) AS i
)
SELECT version FROM v;

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
SELECT m.uid, m.flags, b.name, b.local, b.role FROM message m JOIN mailbox b ON b.id = m.mailbox_id WHERE m.id = $1 AND m.account_id = $2;

-- name: SortMessage :exec
-- Puts a message into a tab or marks it spam or not, and logs the change, unless nothing changes.
WITH changed AS (
  UPDATE message SET category = coalesce(sqlc.narg(category)::text, category), spam = coalesce(sqlc.narg(spam)::boolean, spam)
  WHERE id = sqlc.arg(id) AND account_id = sqlc.arg(account_id)
    AND (category <> coalesce(sqlc.narg(category)::text, category) OR spam <> coalesce(sqlc.narg(spam)::boolean, spam))
  RETURNING id
), v AS (
  UPDATE mail_account SET version = version + 1 WHERE id = sqlc.arg(account_id) AND EXISTS (SELECT FROM changed) RETURNING version
)
INSERT INTO change_log (account_id, version, entity, entity_id, op)
SELECT sqlc.arg(account_id), v.version, 'message', sqlc.arg(id), 'upsert' FROM v;

-- name: ListFlags :many
SELECT id, uid, flags FROM message WHERE mailbox_id = $1;

-- name: ListFlagsFor :many
SELECT id, uid, flags FROM message WHERE mailbox_id = $1 AND uid = ANY(sqlc.arg(uids)::bigint[]);

-- name: DeleteGone :many
-- Messages of a folder whose UID the server doesn't list anymore.
DELETE FROM message WHERE mailbox_id = $1 AND uid <> ALL(sqlc.arg(uids)::bigint[]) RETURNING id;

-- name: SaveFlags :exec
-- Sets a message's flags and logs the change, unless it has them already.
WITH changed AS (
  UPDATE message SET flags = sqlc.arg(flags) WHERE id = sqlc.arg(id) AND account_id = sqlc.arg(account_id) AND flags <> sqlc.arg(flags) RETURNING id
), v AS (
  UPDATE mail_account SET version = version + 1 WHERE id = sqlc.arg(account_id) AND EXISTS (SELECT FROM changed) RETURNING version
)
INSERT INTO change_log (account_id, version, entity, entity_id, op)
SELECT sqlc.arg(account_id), v.version, 'message', sqlc.arg(id), 'upsert' FROM v;

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

-- name: FirstAccount :one
-- The account a user's seeded mail goes to: the first in their order that isn't archived.
SELECT * FROM mail_account WHERE user_id = $1 AND archived_at IS NULL ORDER BY position, created_at LIMIT 1;

-- name: LocalMailbox :one
SELECT * FROM mailbox WHERE account_id = $1 AND local;

-- name: CreateLocalMailbox :exec
INSERT INTO mailbox (id, account_id, name, role, uid_validity, local) VALUES ($1, $2, $3, 'inbox', 1, true);

-- name: HasMessage :one
SELECT EXISTS (SELECT FROM message WHERE account_id = $1 AND message_id = $2);

-- name: DeleteLocalMessage :exec
-- Removes a message and logs it, for mail that only lives in Nouvex.
WITH gone AS (
  DELETE FROM message WHERE id = sqlc.arg(id) AND account_id = sqlc.arg(account_id) RETURNING id
), v AS (
  UPDATE mail_account SET version = version + 1 WHERE id = sqlc.arg(account_id) AND EXISTS (SELECT FROM gone) RETURNING version
)
INSERT INTO change_log (account_id, version, entity, entity_id, op)
SELECT sqlc.arg(account_id), v.version, 'message', sqlc.arg(id), 'delete' FROM v;

-- name: StartSend :one
-- Claims a draft's send. No row: it went out already.
INSERT INTO outbox (draft_id, account_id, state, payload) VALUES ($1, $2, 'sending', $3)
ON CONFLICT (draft_id) DO UPDATE SET state = 'sending', payload = EXCLUDED.payload, error = NULL, updated_at = now()
WHERE outbox.state <> 'sent' AND outbox.account_id = EXCLUDED.account_id
RETURNING state;

-- name: ScheduleSend :execrows
INSERT INTO outbox (draft_id, account_id, state, run_at, payload) VALUES ($1, $2, 'scheduled', $3, $4)
ON CONFLICT (draft_id) DO UPDATE SET state = 'scheduled', run_at = EXCLUDED.run_at, payload = EXCLUDED.payload, error = NULL, updated_at = now()
WHERE outbox.state <> 'sent' AND outbox.account_id = EXCLUDED.account_id;

-- name: EndSend :exec
-- A sent one keeps only its key, to turn the same command away; what it said goes.
UPDATE outbox SET state = @state, error = @error, updated_at = now(),
	payload = CASE WHEN @state = 'sent' THEN ''::bytea ELSE payload END
WHERE draft_id = @draft_id;

-- name: SendState :one
SELECT state FROM outbox WHERE draft_id = $1;

-- name: TakeDueSends :many
-- Due ones, and ones taken before that never got anywhere, e.g. the engine stopped in between: sending one twice is
-- harmless, StartSend lets it out once.
UPDATE outbox SET state = 'sending', updated_at = now()
WHERE draft_id IN (
	SELECT draft_id FROM outbox
	WHERE (state = 'scheduled' AND run_at <= now()) OR (state = 'sending' AND run_at IS NOT NULL AND updated_at < now() - interval '30 minutes')
	ORDER BY run_at LIMIT 20 FOR UPDATE SKIP LOCKED
)
RETURNING draft_id, account_id, payload;

-- name: ForgetSent :exec
DELETE FROM outbox WHERE state = 'sent' AND updated_at < now() - interval '7 days';
