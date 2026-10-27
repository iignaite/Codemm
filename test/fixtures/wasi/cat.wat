;; Copies stdin to stdout, then exits 0.
(module
  (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (loop $more
      (i32.store (i32.const 0) (i32.const 64))
      (i32.store (i32.const 4) (i32.const 4096))
      (br_if 1 (call $read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 16)))
      (br_if 1 (i32.eqz (i32.load (i32.const 16))))
      (i32.store (i32.const 4) (i32.load (i32.const 16)))
      (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 20)))
      (br $more))))
