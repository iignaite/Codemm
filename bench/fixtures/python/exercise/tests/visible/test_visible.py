from solution import clamp


def test_value_inside_range():
    assert clamp(5, 0, 10) == 5


def test_value_below_low():
    assert clamp(-3, 0, 10) == 0
