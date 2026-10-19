import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class SolutionTest {
    @Test
    void sumsSmall() {
        assertEquals(6, Solution.sumTo(3));
    }

    @Test
    void sumsZero() {
        assertEquals(0, Solution.sumTo(0));
    }
}
