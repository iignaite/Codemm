;; Prints 64 KB at a time to stdout, forever.
(module
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 2)
  (func (export "_start")
    (memory.fill (i32.const 1024) (i32.const 120) (i32.const 65536))
    (i32.store (i32.const 0) (i32.const 1024))
    (i32.store (i32.const 4) (i32.const 65536))
    (loop $forever
      (br_if 1 (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 16)))
      (br $forever))))
