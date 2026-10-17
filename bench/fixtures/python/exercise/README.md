# Clamp a number

Write a function `clamp(value, low, high)` in `solution.py` that **returns** `value` forced to stay inside the range `low` to `high` (inclusive).

- If `value` is smaller than `low`, return `low`.
- If `value` is larger than `high`, return `high`.
- Otherwise, return `value` unchanged.

You can assume `low <= high`. The arguments can be integers or floats, and they can be negative.

The function must use `return`, not `print`. The tests call your function and check the value it gives back.

## Examples

```python
clamp(5, 0, 10)    # 5
clamp(-3, 0, 10)   # 0
clamp(42, 0, 10)   # 10
clamp(10, 0, 10)   # 10  (the edges are inside the range)
clamp(-7, -5, -1)  # -5
```
