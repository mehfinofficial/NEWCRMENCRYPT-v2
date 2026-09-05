<?php
// api/messages.php — Quick Message templates (CRUD) + sent-message audit log.
// Actual sending happens client-side via wa.me / sms: links — this endpoint
// only manages the reusable template text and records that a message went out.

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

// Auto-create + seed the templates table so this works on a fresh DB with
// zero manual setup, same pattern as software_types in clients.php.
try {
    $pdo->exec("CREATE TABLE IF NOT EXISTS message_templates (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )");
    $count = (int)$pdo->query("SELECT COUNT(*) FROM message_templates")->fetchColumn();
    if ($count === 0) {
        $seed = $pdo->prepare("INSERT INTO message_templates (name, body) VALUES (:name, :body)");
        $defaults = [
            ['Renewal Reminder', "Hi {name}, this is a reminder that the software renewal for {firm} is due on {renewal_date}. Please get in touch with us to continue uninterrupted service."],
            ['Renewal Overdue', "Hi {name}, we noticed the renewal for {firm} was due on {renewal_date} and hasn't been completed yet. Kindly renew at the earliest to avoid service interruption."],
            ['Payment Confirmation', "Hi {name}, we've received your payment for {firm}. Thank you for your continued trust in us!"],
            ['Installation Complete', "Hi {name}, the installation for {firm} is now complete. System ID: {system_id}. Let us know if you need any help getting started."],
            ['General Follow-up', "Hi {name}, just checking in regarding {firm}. Please let us know if there's anything we can help with."],
            ['Inactive Client Reachout', "Hi {name}, we noticed your subscription for {firm} has lapsed. We'd love to help you get set up again — let us know a good time to connect."],
        ];
        foreach ($defaults as [$name, $body]) {
            $seed->execute([':name' => $name, ':body' => $body]);
        }
    }
} catch (Exception $e) {}

if ($method === 'GET') {
    $stmt = $pdo->query("SELECT id, name, body FROM message_templates ORDER BY id ASC");
    jsonOut(['templates' => $stmt->fetchAll()]);
}

if ($method === 'POST') {
    $body   = jsonIn();
    $action = $body['action'] ?? '';

    if ($action === 'add_template') {
        $name = trim($body['name'] ?? '');
        $text = trim($body['body'] ?? '');
        if (!$name || !$text) jsonOut(['error' => 'Name and message body are required'], 400);
        $stmt = $pdo->prepare("INSERT INTO message_templates (name, body) VALUES (?, ?)");
        $stmt->execute([$name, $text]);
        logAction($pdo, "Message template added: $name");
        jsonOut(['success' => true, 'id' => $pdo->lastInsertId()]);
    }

    if ($action === 'update_template') {
        $id   = (int)($body['id'] ?? 0);
        $name = trim($body['name'] ?? '');
        $text = trim($body['body'] ?? '');
        if (!$id || !$name || !$text) jsonOut(['error' => 'Invalid template'], 400);
        $stmt = $pdo->prepare("UPDATE message_templates SET name = ?, body = ? WHERE id = ?");
        $stmt->execute([$name, $text, $id]);
        logAction($pdo, "Message template updated: $name");
        jsonOut(['success' => true]);
    }

    if ($action === 'delete_template') {
        $id = (int)($body['id'] ?? 0);
        if (!$id) jsonOut(['error' => 'Invalid ID'], 400);
        $pdo->prepare("DELETE FROM message_templates WHERE id = ?")->execute([$id]);
        logAction($pdo, "Message template deleted (id=$id)");
        jsonOut(['success' => true]);
    }

    // Audit trail only — the message itself is sent client-side via a
    // wa.me / sms: link, this just logs that it happened.
    if ($action === 'log_sent') {
        $client   = trim($body['client'] ?? '');
        $template = trim($body['template'] ?? '');
        $channel  = trim($body['channel'] ?? '');
        logAction($pdo, "Quick message sent to $client via $channel ($template)");
        jsonOut(['success' => true]);
    }

    jsonOut(['error' => 'Unknown action'], 400);
}

jsonOut(['error' => 'Method not allowed'], 405);
