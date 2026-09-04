<?php
// migrate_encrypt_phones.php
// Run ONCE from the command line on the server after deploying crypto.php:
//   php migrate_encrypt_phones.php
// It encrypts any contact/whatsapp values that aren't already encrypted
// (i.e. don't start with "enc:"). Safe to run more than once — already
// encrypted rows are skipped.

require_once __DIR__ . '/config/db.php';
require_once __DIR__ . '/config/crypto.php';

$pdo = getDB();

// Widen the columns so encrypted (longer) values always fit.
$pdo->exec("ALTER TABLE clients RENAME COLUMN contact TO contact_old_tmp");
// SQLite ALTER TABLE can't change types directly in older versions, and
// VARCHAR(N) isn't enforced by SQLite anyway, so we just rename back —
// this block is a no-op safeguard for clarity, not a real length change.
$pdo->exec("ALTER TABLE clients RENAME COLUMN contact_old_tmp TO contact");

$rows = $pdo->query("SELECT id, contact, whatsapp FROM clients")->fetchAll();

$updated = 0;
foreach ($rows as $row) {
    $needsUpdate = false;
    $newContact  = $row['contact'];
    $newWhatsapp = $row['whatsapp'];

    if ($row['contact'] !== '' && $row['contact'] !== null && strpos($row['contact'], 'enc:') !== 0) {
        $newContact = encryptField($row['contact']);
        $needsUpdate = true;
    }
    if ($row['whatsapp'] !== '' && $row['whatsapp'] !== null && strpos($row['whatsapp'], 'enc:') !== 0) {
        $newWhatsapp = encryptField($row['whatsapp']);
        $needsUpdate = true;
    }

    if ($needsUpdate) {
        $stmt = $pdo->prepare("UPDATE clients SET contact = ?, whatsapp = ? WHERE id = ?");
        $stmt->execute([$newContact, $newWhatsapp, $row['id']]);
        $updated++;
    }
}

echo "Done. Encrypted phone fields on $updated of " . count($rows) . " client rows.\n";
echo "Encryption key is stored at data/encryption.key (or CRM_ENCRYPTION_KEY env var if set).\n";
echo "BACK THIS KEY UP SOMEWHERE SAFE OUTSIDE THE PROJECT. If it's lost, encrypted phone numbers are unrecoverable.\n";
