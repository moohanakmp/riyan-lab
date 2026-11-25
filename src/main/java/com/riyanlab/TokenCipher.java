package com.riyanlab;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * AES-256-GCM for integration secrets at rest (Telegram bot tokens). The key comes from RIYAN_TOKEN_KEY (any
 * passphrase, hashed with SHA-256). Without a key, values stay as plain text so existing installs keep working.
 * Stored form: "enc:v1:" + base64(12-byte IV + ciphertext + tag). Plain values are still read, so rows can be
 * migrated gradually; a sealed value read without the key returns null (delivery fails, nothing leaks).
 */
final class TokenCipher {
    static final String PREFIX = "enc:v1:";
    private static final SecureRandom RNG = new SecureRandom();
    private final SecretKeySpec key;

    TokenCipher(String passphrase) {
        SecretKeySpec k = null;
        if (passphrase != null && !passphrase.isBlank()) {
            try {
                k = new SecretKeySpec(MessageDigest.getInstance("SHA-256").digest(passphrase.getBytes(StandardCharsets.UTF_8)), "AES");
            } catch (Exception e) { throw new IllegalStateException(e); }
        }
        key = k;
    }

    static TokenCipher fromEnv() { return new TokenCipher(System.getenv("RIYAN_TOKEN_KEY")); }

    boolean enabled() { return key != null; }

    String seal(String plain) {
        if (plain == null || key == null || plain.startsWith(PREFIX)) return plain;
        try {
            byte[] iv = new byte[12];
            RNG.nextBytes(iv);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            return PREFIX + Base64.getEncoder().encodeToString(ByteBuffer.allocate(12 + ct.length).put(iv).put(ct).array());
        } catch (Exception e) { throw new IllegalStateException("Token encryption failed", e); }
    }

    String open(String stored) {
        if (stored == null || !stored.startsWith(PREFIX)) return stored;
        if (key == null) return null;
        try {
            byte[] all = Base64.getDecoder().decode(stored.substring(PREFIX.length()));
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, all, 0, 12));
            return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
        } catch (Exception e) { return null; }
    }
}
