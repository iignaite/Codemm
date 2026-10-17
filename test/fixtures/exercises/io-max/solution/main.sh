read line
max=
for n in $line; do
  if [ -z "$max" ] || [ "$n" -gt "$max" ]; then max=$n; fi
done
echo "$max"
