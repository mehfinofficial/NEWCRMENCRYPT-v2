<?php
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';
require_once __DIR__ . '/../config/crypto.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

$pdo = getDB();
requireAuth($pdo);

// Auto-migrate: soft-delete column. Deleted clients are kept for 30 days
// (Archives screen) instead of being removed immediately.
try {
    $cols = array_column($pdo->query("PRAGMA table_info(clients)")->fetchAll(), 'name');
    if (!in_array('deleted_at', $cols)) {
        $pdo->exec("ALTER TABLE clients ADD COLUMN deleted_at DATETIME DEFAULT NULL");
    }
} catch (Exception $e) {}

ensureClientPhonesTable($pdo);

// Extra phone numbers (beyond the primary `contact` field) for a set of
// client ids, decrypted and grouped by client_id. Batched into one query
// so listing/searching clients doesn't do N+1 lookups.
function fetchExtraPhones(PDO $pdo, array $clientIds): array {
    if (!$clientIds) return [];
    $placeholders = implode(',', array_fill(0, count($clientIds), '?'));
    $stmt = $pdo->prepare("SELECT client_id, phone FROM client_phones WHERE client_id IN ($placeholders) ORDER BY sort_order ASC, id ASC");
    $stmt->execute($clientIds);
    $byClient = [];
    foreach ($stmt->fetchAll() as $row) {
        $byClient[(int)$row['client_id']][] = decryptField($row['phone']);
    }
    return $byClient;
}

// Replaces all extra phone numbers for a client with the given list.
// Simplest correct approach at CRM-sized row counts: delete then re-insert
// rather than diffing — matches the same "form is the source of truth"
// pattern the rest of this file already uses for a client's other fields.
function saveExtraPhones(PDO $pdo, int $clientId, array $phones): void {
    $pdo->prepare("DELETE FROM client_phones WHERE client_id = ?")->execute([$clientId]);
    $phones = array_values(array_filter(array_map('trim', $phones), fn($p) => $p !== ''));
    if (!$phones) return;
    $stmt = $pdo->prepare("INSERT INTO client_phones (client_id, phone, sort_order) VALUES (?, ?, ?)");
    foreach ($phones as $i => $phone) {
        $stmt->execute([$clientId, encryptField($phone), $i]);
    }
}

// Decrypt the phone-number fields on a client row (or array of rows) before
// it goes back to the browser, then mask them per the caller's permission.
// $context distinguishes the two screens that both read from this same
// endpoint but have different default visibility rules: the plain Clients
// list/cards ('clients') vs the Renewal Details screen ('renewals'), which
// reuses this same GET rather than having its own endpoint. Masking here
// (not in app.js) so a restricted user can't just read the field out of
// the network response. $extraPhones is the batched client_id => [phones]
// map from fetchExtraPhones(), same masking rule as the primary contact.
function decryptClient(array $client, bool $canViewPhone, array $extraPhones = []): array {
    $client['contact']  = maskPhone(decryptField($client['contact']  ?? null), $canViewPhone);
    $client['whatsapp'] = maskPhone(decryptField($client['whatsapp'] ?? null), $canViewPhone);
    $extras = $extraPhones[(int)($client['id'] ?? 0)] ?? [];
    $client['extra_contacts'] = $canViewPhone ? $extras : [];
    return $client;
}
function decryptClients(PDO $pdo, array $clients, bool $canViewPhone): array {
    $ids    = array_map(fn($c) => (int)$c['id'], $clients);
    $extras = fetchExtraPhones($pdo, $ids);
    return array_map(fn($c) => decryptClient($c, $canViewPhone, $extras), $clients);
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
    requirePermission($pdo, 'view_clients');

    // Return software types for dropdown
    if (isset($_GET['software_types'])) {
        $stmt = $pdo->query("SELECT id, name FROM software_types ORDER BY name ASC");
        jsonOut(['software_types' => $stmt->fetchAll()]);
    }

    // 'renewals' = Renewal Details screen (reuses this endpoint), anything
    // else = the plain Clients list/cards + Client Detail modal. Each has
    // its own default visibility per the permission matrix.
    $context      = ($_GET['context'] ?? '') === 'renewals' ? 'renewals' : 'clients';
    $permKey      = $context === 'renewals' ? 'view_phone_renewals' : 'view_phone_clients';
    $canViewPhone = getUserPermissions($pdo)[$permKey];

    // Single client by ID
    if (isset($_GET['id'])) {
        $stmt = $pdo->prepare("SELECT * FROM clients WHERE id = ? AND deleted_at IS NULL");
        $stmt->execute([(int)$_GET['id']]);
        $client = $stmt->fetch();
        $extras = $client ? fetchExtraPhones($pdo, [(int)$client['id']]) : [];
        jsonOut(['client' => $client ? decryptClient($client, $canViewPhone, $extras) : null]);
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
            WHERE deleted_at IS NULL AND (
                  clientname LIKE ? OR firmname LIKE ?
               OR email LIKE ? OR system_id LIKE ?
               OR software_type LIKE ? OR software_version LIKE ?
            )
            ORDER BY clientname ASC
        ");
        $stmt->execute([$like, $like, $like, $like, $like, $like]);
        $matchedIds = array_column($stmt->fetchAll(), 'id');

        $all = $pdo->query("SELECT * FROM clients WHERE deleted_at IS NULL ORDER BY clientname ASC")->fetchAll();
        $all = decryptClients($pdo, $all, $canViewPhone);

        $needle = strtolower($search);
        $clients = array_values(array_filter($all, function ($c) use ($matchedIds, $needle) {
            if (in_array($c['id'], $matchedIds, true)) return true;
            $phone = strtolower(($c['contact'] ?? '') . ' ' . ($c['whatsapp'] ?? '') . ' ' . implode(' ', $c['extra_contacts'] ?? []));
            return str_contains($phone, $needle);
        }));
    } else {
        $clients = decryptClients($pdo, $pdo->query("SELECT * FROM clients WHERE deleted_at IS NULL ORDER BY clientname ASC")->fetchAll(), $canViewPhone);
    }
    jsonOut(['clients' => $clients]);
}

if ($method === 'POST') {
    $body   = jsonIn();
    $action = $body['action'] ?? '';

    // Add new software type dynamically
    if ($action === 'add_software_type') {
        requirePermission($pdo, 'can_add_client');
        $name = trim($body['name'] ?? '');
        if (!$name) jsonOut(['error' => 'Name required'], 400);
        $pdo->prepare("INSERT OR IGNORE INTO software_types (name) VALUES (?)")->execute([$name]);
        logAction($pdo, "Software type added: $name");
        jsonOut(['success' => true]);
    }

    if ($action === 'add') {
        requirePermission($pdo, 'can_add_client');
        $stmt = $pdo->prepare("
            INSERT INTO clients
                (clientname, firmname, address, contact, email, whatsapp,
                 system_id, status, renewal_date, software_type, software_version, created_at)
            VALUES
                (:clientname, :firmname, :address, :contact, :email, :whatsapp,
                 :system_id, :status, :renewal_date, :software_type, :software_version, :created_at)
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
            ':created_at'        => date('Y-m-d H:i:s'),
        ]);
        // Capture the id before logAction() (its own INSERT into `logs`
        // would otherwise clobber lastInsertId() with the wrong row's id).
        $newClientId = $pdo->lastInsertId();
        saveExtraPhones($pdo, (int)$newClientId, $body['extra_contacts'] ?? []);
        logAction($pdo, "New client added: " . ($body['firmname'] ?? $body['clientname'] ?? ''));
        jsonOut(['success' => true, 'id' => $newClientId]);
    }

    if ($action === 'update_status') {
        requirePermission($pdo, 'can_edit_client');
        $stmt = $pdo->prepare("UPDATE clients SET status = :status WHERE id = :id");
        $stmt->execute([':status' => (int)($body['status'] ?? 1), ':id' => (int)($body['id'] ?? 0)]);
        logAction($pdo, "Client status updated: id=" . ($body['id'] ?? ''));
        jsonOut(['success' => true]);
    }

    if ($action === 'update') {
        requirePermission($pdo, 'can_edit_client');
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
        saveExtraPhones($pdo, $id, $body['extra_contacts'] ?? []);
        logAction($pdo, "Client updated: " . ($body['clientname'] ?? '') . " (id=$id)");
        jsonOut(['success' => true]);
    }

    if ($action === 'delete') {
        requirePermission($pdo, 'can_delete_client');
        $id = (int)($body['id'] ?? 0);
        if (!$id) jsonOut(['error' => 'Invalid ID'], 400);
        $stmt = $pdo->prepare("SELECT clientname FROM clients WHERE id = ? AND deleted_at IS NULL");
        $stmt->execute([$id]);
        $client = $stmt->fetch();
        if (!$client) jsonOut(['error' => 'Client not found'], 404);

        // Hard block: a client with existing records can never be deleted,
        // by anyone, no override. Records must be removed/reassigned first.
        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE account = ? AND deleted_at IS NULL");
        $countStmt->execute([$client['clientname']]);
        $recordCount = (int)$countStmt->fetchColumn();
        if ($recordCount > 0) {
            jsonOut([
                'success'      => false,
                'has_records'  => true,
                'record_count' => $recordCount,
                'error'        => "This client has $recordCount record(s) and can't be deleted. Remove or reassign their records first.",
            ], 409);
        }

        // Soft delete: kept in Archives for 30 days, then purged by the
        // scheduled cleanup (see api/archive.php), instead of being
        // removed immediately and unrecoverably.
        $pdo->prepare("UPDATE clients SET deleted_at = ? WHERE id = ?")->execute([date('Y-m-d H:i:s'), $id]);
        logAction($pdo, "Client deleted: " . $client['clientname'] . " (id=$id)");
        jsonOut(['success' => true]);
    }

    jsonOut(['error' => 'Unknown action'], 400);
}

jsonOut(['error' => 'Method not allowed'], 405);