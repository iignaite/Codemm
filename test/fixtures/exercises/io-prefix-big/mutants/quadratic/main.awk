NR == 1 { next }
{ a[NR] = $1; s = 0; for (i = 2; i <= NR; i++) s += a[i]; print s }
