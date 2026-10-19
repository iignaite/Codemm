{ n = $1; m = $2; if (n > 1000) n = 1000; s = 0; for (i = 1; i <= n; i++) s += (i * i) % m; print s }
