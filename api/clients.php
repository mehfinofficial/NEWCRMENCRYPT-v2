<?php
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';
require_once __DIR__ . '/../config/crypto.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

$pdo = getDB();
requireAuth($pdo);

// Decrypt the phone-number fields on a client row (or array of rows) before
// it goes back to the browser.
function decryptClient(array $client): array {
    $client['contact']  = decryptField($client['contact']  ?? null);
    $client['whatsapp'] = decryptField($client['whatsapp'] ?? null);
    return $client;
}
function decryptClients(array $clients): array {
    return array_map('decryptClient', $clients);
}

// Auto-migrate: add software columns if they don't exist yet
try {
    $cols = array_column($pdo->query("PRAGMA table_info(clients)")->fetchAll(), 'name');
    if (!in_array('software_type', $cols)) {
        $pdo->exec("ALTER TABLE clients ADD COLUMN software_type TEXT DEFAULT NULL");
    }
    if (!in_array('software_version', $cols)) {
        $pdo->exec("ALTER TABLE clients ADD COLUMN software_version TEXT DEFAULT NULL");
    }
} catch (Exception $e) {}

// Auto-create software_types lookup table + seed if empty
try {
    $pdo->exec("CREATE TABLE IF NOT EXISTS software_types (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
    )");
    $count = (int)$pdo->query("SELECT COUNT(*) FROM software_types")->fetchColumn();
    if ($count === 0) {
        $pdo->exec("INSERT INTO software_types (name) VALUES
            ('Tally Prime'),('Tally ERP 9'),('Busy'),
            ('Marg ERP'),('QuickBooks'),('Zoho Books'),('Other')");
    }
} catch (Exception $e) {}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {

    // Return software types for dropdown
    if (isset($_GET['software_types'])) {
        $stmt = $pdo->query("SELECT id, name FROM software_types ORDER BY name ASC");
        jsonOut(['software_types' => $stmt->fetchAll()]);
    }

    // Single client by ID
    if (isset($_GET['id'])) {
        $stmt = $pdo->prepare("SELECT * FROM clients WHERE id = ?");
        $stmt->execute([(int)$_GET['id']]);
        $client = $stmt->fetch();
        jsonOut(['client' => $client ? decryptClient($client) : null]);
    }

    // Search / list clients.
    // contact/whatsapp are encrypted at rest, so they can't be matched with
    // SQL LIKE. We match the plain columns in SQL, decrypt every row's
    // phone fields, then also check the search term against the decrypted
    // phone numbers in PHP. Fine at CRM-sized row counts.
    $search = trim($_GET['search'] ?? '');
    if ($search) {
        $like = "%$search%";
        $stmt = $pdo->prepare("
            SELECT * FROM clients
            WHERE clientname LIKE ? OR firmname LIKE ?
               OR email LIKE ? OR system_id LIKE ?
               OR software_type LIKE ? OR software_version LIKE ?
            ORDER BY clientname ASC
        ");
        $stmt->execute([$like, $like, $like, $like, $like, $like]);
        $matchedIds = array_column($stmt->fetchAll(), 'id');

        $all = $pdo->query("SELECT * FROM clients ORDER BY clientname ASC")->fetchAll();
        $all = decryptClients($all);

        $needle = strtolower($search);
        $clients = array_values(array_filter($all, function ($c) use ($matchedIds, $needle) {
            if (in_array($c['id'], $matchedIds, true)) return true;
            $phone = strtolower(($c['contact'] ?? '') . ' ' . ($c['whatsapp'] ?? ''));
            return str_contains($phone, $needle);
        }));
    } else {
        $clients = decryptClients($pdo->query("SELECT * FROM clients ORDER BY clientname ASC")->fetchAll());
    }
    jsonOut(['clients' => $clients]);
}

if ($method === 'POST') {
    $body   = jsonIn();
    $action = $body['action'] ?? '';

    // Add new software type dynamically
    if ($action === 'add_software_type') {
        $name = trim($body['name'] ?? '');
        if (!$name) jsonOut(['error' => 'Name required'], 400);
        $pdo->prepare("INSERT OR IGNORE INTO software_types (name) VALUES (?)")->execute([$name]);
        logAction($pdo, "Software type added: $name");
        jsonOut(['success' => true]);
    }

    if ($action === 'add') {
        $stmt = $pdo->prepare("
            INSERT INTO clients
                (clientname, firmname, address, contact, email, whatsapp,
                 system_id, status, renewal_date, software_type, software_version)
            VALUES
                (:clientname, :firmname, :address, :contact, :email, :whatsapp,
                 :system_id, :status, :renewal_date, :software_type, :software_version)
        ");
        $stmt->execute([
            ':clientname'        => $body['clientname']        ?? '',
            ':firmname'          => $body['firmname']          ?? '',
            ':address'           => $body['address']           ?? '',
            ':contact'           => encryptField($body['contact']  ?? ''),
            ':email'             => $body['email']             ?? '',
            ':whatsapp'          => encryptField($body['whatsapp'] ?? ''),
            ':system_id'         => $body['system_id']         ?? null,
            ':status'            => isset($body['status']) ? (int)$body['status'] : 1,
            ':renewal_date'      => $body['renewal_date']      ?? null,
            ':software_type'     => $body['software_type']     ?? null,
            ':software_version'  => $body['software_version']  ?? null,
        ]);
        logAction($pdo, "New client added: " . ($body['firmname'] ?? $body['clientname'] ?? ''));
        jsonOut(['success' => true, 'id' => $pdo->lastInsertId()]);
    }

    if ($action === 'update_status') {
        $stmt = $pdo->prepare("UPDATE clients SET status = :status WHERE id = :id");
        $stmt->execute([':status' => (int)($body['status'] ?? 1), ':id' => (int)($body['id'] ?? 0)]);
        logAction($pdo, "Client status updated: id=" . ($body['id'] ?? ''));
        jsonOut(['success' => true]);
    }

    if ($action === 'update') {
        $id = (int)($body['id'] ?? 0);
        if (!$id) jsonOut(['error' => 'Invalid ID'], 400);
        $stmt = $pdo->prepare("
            UPDATE clients
            SET clientname       = :clientname,
                firmname         = :firmname,
                address          = :address,
                contact          = :contact,
                email            = :email,
                whatsapp         = :whatsapp,
                system_id        = :system_id,
                status           = :status,
                renewal_date     = :renewal_date,
                software_type    = :software_type,
                software_version = :software_version
            WHERE id = :id
        ");
        $stmt->execute([
            ':clientname'        => $body['clientname']        ?? '',
            ':firmname'          => $body['firmname']          ?? '',
            ':address'           => $body['address']           ?? '',
            ':contact'           => encryptField($body['contact']  ?? ''),
            ':email'             => $body['email']             ?? '',
            ':whatsapp'          => encryptField($body['whatsapp'] ?? ''),
            ':system_id'         => $body['system_id']         ?? null,
            ':status'            => isset($body['status']) ? (int)$body['status'] : 1,
            ':renewal_date'      => $body['renewal_date']      ?? null,
            ':software_type'     => $body['software_type']     ?? null,
            ':software_version'  => $body['software_version']  ?? null,
            ':id'                => $id,
        ]);
        logAction($pdo, "Client updated: " . ($body['clientname'] ?? '') . " (id=$id)");
        jsonOut(['success' => true]);
    }

    if ($action === 'delete') {
        $id = (int)($body['id'] ?? 0);
        if (!$id) jsonOut(['error' => 'Invalid ID'], 400);
        $stmt = $pdo->prepare("SELECT clientname FROM clients WHERE id = ?");
        $stmt->execute([$id]);
        $client = $stmt->fetch();
        if (!$client) jsonOut(['error' => 'Client not found'], 404);
        $pdo->prepare("DELETE FROM clients WHERE id = ?")->execute([$id]);
        logAction($pdo, "Client deleted: " . $client['clientname'] . " (id=$id)");
        jsonOut(['success' => true]);
    }

    jsonOut(['error' => 'Unknown action'], 400);
}

jsonOut(['error' => 'Method not allowed'], 405);