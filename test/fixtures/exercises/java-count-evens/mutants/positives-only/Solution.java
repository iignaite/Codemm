public class Solution {
    public static int countEvens(int[] numbers) {
        int count = 0;
        for (int n : numbers) if (n > 0 && n % 2 == 0) count++;
        return count;
    }
}
