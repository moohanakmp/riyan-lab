package com.riyanlab;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Baseline HTTP hardening for every response, plus a request body size cap that runs before
 * JSON parsing (so an anonymous client cannot fill the small Render heap with one huge login body).
 *
 * The CSP restricts framing, plugins, base URLs, form targets and script hosts. 'unsafe-inline' stays until the
 * inline engine in index.html (and its onclick handlers) is moved into files; see README "Security headers".
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class SecurityHeadersFilter extends OncePerRequestFilter {
    // Scripts only from this site and the two CDNs the page uses (EmailJS, TradingView widgets). Inline scripts are
    // still allowed because the engine lives inline in index.html; external script hosts are not.
    static final String CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; "
        + "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://s3.tradingview.com";
    static final long AUTH_LIMIT = 16 * 1024;          // login / user admin bodies are tiny
    static final long DEFAULT_LIMIT = 2 * 1024 * 1024; // records are capped at 1 MB of JSON after parsing

    static long limitFor(String path) {
        return path != null && path.startsWith("/api/v1/auth/") ? AUTH_LIMIT : DEFAULT_LIMIT;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        res.setHeader("Content-Security-Policy", CSP);
        res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
        if (req.isSecure()) res.setHeader("Strict-Transport-Security", "max-age=15552000");

        long limit = limitFor(req.getRequestURI());
        long declared = req.getContentLengthLong();
        if (declared > limit) {
            res.sendError(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
            return;
        }
        // Chunked bodies have no Content-Length: count bytes as they are read.
        chain.doFilter(declared < 0 && hasBody(req) ? new Limited(req, limit) : req, res);
    }

    private static boolean hasBody(HttpServletRequest req) {
        String m = req.getMethod();
        return "POST".equals(m) || "PUT".equals(m) || "PATCH".equals(m) || "DELETE".equals(m);
    }

    static final class TooLarge extends IOException {
        TooLarge() { super("Request body too large"); }
    }

    static final class Limited extends HttpServletRequestWrapper {
        private final long limit;
        private ServletInputStream stream;

        Limited(HttpServletRequest req, long limit) { super(req); this.limit = limit; }

        @Override
        public ServletInputStream getInputStream() throws IOException {
            if (stream == null) {
                ServletInputStream in = super.getInputStream();
                stream = new ServletInputStream() {
                    long read;
                    private void count(long n) throws IOException {
                        if (n > 0 && (read += n) > limit) throw new TooLarge();
                    }
                    @Override public int read() throws IOException { int b = in.read(); if (b >= 0) count(1); return b; }
                    @Override public int read(byte[] b, int off, int len) throws IOException { int n = in.read(b, off, len); count(n); return n; }
                    @Override public boolean isFinished() { return in.isFinished(); }
                    @Override public boolean isReady() { return in.isReady(); }
                    @Override public void setReadListener(ReadListener l) { in.setReadListener(l); }
                };
            }
            return stream;
        }

        @Override
        public BufferedReader getReader() throws IOException {
            String enc = getCharacterEncoding();
            return new BufferedReader(new InputStreamReader(getInputStream(), enc == null ? StandardCharsets.UTF_8.name() : enc));
        }
    }
}
