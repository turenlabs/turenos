#!/bin/sh
# Regenerate the committed fixture databases under test/fixtures/ using the
# macOS /usr/bin/sqlite3 CLI. Fixtures are committed; this script documents
# how they were produced and only needs to run when they change.
set -eu

dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/fixtures"
mkdir -p "$dir"

# 1. simple.db — tables, index, view, trigger, all serial kinds, metadata.
rm -f "$dir/simple.db"
sqlite3 "$dir/simple.db" <<'SQL'
CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, age INTEGER, score REAL, data BLOB);
INSERT INTO users VALUES
  (1, 'alice', 30, 91.5, x'0102deadbeef'),
  (2, 'bob', 25, 88.0, x''),
  (3, 'carol', 42, NULL, x'ff'),
  (4, 'dave', -7, 0.25, zeroblob(12));
CREATE TABLE meta(k TEXT PRIMARY KEY, v INTEGER);
INSERT INTO meta VALUES('schema', 4);
CREATE INDEX idx_users_age ON users(age);
CREATE VIEW v_users AS SELECT name, age FROM users;
CREATE TRIGGER trg_users AFTER INSERT ON users BEGIN SELECT 1; END;
PRAGMA user_version = 7;
PRAGMA application_id = 1337;
SQL

# 2. without-rowid.db — index b-tree as table storage.
rm -f "$dir/without-rowid.db"
sqlite3 "$dir/without-rowid.db" <<'SQL'
CREATE TABLE dict(word TEXT PRIMARY KEY, def TEXT, n INTEGER) WITHOUT ROWID;
INSERT INTO dict VALUES
  ('apple', 'a fruit', 1),
  ('zinc', 'a metal', 26),
  ('mid', 'in between', 13);
SQL

# 3. overflow.db — small pages + big blob/text payloads spill to overflow
#    chains. zeroblob keeps bytes deterministic for sha256 assertions.
rm -f "$dir/overflow.db"
sqlite3 "$dir/overflow.db" <<'SQL'
PRAGMA page_size = 512;
CREATE TABLE big(id INTEGER PRIMARY KEY, data BLOB, note TEXT);
INSERT INTO big VALUES
  (1, zeroblob(4000), 'big-one'),
  (2, zeroblob(600), 'small'),
  (3, replace(hex(zeroblob(1500)), '00', 'ab'), 'text-overflow');
SQL

# 4. deleted.db — DELETE leaves freeblocks; DROP TABLE parks whole pages on
#    the freelist with intact stale records (carvable).
rm -f "$dir/deleted.db"
sqlite3 "$dir/deleted.db" <<'SQL'
PRAGMA page_size = 1024;
PRAGMA auto_vacuum = NONE;
CREATE TABLE logs(id INTEGER PRIMARY KEY, msg TEXT, level INTEGER);
INSERT INTO logs VALUES
  (1, 'keep-alpha', 1),
  (2, 'deleted-bravo', 2),
  (3, 'keep-charlie', 3),
  (4, 'deleted-delta', 4),
  (5, 'keep-echo', 5);
DELETE FROM logs WHERE msg LIKE 'deleted%';
CREATE TABLE scratch(tag TEXT, note TEXT);
INSERT INTO scratch VALUES('scratch-row-111', 'first dropped row');
INSERT INTO scratch VALUES('scratch-row-222', 'second dropped row');
WITH RECURSIVE c(x) AS (
  SELECT 3 UNION ALL SELECT x + 1 FROM c WHERE x < 90
)
INSERT INTO scratch SELECT 'filler-' || printf('%03d', x), 'padding row to span pages ' || x FROM c;
DROP TABLE scratch;
SQL

# 5. corrupt.db — valid file with the magic byte and page-size field damaged.
rm -f "$dir/corrupt.db"
sqlite3 "$dir/corrupt.db" <<'SQL'
CREATE TABLE t(a, b);
INSERT INTO t VALUES(1, 'x'), (2, 'y');
SQL
# Break the magic string (offset 0) and the page-size field (offset 16).
printf 'X' | dd of="$dir/corrupt.db" bs=1 seek=0 count=1 conv=notrunc 2>/dev/null
printf '\x03' | dd of="$dir/corrupt.db" bs=1 seek=16 count=1 conv=notrunc 2>/dev/null

# 6. wal.db — WAL journal mode persists as write/read version 2 in the header.
rm -f "$dir/wal.db" "$dir/wal.db-wal" "$dir/wal.db-shm"
sqlite3 "$dir/wal.db" <<'SQL'
PRAGMA journal_mode = WAL;
CREATE TABLE t(a);
INSERT INTO t VALUES('in-wal-mode');
PRAGMA wal_checkpoint(TRUNCATE);
SQL
rm -f "$dir/wal.db-wal" "$dir/wal.db-shm"

# 7. utf16.db — UTF-16le storage encoding.
rm -f "$dir/utf16.db"
sqlite3 "$dir/utf16.db" <<'SQL'
PRAGMA encoding = 'UTF-16le';
CREATE TABLE t(s TEXT, n INTEGER);
INSERT INTO t VALUES('héllo', 5);
SQL

# 8. empty.db — valid header, zero user content.
rm -f "$dir/empty.db"
sqlite3 "$dir/empty.db" "CREATE TABLE t(x);"

# 9. many.db — small pages + enough rows to force interior b-tree pages
#    (depth >= 2), exercising interior traversal and right pointers.
rm -f "$dir/many.db"
sqlite3 "$dir/many.db" <<'SQL'
PRAGMA page_size = 512;
CREATE TABLE nums(n INTEGER PRIMARY KEY, label TEXT);
WITH RECURSIVE c(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 300
)
INSERT INTO nums SELECT x, 'label-' || printf('%03d', x) FROM c;
SQL

ls -l "$dir"
