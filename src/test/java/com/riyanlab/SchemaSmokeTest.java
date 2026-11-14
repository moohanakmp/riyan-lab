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

    @Test
    void previouslyAppliedBasketMigrationIsImmutableAndReplayUsesV4() throws Exception {
        var v3=getClass().getResourceAsStream("/db/migration/V3__basket_scalp_paper_ledger.sql");
        assertNotNull(v3, "Expected original V3 basket migration");
        var crc=new java.util.zip.CRC32();
        try(var reader=new java.io.BufferedReader(new java.io.InputStreamReader(v3,StandardCharsets.UTF_8))){
            String line;
            while((line=reader.readLine())!=null)crc.update(line.getBytes(StandardCharsets.UTF_8));
        }
        assertEquals(1351136328,(int)crc.getValue(),
            "Never edit Flyway V3 after it ran; use a new versioned migration");
        try(var v4=getClass().getResourceAsStream("/db/migration/V4__basket_scalp_replay_ledger.sql")){
            assertNotNull(v4,"Replay table must be added in Flyway V4");
            var sql=new String(v4.readAllBytes(),StandardCharsets.UTF_8);
            assertTrue(sql.contains("CREATE TABLE IF NOT EXISTS basket_scalp_replays"));
            assertTrue(sql.contains("CREATE INDEX IF NOT EXISTS basket_replays_owner_idx"));
        }
    }
    @Test void migrationVersionsAreUnique()throws Exception{
        var location=java.nio.file.Path.of(getClass().getResource("/db/migration").toURI());
        var versions=new java.util.HashSet<String>();
        try(var files=java.nio.file.Files.list(location)){
            for(var name:files.map(p->p.getFileName().toString()).filter(n->n.startsWith("V")).toList())
                assertTrue(versions.add(name.split("__")[0]),"Duplicate migration version: "+name);
        }
    }

}
