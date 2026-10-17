read line
max=0
for n in $line; do
  if [ "$n" -gt "$max" ]; then max=$n; fi
done
echo "$max"
