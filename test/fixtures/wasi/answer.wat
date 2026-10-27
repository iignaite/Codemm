;; A language-free "interpreter" for end-to-end tests: reads answer.txt from /work/src (the first folder it is given,
;; fd 3). A file starting with "e" copies stdin to stdout; any other file is printed as it is. Exits 0.
(module
  (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open" (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 128) "answer.txt")
  ;; Copies what fd $from has left to stdout, through the buffer at 4096.
  (func $copy (param $from i32)
    (loop $more
      (i32.store (i32.const 0) (i32.const 4096))
      (i32.store (i32.const 4) (i32.const 4096))
      (br_if 1 (call $read (local.get $from) (i32.const 0) (i32.const 1) (i32.const 16)))
      (br_if 1 (i32.eqz (i32.load (i32.const 16))))
      (i32.store (i32.const 4) (i32.load (i32.const 16)))
      (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 20)))
      (br $more)))
  (func (export "_start")
    (local $file i32)
    ;; Rights: fd_read (1 << 1).
    (if (call $open (i32.const 3) (i32.const 0) (i32.const 128) (i32.const 10) (i32.const 0) (i64.const 2) (i64.const 0) (i32.const 0) (i32.const 32))
      (then (unreachable)))
    (local.set $file (i32.load (i32.const 32)))
    ;; The file's first byte, read into 1024.
    (i32.store (i32.const 0) (i32.const 1024))
    (i32.store (i32.const 4) (i32.const 1))
    (drop (call $read (local.get $file) (i32.const 0) (i32.const 1) (i32.const 16)))
    (if (i32.eq (i32.load8_u (i32.const 1024)) (i32.const 101))
      (then (call $copy (i32.const 0)))
      (else
        (i32.store (i32.const 0) (i32.const 1024))
        (i32.store (i32.const 4) (i32.load (i32.const 16)))
        (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 20)))
        (call $copy (local.get $file))))))
