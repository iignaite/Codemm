;; Prints 8 KB of "e" to stderr, then exits 1.
(module
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (memory.fill (i32.const 1024) (i32.const 101) (i32.const 8192))
    (i32.store (i32.const 0) (i32.const 1024))
    (i32.store (i32.const 4) (i32.const 8192))
    (drop (call $write (i32.const 2) (i32.const 0) (i32.const 1) (i32.const 16)))
    (call $exit (i32.const 1))))
