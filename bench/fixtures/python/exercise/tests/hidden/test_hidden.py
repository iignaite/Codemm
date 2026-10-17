from solution import clamp


def test_value_above_high():
    assert clamp(42, 0, 10) == 10


def test_value_equal_to_high():
    assert clamp(10, 0, 10) == 10


def test_value_equal_to_low():
    assert clamp(0, 0, 10) == 0


def test_negative_range():
    assert clamp(-7, -5, -1) == -5
    assert clamp(0, -5, -1) == -1
    assert clamp(-3, -5, -1) == -3


def test_floats():
    assert clamp(2.5, 0.0, 1.5) == 1.5
    assert clamp(0.75, 0.0, 1.5) == 0.75


def test_inside_range_returns_value():
    assert clamp(7, 1, 100) == 7
