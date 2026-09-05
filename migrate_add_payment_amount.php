<?php
// migrate_add_payment_amount.php
// Run ONCE from the command line on the server after deploying this update:
//   php migrate_add_payment_amount.php
//
// Adds the `payment_amount` column to the transactions table. This column
// stores the numeric amount paid for both Renewal and New Installation
// records (Payment Info already existed as a free-text field; this adds a
// proper amount alongside it so Transaction History / totals can sum it).
// Safe to run more than once — skips if the column already exists.

require_once __DIR__ . '/config/db.php';

$pdo = getDB();

$cols = $pdo->query("PRAGMA table_info(transactions)")->fetchAll(PDO::FETCH_ASSOC);
$hasColumn = false;
foreach ($cols as $col) {
    if ($col['name'] === 'payment_amount') { $hasColumn = true; break; }
}

if ($hasColumn) {
    echo "Column 'payment_amount' already exists on transactions. Nothing to do.\n";
} else {
    $pdo->exec("ALTER TABLE transactions ADD COLUMN payment_amount REAL DEFAULT NULL");
    echo "Added 'payment_amount' column to transactions table.\n";
}
