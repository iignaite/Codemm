public class Solution {
    public static long sumTo(int n) {
        long sum = 0;
        for (int i = 1; i < n; i++) sum += i;
        return sum;
    }
}
