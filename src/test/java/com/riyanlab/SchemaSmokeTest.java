package com.riyanlab;

import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

class SchemaSmokeTest {
    @Test
    void includesExpectedTables() throws Exception {
        try (InputStream stream = getClass().getResourceAsStream("/db/migration/V1__initial.sql")) {
            assertNotNull(stream);
            String sql = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            for (String table : new String[] {
                "auto_signals", "manual_signals", "low_profit_signals", "analysis_reports",
                "seven_day_predictions", "pnl_reports", "gold_predictions_actuals", "audit_events"
            }) {
                assertTrue(sql.contains(table), table);
            }
        }
    }
}
