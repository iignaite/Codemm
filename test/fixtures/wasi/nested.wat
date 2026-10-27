;; In /work/src (fd 3): prints sub/inner.txt, then tries to delete it and to create sub/new.txt, printing "denied" or
;; "allowed" for each.
(module
  (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open" (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_unlink_file" (func $unlink (param i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 64) "denied\n")
  (data (i32.const 72) "allowed\n")
  (data (i32.const 128) "sub/inner.txt")
  (data (i32.const 144) "sub/new.txt")
  (func $say (param $errno i32)
    (i32.store (i32.const 0) (select (i32.const 64) (i32.const 72) (local.get $errno)))
    (i32.store (i32.const 4) (select (i32.const 7) (i32.const 8) (local.get $errno)))
    (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 16))))
  (func (export "_start")
    ;; Rights: fd_read (1 << 1).
    (if (i32.eqz (call $open (i32.const 3) (i32.const 0) (i32.const 128) (i32.const 13) (i32.const 0) (i64.const 2) (i64.const 0) (i32.const 0) (i32.const 32)))
      (then
        (i32.store (i32.const 0) (i32.const 1024))
        (i32.store (i32.const 4) (i32.const 1024))
        (drop (call $read (i32.load (i32.const 32)) (i32.const 0) (i32.const 1) (i32.const 4)))
        (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 40)))))
    (call $say (call $unlink (i32.const 3) (i32.const 128) (i32.const 13)))
    ;; oflags 1: creat. Rights: fd_write (1 << 6).
    (call $say (call $open (i32.const 3) (i32.const 0) (i32.const 144) (i32.const 11) (i32.const 1) (i64.const 64) (i64.const 0) (i32.const 0) (i32.const 32)))))
