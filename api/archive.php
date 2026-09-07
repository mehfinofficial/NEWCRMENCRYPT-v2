<?php
// api/archive.php — the "dustbin" for everything soft-deleted from
// Clients, Records/Transactions, and Follow-ups. Admin-only, same
// hard-coded (not toggleable) gate as users.php, and for the same
// reason: this screen can permanently destroy data across every table,
// so it isn't something a permission toggle should be able to grant.
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

$pdo = getDB();
requireAuth($pdo);

if (getUserRole($pdo) !== 'admin') {
    jsonOut(['error' => 'Admin access required'], 403);
}

// Auto-migrate: deleted_at should already exist on all three tables (each
// endpoint adds its own), but guard here too in case Archives is opened
// before any of them has run yet on a fresh install.
foreach (ARCHIVE_TABLES as $meta) {
    $table = $meta['table'];
    try {
        $cols = array_column($pdo->query("PRAGMA table_info($table)")->fetchAll(), 'name');
        if (!in_array('deleted_at', $cols)) {
            $pdo->exec("ALTER TABLE $table ADD COLUMN deleted_at DATETIME DEFAULT NULL");
        }
    } catch (Exception $e) {}
}

// Sweep expired items before doing anything else, so a restore/purge
// request never operates on something that should already be gone, and
// the list never briefly shows something about to be swept.
purgeExpiredArchives($pdo);

$method = $_SERVER['REQUEST_METHOD'];
$RETENTION_DAYS = 30;

if ($method === 'GET') {
    $items = [];
    foreach (ARCHIVE_TABLES as $type => $meta) {
        $table    = $meta['table'];
        $titleCol = $meta['title'];
        $subCol   = $meta['subtitle'];
        $stmt = $pdo->query("SELECT * FROM $table WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC");
        foreach ($stmt->fetchAll() as $row) {
            $deletedAt = $row['deleted_at'];
            $expiresAt = date('Y-m-d H:i:s', strtotime($deletedAt) + ($RETENTION_DAYS * 86400));
            $daysLeft  = max(0, (int)ceil((strtotime($expiresAt) - time()) / 86400));
            $items[] = [
                'type'       => $type,
                'id'         => (int)$row['id'],
                'title'      => $row[$titleCol] ?? '',
                'subtitle'   => $row[$subCol] ?? '',
                'deleted_at' => $deletedAt,
                'expires_at' => $expiresAt,
                'days_left'  => $daysLeft,
            ];
        }
    }
    // Soonest-to-purge first — the ones an admin most likely needs to act
    // on if they want to save something.
    usort($items, fn($a, $b) => $a['days_left'] <=> $b['days_left']);

    jsonOut(['items' => $items, 'retention_days' => $RETENTION_DAYS]);
}

if ($method === 'POST') {
    $body   = jsonIn();
    $action = $body['action'] ?? '';
    $type   = $body['type'] ?? '';
    $id     = (int)($body['id'] ?? 0);

    if (!isset(ARCHIVE_TABLES[$type]) || !$id) {
        jsonOut(['error' => 'Invalid type or id'], 400);
    }
    $table    = ARCHIVE_TABLES[$type]['table'];
    $titleCol = ARCHIVE_TABLES[$type]['title'];

    if ($action === 'restore') {
        $stmt = $pdo->prepare("SELECT $titleCol AS title FROM $table WHERE id = ? AND deleted_at IS NOT NULL");
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) jsonOut(['error' => 'Item not found in Archives'], 404);

        $pdo->prepare("UPDATE $table SET deleted_at = NULL WHERE id = ?")->execute([$id]);
        logAction($pdo, ucfirst($type) . " restored from Archives: " . ($row['title'] ?: "#$id"));
        jsonOut(['success' => true]);
    }

    // Permanently deletes right now, ahead of the normal 30-day sweep —
    // for an admin who's certain they don't want it back and would
    // rather not wait. Irreversible, unlike the soft-delete this follows.
    if ($action === 'purge') {
        $stmt = $pdo->prepare("SELECT $titleCol AS title FROM $table WHERE id = ? AND deleted_at IS NOT NULL");
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) jsonOut(['error' => 'Item not found in Archives'], 404);

        $pdo->prepare("DELETE FROM $table WHERE id = ?")->execute([$id]);
        logAction($pdo, ucfirst($type) . " permanently deleted: " . ($row['title'] ?: "#$id"));
        jsonOut(['success' => true]);
    }

    jsonOut(['error' => 'Unknown action'], 400);
}

jsonOut(['error' => 'Method not allowed'], 405);
