maxof() {
  max=0
  for n in "$@"; do [ "$n" -gt "$max" ] && max=$n; done
  echo "$max"
}
