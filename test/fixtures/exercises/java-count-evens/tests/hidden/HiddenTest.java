import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class HiddenTest {
    @Test
    void countsNegativesAndZero() {
        assertEquals(3, Solution.countEvens(new int[] {-2, -4, 0, 3}));
    }

    @Test
    void emptyHasNone() {
        assertEquals(0, Solution.countEvens(new int[] {}));
    }
}
