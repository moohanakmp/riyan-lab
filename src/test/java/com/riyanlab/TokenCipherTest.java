package com.riyanlab;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class TokenCipherTest {
    @Test void sealsAndOpensWithKeyAndKeepsPlainTextReadable() {
        var c = new TokenCipher("test-key-123");
        String token = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
        String sealed = c.seal(token);
        assertTrue(sealed.startsWith(TokenCipher.PREFIX));
        assertFalse(sealed.contains("ABCDEFGHIJ"));
        assertNotEquals(sealed, c.seal(token), "random IV per value");
        assertEquals(token, c.open(sealed));
        assertEquals(sealed, c.seal(sealed), "never double-encrypt");
        assertEquals(token, c.open(token), "legacy plain rows still work");
    }
    @Test void withoutKeyStaysPlainAndCannotOpenSealed() {
        var none = new TokenCipher(null);
        assertFalse(none.enabled());
        assertEquals("abc", none.seal("abc"));
        assertNull(none.open(new TokenCipher("k").seal("abc")));
        assertNull(new TokenCipher("other").open(new TokenCipher("k").seal("abc")), "wrong key fails closed");
    }
}
