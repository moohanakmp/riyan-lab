package com.riyanlab;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;\nimport org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication\n@EnableScheduling
public class RiyanLabApplication {
    public static void main(String[] args) {
        SpringApplication.run(RiyanLabApplication.class, args);
    }
}
