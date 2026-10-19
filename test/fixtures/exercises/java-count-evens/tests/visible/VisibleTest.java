import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class VisibleTest {
    @Test
    void countsEvens() {
        assertEquals(2, Solution.countEvens(new int[] {1, 2, 3, 4}));
    }
}
