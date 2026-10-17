#include <stdio.h>

int main(void) {
    unsigned int n;
    scanf("%u", &n);
    printf("Hello, C!\n");
    printf("You entered %u.\n", n);
    printf("The next number is %u.\n", n + 1);
    return 0;
}
