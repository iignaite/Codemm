def clamp(value, low, high):
    if value < low:
        return low
    elif value > high:
        return low
    else:
        return value
