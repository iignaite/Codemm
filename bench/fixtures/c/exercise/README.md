# Hello, number!

Your first C program: read one whole number and print a short greeting about it.

## Input

One integer `n` on a single line, with `-1000 <= n <= 1000`. It may be negative or zero.

## Output

Exactly three lines:

```
Hello, C!
You entered N.
The next number is M.
```

where `N` is the number you read and `M` is `N + 1`. Note the comma, the exclamation mark and the periods at the end of lines 2 and 3.

## Example

Input:

```
7
```

Output:

```
Hello, C!
You entered 7.
The next number is 8.
```

Another example, input `-3`:

```
Hello, C!
You entered -3.
The next number is -2.
```

## Tips

- Every C program starts in `int main(void)` and should `return 0;` at the end.
- `#include <stdio.h>` gives you `printf` and `scanf`.
- Read an `int` with `scanf("%d", &n);` and print it with `printf("%d", n);`.
