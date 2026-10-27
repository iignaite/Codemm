;; Asks for 512 MB more memory: prints "grown" and exits 0 if it gets it, else prints "no memory" to stderr and exits 1.
(module
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 64) "grown\n")
  (data (i32.const 128) "no memory\n")
  (func (export "_start")
    (if (i32.eq (memory.grow (i32.const 8192)) (i32.const -1))
      (then
        (i32.store (i32.const 0) (i32.const 128))
        (i32.store (i32.const 4) (i32.const 10))
        (drop (call $write (i32.const 2) (i32.const 0) (i32.const 1) (i32.const 16)))
        (call $exit (i32.const 1))))
    (i32.store (i32.const 0) (i32.const 64))
    (i32.store (i32.const 4) (i32.const 6))
    (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 16)))))
