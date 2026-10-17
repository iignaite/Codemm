maxof() {
  max=$1
  for n in "$@"; do [ "$n" -gt "$max" ] && max=$n; done
  echo "$max"
}
