package com.riyanlab;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class RiyanLabApplication {
    public static void main(String[] args) {
        // Fail before Flyway if a staging service forgot its isolated schema.
        String environment = System.getenv().getOrDefault("APP_ENV", "production");
        String schema = System.getenv().getOrDefault("DB_SCHEMA", "riyan_lab");
        if (!schema.matches("[a-z][a-z0-9_]{0,62}")) {
            throw new IllegalStateException("Invalid DB_SCHEMA");
        }
        if ("staging".equalsIgnoreCase(environment) && "riyan_lab".equals(schema)) {
            throw new IllegalStateException("Staging must set DB_SCHEMA to a non-production schema");
        }
        SpringApplication.run(RiyanLabApplication.class, args);
    }
}
