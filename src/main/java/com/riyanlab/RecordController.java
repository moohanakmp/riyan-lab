package com.riyanlab;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

@RestController
@RequestMapping("/api/v1")
public class RecordController {
    private static final Map<String, String> TABLES = Map.of(
        "auto-signals", "auto_signals",
        "manual-signals", "manual_signals",
        "low-profit", "low_profit_signals",
        "analysis", "analysis_reports",
        "seven-day", "seven_day_predictions",
        "pnl", "pnl_reports",
        "gold-calls", "gold_predictions_actuals",
        "research", "research_reports",
        "tab-state", "tab_states"
    );

    private final JdbcTemplate jdbc;

    @Value("${RIYAN_API_TOKEN:}")
    private String apiToken;

    public RecordController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private void authorize(String supplied) {
        if (apiToken == null || apiToken.isBlank()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "API token not configured");
        }
        String expected = "Bearer " + apiToken;
        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                Objects.toString(supplied, "").getBytes(StandardCharsets.UTF_8))) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid token");
        }
    }

    private String table(String type) {
        String mapped = TABLES.get(type);
        if (mapped == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown type");
        return "riyan_lab." + mapped;
    }

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "UP");
    }

    @GetMapping("/records/{type}")
    public List<Map<String, Object>> list(
        @PathVariable String type,
        @RequestHeader(value = "Authorization", required = false) String auth,
        @RequestParam(defaultValue = "200") int limit
    ) {
        authorize(auth);
        return jdbc.queryForList(
            "SELECT source_id, payload::text AS payload, updated_at FROM " + table(type)
            + " ORDER BY updated_at DESC LIMIT ?",
            Math.max(1, Math.min(limit, 1000))
        );
    }

    @PutMapping("/records/{type}/{sourceId}")
    public ResponseEntity<Map<String, Object>> put(
        @PathVariable String type,
        @PathVariable String sourceId,
        @RequestHeader(value = "Authorization", required = false) String auth,
        @RequestBody JsonNode payload
    ) {
        authorize(auth);
        if (sourceId.isBlank() || sourceId.length() > 200 || !payload.isObject()) {
            return ResponseEntity.badRequest().build();
        }
        String target = table(type);
        String raw = payload.toString();
        String symbol = payload.path("sym").asText(payload.path("symbol").asText(null));
        String direction = payload.path("dir").asText(payload.path("direction").asText(null));
        String status = payload.path("outcome").asText(payload.path("status").asText(null));
        long epochMillis = payload.path("ts").asLong(payload.path("t").asLong(System.currentTimeMillis()));
        Timestamp eventTime;
        try {
            eventTime = Timestamp.from(Instant.ofEpochMilli(epochMillis));
        } catch (RuntimeException ex) {
            return ResponseEntity.badRequest().build();
        }

        jdbc.update(
            "INSERT INTO " + target + " (source_id, symbol, direction, status, event_time, payload) "
            + "VALUES (?, ?, ?, ?, ?, ?::jsonb) ON CONFLICT (source_id) DO UPDATE SET "
            + "symbol = EXCLUDED.symbol, direction = EXCLUDED.direction, "
            + "status = EXCLUDED.status, event_time = EXCLUDED.event_time, "
            + "payload = EXCLUDED.payload, updated_at = now()",
            sourceId, symbol, direction, status, eventTime, raw
        );
        jdbc.update(
            "INSERT INTO riyan_lab.audit_events(record_type, source_id, action, new_payload) "
            + "VALUES (?, ?, 'UPSERT', ?::jsonb)",
            type, sourceId, raw
        );
        return ResponseEntity.ok(Map.of("saved", true, "sourceId", sourceId));
    }
}
