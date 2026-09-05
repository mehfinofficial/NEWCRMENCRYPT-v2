<?php
// api/files.php — File Manager backend
//
// Files are uploaded alongside a Support / Renewal / New Installation
// record (license files, receipts, customized reports, etc). Each upload
// is stored on disk under data/uploads/ with a random filename, and
// tracked in the `files` table so it can be listed in the File Manager,
// shown as a pill on its record, and downloaded either from inside the
// app (authenticated) or via a short-lived public link (no auth — meant
// to be pasted into a client's browser, valid for 10 minutes).
ini_set('display_errors', 0);
ini_set('log_errors', 1);
error_reporting(E_ALL);
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

$pdo = getDB();

$pdo->exec("CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id INTEGER,
    account TEXT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    filesize INTEGER DEFAULT 0,
    mimetype TEXT,
    download_token TEXT,
    token_expires_at DATETIME,
    uploaded_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)");

$uploadDir = __DIR__ . '/../data/uploads';
if (!is_dir($uploadDir)) {
    mkdir($uploadDir, 0700, true);
}
// Belt-and-suspenders: even though data/ already has protections, deny
// all direct web access to the uploads folder specifically — every file
// must go through this script (auth check or valid time-limited token).
$htaccess = $uploadDir . '/.htaccess';
if (!file_exists($htaccess)) {
    file_put_contents($htaccess, "Require all denied\n");
}

// Streams a file's bytes as an attachment download and exits.
function streamFile(string $uploadDir, array $file): void {
    $path = $uploadDir . '/' . $file['stored_name'];
    if (!is_file($path)) { http_response_code(404); echo 'File missing on server'; exit; }
    header('Content-Type: ' . ($file['mimetype'] ?: 'application/octet-stream'));
    header('Content-Disposition: attachment; filename="' . basename($file['original_name']) . '"');
    header('Content-Length: ' . filesize($path));
    header('X-Content-Type-Options: nosniff');
    readfile($path);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];

// ── Public, token-based download — NOT behind requireAuth on purpose.
// This is the "paste in the client's browser" link, valid for 10 minutes
// from when it was generated.
if ($method === 'GET' && isset($_GET['token'])) {
    $token = trim($_GET['token']);
    $stmt = $pdo->prepare("SELECT * FROM files WHERE download_token = ?");
    $stmt->execute([$token]);
    $file = $stmt->fetch();
    if (!$file) { http_response_code(404); echo 'Link not found.'; exit; }
    if (!$file['token_expires_at'] || strtotime($file['token_expires_at']) < time()) {
        http_response_code(410); echo 'This link has expired.'; exit;
    }
    streamFile($uploadDir, $file);
}

// Everything below requires a logged-in CRM session.
requireAuth($pdo);

if ($method === 'GET') {

    // Authenticated direct download (the "Download" button inside the app).
    if (isset($_GET['download'])) {
        $id = (int)$_GET['download'];
        $stmt = $pdo->prepare("SELECT * FROM files WHERE id = ?");
        $stmt->execute([$id]);
        $file = $stmt->fetch();
        if (!$file) { jsonOut(['error' => 'File not found'], 404); }
        streamFile($uploadDir, $file);
    }

    // Single file's metadata (for the File Detail modal).
    if (isset($_GET['info'])) {
        $id = (int)$_GET['info'];
        $stmt = $pdo->prepare("
            SELECT f.*, c.firmname FROM files f
            LEFT JOIN clients c ON c.clientname = f.account
            WHERE f.id = ?
        ");
        $stmt->execute([$id]);
        $file = $stmt->fetch();
        if (!$file) jsonOut(['error' => 'File not found'], 404);
        jsonOut(['file' => $file]);
    }

    // Files attached to one record (for the "File" pill on a query).
    if (isset($_GET['record_id'])) {
        $rid = (int)$_GET['record_id'];
        $stmt = $pdo->prepare("SELECT id, original_name, filesize, created_at FROM files WHERE record_id = ? ORDER BY created_at ASC");
        $stmt->execute([$rid]);
        jsonOut(['files' => $stmt->fetchAll()]);
    }

    // Default: full file list for the File Manager screen.
    $search = trim($_GET['search'] ?? '');
    $where  = [];
    $params = [];
    if ($search) {
        $like    = "%$search%";
        $where[] = "(f.original_name LIKE ? OR f.account LIKE ? OR c.firmname LIKE ?)";
        $params  = [$like, $like, $like];
    }
    $whereSql = $where ? (" WHERE " . implode(' AND ', $where)) : '';
    $stmt = $pdo->prepare("
        SELECT f.id, f.original_name, f.filesize, f.account, f.created_at, c.firmname
        FROM files f
        LEFT JOIN clients c ON c.clientname = f.account
        $whereSql
        ORDER BY f.created_at DESC
    ");
    $stmt->execute($params);
    jsonOut(['files' => $stmt->fetchAll()]);
}

if ($method === 'POST') {

    // Multipart file upload — arrives in $_FILES / $_POST, not the JSON
    // body, so it's handled before the jsonIn() branch below.
    if (($_POST['action'] ?? '') === 'upload') {
        if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
            jsonOut(['error' => 'No file received'], 400);
        }

        $recordId = (int)($_POST['record_id'] ?? 0);
        $account  = trim($_POST['account'] ?? '');
        $tmpPath  = $_FILES['file']['tmp_name'];
        $origName = $_FILES['file']['name'];
        $size     = (int)$_FILES['file']['size'];
        $mime     = $_FILES['file']['type'] ?: 'application/octet-stream';

        // Store under a random name so it can't be guessed/browsed directly;
        // the original name is kept in the DB for display and download.
        $ext = '';
        if (strpos($origName, '.') !== false) {
            $ext = '.' . preg_replace('/[^a-z0-9]/', '', strtolower(pathinfo($origName, PATHINFO_EXTENSION)));
        }
        $storedName = bin2hex(random_bytes(16)) . $ext;

        if (!move_uploaded_file($tmpPath, $uploadDir . '/' . $storedName)) {
            jsonOut(['error' => 'Failed to save file'], 500);
        }

        $username = $_SESSION['username'] ?? 'Admin';
        $stmt = $pdo->prepare("
            INSERT INTO files (record_id, account, original_name, stored_name, filesize, mimetype, uploaded_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([
            $recordId ?: null, $account, $origName, $storedName,
            $size, $mime, $username, date('Y-m-d H:i:s'),
        ]);
        $fileId = $pdo->lastInsertId();

        logAction($pdo, "File uploaded: {$origName}" . ($account ? " for {$account}" : ''));
        jsonOut(['success' => true, 'id' => (int)$fileId]);
    }

    $body   = jsonIn();
    $action = $body['action'] ?? '';

    // Generate a random, time-limited public download link for a file.
    if ($action === 'generate_link') {
        $id = (int)($body['id'] ?? 0);
        $stmt = $pdo->prepare("SELECT * FROM files WHERE id = ?");
        $stmt->execute([$id]);
        $file = $stmt->fetch();
        if (!$file) jsonOut(['error' => 'File not found'], 404);

        $token   = bin2hex(random_bytes(24));
        $expires = date('Y-m-d H:i:s', time() + 600); // valid for 10 minutes
        $pdo->prepare("UPDATE files SET download_token = ?, token_expires_at = ? WHERE id = ?")
            ->execute([$token, $expires, $id]);

        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $host   = $_SERVER['HTTP_HOST'] ?? '';
        // Project root = one level up from /api/, same auto-detect approach
        // used on the frontend (api.js) so this works whether the app is
        // hosted at the domain root or in a subfolder.
        $root   = rtrim(str_replace('\\', '/', dirname(dirname($_SERVER['SCRIPT_NAME']))), '/');
        $url    = "$scheme://$host$root/api/files.php?token=$token";

        jsonOut(['success' => true, 'token' => $token, 'url' => $url, 'expires_at' => $expires]);
    }

    jsonOut(['error' => 'Unknown action'], 400);
}

jsonOut(['error' => 'Method not allowed'], 405);
