package com.riyanlab;

import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

/** Return controlled ledger rejection reasons without exposing database/server exceptions. */
@RestControllerAdvice(assignableTypes=RecordController.class)
public class PaperConflictAdvice {
    @ExceptionHandler(ResponseStatusException.class)
    ResponseEntity<Map<String,String>> rejected(ResponseStatusException e) {
        String reason=e.getStatusCode().value()==409?e.getReason():"Request rejected";
        return ResponseEntity.status(e.getStatusCode()).body(Map.of("reason",reason==null?"Paper entry rejected":reason));
    }
}
