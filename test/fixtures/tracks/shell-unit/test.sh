#!/bin/sh
# Runs every $TESTS/*.sh against /work/src/lib.sh and writes a Codemm report to $OUT.
first=1
printf '{"tests":[' > "$OUT"
for t in "$TESTS"/*.sh; do
  [ -e "$t" ] || continue
  name=$(basename "$t" .sh)
  if sh -c ". /work/src/lib.sh; . '$t'" > /tmp/test.log 2>&1; then status=pass; else status=fail; fi
  [ "$first" = 1 ] || printf ',' >> "$OUT"
  first=0
  printf '{"name":"%s","status":"%s"}' "$name" "$status" >> "$OUT"
done
printf ']}' >> "$OUT"
