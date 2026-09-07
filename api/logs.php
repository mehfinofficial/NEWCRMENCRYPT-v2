<?php
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

$pdo = getDB();
requireAuth($pdo);
// Logs is admin-only, hard-coded rather than a Set User toggle — same
// reasoning as Add User/Set User/Archives: this can reveal every action
// taken by every account, so it isn't something a permission checkbox
// should be able to grant.
if (getUserRole($pdo) !== 'admin') {
    jsonOut(['error' => 'Admin access required'], 403);
}
$pdo->exec("CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    user TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)");

// Auto-migrate: add user column to existing logs table if missing
try {
    $cols = array_column($pdo->query("PRAGMA table_info(logs)")->fetchAll(), 'name');
    if (!in_array('user', $cols)) {
        $pdo->exec("ALTER TABLE logs ADD COLUMN user TEXT DEFAULT NULL");
    }
} catch (Exception $e) {}

$page     = max(1, (int)($_GET['page'] ?? 1));
$pageSize = 100;
$offset   = ($page - 1) * $pageSize;

$total = (int)$pdo->query("SELECT COUNT(*) FROM logs")->fetchColumn();

$stmt = $pdo->prepare("SELECT id, message, user, created_at FROM logs ORDER BY created_at DESC LIMIT ? OFFSET ?");
$stmt->bindValue(1, $pageSize, PDO::PARAM_INT);
$stmt->bindValue(2, $offset, PDO::PARAM_INT);
$stmt->execute();
$rows = $stmt->fetchAll();

jsonOut([
    'logs'    => $rows,
    'page'    => $page,
    'total'   => $total,
    'hasMore' => ($offset + count($rows)) < $total,
]);