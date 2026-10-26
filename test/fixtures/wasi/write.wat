;; Tries to change /work/src (the first folder it is given, fd 3): create new.txt, truncate main.txt, make a folder
;; and delete main.txt. Prints "denied" or "allowed" for each, one per line.
(module
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open" (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_create_directory" (func $mkdir (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_unlink_file" (func $unlink (param i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 64) "denied\n")
  (data (i32.const 72) "allowed\n")
  (data (i32.const 128) "new.txt")
  (data (i32.const 136) "main.txt")
  (data (i32.const 144) "dir")
  (func $say (param $errno i32)
    (i32.store (i32.const 0) (select (i32.const 64) (i32.const 72) (local.get $errno)))
    (i32.store (i32.const 4) (select (i32.const 7) (i32.const 8) (local.get $errno)))
    (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 16))))
  (func (export "_start")
    ;; oflags: 1 creat, 8 trunc. Rights: fd_write (1 << 6).
    (call $say (call $open (i32.const 3) (i32.const 0) (i32.const 128) (i32.const 7) (i32.const 1) (i64.const 64) (i64.const 0) (i32.const 0) (i32.const 32)))
    (call $say (call $open (i32.const 3) (i32.const 0) (i32.const 136) (i32.const 8) (i32.const 8) (i64.const 64) (i64.const 0) (i32.const 0) (i32.const 32)))
    (call $say (call $mkdir (i32.const 3) (i32.const 144) (i32.const 3)))
    (call $say (call $unlink (i32.const 3) (i32.const 136) (i32.const 8)))))
