<?php
// api/quicklinks.php — Quick Links screen.
//
// A flat list of links (tools, portals, docs, whatever) that admins paste
// in once and everyone with access can copy from. Viewing the screen is a
// per-user permission toggle (access_quick_links, set from Set User), same
// pattern as access_file_manager / access_quick_message. Adding, editing,
// and removing links is hard admin-only — not a toggle — same non-toggleable
// pattern as Add User / Set User / Archives, since that's the whole point:
// regular users can only ever copy what an admin put there.
ini_set('display_errors', 0);
ini_set('log_errors', 1);
error_reporting(E_ALL);
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

$pdo = getDB();
requireAuth($pdo);
$method = $_SERVER['REQUEST_METHOD'];

// Auto-create the table so this works on a fresh DB with zero manual setup,
// same pattern as message_templates in messages.php.
try {
    $pdo->exec("CREATE TABLE IF NOT EXISTS quick_links (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        title      TEXT NOT NULL,
        url        TEXT NOT NULL,
        notes      TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )");
} catch (Exception $e) {}

// ── VIEW (any user with the access_quick_links permission) ──────────────
if ($method === 'GET') {
    requirePermission($pdo, 'access_quick_links');
    $stmt = $pdo->query("SELECT id, title, url, notes, created_at FROM quick_links ORDER BY title COLLATE NOCASE ASC");
    jsonOut(['links' => $stmt->fetchAll()]);
}

if ($method === 'POST') {
    $body   = jsonIn();
    $action = $body['action'] ?? '';

    // Every write action below is hard admin-only, checked here rather
    // than trusting access_quick_links — that permission only ever governs
    // whether a user can *see* the screen and copy from it.
    if (getUserRole($pdo) !== 'admin') {
        jsonOut(['error' => 'Only admins can manage Quick Links', 'permission_denied' => true], 403);
    }

    if ($action === 'add') {
        $title = trim($body['title'] ?? '');
        $url   = trim($body['url'] ?? '');
        $notes = trim($body['notes'] ?? '');
        if (!$title || !$url) jsonOut(['success' => false, 'error' => 'Title and URL are required.'], 400);

        $stmt = $pdo->prepare("INSERT INTO quick_links (title, url, notes, created_by) VALUES (?, ?, ?, ?)");
        $stmt->execute([$title, $url, $notes ?: null, $_SESSION['username'] ?? '']);
        $newId = $pdo->lastInsertId();

        logAction($pdo, "Quick Link added: $title");
        jsonOut(['success' => true, 'id' => $newId]);
    }

    if ($action === 'update') {
        $id    = (int)($body['id'] ?? 0);
        $title = trim($body['title'] ?? '');
        $url   = trim($body['url'] ?? '');
        $notes = trim($body['notes'] ?? '');
        if (!$id || !$title || !$url) jsonOut(['success' => false, 'error' => 'Invalid quick link.'], 400);

        $stmt = $pdo->prepare("UPDATE quick_links SET title = ?, url = ?, notes = ?, updated_at = ? WHERE id = ?");
        $stmt->execute([$title, $url, $notes ?: null, date('Y-m-d H:i:s'), $id]);

        logAction($pdo, "Quick Link updated: $title");
        jsonOut(['success' => true]);
    }

    if ($action === 'delete') {
        $id = (int)($body['id'] ?? 0);
        if (!$id) jsonOut(['success' => false, 'error' => 'Invalid ID.'], 400);

        $stmt = $pdo->prepare("SELECT title FROM quick_links WHERE id = ? LIMIT 1");
        $stmt->execute([$id]);
        $title = $stmt->fetchColumn();

        $pdo->prepare("DELETE FROM quick_links WHERE id = ?")->execute([$id]);
        logAction($pdo, "Quick Link deleted: " . ($title ?: "#$id"));
        jsonOut(['success' => true]);
    }

    jsonOut(['error' => 'Unknown action'], 400);
}

jsonOut(['error' => 'Method not allowed'], 405);
