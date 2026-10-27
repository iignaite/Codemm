;; Has two linear memories, so the memory limit can't be multiplied by declaring more of them.
(module
  (memory $a 1)
  (memory $b 1)
  (func (export "_start")))
