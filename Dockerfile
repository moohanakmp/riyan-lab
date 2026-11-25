FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src src
RUN mvn -B -q verify
FROM node:22-bookworm-slim AS scanner-node
FROM eclipse-temurin:21-jre
COPY --from=scanner-node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /build/target/riyan-lab-1.0.0.jar app.jar
# Run as an unprivileged user (2026-11-25 review); the app only writes to /tmp.
RUN useradd --system --uid 10001 --no-create-home riyan
USER 10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
