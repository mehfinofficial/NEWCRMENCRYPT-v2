<?php
// config/crypto.php
// Reversible AES-256-GCM encryption for sensitive fields (phone numbers).
// NOT for passwords — passwords should stay as salted one-way hashes.

function getEncryptionKey(): string {
    // Preferred: key supplied via environment variable (set this in your
    // hosting panel / php-fpm pool / .env loader). Never commit real keys.
    $envKey = getenv('CRM_ENCRYPTION_KEY');
    if ($envKey) {
        $decoded = base64_decode($envKey, true);
        if ($decoded !== false && strlen($decoded) === 32) {
            return $decoded;
        }
    }

    // Fallback: an auto-generated key file kept in data/, which is already
    // outside the web-servable app and blocked by data/.htaccess.
    $keyFile = __DIR__ . '/../data/encryption.key';
    if (!file_exists($keyFile)) {
        $key = random_bytes(32); // 256-bit key for AES-256
        file_put_contents($keyFile, base64_encode($key));
        @chmod($keyFile, 0600);
    }
    $stored = base64_decode(trim(file_get_contents($keyFile)), true);
    if ($stored === false || strlen($stored) !== 32) {
        throw new RuntimeException('Invalid encryption key in data/encryption.key');
    }
    return $stored;
}

/**
 * Encrypt a plaintext string. Returns null/'' unchanged so optional fields
 * stay optional. Output is prefixed with "enc:" so we can tell encrypted
 * values apart from any old plaintext rows during/after migration.
 */
function encryptField(?string $plaintext): ?string {
    if ($plaintext === null || $plaintext === '') return $plaintext;

    $key = getEncryptionKey();
    $iv  = random_bytes(12); // 96-bit nonce, required for GCM
    $tag = '';

    $cipher = openssl_encrypt($plaintext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    if ($cipher === false) {
        // Fail safe: never silently lose the user's data.
        return $plaintext;
    }

    return 'enc:' . base64_encode($iv . $tag . $cipher);
}

/**
 * Decrypt a value produced by encryptField(). Values without the "enc:"
 * prefix are returned as-is (handles rows not yet migrated).
 */
function decryptField(?string $value): ?string {
    if ($value === null || $value === '') return $value;
    if (strpos($value, 'enc:') !== 0) return $value;

    $raw = base64_decode(substr($value, 4), true);
    if ($raw === false || strlen($raw) < 12 + 16) return $value;

    $iv     = substr($raw, 0, 12);
    $tag    = substr($raw, 12, 16);
    $cipher = substr($raw, 28);

    $key   = getEncryptionKey();
    $plain = openssl_decrypt($cipher, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);

    return $plain === false ? $value : $plain;
}
