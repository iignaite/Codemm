require("../../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  countJUnitTests,
  isValidJUnit5TestSuite,
  isValidJUnit5TestSuiteCountRange,
  pruneJUnitTestMethods,
} = require("../../../../src/languages/java/rules");

const BASE_SUITE = `
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class BillingTest {
  @Test void test_case_1(){ assertEquals(1, 1); }
  @Test void test_case_2(){ assertEquals(2, 2); }
  @Test void test_case_3(){ assertEquals(3, 3); }
}
`.trim();

test("java rules: pruneJUnitTestMethods removes only named @Test methods", () => {
  const pruned = pruneJUnitTestMethods(BASE_SUITE, ["test_case_2"]);

  assert.deepEqual(pruned.dropped, ["test_case_2"]);
  assert.equal(pruned.remaining, 2);
  assert.equal(countJUnitTests(pruned.testSuite), 2);
  assert.match(pruned.testSuite, /test_case_1/);
  assert.doesNotMatch(pruned.testSuite, /test_case_2/);
  assert.match(pruned.testSuite, /test_case_3/);
});

test("java rules: relaxed range validator accepts degraded suites while exact validator does not", () => {
  const pruned = pruneJUnitTestMethods(BASE_SUITE, ["test_case_2"]);

  assert.equal(isValidJUnit5TestSuite(pruned.testSuite, 3), false);
  assert.equal(isValidJUnit5TestSuiteCountRange(pruned.testSuite, 1, 8), true);
});
