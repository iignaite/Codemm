#!/bin/sh
# Builds the learner's files and the tests in $TESTS as a Maven project in /tmp (the sources are read-only), offline
# against the repository baked into the image, then converts Surefire's reports into $OUT.
p=/tmp/project
rm -rf "$p" && mkdir -p "$p/src/main/java" "$p/src/test/java" || exit 1
cp /opt/track/pom.xml "$p/" && cp /work/src/*.java "$p/src/main/java/" && cp "$TESTS"/*.java "$p/src/test/java/" || exit 1
cd "$p" || exit 1
# A test that fails still exits 0; a compile error doesn't, and its output says why.
mvn -o -q -B -Dmaven.repo.local=/opt/m2 -Dmaven.test.failure.ignore=true test > /tmp/mvn.log 2>&1 || { tail -c 3000 /tmp/mvn.log; exit 1; }
java -cp /opt/track Report target/surefire-reports "$OUT"
