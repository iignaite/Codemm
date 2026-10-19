FROM maven:3.9-eclipse-temurin-21-alpine@sha256:308cba8b638ed7e4658cea3f8399066219466211c805f6d5728c3c9c7614661b
WORKDIR /opt/track
COPY pom.xml run-tests.sh Report.java ./
COPY probe/unit/pass/ warm/src/main/java/
COPY probe/unit/tests/ warm/src/test/java/
# Checks have no network and run as another user with HOME=/tmp, so the build caches every plugin and dependency the
# test command needs in a folder anyone can read: running the real build once on the pass probe caches them all.
RUN javac -d /opt/track Report.java \
 && cp pom.xml warm/ && cd warm && mvn -B -q -Dmaven.repo.local=/opt/m2 test \
 && cd /opt/track && rm -rf warm && chmod -R a+rX /opt/m2 /opt/track
