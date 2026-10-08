-- name: LatestVersion :one
SELECT COALESCE(MAX(version), 0)::bigint FROM change_log WHERE account_id = $1;
