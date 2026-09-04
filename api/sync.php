<?php
// api/sync.php — Lightweight change detector
// Returns only whether data changed since a given timestamp.
// 99% of calls = just 4 COUNT queries on SQLite = near zero cost.

session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

$pdo   = getDB();
requireAuth($pdo);
$since = $_GET['since'] ?? null;

// ── Ensure meta table exists ──────────────────────────────────────────
$pdo->exec("CREATE TABLE IF NOT EXISTS sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
)");

// ── Helper: get the stored last_modified timestamp ────────────────────
function getLastModified(PDO $pdo): string {
    $row = $pdo->query("SELECT value FROM sync_meta WHERE key = 'last_modified'")->fetch();
    return $row ? $row['value'] : '1970-01-01 00:00:00';
}

// ── On POST: bump the timestamp (called internally by other endpoints) ─
// We actually bump it from within this file's bumpLastModified() helper
// which is included by helpers.php after this file is loaded.
// External bump: any write endpoint calls bumpSync() below.

// ── On GET: compare timestamps ────────────────────────────────────────
$lastModified = getLastModified($pdo);
$serverTs     = strtotime($lastModified);
$clientTs     = $since ? (int)$since : 0;

$changed = $serverTs > $clientTs;

jsonOut([
    'changed'       => $changed,
    'last_modified' => $lastModified,
    'server_ts'     => $serverTs,
]);